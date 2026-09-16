// Thin client for an OpenAI-compatible chat completions endpoint (Groq free tier by default).
import cds from '@sap/cds'

const LOG = cds.log('model')
const MAX_429_RETRIES = 3

export class ModelError extends Error {
  constructor(message, { status = 502, body } = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

// Read lazily: cds loads .env into process.env during bootstrap.
export function modelConfig() {
  return {
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_MODEL,
    apiKey: process.env.GROQ_API_KEY,
    reasoningEffort: process.env.GROQ_REASONING_EFFORT || undefined,
    // 'off' disables response_format json_object; used only to measure prompt-only structured output
    jsonMode: process.env.GROQ_JSON_MODE !== 'off'
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * One chat completion. Waits and retries only on HTTP 429, and only for the
 * number of seconds the endpoint asks for in `retry-after`.
 * Returns { content, model, usage, latencyMs, waitedMs, attempts }.
 */
export async function chat(messages, { json = false, label = 'chat' } = {}) {
  const { baseUrl, model, apiKey, reasoningEffort, jsonMode } = modelConfig()
  if (!apiKey) throw new ModelError('GROQ_API_KEY is not set. Copy .env.example to .env and fill it in.', { status: 500 })
  if (!model) throw new ModelError('GROQ_MODEL is not set. Copy .env.example to .env and fill it in.', { status: 500 })

  const body = { model, messages, temperature: 0 }
  if (json && jsonMode) body.response_format = { type: 'json_object' }
  if (reasoningEffort) body.reasoning_effort = reasoningEffort

  let waitedMs = 0
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now()
    let response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      })
    } catch (err) {
      throw new ModelError(`Could not reach the model endpoint: ${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}`)
    }
    const text = await response.text()
    const latencyMs = Date.now() - startedAt

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))
      if (attempt > MAX_429_RETRIES || !Number.isFinite(retryAfter)) {
        throw new ModelError(`Rate limited by the model endpoint (retry-after=${response.headers.get('retry-after')}): ${text}`, { status: 429, body: text })
      }
      LOG.warn(`[${label}] HTTP 429, waiting retry-after=${retryAfter}s (attempt ${attempt}/${MAX_429_RETRIES})`)
      await sleep(retryAfter * 1000)
      waitedMs += retryAfter * 1000
      continue
    }
    if (!response.ok) throw new ModelError(`Model endpoint returned ${response.status}: ${text}`, { status: response.status, body: text })

    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new ModelError(`Model endpoint returned a non-JSON body: ${text}`, { body: text })
    }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new ModelError(`Unexpected response shape: ${text}`, { body: text })

    LOG.info(`[${label}] model=${data.model} latency=${latencyMs}ms tokens=${data.usage?.total_tokens ?? 'n/a'}${waitedMs ? ` waited=${waitedMs}ms` : ''}`)
    return { content, model: data.model, usage: data.usage, latencyMs, waitedMs, attempts: attempt }
  }
}
