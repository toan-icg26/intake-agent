import cds from '@sap/cds'
import { chat, modelConfig, ModelError } from './lib/groq.js'
import { callStructured } from './lib/structured.js'
import { runGraph, initialState, START, END } from './lib/graph.js'
import { TRIAGE_SCHEMA } from './lib/schema.js'
import { askAgentMessages, triageMessages } from './lib/prompts.js'

const LOG = cds.log('agent')
const RUNS = 'intake.IntakeRuns'

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
    const execute = async (req, ID, state, node) => {
      const deps = {
        findArticles: async requestText => rankArticles(await cds.tx(tx => tx.run(SELECT.from(KnowledgeArticles))), requestText),
        saveCheckpoint: async (s, nextNode) => {
          await cds.tx(tx => tx.run(UPDATE(RUNS).set({ state: JSON.stringify(s), nextNode, status: nextNode === END ? 'completed' : 'running', error: null }).where({ ID })))
          LOG.info(`[checkpoint] run=${ID} next=${nextNode}`)
        }
      }
      try {
        const s = await runGraph(state, node, deps)
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
      LOG.info(`[resumeIntake] run=${runID} status=${run.status} resuming at ${run.nextNode}`)
      return execute(req, runID, state, run.nextNode)
    })

    return super.init()
  }
}

function toIntakeRun(runID, s) {
  return {
    runID,
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
    return req.error(err.status, err.message)
  }
  throw err
}
