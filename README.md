# intake-agent

An intake-to-resolution agent for an IT service desk, built with **SAP CAP (Node.js)** on a **BTP trial** account, with **no SAP AI Core**. The model comes from Groq's free-tier OpenAI-compatible endpoint.

It reads a messy service request, returns structured fields, and chooses one of four paths: **ask for missing info**, **draft a response**, **route to a resolver group**, or **escalate to a human**. P1 escalation and refusal rules are decided in application code, not by the model.

> Status: work items 1–3 were submitted as the first post (tag `assignment-1`), work item 5 (checkpointing) as the second (tag `assignment-2`). On top of those: `SETUP.md` (work item 7) and the human approval gate (work item 8).
> Item 9 (the `/ui/` console) was submitted as "Assignment 4" (tag `assignment-4`). Work item 11 then replayed 50 fixtures — 30 original plus 20 written in wording the policy rules had never seen — and found the first real gap in the "0 missed escalations" hard gate; see "50-fixture evaluation" below.
> Not built yet: the final packaging (assignment 12) and the retrospective (assignment 13).

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
| 7 — Gate | `SETUP.md`: a first-time setup a stranger can follow, with expected output per step | [`SETUP.md`](SETUP.md), `test/setup-runs/` |
| 8 — Build | Human approval gate: pause, edit, approve, resume, with an audit trail and an `Outbox` | `db/schema.cds` (`Outbox`, `ApprovalEvents`), `srv/agent-service.js`, "Approval gate" below |
| 9 — Build | A console a non-technical person can drive: node path, structured fields, and the approval gate on screen | `app/ui/`, "The console" below |
| 10 — SUBMIT | Item 9 submitted as **"Assignment 4"** (repo tagged `assignment-4`) | — |
| 11 — Build | 50 fixtures (30 original + 20 new, written in unseen wording on purpose), 5 metrics, failures grouped by category with a root cause each | `fixtures/requests.json` (`N01`–`N20`), "50-fixture evaluation" below |

## How does it work?

```
POST /odata/v4/agent/runIntake { text }

extract ──> lookup_context ──> classify ──> check_policy ──> choose_path ─┬─> ask_for_info      ─┐
 (model)     (keyword match      (model)        (code)          (code)     ├─> draft_response    ─┤
             on SQLite KB)                                                 ├─> route_to_group    ─┼─> approval_gate ──> post
                                                                           └─> escalate_to_human ─┘   (a person)      (Outbox)
```

- **Schema first.** `EXTRACTION_SCHEMA` and `CLASSIFICATION_SCHEMA` are defined in `srv/lib/schema.js`, and the prompts in `srv/lib/prompts.js` embed them. The model runs in JSON mode (`response_format: json_object`). Every response is validated in code by a small hand-written validator. No library is needed for this subset of JSON Schema.
- **Invalid output is expected.** Invalid output can fail in three places: Groq rejecting the JSON (`json_validate_failed`), `JSON.parse` failing, or schema validation failing. Every case is logged with the raw output and returned in the response. Each model node gets one retry that includes the validation errors. If the output is still invalid, the request goes to a human.
- **Policy in code.** `srv/lib/policy.js` checks the raw text for P1 signals (production stopped, safety system, security breach, data loss, >50 users) and refusal cases (another person's credentials; access change with no named approver). `choose_path` applies these before it looks at the model's proposal, and records every override as `{ rule, modelSaid, codeDecided }`.
- **No framework.** The graph is a `while` loop over a `NODES` object. The flow is fixed, with one branching point, so a graph library would add dependencies without adding capability yet. See "Branch conditions" below.
- **Rate limits.** `srv/lib/groq.js` retries only on HTTP 429, waiting exactly the `retry-after` seconds, up to 3 times.
- **Checkpoints.** After every node, the whole graph state and the next node are written to the `IntakeRuns` table in `db.sqlite`. `POST resumeIntake { runID }` continues a run from there. See "Checkpointing" below.
- **Nothing leaves without a person.** A proposed action waits at an approval gate until someone with the `approver` role releases it. Releasing writes a row to `Outbox`; the agent sends nothing anywhere. See "Approval gate" below.

## Branch conditions (assignment 3)

`choose_path` in `srv/lib/graph.js` applies these rules top to bottom; the first match wins. Every time the code's decision differs from the model's proposed `next_action`, the response records an override: `{ rule, modelSaid, codeDecided }`.

1. **A P1 signal is in the text → escalate to a human.** Checked in code (`srv/lib/policy.js`) against the raw text, before the model's opinion is consulted: production line stopped, a safety system affected, a suspected security breach, data loss, or more than 50 users affected.
2. **A refusal rule matches → escalate to a human.** Asking for another person's credentials, or for an access/role change with no named approver.
3. **Model output is still invalid after one retry → escalate to a human**, to triage by hand. Trade-off: a false escalation costs minutes; routing on garbage costs more.
4. **The model explicitly proposed `escalate_to_human` → escalate.** Checked *before* completeness on purpose (assignment 11, fixture N14): a model that already recognised the request as urgent should not be overruled just because one field came back empty.
5. **Requester or affected system can't be identified → ask for information.** Checked on the extracted fields, independent of what the model proposed.
6. **The model's `owner` defaulted to `it_duty_manager`, with no explicit escalation → escalate.** This is the model's catch-all when it cannot tell which resolver group fits, and it is checked *after* completeness on purpose (assignment 11): a genuinely vague request should be asked for more information first, not escalated on an empty owner guess.
7. **Model asked for more information → ask for information.**
8. **Model proposed a drafted response → draft it, but only if the cited article was one of the candidates returned by `lookup_context`.** Otherwise, route to the group the model named.
9. **Otherwise → route to the resolver group the model chose.**

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
- **Regression.** A full 30-fixture replay after the change (`test/results/intake-a5-regression-2026-09-17T09-51-39-736Z.json`) ran on a clean copy of the repo, set up only with the written setup steps (in this README at the time, now in SETUP.md). It completed 30/30 with no HTTP errors and 0 missed escalations, and every row in `IntakeRuns` ended `completed`. Its path mismatches (C04, A01, A03, A04) are exactly those of the last run before the change.
- Under `cds watch`, the checkpoint writes to `db.sqlite` did not trigger a restart.
- After `kill -9`, SQLite leaves `db.sqlite-wal` and `db.sqlite-shm` next to the database. The data committed before the kill is in the WAL file and is read back on the next start. Both files are gitignored.

**Cost of doing it by hand.** The code change for this work item was 95 inserted and 28 deleted lines across 5 files (`git diff --stat -- db package.json srv`), 59 of the added lines in `graph.js` and `agent-service.js`. LangGraph's checkpointer would have replaced part of that, but the graph would have had to be rewritten into its API, and the checkpoints would live outside CAP's database and OData service.

**Known limits**
- The node that was running when the process died runs again on resume, including its model call. The tokens of the interrupted call are lost.
- Nothing stops two `resumeIntake` calls for the same run at the same time, or a resume while the original request is still running. Both would execute the remaining nodes.
- `cds deploy` drops and recreates the SQLite tables, so **it deletes all stored runs**. Seen while building: after `cds deploy`, `IntakeRuns` was empty.
- `totalMs` covers only the last process that worked on the run. `modelCalls` and `modelLatencyMs` add up across resumes because they are part of the stored state.
- Stored state is not versioned. A checkpoint written by an older version of `graph.js` may not resume correctly after the state shape changes.

## Approval gate (assignment 8)

Modelled on **park and post**: the agent parks a proposal, a person releases it. The agent itself performs only the reversible step.

```
choose_path ──> one of the four path nodes ──> approval_gate ──(a person approves)──> post ──> Outbox
                                                    │
     code-decided escalation (P1 / refusal / invalid output) ─────────────────────────────┘  (no gate)
```

**What a person can do**, all four required by the assignment, all restricted to the `approver` role:

| Action | From → to | Notes |
|---|---|---|
| *(the gate itself)* | `running` → `awaiting_approval` | The graph pauses and checkpoints; nothing is sent |
| `editProposal(runID, path?, owner?, message?, reason?)` | stays parked | Changing a path that a **code rule** decided requires a `reason`, otherwise 400 |
| `pauseRun(runID, reason?)` | `awaiting_approval` → `on_hold` | Takes it out of the queue while the approver checks something |
| `resumeRun(runID)` | `on_hold` → `awaiting_approval` | Back into the queue |
| `approveRun(runID)` | `awaiting_approval` → `completed` | Continues the graph from the checkpoint and posts |

The queue is `GET /odata/v4/agent/IntakeRuns?$filter=status eq 'awaiting_approval'`. Released actions are in `Outbox`, and every human action is in `ApprovalEvents` (`parked`, `edited`, `paused`, `resumed`, `approved`, `posted`, each with the actor and any reason).

**Which paths wait.** Everything the model proposes waits: ask, draft, route, and an escalation the model asked for. An escalation that **code** decided (a P1 signal, a refusal rule, or invalid model output) posts immediately with `postedBy: code`. The brief requires the duty manager to hear about a P1 immediately, so parking those would rebuild the "slow escalation" failure this project exists to fix.

**In-flight state while it waits.** The parked run is an ordinary checkpoint row: `status = awaiting_approval`, `nextNode = post`, plus the full `state` JSON and a readable `proposal`. Tested: park a run, stop the server, start it again, approve — the run finishes from the same state (`extract` … `approval_gate`, `resume`, `post`).

**Why the human can override code.** An approver may turn a code decision into something else, but only with a reason, which is stored in `ApprovalEvents`. Code overriding the model is recorded the same way. Refusing the override outright would leave no way to correct a regex that matched the wrong request.

**Guards** (each transition is `UPDATE … WHERE status = <expected>`, so two approvers cannot both release one run):
- approving twice returns the stored result and posts once;
- editing or approving after the post → 409;
- approving while `on_hold` → 409;
- `resumeIntake` on a parked run → 409, because a crash-resume must not skip the gate;
- editing without the `approver` role → 403.

**Evidence.** [`test/results/approval-gate-2026-09-24T07-02-48Z.log`](test/results/approval-gate-2026-09-24T07-02-48Z.log) is a `script` capture of one run going through all four operations: parked → edited → paused → (approve refused, 409) → resumed → **server killed with `kill -9` while parked** → restarted → approved → posted. It ends with the `Outbox` row, the audit trail, a second approval that does not post twice (`outboxRows: 1`), and a P1 that code posted with no gate. Replay it with `scriptreplay --log-timing test/results/approval-gate-2026-09-24T07-02-48Z.timing --log-out test/results/approval-gate-2026-09-24T07-02-48Z.log`.

**Regression with the gate in place** (`test/results/intake-a8-gate-2026-09-24T07-02-23-696Z.json`): all 30 fixtures completed, 0 HTTP errors, **0 missed escalations**, 26/30 paths matched, code overrode the model 8 times. The 8 escalations decided by code posted immediately; the other 22 runs were left waiting for an approver.

**Known limits**
- Authentication is CAP's **mocked** auth (users `lead` with role `approver`, and `agent` without it). That is a development stand-in, not production authentication.
- "Posting" writes to `Outbox` only. No mail, no ticketing system: the brief puts both out of scope.
- There is no reject-and-close action yet; an approver edits and approves, or leaves the run parked.
- Nothing expires a parked run, and nothing reminds anyone about it.

## The console (assignment 9)

`app/ui/` is a single page served by CAP at **<http://localhost:4004/ui/>**. A first-line agent pastes a request, watches the graph run, and clears the approval gate without touching a terminal.

**Stack:** OpenUI5 **1.148.0** (LTS), loaded from `sdk.openui5.org` with the version pinned in `app/ui/index.html`. No build step, no `Component.js`, no manifest, and nothing added to `package.json`: one HTML file and one JS file that create `sap.m` controls and call the same OData service as `curl`. The trade-off is that the page needs to reach the CDN; everything else runs locally.

**What it shows**
- **Node by node, while it runs.** The page polls `IntakeRuns` every 500 ms and paints each node as its checkpoint lands, then replaces that with the real trace and the note each node wrote. The checkpoint table from assignment 5 is what makes this possible without any server change.
- **What the agent read** from the request: requester, affected system, urgency, category, the model's confidence.
- **Where code overruled the model**: the rule, what the model said, what code decided.
- **The approval gate**: the queue of parked runs, the proposed message (editable), and Hold / Back to queue / Approve & release. The header has a user switcher — `lead` may approve, `agent` may not — so the 403 is visible on screen instead of being described.
- **What was released** (Outbox) and **who did what** (the audit trail).

**What it deliberately hides:** the prompts, the raw model JSON, the state blob, token counts and latency numbers. Those matter when debugging, not when deciding whether to send a reply to Oliver. The one exception is the override panel: the moment code disagrees with the model is exactly the moment a human should see.

## 50-fixture evaluation (assignment 11)

The original 30 fixtures were replayed many times, but the regex policy rules and the prompts were written while looking at those same 30 — passing them proves nothing about wording nobody has seen yet. This section adds 20 new fixtures (`N01`–`N20` in `fixtures/requests.json`) written in different styles on purpose: informal phrasing for refusals, an equipment name instead of the word "line" for a stopped production line, "65 agents" instead of "65 users", files that "disappeared" instead of being "deleted". Six of them were written to probe a specific regex boundary I could name in advance (checked against `srv/lib/policy.js` with `textSignals()` before spending any model calls); the rest are ordinary new scenarios, including 3 that finally exercise the three knowledge articles (KB-005, KB-006, KB-008) the original 30 never touched.

**This section went through three live runs, and the table below is the third.** The first run found a real bug (N14, below) in `srv/lib/graph.js`. The first attempt to fix it caused a regression, caught by re-running all 50 rather than just the one fixture. The numbers here are from the run after the corrected fix, kept as [`test/results/intake-a11-50fixtures-final-2026-09-30T10-03-16-014Z.json`](test/results/intake-a11-50fixtures-final-2026-09-30T10-03-16-014Z.json), model `openai/gpt-oss-120b`, 30 Sep 2026. The two earlier runs are also kept, for the record: [`...-2026-09-30T09-42-40-150Z.json`](test/results/intake-a11-50fixtures-2026-09-30T09-42-40-150Z.json) (before the fix) and [`...fixed-2026-09-30T09-56-40-810Z.json`](test/results/intake-a11-50fixtures-fixed-2026-09-30T09-56-40-810Z.json) (the regression). Reproduce the current numbers with `npm run fixtures:intake -- --label your-label` after `cds deploy`.

| Metric | Result |
|---|---|
| Requests completed | 50 / 50, 0 HTTP errors |
| **Routing accuracy** (path matches the human label) | **39 / 50 = 78.0%** |
| **False escalations** (escalated, should not have) | **1** — N16 |
| **Missed escalations** (should have escalated, did not) | **2** — N15, N17 |
| **Tool-call success rate**¹ (structured output valid on first or second attempt) | **108 / 108 = 100%**, 0 invalid |
| **Needs human intervention** (parked at the approval gate) | **39 / 50 = 78%** (11 of 50 were escalations decided by code, which post immediately with no gate) |

¹ This project has no separate "tool calls" — every model turn is one JSON-mode completion checked against a schema (`srv/lib/structured.js`). I am reading "tool-call success rate" as that check: did the model return valid structured output. It did, on every one of the 108 calls in this run.

**The hard gate still broke.** Every replay of the original 30 fixtures had 0 missed escalations. On unseen wording, 2 still do not escalate, even after the fix below. See N15/N17.

### The bug this run found, and fixing it without breaking something else

**N14** ("Priya is out sick... what's the fastest way to get in as her for ten minutes?") is a real attempt to get someone else's access. The model's own `classification` got it right: `next_action: "escalate_to_human"`, confidence 0.95, `policy_basis: "User requests temporary access to another employee's account, which is a policy violation and requires human handling"`. But `extraction.affected_system` came back `null` — there genuinely isn't a "system" to name for an account-impersonation request — and in `decide()` the completeness check used to run *before* the rule that accepts a model-proposed escalation. The correct judgment the model already made was discarded, and the request was returned for more information instead.

The first fix moved the whole escalation check (`next_action === 'escalate_to_human' || owner === 'it_duty_manager'`) ahead of completeness. Re-running all 50 fixtures — not just N14 — showed why that condition existed as two parts: **N14 fixed, but `missing_info` dropped from 8/8 to 4/8.** M01, M03, M04 and N08 are all genuinely vague requests ("it's broken again, please fix asap!!!", a caller who hung up with no details). The model correctly proposed `ask_for_info` for every one of them — but it also defaults `owner` to `it_duty_manager` as a catch-all when it cannot tell which resolver group fits, and that owner-only signal was now firing before completeness got a chance to ask for more information, turning four vague requests into false escalations.

The final fix in `srv/lib/graph.js` splits the two: an **explicit** `next_action: "escalate_to_human"` is now accepted before completeness (this is what N14 needed); `owner === 'it_duty_manager'` on its own is still checked *after* completeness, exactly where it was before (this is what M01/M03/M04/N08 needed). Both are now true again: N14 escalates, and the vague requests still ask for information first.

### Failures, by category, with a root cause

| Category | Match | Notes |
|---|---|---|
| `missing_info` | 8 / 8 | No failures. |
| `p1` | 7 / 8 | **N17 missed.** |
| `clear` | 18 / 20 | C04 (known, see "Branch conditions") + N04. |
| `refuse` | 5 / 7 | **N15 missed; N16 false escalation.** |
| `ambiguous` | 1 / 7 | A01, A03, A04, N11, N12, N13 all asked for more information instead of routing. |

**`ambiguous` (1/7) — root cause: the model defaults to asking for information rather than picking between two plausible teams.** All six misses give the identical reason, verbatim: `model_judgement: model needs more information`. This is not random noise — it is a consistent preference, and the same reason shows up on **N04**, a `clear` fixture (a broken headset), which should not have been ambiguous at all. Asking is a safe failure (no reply goes out, no team gets an idle ticket), but it does mean routing accuracy on ambiguous input is currently close to a coin flip in the wrong direction.

**`refuse` (5/7) — root cause: `access_change_without_approver` is narrow, and the model does not reliably back it up.** The rule allows at most two filler words between "give me" and "access"; **N15** ("give me the same ERP access as my supervisor") has three and slips through the regex. In this run the model's own classification for N15 was `route to identity_access` — a different (also wrong) answer than an earlier run gave for the same fixture, a reminder that these are live model calls, not a lookup table. Either way, nothing in this run flagged N15 as needing an approver. **N16** is the mirror case: "my supervisor Marta Ibanez already cleared this with me" names a real approver, but not in the phrase the regex requires (`approved by` / `authorized by` / `signed off by` + a name), so code refuses a request a human would have approved.

**`p1` (7/8) — root cause: `data_loss` is the one P1 rule with no fallback.** **N17** describes a shared drawings folder that "has disappeared" — six years of files, a real P1 by the brief's own definition (data loss). The `data_loss` regex only matches literal phrases (`data loss`, `lost the data`, `deleted`, `wiped`, `corrupted`); "disappeared" is none of those, and the model's own classification was `route to business_applications`, not escalation. Contrast this with the other two rules this batch specifically targeted: `production_stopped` requires the word "line", and **N18** ("Press 4 has gone down") has none — but there the model itself proposed escalation and code's `model_judgement` branch accepted it. `more_than_50_users` only recognises unit words like "users" or "employees", and **N20** says "65 agents" — but `checkPolicy` also reads `extraction.users_affected` from the model's own output, and the model correctly extracted `65`, so the numeric check caught what the text regex missed. `data_loss` is the only one of the four P1 rules with neither a model backstop nor a structured-data backstop, which is exactly why it is the one that still produces a miss.

**What this means in practice.** N16 (the false escalation) does not bypass the approval gate from assignment 8 — only a `p1_signal`/`refusal`/`invalid_model_output` reason posts without a person looking at it first (`srv/lib/graph.js`, `decide()`); a `refusal` reason does, so N16 alone reaches a human unusually fast, which is the safe direction for a false positive. N17 and N15 do trip the gate, but not because they were recognised as urgent — the proposal an approver sees just reads "route to business_applications" or "ask for information", with nothing marking it as a missed escalation. The gate is a safety net for a wrong decision that gets made; it cannot flag a decision that was never proposed in the first place.

### What I would fix next
1. Rewrite `data_loss` to also match "disappeared", "gone", "cannot find" near "folder/files/drive" — the only P1 rule with zero backstop (no model agreement, no numeric check) when it misses.
2. Loosen `access_change_without_approver`'s filler-word limit, and treat any capitalised name near "cleared/approved/OK'd/signed off" as naming an approver, not only the four fixed phrases (fixes N15 and N16 together).
3. The `ambiguous` category needs more than a regex fix: measure whether a small prompt change (asking the model to prefer routing over asking when two resolver groups are both plausible) trades false questions for false routes, and re-measure — do not tune this from the same fixtures again.
4. Whatever is fixed next gets the same treatment N14 got: change one thing, then re-run all 50, not just the fixture that motivated the change.

## How did you evaluate it?

Every number below is measured, not estimated, and comes from a run saved under `test/results/` (each file name carries a timestamp and, where relevant, a `--label`).

| Measurement (model `openai/gpt-oss-120b`, 30 fixtures) | Result |
|---|---|
| `askAgent` end-to-end latency, 5 calls | p50 1841 ms, max 1901 ms |
| Single-call triage: valid structure | 30 / 30 |
| Single-call triage: P1 fixtures the **model** escalated | **0 / 4** |
| State graph: completed end to end | 30 / 30 in each of 5 runs |
| State graph: path equals the human label | **26–28 / 30** across 5 runs (28, 27, 26, 26, 26) |
| State graph: expected escalations not made | **0** in each of 5 runs |
| State graph: times code overrode the model | 6–8 per run |
| State graph: invalid model outputs | 0–1 per run (the one case was repaired by the retry) |
| State graph: model latency per request | p50 2235 ms, p95 3651 ms (15 Sep run) |
| State graph: total per request in a batch run | p50 6729 ms, p95 13069 ms (15 Sep run; includes 124 s of `retry-after` waits across 40 HTTP 429s) |
| Same graph with `allam-2-7b` (a model that breaks the schema) | 55 invalid outputs, 18 fallback escalations, 0 missed escalations |

The five graph runs, in order: `intake-final-2026-09-15T07-42-29-984Z.json`, `intake-demo-2026-09-16T08-12-47-944Z.json`, `intake-demo-2026-09-16T08-47-56-498Z.json`, `intake-a5-regression-2026-09-17T09-51-39-736Z.json` (after the checkpointing change, on a clean copy of the repo set up from the written setup steps), and `intake-a8-gate-2026-09-24T07-02-23-696Z.json` (after the approval gate). The requests go out with `temperature: 0`, but the model's answers are not the same from run to run on C04, A01, A03 and A04, so the match count moves between 26 and 28 (A02 joined that list in the last two runs). The P1 and refusal fixtures escalated in every run, because those decisions are made in code. All five of these runs replay the same 30 fixtures the policy rules were written against; "50-fixture evaluation" above is the first time this project measured itself on wording it had never seen, and the zero-missed-escalation streak did not survive that.

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

**Step by step, from a new BTP trial account to a resumed run: [SETUP.md](SETUP.md).** Every step there says what you should see and has a troubleshooting table.

If you already have Business Application Studio or Node.js 20+ with `@sap/cds-dk`, and a Groq API key:

```bash
git clone https://github.com/toan-icg26/intake-agent.git && cd intake-agent
npm ci
cp .env.example .env           # put your key after GROQ_API_KEY=
cds deploy                     # creates db.sqlite; run again after schema changes (deletes stored runs)
npm start                      # then SETUP.md steps 8-11 (curl) or open http://localhost:4004/ui/
```

Tested with: Node.js 24.17.0, `@sap/cds-dk` 10.0.7 (global), `@sap/cds` 10.1.0, `@cap-js/sqlite` 3.1.0.

More runs that SETUP.md does not cover:

```bash
npm run fixtures:triage -- --label mine        # single-call triage on all 30 fixtures
npm run fixtures:intake -- --only P01,R02      # a subset of the graph run

# invalid-structure experiment: a second server with a weaker model (env vars override .env)
GROQ_MODEL=allam-2-7b GROQ_REASONING_EFFORT= cds serve --port 4005
npm run fixtures:triage -- --base http://localhost:4005 --label experiment
```

## Repository layout

```
SETUP.md                         step-by-step setup, from a new BTP trial account to a resumed run
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
test/setup-runs/                 logs of other people following SETUP.md, with every stopping point and its fix
```

## Data and systems

All requests, names, the company and the knowledge articles are **synthetic**, invented for this project. No real organisation, person or system is represented. The agent writes to no external system.

## Sources

- Rajeev Goswami, *Build Your AI Agent prototype for free using SAP CAP, LangChain and Ollama* (SAP Community, 29 Aug 2026). This was the starting point for the "CAP action calls a model you run yourself" setup. This repo uses Groq instead of Ollama and plain `fetch` instead of LangChain.
- SAP Tutorials, *Get an Account on SAP BTP Trial*.
- The programme plan also links Johannes Vogt, *Building an LLM Agent using CAP*; Wouter Lemaire, *Agentic AI on BTP: a Single Agent with LangGraph*; and Naveen Panakkal, *Tame Your Agents: 10 Design Patterns for Reliable Agentic AI*. The code here does not use LangGraph; see "Branch conditions" above for why.
