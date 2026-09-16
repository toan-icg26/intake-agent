// Calls the model for a JSON object and validates it against a schema.
// Invalid structure is an expected outcome and is returned (and logged) with the raw output.
import cds from '@sap/cds'
import { chat, ModelError } from './groq.js'
import { validate } from './schema.js'

const LOG = cds.log('structured')

/**
 * Returns { valid, stage, errors, value, raw, model, latencyMs, waitedMs, usage }.
 * stage (only when invalid): json_mode | parse | schema
 */
export async function callStructured({ schema, messages, label }) {
  let reply
  try {
    reply = await chat(messages, { json: true, label })
  } catch (err) {
    const failed = jsonModeFailure(err)
    if (!failed) throw err
    return invalid({ label, stage: 'json_mode', errors: [failed.message], raw: failed.raw })
  }

  const base = { raw: reply.content, model: reply.model, latencyMs: reply.latencyMs, waitedMs: reply.waitedMs, usage: reply.usage }
  let value
  try {
    value = JSON.parse(reply.content)
  } catch (err) {
    return invalid({ label, stage: 'parse', errors: [err.message], ...base })
  }
  const errors = validate(schema, value)
  if (errors.length) return invalid({ label, stage: 'schema', errors, value, ...base })
  return { valid: true, stage: null, errors: [], value, ...base }
}

// Groq rejects JSON-mode generations that are not valid JSON with HTTP 400 json_validate_failed
// and returns the offending text in error.failed_generation.
function jsonModeFailure(err) {
  if (!(err instanceof ModelError) || err.status !== 400 || !err.body) return null
  try {
    const { error } = JSON.parse(err.body)
    if (error?.code !== 'json_validate_failed') return null
    return { message: error.message, raw: error.failed_generation ?? err.body }
  } catch {
    return null
  }
}

function invalid(result) {
  const { label, stage, errors, raw } = result
  LOG.warn(`[${label}] invalid structure at stage=${stage}: ${errors.join(' | ')}\n--- raw model output ---\n${raw}\n--- end raw ---`)
  return { valid: false, value: null, latencyMs: null, ...result, label: undefined }
}
