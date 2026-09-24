// Explicit state graph for one intake request, in plain application code.
//
//   extract -> lookup_context -> classify -> check_policy -> choose_path
//                                                               |-> ask_for_info      -+
//                                                               |-> draft_response     +-> approval_gate (pause) -> post
//                                                               |-> route_to_group    -+                           ^
//                                                               '-> escalate_to_human -+---------------------------'
//                                                                   (straight to post when code alone decided it)
//
// Branch conditions are written out in the "Branch conditions" section of README.md.
import { callStructured } from './structured.js'
import { chat } from './groq.js'
import { checkPolicy } from './policy.js'
import { EXTRACTION_SCHEMA, CLASSIFICATION_SCHEMA } from './schema.js'
import { extractionMessages, classificationMessages, draftMessages } from './prompts.js'

export const END = '__end__'
export const POST = 'post'
const MAX_STRUCTURED_ATTEMPTS = 2

// Where a posted action goes. Nothing leaves this system: "posting" writes a row to the Outbox table.
export const CHANNEL = {
  ask_for_info: 'reply_to_requester',
  draft_response: 'reply_to_requester',
  route_to_group: 'handoff_to_group',
  escalate_to_human: 'page_duty_manager'
}

export function proposalFor(path, owner, message, extraction) {
  const recipient = CHANNEL[path] === 'reply_to_requester' ? (extraction?.requester || 'requester') : (owner || 'it_duty_manager')
  return { path, owner: owner ?? null, channel: CHANNEL[path], recipient, message }
}

// A path node parks its proposal for a person, unless code alone decided to escalate: the brief
// requires the duty manager to hear about a P1 immediately, and notifying a human is the safe direction.
function afterProposal(state, message) {
  const { path, owner } = state.decision
  state.proposal = proposalFor(path, owner, message, state.extraction)
  state.output = message
  return state.decision.gated ? 'approval_gate' : POST
}

const NODES = {
  async extract(state) {
    state.extraction = await structuredWithRepair(state, 'extract', EXTRACTION_SCHEMA, extractionMessages(state.text))
    return { next: 'lookup_context', note: state.extraction ? 'facts extracted' : 'extraction invalid after retry; continuing with text-only policy checks' }
  },

  async lookup_context(state, { findArticles }) {
    state.articles = await findArticles(state.text)
    return { next: 'classify', note: state.articles.length ? `candidate articles: ${state.articles.map(a => a.ID).join(', ')}` : 'no candidate articles' }
  },

  async classify(state) {
    if (!state.extraction) return { next: 'check_policy', note: 'skipped: no valid extraction to classify' }
    state.classification = await structuredWithRepair(state, 'classify', CLASSIFICATION_SCHEMA, classificationMessages(state.text, state.extraction, state.articles))
    const c = state.classification
    return { next: 'check_policy', note: c ? `model says ${c.next_action} / ${c.owner} / ${c.urgency} (confidence ${c.confidence})` : 'classification invalid after retry' }
  },

  async check_policy(state) {
    state.policy = checkPolicy(state.text, state.extraction)
    const { p1, refusals, incomplete } = state.policy
    const hits = [...p1, ...refusals, ...incomplete]
    return { next: 'choose_path', note: hits.length ? `policy hits: ${hits.join(', ')}` : 'no policy hits' }
  },

  async choose_path(state) {
    const d = decide(state)
    state.decision = d
    return { next: d.path, note: d.reasons.join('; ') }
  },

  async ask_for_info(state) {
    const missing = [
      ...state.policy.incomplete.map(i => i === 'requester_not_identifiable' ? 'your name and department' : 'which system, application or device is affected'),
      ...(state.extraction?.missing_info ?? [])
    ]
    const message = `Thanks for contacting the IT Service Desk. Before we can work on this, please reply with:\n${[...new Set(missing)].map(m => `- ${m}`).join('\n') || '- a description of the problem, the affected system and your name'}`
    return { next: afterProposal(state, message), note: 'information request prepared' }
  },

  async draft_response(state) {
    const article = state.articles.find(a => a.ID === state.decision.kbArticleId)
    const reply = await chat(draftMessages(state.text, state.extraction, article), { label: 'draft_response' })
    recordCall(state, reply)
    return { next: afterProposal(state, reply.content.trim()), note: `draft based on ${article.ID}` }
  },

  async route_to_group(state) {
    const e = state.extraction, c = state.classification
    const message = [
      `Route to: ${state.decision.owner}`,
      `Urgency: ${c.urgency} | Category: ${c.category} | Confidence: ${c.confidence}`,
      `Summary: ${e.summary}`,
      `Requester: ${e.requester} | Affected system: ${e.affected_system}`,
      e.error_message ? `Error: ${e.error_message}` : null,
      `Basis: ${c.policy_basis}`
    ].filter(Boolean).join('\n')
    return { next: afterProposal(state, message), note: `handoff note for ${state.decision.owner}` }
  },

  async escalate_to_human(state) {
    const { p1, refusals } = state.policy
    const message = [
      'ESCALATION to IT duty manager',
      p1.length ? `P1 signals (code): ${p1.join(', ')}` : null,
      refusals.length ? `Refusal rules (code): ${refusals.join(', ')} - do not fulfil; a person must decline this request` : null,
      `Reasons: ${state.decision.reasons.join('; ')}`,
      `Request: ${state.extraction?.summary ?? state.text}`
    ].filter(Boolean).join('\n')
    return { next: afterProposal(state, message), note: 'escalation note prepared' }
  },

  async approval_gate(state) {
    return { next: POST, pause: true, note: `parked for approval: ${state.proposal.channel} to ${state.proposal.recipient}` }
  },

  async post(state, { post }) {
    state.posted = await post(state.proposal)
    return { next: END, note: `posted: ${state.proposal.channel} to ${state.proposal.recipient}` }
  }
}

/**
 * The branch decision. Order matters: code rules first, model judgement last.
 * Every time code changes what the model proposed, an override is recorded.
 */
export function decide({ extraction, classification: c, policy, articles }) {
  const reasons = [], overrides = []
  const result = (path, owner, extra = {}) => {
    if (c && path !== c.next_action) overrides.push({ rule: reasons[0], modelSaid: c.next_action, codeDecided: path })
    // Escalations that code decided on its own are posted without waiting for an approver.
    const gated = !(path === 'escalate_to_human' && /^(p1_signal|refusal|invalid_model_output)/.test(reasons[0]))
    return { path, owner, reasons, overrides, gated, ...extra }
  }

  if (policy.p1.length) {
    reasons.push(`p1_signal: ${policy.p1.join(', ')}`)
    return result('escalate_to_human', 'it_duty_manager')
  }
  if (policy.refusals.length) {
    reasons.push(`refusal: ${policy.refusals.join(', ')}`)
    return result('escalate_to_human', 'it_duty_manager')
  }
  if (!extraction || !c) {
    reasons.push('invalid_model_output: a person must triage this request')
    return result('escalate_to_human', 'it_duty_manager')
  }
  if (policy.incomplete.length) {
    reasons.push(`incomplete: ${policy.incomplete.join(', ')}`)
    return result('ask_for_info', null)
  }
  if (c.next_action === 'escalate_to_human' || c.owner === 'it_duty_manager') {
    reasons.push('model_judgement: model requested escalation (accepted; a false escalation is cheaper than a missed one)')
    return result('escalate_to_human', 'it_duty_manager')
  }
  if (c.next_action === 'ask_for_info') {
    reasons.push('model_judgement: model needs more information')
    return result('ask_for_info', null)
  }
  if (c.next_action === 'draft_response') {
    const article = articles.find(a => a.ID === c.kb_article_id)
    if (article) {
      reasons.push(`documented_resolution: ${article.ID}`)
      return result('draft_response', article.owner, { kbArticleId: article.ID })
    }
    reasons.push(`no_documented_resolution: model cited ${c.kb_article_id} which was not a candidate from lookup_context`)
    return result('route_to_group', c.owner)
  }
  reasons.push(`model_judgement: route to ${c.owner}`)
  return result('route_to_group', c.owner)
}

// One retry with the validation errors fed back. Every invalid attempt is kept with its raw output.
async function structuredWithRepair(state, node, schema, messages) {
  for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt++) {
    const r = await callStructured({ schema, messages, label: `${node}#${attempt}` })
    recordCall(state, r)
    if (r.valid) return r.value
    state.invalidOutputs.push({ node, attempt, stage: r.stage, errors: r.errors, raw: r.raw })
    messages = [
      ...messages,
      { role: 'assistant', content: r.raw ?? '' },
      { role: 'user', content: `That output is invalid: ${r.errors.join('; ')}. Return only a corrected JSON object that conforms to the schema.` }
    ]
  }
  return null
}

function recordCall(state, r) {
  state.modelCalls++
  if (typeof r.latencyMs === 'number') state.modelLatencyMs += r.latencyMs
  if (r.waitedMs) state.rateLimitWaitMs += r.waitedMs
  if (r.usage?.total_tokens) state.tokens += r.usage.total_tokens
}

export const START = 'extract'

export function initialState(text) {
  return {
    text, extraction: null, articles: [], classification: null, policy: null, decision: null, output: null,
    invalidOutputs: [], trace: [], modelCalls: 0, modelLatencyMs: 0, rateLimitWaitMs: 0, tokens: 0
  }
}

// A node is either fully in the saved checkpoint or re-run on resume; totalMs covers this process only.
export async function runGraph(state, node, deps) {
  const startedAt = Date.now()
  state.paused = false
  if (state.trace.length) state.trace.push({ node: 'resume', next: node, ms: 0, note: `resumed from checkpoint at ${node}; ${state.trace.filter(t => t.node !== 'resume').length} earlier nodes not re-run` })
  while (node !== END) {
    const t0 = Date.now()
    const { next, note, pause } = await NODES[node](state, deps)
    state.trace.push({ node, next, ms: Date.now() - t0, note })
    node = next
    state.totalMs = Date.now() - startedAt
    await deps.saveCheckpoint(state, node, pause ? 'awaiting_approval' : node === END ? 'completed' : 'running')
    if (pause) { state.paused = true; return state }
  }
  return state
}
