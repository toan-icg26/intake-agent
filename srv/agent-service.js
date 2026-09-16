import cds from '@sap/cds'
import { chat, modelConfig, ModelError } from './lib/groq.js'
import { callStructured } from './lib/structured.js'
import { runGraph } from './lib/graph.js'
import { TRIAGE_SCHEMA } from './lib/schema.js'
import { askAgentMessages, triageMessages } from './lib/prompts.js'

const LOG = cds.log('agent')

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

    this.on('runIntake', async req => {
      const { text } = req.data
      if (!text?.trim()) return req.error(400, 'text must not be empty')
      const findArticles = async requestText => {
        const articles = await SELECT.from(KnowledgeArticles)
        return rankArticles(articles, requestText)
      }
      try {
        const s = await runGraph(text, { findArticles })
        LOG.info(`[runIntake] path=${s.decision.path} nodes=${s.trace.map(t => t.node).join('>')} modelCalls=${s.modelCalls} modelLatency=${s.modelLatencyMs}ms total=${s.totalMs}ms`)
        return {
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
      } catch (err) {
        return fail(req, err)
      }
    })

    return super.init()
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
    return req.error(err.status, err.message)
  }
  throw err
}
