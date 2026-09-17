# intake-agent

An intake-to-resolution agent for an IT service desk, built with **SAP CAP (Node.js)** on a **BTP trial** account, with **no SAP AI Core**. The model comes from Groq's free-tier OpenAI-compatible endpoint.

It reads a messy service request, returns structured fields, and chooses one of four paths: **ask for missing info**, **draft a response**, **route to a resolver group**, or **escalate to a human**. P1 escalation and refusal rules are decided in application code, not by the model.

> Status: Track C work items 1–3 (brief, structured output, state graph) were submitted together as the first post and tagged `assignment-1`. Work item 5 (checkpointing: a run survives process death and resumes) is built on top of that.
> Not built yet: approval gate, UI, 50-fixture evaluation.

---

## Who is the customer?

**Lumen Industrial**, a fictional manufacturer (~1,200 employees, three plants, one head office). The users are its internal IT Service Desk: 12 first-line agents, four resolver groups, and an IT duty manager. Full brief: [`discovery-brief.md`](discovery-brief.md).

## What was broken?

Triage is manual. Requests arrive by mailbox, web form and phone notes, and agents assign category, urgency and owner by hand. The brief identifies three failures:
- misrouting (benchmark: up to 30% of manually triaged tickets go to the wrong team first);
- incomplete requests that sit idle;
- P1 escalation that depends on whether the agent on duty spots the signal.

A missed escalation is the most expensive of the three.

## What did you build?

| Work item (Track C sheet) | Deliverable | Where |
|---|---|---|
| 1 — Brief | CAP action `askAgent(question)` that returns a real model answer | `srv/agent-service.cds`, `srv/lib/groq.js` |
| 2 — Replicate | Structured-output schema, validator, and 30 synthetic fixtures | `srv/lib/schema.js`, `fixtures/requests.json`, action `triage` |
| 3 — Build | Explicit state graph, with policy checks in code that override the model | `srv/lib/graph.js`, `srv/lib/policy.js`, action `runIntake`, "Branch conditions" below |
| 4 — SUBMIT | Items 1–3 submitted together as **"Assignment 1"** (repo tagged `assignment-1`; demo video and slide deck submitted separately, not in this repo) | see "How did you evaluate it?" below for the numbers they use |
| 5 — Build | Checkpoint after every graph node, and `resumeIntake(runID)` to continue a run after the process died | `db/schema.cds` (`IntakeRuns`), `srv/lib/graph.js`, `srv/agent-service.js`, "Checkpointing" below |

## How does it work?

```
POST /odata/v4/agent/runIntake { text }

extract ──> lookup_context ──> classify ──> check_policy ──> choose_path ─┬─> ask_for_info
 (model)     (keyword match      (model)        (code)          (code)     ├─> draft_response (model writes the reply)
             on SQLite KB)                                                 ├─> route_to_group
                                                                           └─> escalate_to_human
```

- **Schema first.** `EXTRACTION_SCHEMA` and `CLASSIFICATION_SCHEMA` are defined in `srv/lib/schema.js`, and the prompts in `srv/lib/prompts.js` embed them. The model runs in JSON mode (`response_format: json_object`). Every response is validated in code by a small hand-written validator. No library is needed for this subset of JSON Schema.
- **Invalid output is expected.** Invalid output can fail in three places: Groq rejecting the JSON (`json_validate_failed`), `JSON.parse` failing, or schema validation failing. Every case is logged with the raw output and returned in the response. Each model node gets one retry that includes the validation errors. If the output is still invalid, the request goes to a human.
- **Policy in code.** `srv/lib/policy.js` checks the raw text for P1 signals (production stopped, safety system, security breach, data loss, >50 users) and refusal cases (another person's credentials; access change with no named approver). `choose_path` applies these before it looks at the model's proposal, and records every override as `{ rule, modelSaid, codeDecided }`.
- **No framework.** The graph is a `while` loop over a `NODES` object. The flow is fixed, with one branching point, so a graph library would add dependencies without adding capability yet. See "Branch conditions" below.
- **Rate limits.** `srv/lib/groq.js` retries only on HTTP 429, waiting exactly the `retry-after` seconds, up to 3 times.
- **Checkpoints.** After every node, the whole graph state and the next node are written to the `IntakeRuns` table in `db.sqlite`. `POST resumeIntake { runID }` continues a run from there. See "Checkpointing" below.

## Branch conditions (assignment 3)

`choose_path` in `srv/lib/graph.js` applies these rules top to bottom; the first match wins. Every time the code's decision differs from the model's proposed `next_action`, the response records an override: `{ rule, modelSaid, codeDecided }`.

1. **A P1 signal is in the text → escalate to a human.** Checked in code (`srv/lib/policy.js`) against the raw text, before the model's opinion is consulted: production line stopped, a safety system affected, a suspected security breach, data loss, or more than 50 users affected.
2. **A refusal rule matches → escalate to a human.** Asking for another person's credentials, or for an access/role change with no named approver.
3. **Model output is still invalid after one retry → escalate to a human**, to triage by hand. Trade-off: a false escalation costs minutes; routing on garbage costs more.
4. **Requester or affected system can't be identified → ask for information.** Checked on the extracted fields, independent of what the model proposed.
5. **Model asked for escalation → escalate.** Accepted without a code signal, because a false escalation is cheaper than a missed one.
6. **Model asked for more information → ask for information.**
7. **Model proposed a drafted response → draft it, but only if the cited article was one of the candidates returned by `lookup_context`.** Otherwise, route to the group the model named.
8. **Otherwise → route to the resolver group the model chose.**

**Why plain code and not a graph framework:** the flow is fixed — five nodes in a line, one branching point, no loops except one bounded retry. A `while` loop over a `NODES` object is about 30 lines. A framework such as LangGraph would buy checkpointing/resume, a graph visualiser (the list above does the job for five nodes), and a dependency tree to pin and audit. When this was written (assignment 3) the honest answer was "not much", so there is no framework. Assignment 5 then added checkpointing by hand, and the cost is recorded below.

**Known limits of the rules**, found while testing: the P1 and refusal regular expressions were written while looking at the same 30 fixtures they are tested against, so passing all 30 proves nothing about unseen wording (see assignment 11). The completeness rule requires an "affected system", which is too strict for a service request like a joiner setup (fixture C04).

## Checkpointing (assignment 5)

**Where checkpoints are stored.** In the CAP entity `intake.IntakeRuns` (`db/schema.cds`), in the SQLite file `db.sqlite` in the project root (`cds.requires.db` in `package.json`; the file is gitignored). There is one row per run:

| Column | Content |
|---|---|
| `ID` | run ID, returned as `runID` by `runIntake` and `resumeIntake` |
| `status` | `running`, `completed` or `failed` |
| `nextNode` | the node to execute on resume; `__end__` once completed |
| `state` | JSON snapshot of the whole graph state: extraction, candidate articles, classification, policy hits, decision, output, invalid outputs, trace, model counters |
| `error` | verbatim error text of the last failure, cleared by the next checkpoint |
| `createdAt`, `modifiedAt` | from CAP's `managed` aspect |

The table is exposed read-only as `GET /odata/v4/agent/IntakeRuns`.

**When a checkpoint is written.** `runGraph` in `srv/lib/graph.js` awaits `saveCheckpoint(state, nextNode)` after every node, before the next node starts. The checkpoint that points to `__end__` also sets `status = completed`, in the same `UPDATE`. A node is therefore either fully in the saved state or runs again on resume. `graph.js` does not import CAP: the handler in `srv/agent-service.js` passes `saveCheckpoint` in.

**How resume works.** `POST /odata/v4/agent/resumeIntake { runID }` loads the row. A `completed` run returns the stored result without calling the model. A `running` or `failed` run continues from `nextNode` with the stored state. If at least one node had finished, the trace gets a `resume` entry that says where it resumed and how many earlier nodes were not re-run. A run that failed in its first node simply starts again at `extract`. Nothing resumes automatically at startup. To find interrupted runs, query `IntakeRuns?$filter=status eq 'running'`.

**Two CAP details that make this work**, checked in the installed `@sap/cds` 10.1.0 and `@cap-js/sqlite` 3.1.0:
- **Each checkpoint is its own transaction.** In a CAP action handler, queries run in the request's transaction, which commits only when the request ends. A process that dies mid-run would roll back every checkpoint. The handler uses `cds.tx(tx => ...)` for every write instead. This always opens a new root transaction and commits when the function resolves (`node_modules/@sap/cds/lib/srv/srv-tx.js`, "Usage variant 2").
- **The SQLite pool has one connection** (`pool.max: 1` in `@cap-js/sqlite`'s defaults). If the request's transaction held that connection (for example by reading `KnowledgeArticles` with a plain `SELECT`), the first checkpoint would wait for it forever. So `lookup_context` also reads through its own short `cds.tx`.

**Evidence.** [`test/results/kill-resume-2026-09-17T07-34-10Z.log`](test/results/kill-resume-2026-09-17T07-34-10Z.log) is a `script` terminal capture of the whole cycle. It was recorded on the uncommitted changes of this work item on top of `fdd491e`, as the capture's own `git status` shows. Changes made after the recording:
- two code comments shortened;
- a 400 response added for a missing `runID`;
- the SQLite WAL files added to `.gitignore`;
- this README written.

Replay it with `scriptreplay --log-timing test/results/kill-resume-2026-09-17T07-34-10Z.timing --log-out test/results/kill-resume-2026-09-17T07-34-10Z.log`. In that run:

- Fixture D01 started. The server was killed with `kill -9` as soon as the checkpoint `next=classify` appeared in its log (polled every 50 ms), before `classify` returned.
- The client got `curl: (52) Empty reply from server`.
- After a restart (new PID), the run was still `running` with `nextNode: classify`.
- `resumeIntake` ran only `classify` and `draft_response`. The server log after the restart has no `extract` call. The run ended `completed` on path `draft_response`, with `modelCalls: 3` in total (1 before the kill, 2 after).

Also tested while building (not recorded):
- A run started with a model name that does not exist was stored as `failed`, with `nextNode: extract` and the verbatim `model_not_found` error. `resumeIntake` with the correct model completed it.
- Calling `resumeIntake` on a completed run returned the stored result without a model call.
- An unknown `runID` returns 404, and a missing `runID` returns 400.
- **Regression.** A full 30-fixture replay after the change (`test/results/intake-a5-regression-2026-09-17T09-51-39-736Z.json`) ran on a clean copy of the repo, set up only with the steps in this README. It completed 30/30 with no HTTP errors and 0 missed escalations, and every row in `IntakeRuns` ended `completed`. Its path mismatches (C04, A01, A03, A04) are exactly those of the last run before the change.
- Under `cds watch`, the checkpoint writes to `db.sqlite` did not trigger a restart.
- After `kill -9`, SQLite leaves `db.sqlite-wal` and `db.sqlite-shm` next to the database. The data committed before the kill is in the WAL file and is read back on the next start. Both files are gitignored.

**Cost of doing it by hand.** The code change for this work item was 95 inserted and 28 deleted lines across 5 files (`git diff --stat -- db package.json srv`), 59 of the added lines in `graph.js` and `agent-service.js`. LangGraph's checkpointer would have replaced part of that, but the graph would have had to be rewritten into its API, and the checkpoints would live outside CAP's database and OData service.

**Known limits**
- The node that was running when the process died runs again on resume, including its model call. The tokens of the interrupted call are lost.
- Nothing stops two `resumeIntake` calls for the same run at the same time, or a resume while the original request is still running. Both would execute the remaining nodes.
- `cds deploy` drops and recreates the SQLite tables, so **it deletes all stored runs**. Seen while building: after `cds deploy`, `IntakeRuns` was empty.
- `totalMs` covers only the last process that worked on the run. `modelCalls` and `modelLatencyMs` add up across resumes because they are part of the stored state.
- Stored state is not versioned. A checkpoint written by an older version of `graph.js` may not resume correctly after the state shape changes.

## How did you evaluate it?

Every number below is measured, not estimated, and comes from a run saved under `test/results/` (each file name carries a timestamp and, where relevant, a `--label`).

| Measurement (model `openai/gpt-oss-120b`, 30 fixtures) | Result |
|---|---|
| `askAgent` end-to-end latency, 5 calls | p50 1841 ms, max 1901 ms |
| Single-call triage: valid structure | 30 / 30 |
| Single-call triage: P1 fixtures the **model** escalated | **0 / 4** |
| State graph: completed end to end | 30 / 30 in each of 4 runs |
| State graph: path equals the human label | **26–28 / 30** across 4 runs (28, 27, 26, 26) |
| State graph: expected escalations not made | **0** in each of 4 runs |
| State graph: times code overrode the model | 6–8 per run |
| State graph: invalid model outputs | 0–1 per run (the one case was repaired by the retry) |
| State graph: model latency per request | p50 2235 ms, p95 3651 ms (15 Sep run) |
| State graph: total per request in a batch run | p50 6729 ms, p95 13069 ms (15 Sep run; includes 124 s of `retry-after` waits across 40 HTTP 429s) |
| Same graph with `allam-2-7b` (a model that breaks the schema) | 55 invalid outputs, 18 fallback escalations, 0 missed escalations |

The four graph runs, in order: `intake-final-2026-09-15T07-42-29-984Z.json`, `intake-demo-2026-09-16T08-12-47-944Z.json`, `intake-demo-2026-09-16T08-47-56-498Z.json`, and `intake-a5-regression-2026-09-17T09-51-39-736Z.json` (after the checkpointing change, on a clean copy of the repo set up from this README). The requests go out with `temperature: 0`, but the model's answers are not the same from run to run on C04, A01, A03 and A04, so the match count moves between 26 and 28. The P1 and refusal fixtures escalated in every run, because those decisions are made in code.

**What did not work**
- **C04** (a joiner request with a named approver) is sent back for information in 3 of the 4 runs: the code completeness rule requires an affected system, and a new starter has none.
- **A01** (ambiguous "Connection refused" from home): the model asks for more information instead of routing. This happened in all 4 runs.
- **A03 and A04** (ambiguous): sent back for information instead of routed in 3 of the 4 runs.
- The P1 and refusal regular expressions were written against the same 30 fixtures they pass. That proves nothing about unseen wording.
- Batch runs spend most of their time waiting on the free tier's 8,000 tokens/minute limit.
- **Setup:** the originally planned model `llama-3.3-70b-versatile` returned `The model \`llama-3.3-70b-versatile\` does not exist or you do not have access to it.` for this account.

**Not measured yet:** routing accuracy on unseen requests, false-escalation rate on a larger set, token cost per request (token counts are logged per call but not aggregated).

## What would you change before production?

- Replace the regex policy rules with rules reviewed by the service desk, and test them on requests they were not written against.
- Make the completeness rule depend on category, so a service request needs no "affected system".
- Put a human approval gate before any routing or escalation leaves the system (assignment 8).
- Store checkpoints in a server database with schema migrations instead of `cds deploy`, lock a run while it executes so it cannot be resumed twice, and version the stored state.
- Use a model endpoint with an SLA and limits sized for 800 requests/week, instead of a free tier.
- Add authentication. The service currently runs with CAP's mocked auth for local development.

---

## Run it yourself

### Prerequisites
- A BTP trial account with Business Application Studio, and a **Full Stack Cloud Application** dev space. Any machine with Node.js 20+ and `@sap/cds-dk` also works.
- A free Groq API key from <https://console.groq.com/keys>. No credit card is needed.

Tested with: Node.js 24.17.0, `@sap/cds-dk` 10.0.7 (global), `@sap/cds` 10.1.0, `@cap-js/sqlite` 3.1.0.

### Steps

```bash
git clone https://github.com/toan-icg26/intake-agent.git intake-agent
cd intake-agent
npm ci                         # exact versions from package-lock.json
cp .env.example .env           # then put your key after GROQ_API_KEY=
cds deploy                     # creates db.sqlite with the tables and the knowledge articles
```

> Run `cds deploy` again after pulling a change to `db/` or to the service definitions. Without it, requests fail with errors such as `no such table: AgentService_IntakeRuns`. Redeploying **deletes all stored runs**.

Check that the endpoint and model work **before** starting the server:

```bash
set -a; . ./.env; set +a
curl -s https://api.groq.com/openai/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $GROQ_API_KEY" \
  -d "{\"model\":\"$GROQ_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}]}"
```

If you get `model_not_found`, list the models your key can use with `curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"` and set `GROQ_MODEL` in `.env`. Any OpenAI-compatible endpoint works: change `GROQ_BASE_URL`, `GROQ_MODEL` and the key. `GROQ_REASONING_EFFORT` only applies to reasoning models; leave it empty for others.

Start the server. CAP loads `.env` automatically in the development profile:

```bash
cds watch          # or: npm start
```

In a second terminal:

```bash
# assignment 1
curl -s -X POST http://localhost:4004/odata/v4/agent/askAgent \
  -H "Content-Type: application/json" \
  -d '{"question": "My VPN disconnects every ten minutes. What should I check?"}'

# assignment 2 - structured fields from one call
curl -s -X POST http://localhost:4004/odata/v4/agent/triage \
  -H "Content-Type: application/json" \
  -d '{"text": "Caller: Jorge Alvarez, shift lead Plant 2. Packaging line 3 has stopped. The MES stations on the line show Server not responding."}'

# assignment 3 - the state graph (compare "path" and "overrides" with the triage result above)
curl -s -X POST http://localhost:4004/odata/v4/agent/runIntake \
  -H "Content-Type: application/json" \
  -d '{"text": "Caller: Jorge Alvarez, shift lead Plant 2. Packaging line 3 has stopped. The MES stations on the line show Server not responding."}'
```

Kill a run and resume it (assignment 5). A whole run takes only a few seconds, too fast to kill by hand, so the server is killed from the shell as soon as its log shows the checkpoint before `classify`. Stop any `cds watch` on port 4004 first, then run this in one terminal. The server is started through `node_modules/.bin/cds-serve`, not `npm start`, so that `$!` is the server's own PID and not npm's.

```bash
node_modules/.bin/cds-serve > /tmp/intake-server.log 2>&1 & SERVER_PID=$!
sleep 5                                           # wait for "server listening"

curl -sS -X POST http://localhost:4004/odata/v4/agent/runIntake \
  -H "Content-Type: application/json" \
  -d '{"text": "Name: Oliver Grant\nLocation: Plant 1\nAffected system: Windows login\nDescription: Back from holiday and I forgot my password. After a few tries it says the account is locked."}' &

until grep -q "next=classify" /tmp/intake-server.log; do sleep 0.05; done; kill -9 $SERVER_PID
# curl prints: curl: (52) Empty reply from server

node_modules/.bin/cds-serve > /tmp/intake-server.log 2>&1 & SERVER_PID=$!
sleep 5
curl -sS "http://localhost:4004/odata/v4/agent/IntakeRuns?\$filter=status%20eq%20%27running%27&\$select=ID,status,nextNode"
curl -sS -X POST http://localhost:4004/odata/v4/agent/resumeIntake \
  -H "Content-Type: application/json" -d '{"runID": "<ID from the previous command>"}'
kill $SERVER_PID
```

The trace in the response contains a `resume` entry, and the nodes before it are not executed again. `grep "\[model\]" /tmp/intake-server.log` shows that only `classify` and `draft_response` called the model after the restart.

Replay all 30 fixtures. A new timestamped file is written to `test/results/`.

```bash
npm run fixtures:triage -- --label mine
npm run fixtures:intake -- --label mine
npm run fixtures:intake -- --only P01,R02      # a subset
```

> Do not save files in the project while a fixture run is going against `cds watch`. The watcher restarts the server, and the in-flight request fails with `fetch failed (UND_ERR_SOCKET)`. Use `npm start` for long runs.
>
> A 30-fixture graph run makes ~66 model calls and takes about 3–4 minutes on the free tier because of 429 waits.

To reproduce the invalid-structure experiment, start a second server with a different model. The environment variable takes precedence over `.env`:

```bash
GROQ_MODEL=allam-2-7b GROQ_REASONING_EFFORT= cds serve --port 4005
npm run fixtures:triage -- --base http://localhost:4005 --label experiment
```

## Repository layout

```
db/schema.cds, db/data/          knowledge articles (synthetic) and IntakeRuns checkpoints, in db.sqlite
srv/agent-service.cds|js         CAP service: askAgent, triage, runIntake, resumeIntake, IntakeRuns
srv/lib/groq.js                  model client, 429 handling, latency logging
srv/lib/schema.js                output schemas + validator
srv/lib/prompts.js               prompts generated from the schemas
srv/lib/structured.js            JSON call + validation + raw-output logging
srv/lib/policy.js                deterministic P1 / refusal / completeness checks
srv/lib/graph.js                 the state graph and branch decision
fixtures/requests.json           30 synthetic requests with human labels
test/run-fixtures.js             replays fixtures against the running server
test/results/                    every run behind the numbers in this README, and the kill-and-resume capture
```

## Data and systems

All requests, names, the company and the knowledge articles are **synthetic**, invented for this project. No real organisation, person or system is represented. The agent writes to no external system.

## Sources

- Rajeev Goswami, *Build Your AI Agent prototype for free using SAP CAP, LangChain and Ollama* (SAP Community, 29 Aug 2026). This was the starting point for the "CAP action calls a model you run yourself" setup. This repo uses Groq instead of Ollama and plain `fetch` instead of LangChain.
- SAP Tutorials, *Get an Account on SAP BTP Trial*.
- The programme plan also links Johannes Vogt, *Building an LLM Agent using CAP*; Wouter Lemaire, *Agentic AI on BTP: a Single Agent with LangGraph*; and Naveen Panakkal, *Tame Your Agents: 10 Design Patterns for Reliable Agentic AI*. The code here does not use LangGraph; see "Branch conditions" above for why.
