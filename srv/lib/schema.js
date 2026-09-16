// Structured output contract. Defined before any prompt; prompts are generated from it.

export const RESOLVER_GROUPS = ['network_infrastructure', 'business_applications', 'end_user_devices', 'identity_access']
export const OWNERS = [...RESOLVER_GROUPS, 'it_duty_manager']
export const PATHS = ['ask_for_info', 'draft_response', 'route_to_group', 'escalate_to_human']
export const CATEGORIES = ['incident', 'service_request', 'access_request', 'how_to_question', 'security_concern']
export const URGENCIES = ['P1', 'P2', 'P3', 'P4']

const nullableString = description => ({ type: ['string', 'null'], description })

export const EXTRACTION_PROPERTIES = {
  summary: { type: 'string', minLength: 1, description: 'One sentence restating the request in neutral language.' },
  requester: nullableString('Name or identifier of the person raising the request, exactly as written; null if absent.'),
  affected_system: nullableString('The system, application, device or service that is affected; null if it cannot be identified.'),
  error_message: nullableString('Any error message or code quoted in the request; null if none.'),
  users_affected: { type: ['integer', 'null'], minimum: 0, description: 'Number of users affected if stated or clearly implied; null if unknown.' },
  missing_info: { type: 'array', items: { type: 'string' }, description: 'Only facts without which the right resolver group cannot be chosen or work cannot start (for example: which system, what the problem is, who is asking). Details a resolver can collect later do not belong here. Empty array if none.' }
}

export const CLASSIFICATION_PROPERTIES = {
  category: { type: 'string', enum: CATEGORIES },
  urgency: { type: 'string', enum: URGENCIES, description: 'P1 = production stopped, safety, security breach, data loss or >50 users; P2 = team blocked; P3 = single user blocked; P4 = question or minor.' },
  owner: { type: 'string', enum: OWNERS },
  next_action: { type: 'string', enum: PATHS },
  kb_article_id: nullableString('ID of the knowledge article whose resolution applies, only if one was provided in the context; otherwise null.'),
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  policy_basis: { type: 'string', minLength: 1, description: 'Short justification naming the facts in the request that led to this classification.' }
}

const objectSchema = properties => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false
})

export const EXTRACTION_SCHEMA = objectSchema(EXTRACTION_PROPERTIES)
export const CLASSIFICATION_SCHEMA = objectSchema(CLASSIFICATION_PROPERTIES)
export const TRIAGE_SCHEMA = objectSchema({ ...EXTRACTION_PROPERTIES, ...CLASSIFICATION_PROPERTIES })

/**
 * Minimal JSON Schema validator for the subset used above
 * (type, enum, minimum, maximum, minLength, items, properties, required, additionalProperties).
 * Returns a list of human-readable errors; empty means valid.
 */
export function validate(schema, value) {
  const errors = []
  check(schema, value, '$', errors)
  return errors
}

function matchesType(type, v) {
  switch (type) {
    case 'null': return v === null
    case 'string': return typeof v === 'string'
    case 'integer': return Number.isInteger(v)
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'array': return Array.isArray(v)
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v)
    default: return false
  }
}

function check(schema, v, path, errors) {
  const types = [].concat(schema.type)
  if (!types.some(t => matchesType(t, v))) {
    errors.push(`${path}: expected ${types.join('|')}, got ${JSON.stringify(v)}`)
    return
  }
  if (v === null) return
  if (schema.enum && !schema.enum.includes(v)) errors.push(`${path}: ${JSON.stringify(v)} is not one of ${schema.enum.join(', ')}`)
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${path}: ${v} is below minimum ${schema.minimum}`)
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${path}: ${v} is above maximum ${schema.maximum}`)
  }
  if (typeof v === 'string' && schema.minLength && v.trim().length < schema.minLength) errors.push(`${path}: must not be empty`)
  if (Array.isArray(v) && schema.items) v.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors))
  if (matchesType('object', v) && schema.properties) {
    for (const key of schema.required ?? []) if (!(key in v)) errors.push(`${path}.${key}: required property missing`)
    for (const [key, sub] of Object.entries(schema.properties)) if (key in v) check(sub, v[key], `${path}.${key}`, errors)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(v)) if (!(key in schema.properties)) errors.push(`${path}.${key}: unexpected property`)
    }
  }
}
