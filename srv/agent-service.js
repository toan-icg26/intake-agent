import cds from '@sap/cds'
import { chat, modelConfig, ModelError } from './lib/groq.js'
import { callStructured } from './lib/structured.js'
import { runGraph, initialState, proposalFor, START, END } from './lib/graph.js'
import { TRIAGE_SCHEMA, OWNERS, PATHS } from './lib/schema.js'
import { askAgentMessages, triageMessages } from './lib/prompts.js'

const LOG = cds.log('agent')
const RUNS = 'intake.IntakeRuns'
const OUTBOX = 'intake.Outbox'
const EVENTS = 'intake.ApprovalEvents'
const EDITABLE = ['awaiting_approval', 'on_hold']
const CODE_RULE = /^(p1_signal|refusal|invalid_model_output|incomplete)/

export default class AgentService extends cds.ApplicationService {
  init() {
    const { KnowledgeArticles } = this.entities

    this.on('askAgent', async req => {
      const { question } = req.data
      if (!question?.trim()) return req.error(400, 'question must not be empty')
      try {
        const reply = await chat(askAgentMessages(question), { label: 'askAgent' })
        return reply.content
      } catch (err) {
        return fail(req, err)
      }
    })

    this.on('triage', async req => {
      const { text } = req.data
      if (!text?.trim()) return req.error(400, 'text must not be empty')
      try {
        const r = await callStructured({ schema: TRIAGE_SCHEMA, messages: triageMessages(text), label: 'triage' })
        return {
          valid: r.valid, stage: r.stage, errors: r.errors,
          result: r.valid ? r.value : null,
          raw: r.raw, model: r.model ?? modelConfig().model, latencyMs: r.latencyMs
        }
      } catch (err) {
        return fail(req, err)
      }
    })

    // Own cds.tx per DB access: checkpoints must commit immediately, and the request tx must not hold the single SQLite connection.
    const execute = async (req, ID, state, node, postedBy = 'code') => {
      const deps = {
        findArticles: async requestText => rankArticles(await cds.tx(tx => tx.run(SELECT.from(KnowledgeArticles))), requestText),
        saveCheckpoint: async (s, nextNode, status) => {
          await cds.tx(tx => tx.run(UPDATE(RUNS).set({ state: JSON.stringify(s), nextNode, status, proposal: s.proposal ? JSON.stringify(s.proposal) : null, error: null }).where({ ID })))
          LOG.info(`[checkpoint] run=${ID} next=${nextNode} status=${status}`)
        },
        post: async proposal => {
          const row = { ID: cds.utils.uuid(), runID: ID, path: proposal.path, channel: proposal.channel, recipient: proposal.recipient, message: proposal.message, postedBy }
          await cds.tx(tx => tx.run(INSERT.into(OUTBOX).entries(row)))
          await logEvent(ID, 'posted', postedBy)
          LOG.info(`[outbox] run=${ID} ${proposal.channel} to ${proposal.recipient} postedBy=${postedBy}`)
          return { ID: row.ID, channel: row.channel, recipient: row.recipient, postedBy }
        }
      }
      try {
        const s = await runGraph(state, node, deps)
        if (s.paused) {
          await logEvent(ID, 'parked', 'system')
          LOG.info(`[approval] run=${ID} parked: ${s.proposal.channel} to ${s.proposal.recipient}`)
        }
        LOG.info(`[intake] run=${ID} path=${s.decision.path} nodes=${s.trace.map(t => t.node).join('>')} modelCalls=${s.modelCalls} modelLatency=${s.modelLatencyMs}ms total=${s.totalMs}ms`)
        return toIntakeRun(ID, s)
      } catch (err) {
        await cds.tx(tx => tx.run(UPDATE(RUNS).set({ status: 'failed', error: err.message }).where({ ID })))
        return fail(req, err)
      }
    }

    this.on('runIntake', async req => {
      const { text } = req.data
      if (!text?.trim()) return req.error(400, 'text must not be empty')
      const ID = cds.utils.uuid(), state = initialState(text)
      await cds.tx(tx => tx.run(INSERT.into(RUNS).entries({ ID, text, status: 'running', nextNode: START, state: JSON.stringify(state) })))
      LOG.info(`[runIntake] run=${ID} started`)
      return execute(req, ID, state, START)
    })

    this.on('resumeIntake', async req => {
      const { runID } = req.data
      if (!runID) return req.error(400, 'runID must not be empty')
      const run =await cds.tx(tx => tx.run(SELECT.one.from(RUNS).where({ ID: runID })))
      if (!run) return req.error(404, `run ${runID} not found`)
      const state = JSON.parse(run.state)
      if (run.status === 'completed') return toIntakeRun(runID, state)
      if (EDITABLE.includes(run.status)) return req.error(409, `run ${runID} is ${run.status} and waits for a person; use approveRun`)
      LOG.info(`[resumeIntake] run=${runID} status=${run.status} resuming at ${run.nextNode}`)
      return execute(req, runID, state, run.nextNode)
    })

    // ---- Assignment 8: the approval gate ----------------------------------------------
    const parked = async (req, allowed = EDITABLE) => {
      const { runID } = req.data
      if (!runID) { req.error(400, 'runID must not be empty'); return null }
      const run = await cds.tx(tx => tx.run(SELECT.one.from(RUNS).where({ ID: runID })))
      if (!run) { req.error(404, `run ${runID} not found`); return null }
      if (!allowed.includes(run.status)) { req.error(409, `run ${runID} is ${run.status}; expected ${allowed.join(' or ')}`); return null }
      return run
    }

    // Every transition is guarded by the status it expects, so two approvers cannot both release one run.
    const claim = async (req, run, from, changes) => {
      const affected = await cds.tx(tx => tx.run(UPDATE(RUNS).set(changes).where({ ID: run.ID, status: from })))
      if (!affected) { req.error(409, `run ${run.ID} changed while you were working on it`); return false }
      return true
    }

    this.on('editProposal', async req => {
      const run = await parked(req)
      if (!run) return
      const { path, owner, message, reason } = req.data
      if (path && !PATHS.includes(path)) return req.error(400, `path must be one of: ${PATHS.join(', ')}`)
      if (owner && !OWNERS.includes(owner)) return req.error(400, `owner must be one of: ${OWNERS.join(', ')}`)
      const state = JSON.parse(run.state), before = state.proposal
      const rule = state.decision.reasons[0] ?? ''
      if (path && path !== before.path && CODE_RULE.test(rule) && !reason?.trim())
        return req.error(400, `this path was decided by a code rule (${rule}); changing it requires a reason`)
      const after = proposalFor(path ?? before.path, owner ?? before.owner, message ?? before.message, state.extraction)
      state.proposal = after
      state.output = after.message
      if (!await claim(req, run, run.status, { state: JSON.stringify(state), proposal: JSON.stringify(after) })) return
      await logEvent(run.ID, 'edited', req.user.id, { reason, before: JSON.stringify(before), after: JSON.stringify(after) })
      LOG.info(`[approval] run=${run.ID} edited by ${req.user.id}${reason ? ` reason="${reason}"` : ''}`)
      return { runID: run.ID, status: run.status, proposal: JSON.stringify(after) }
    })

    this.on('pauseRun', async req => {
      const run = await parked(req, ['awaiting_approval'])
      if (!run) return
      if (!await claim(req, run, 'awaiting_approval', { status: 'on_hold' })) return
      await logEvent(run.ID, 'paused', req.user.id, { reason: req.data.reason })
      LOG.info(`[approval] run=${run.ID} on hold, by ${req.user.id}${req.data.reason ? ` reason="${req.data.reason}"` : ''}`)
      return { runID: run.ID, status: 'on_hold', proposal: run.proposal }
    })

    this.on('resumeRun', async req => {
      const run = await parked(req, ['on_hold'])
      if (!run) return
      if (!await claim(req, run, 'on_hold', { status: 'awaiting_approval' })) return
      await logEvent(run.ID, 'resumed', req.user.id)
      LOG.info(`[approval] run=${run.ID} back in the queue, by ${req.user.id}`)
      return { runID: run.ID, status: 'awaiting_approval', proposal: run.proposal }
    })

    this.on('approveRun', async req => {
      const { runID } = req.data
      if (!runID) return req.error(400, 'runID must not be empty')
      const existing = await cds.tx(tx => tx.run(SELECT.one.from(RUNS).where({ ID: runID })))
      if (existing?.status === 'completed') return toIntakeRun(runID, JSON.parse(existing.state))
      const run = await parked(req, ['awaiting_approval'])
      if (!run) return
      if (!await claim(req, run, 'awaiting_approval', { status: 'running' })) return
      await logEvent(run.ID, 'approved', req.user.id)
      LOG.info(`[approval] run=${run.ID} approved by ${req.user.id}, continuing at ${run.nextNode}`)
      return execute(req, run.ID, JSON.parse(run.state), run.nextNode, req.user.id)
    })

    return super.init()
  }
}

const logEvent = (runID, action, actor, { reason, before, after } = {}) =>
  cds.tx(tx => tx.run(INSERT.into(EVENTS).entries({ ID: cds.utils.uuid(), runID, action, actor, reason: reason ?? null, before: before ?? null, after: after ?? null })))

function toIntakeRun(runID, s) {
  return {
    runID,
    status: s.paused ? 'awaiting_approval' : s.posted ? 'completed' : 'running',
    proposal: s.proposal ? JSON.stringify(s.proposal) : null,
    posted: s.posted ? JSON.stringify(s.posted) : null,
    path: s.decision.path,
    owner: s.decision.owner,
    reasons: s.decision.reasons,
    overrides: s.decision.overrides,
    output: s.output,
    extraction: JSON.stringify(s.extraction),
    classification: JSON.stringify(s.classification),
    policy: JSON.stringify(s.policy),
    invalidOutputs: s.invalidOutputs,
    trace: s.trace,
    modelCalls: s.modelCalls,
    modelLatencyMs: s.modelLatencyMs,
    totalMs: s.totalMs
  }
}

// Keyword match: an article is a candidate when at least one of its phrases occurs in the request.
export function rankArticles(articles, text) {
  const haystack = text.toLowerCase()
  return articles
    .map(a => ({ ...a, hits: a.keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k && haystack.includes(k)) }))
    .filter(a => a.hits.length)
    .sort((a, b) => b.hits.length - a.hits.length)
    .slice(0, 3)
}

function fail(req, err) {
  if (err instanceof ModelError) {
    LOG.error(err.message)
    // A 401/403 from the model endpoint is not the caller's auth problem; CAP would reply a bare "Unauthorized".
    const status = err.status === 401 || err.status === 403 ? 502 : err.status
    return req.error(status, err.message)
  }
  throw err
}
