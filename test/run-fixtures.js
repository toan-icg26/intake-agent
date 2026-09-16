// Replays fixtures/requests.json against a running server (cds watch) and saves every response.
//
//   node test/run-fixtures.js ask               assignment 1: askAgent, free text (latency only)
//   node test/run-fixtures.js triage            assignment 2: one structured call per request
//   node test/run-fixtures.js intake            assignment 3: the state graph
//   options: --only C01,R02   --base http://localhost:4004   --gap 2000   --label v2
//
// Requests are sequential with a minimum gap between starts (the free tier allows ~30 requests/minute).
// HTTP 429 from Groq is handled inside the service using the retry-after header.
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const mode = args[0]
const opt = name => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined }
if (!['ask', 'triage', 'intake'].includes(mode)) {
  console.error('usage: node test/run-fixtures.js <ask|triage|intake> [--only C01,R02] [--base http://localhost:4004] [--gap 2000] [--label v2]')
  process.exit(1)
}
const base = opt('base') ?? 'http://localhost:4004'
const gapMs = Number(opt('gap') ?? 2000)
const only = opt('only')?.split(',')
const label = opt('label')
const endpoint = `${base}/odata/v4/agent/${{ ask: 'askAgent', triage: 'triage', intake: 'runIntake' }[mode]}`

const root = path.resolve(import.meta.dirname, '..')
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/requests.json'), 'utf8'))
  .filter(f => !only || only.includes(f.id))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const runs = []
let lastStart = 0

for (const f of fixtures) {
  await sleep(Math.max(0, lastStart + gapMs - Date.now()))
  lastStart = Date.now()
  let status, body
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mode === 'ask' ? { question: f.text } : { text: f.text }) })
    status = res.status
    const raw = await res.text()
    try { body = JSON.parse(raw) } catch { body = { nonJsonBody: raw } }
  } catch (err) {
    status = 'fetch_failed'
    body = { error: `${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}` }
  }
  const e2eMs = Date.now() - lastStart
  const run = { id: f.id, quality: f.quality, expected: f.expected, status, e2eMs, response: body }
  runs.push(run)
  console.log(line(mode, run))
}

const summary = { ask: summariseAsk, triage: summariseTriage, intake: summariseIntake }[mode](runs)
const outDir = path.join(root, 'test/results')
fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outFile = path.join(outDir, `${[mode, label, stamp].filter(Boolean).join('-')}.json`)
fs.writeFileSync(outFile, JSON.stringify({ mode, label, endpoint, startedFixtures: fixtures.length, finishedAt: new Date().toISOString(), summary, runs }, null, 2))
console.log('\nSUMMARY\n' + JSON.stringify(summary, null, 2))
console.log(`\nSaved ${path.relative(root, outFile)}`)

function line(mode, r) {
  const b = r.response
  if (r.status !== 200) return `${r.id} HTTP ${r.status} ${JSON.stringify(b?.error ?? b).slice(0, 300)}`
  if (mode === 'ask') return `${r.id} answered (${String(b.value).length} chars) e2e=${r.e2eMs}ms`
  if (mode === 'triage') {
    return b.valid
      ? `${r.id} valid   ${b.result.next_action.padEnd(17)} ${b.result.owner.padEnd(22)} ${b.result.urgency} expected=${r.expected.path} model=${b.latencyMs}ms`
      : `${r.id} INVALID stage=${b.stage} errors=${b.errors.join(' | ')}`
  }
  const ok = b.path === r.expected.path ? 'match' : 'DIFF '
  return `${r.id} ${ok} ${b.path.padEnd(17)} ${(b.owner ?? '-').padEnd(22)} expected=${r.expected.path} overrides=${b.overrides.length} invalid=${b.invalidOutputs.length} calls=${b.modelCalls} total=${b.totalMs}ms`
}

function stats(values) {
  const v = values.filter(x => typeof x === 'number').sort((a, b) => a - b)
  if (!v.length) return null
  const pct = p => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]
  return { n: v.length, min: v[0], p50: pct(50), p95: pct(95), max: v[v.length - 1], mean: Math.round(v.reduce((s, x) => s + x, 0) / v.length) }
}

function summariseAsk(runs) {
  const ok = runs.filter(r => r.status === 200)
  return {
    requests: runs.length,
    httpErrors: runs.filter(r => r.status !== 200).map(r => ({ id: r.id, status: r.status, error: r.response?.error ?? r.response })),
    endToEndMs: stats(ok.map(r => r.e2eMs))
  }
}

function summariseTriage(runs) {
  const ok = runs.filter(r => r.status === 200)
  const valid = ok.filter(r => r.response.valid)
  const invalid = ok.filter(r => !r.response.valid)
  return {
    requests: runs.length,
    httpErrors: runs.filter(r => r.status !== 200).map(r => ({ id: r.id, status: r.status, error: r.response?.error ?? r.response })),
    validStructure: valid.length,
    invalidStructure: invalid.map(r => ({ id: r.id, quality: r.quality, stage: r.response.stage, errors: r.response.errors, raw: r.response.raw })),
    validByQuality: Object.fromEntries([...new Set(runs.map(r => r.quality))].map(q => [q, `${valid.filter(r => r.quality === q).length}/${runs.filter(r => r.quality === q).length}`])),
    modelNextActionMatchesExpectedPath: `${valid.filter(r => r.response.result.next_action === r.expected.path).length}/${valid.length}`,
    modelLatencyMs: stats(valid.map(r => r.response.latencyMs)),
    endToEndMs: stats(ok.map(r => r.e2eMs))
  }
}

function summariseIntake(runs) {
  const ok = runs.filter(r => r.status === 200)
  const expectedEscalations = ok.filter(r => r.expected.path === 'escalate_to_human')
  return {
    requests: runs.length,
    httpErrors: runs.filter(r => r.status !== 200).map(r => ({ id: r.id, status: r.status, error: r.response?.error ?? r.response })),
    completedGraph: ok.length,
    pathMatchesExpected: `${ok.filter(r => r.response.path === r.expected.path).length}/${ok.length}`,
    pathMismatches: ok.filter(r => r.response.path !== r.expected.path).map(r => ({ id: r.id, expected: r.expected.path, got: r.response.path, reasons: r.response.reasons })),
    escalationsExpectedButNotMade: expectedEscalations.filter(r => r.response.path !== 'escalate_to_human').map(r => r.id),
    pathCounts: ok.reduce((acc, r) => ({ ...acc, [r.response.path]: (acc[r.response.path] ?? 0) + 1 }), {}),
    codeOverrodeModel: ok.flatMap(r => r.response.overrides.map(o => ({ id: r.id, ...o }))),
    invalidModelOutputs: ok.flatMap(r => r.response.invalidOutputs.map(o => ({ id: r.id, ...o }))),
    modelCalls: ok.reduce((s, r) => s + r.response.modelCalls, 0),
    graphTotalMs: stats(ok.map(r => r.response.totalMs)),
    modelLatencyPerRequestMs: stats(ok.map(r => r.response.modelLatencyMs)),
    endToEndMs: stats(ok.map(r => r.e2eMs))
  }
}
