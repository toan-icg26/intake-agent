// Prompts are generated from the schemas in schema.js; the schema is the contract.
import { EXTRACTION_SCHEMA, CLASSIFICATION_SCHEMA, TRIAGE_SCHEMA } from './schema.js'

const CONTEXT = `You work on the internal IT Service Desk of Lumen Industrial, a fictional manufacturer with three plants and a head office.
Resolver groups (owner values):
- network_infrastructure: connectivity, VPN, servers, plant network, Wi-Fi
- business_applications: ERP, MES, reporting, integrations
- end_user_devices: laptops, printers, peripherals, operating system, email client
- identity_access: accounts, passwords, permissions, MFA, joiners and leavers
- it_duty_manager: suspected security incidents, stopped production lines, safety systems
Paths (next_action values):
- ask_for_info: only when the owner cannot be determined or the problem itself is not described; if the owner is clear, route even when some details are missing
- draft_response: a knowledge article provided in the context resolves the request
- route_to_group: a specialist group needs to work on it
- escalate_to_human: P1 signal, or the request is outside policy and a person must refuse it`

const RULES = `Return ONLY one JSON object that conforms to the JSON Schema below. No markdown, no prose.
Use null where the request does not contain the information. Never invent names, systems or numbers.`

const schemaBlock = schema => `JSON Schema:\n${JSON.stringify(schema)}`

export function askAgentMessages(question) {
  return [
    { role: 'system', content: 'You are an IT service desk assistant. Answer concisely.' },
    { role: 'user', content: question }
  ]
}

export function triageMessages(text) {
  return [
    { role: 'system', content: `${CONTEXT}\n\nNo knowledge articles are available in this mode, so kb_article_id must be null.\n${RULES}\n${schemaBlock(TRIAGE_SCHEMA)}` },
    { role: 'user', content: `Incoming request:\n"""\n${text}\n"""` }
  ]
}

export function extractionMessages(text) {
  return [
    { role: 'system', content: `Extract facts from one incoming IT service request. Do not classify it.\n${RULES}\n${schemaBlock(EXTRACTION_SCHEMA)}` },
    { role: 'user', content: `Incoming request:\n"""\n${text}\n"""` }
  ]
}

export function classificationMessages(text, extraction, articles) {
  const kb = articles.length
    ? articles.map(a => `- ${a.ID} (${a.owner}): ${a.title}`).join('\n')
    : '(no matching knowledge articles)'
  return [
    { role: 'system', content: `${CONTEXT}\n\n${RULES}\n${schemaBlock(CLASSIFICATION_SCHEMA)}` },
    { role: 'user', content: `Incoming request:\n"""\n${text}\n"""\n\nExtracted facts:\n${JSON.stringify(extraction)}\n\nCandidate knowledge articles:\n${kb}` }
  ]
}

export function draftMessages(text, extraction, article) {
  return [
    { role: 'system', content: 'You draft replies for the IT Service Desk. Write a short, polite plain-text reply (max 120 words) to the requester, based only on the knowledge article provided. Do not add steps that are not in the article. Do not include a subject line or signature.' },
    { role: 'user', content: `Request:\n"""\n${text}\n"""\nRequester: ${extraction?.requester ?? 'unknown'}\n\nKnowledge article ${article.ID} - ${article.title}:\n${article.resolution}` }
  ]
}
