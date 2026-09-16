// Deterministic policy checks. These run in code and override the model.
// See "Branch conditions" in README.md for the plain-language version of each rule.

export const P1_USER_THRESHOLD = 50

const P1_RULES = [
  { id: 'production_stopped', pattern: /\b(production|assembly|packaging|packing|press|paint|moulding|molding)?\s*line(\s+\d+)?\s+(has\s+|is\s+)?(stopped|halted|down|not running|at a standstill)\b|\bproduction (has )?(stopped|halted)\b/i },
  { id: 'safety_system', pattern: /\b(gas detection|fire alarm|fire panel|sprinkler|emergency stop|e-stop|safety (system|interlock|panel|controller))\b/i },
  { id: 'security_breach', pattern: /\b(ransomware|malware|virus|hacked|compromised|phishing|data breach|security breach)\b|\b(clicked|opened) (a|the|on a) (link|attachment)\b.*\b(password|credentials|log ?in)\b|\bemails? (that )?I (never|did not|didn't) (send|sent|write|wrote)\b/is },
  { id: 'data_loss', pattern: /\b(data loss|lost (all )?(the )?data|files (have been |were )?(deleted|wiped|encrypted)|database (was |has been )?(deleted|corrupted|wiped))\b/i }
]

const USER_COUNT = /\b(?:roughly|about|around|approximately|over|more than|nearly|some)?\s*(\d{2,5})\s+(?:people|users|employees|staff|colleagues|operators|workers)\b/gi

const REFUSAL_RULES = [
  {
    id: 'other_persons_credentials',
    test: text =>
      /\b(his|her|their|[A-Z][a-z]+'s|colleague's|manager's|boss's)\s+(email\s+|network\s+|account\s+|login\s+)?(password|credentials|login details|pin)\b/.test(text) ||
      /\blog ?in as (her|him|them|my (manager|colleague|boss)|[A-Z][a-z]+)\b/i.test(text)
  },
  {
    id: 'access_change_without_approver',
    test: text => {
      const asksForAccess =
        /\b(grant|give|assign)\s+(me|him|her|them|\w+)\s+(\w+\s+){0,2}(access|admin(istrator)? rights|rights|permissions?|role)\b/i.test(text) ||
        /\b(add|be added|added)\s+(me\s+|him\s+|her\s+|them\s+)?to\s+(the\s+)?[\w-]+(\s+[\w-]+)?\s+(group|role|distribution list)\b/i.test(text)
      const namesApprover = /\b(approved by|approver:?|approval from|authori[sz]ed by|signed off by)\s*:?\s*[A-Z][a-z]+/.test(text)
      return asksForAccess && !namesApprover
    }
  }
]

/** Signals that need only the raw text. Runs before the model and cannot be skipped. */
export function textSignals(text) {
  const p1 = P1_RULES.filter(r => r.pattern.test(text)).map(r => r.id)
  const counts = [...text.matchAll(USER_COUNT)].map(m => Number(m[1]))
  const maxUsers = counts.length ? Math.max(...counts) : null
  if (maxUsers !== null && maxUsers > P1_USER_THRESHOLD) p1.push('more_than_50_users')
  const refusals = REFUSAL_RULES.filter(r => r.test(text)).map(r => r.id)
  return { p1, refusals, usersMentioned: maxUsers }
}

/**
 * Full policy evaluation. `extraction` may be null when the model output was invalid;
 * the text-only checks still apply in that case.
 */
export function checkPolicy(text, extraction) {
  const { p1, refusals, usersMentioned } = textSignals(text)
  if (extraction?.users_affected > P1_USER_THRESHOLD && !p1.includes('more_than_50_users')) p1.push('more_than_50_users')

  const incomplete = []
  if (extraction) {
    if (!extraction.requester?.trim()) incomplete.push('requester_not_identifiable')
    if (!extraction.affected_system?.trim()) incomplete.push('affected_system_not_identifiable')
  }
  return { p1, refusals, incomplete, usersMentioned }
}
