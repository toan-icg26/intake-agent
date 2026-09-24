# SETUP — run intake-agent from scratch

This guide takes you from nothing to:

- a running agent,
- all 30 synthetic requests replayed through it,
- a run that you interrupt and then resume.

Everything runs in **SAP Business Application Studio (BAS)** on a free **SAP BTP trial** account. The model comes from **Groq's** free tier. You need no credit card and nothing installed on your own machine.

Follow the steps in order. Each step says what to run and what you should see. If you see something else, look it up in [Troubleshooting](#troubleshooting) at the end before you change anything.

What the agent does and why it is built this way is explained in [README.md](README.md). You do not need to read it to follow this guide.

---

## 0. What you need

- A web browser.
- An **SAP BTP trial account**. If you do not have one, follow SAP's tutorial [Get an Account on SAP BTP Trial](https://developers.sap.com/tutorials/hcp-create-trial-account).
- A **Groq account**. You create it in step 2.

---

## 1. Open a BAS dev space

1. From your BTP trial account, open **SAP Business Application Studio**.
2. Click **Create Dev Space**. Give it any name, for example `IntakeAgent`, and choose the kind **Full Stack Cloud Application**. Then click **Create Dev Space**.
3. Wait until its status is **RUNNING**, then click its name to open it.
4. Open a terminal: menu **Terminal → New Terminal**.

> A trial account can run **only one dev space at a time**. If another one is running, stop it first on the Dev Spaces page.

Check that the tools are there:

```bash
node -v
cds -v | head -3
```

**You should see** a Node.js version (20 or later) and a list that starts with `@sap/cds-dk`. This guide was tested with Node.js 24.17.0 and `@sap/cds-dk` 10.0.7.

---

## 2. Get a Groq API key

1. Go to <https://console.groq.com> and sign in. Google sign-in works, and no credit card is needed.
2. Open **API Keys**, click **Create API Key**, and give it any name.
3. **Copy the key now.** Groq shows it only once. It starts with `gsk_`.

Keep the key to yourself. It only goes into the `.env` file in step 4. Never paste it into a chat, an issue, or any file that is committed.

---

## 3. Get the code

In the BAS terminal:

```bash
cd ~/projects
git clone https://github.com/toan-icg26/intake-agent.git
cd intake-agent
npm ci
```

**You should see** npm finish without any `npm ERR!` lines. `npm ci` installs the exact versions recorded in `package-lock.json`: `@sap/cds` 10.1.0 and `@cap-js/sqlite` 3.1.0.

The 30 synthetic test requests are already in the repo, in `fixtures/requests.json`. You do not need any other data.

---

## 4. Put your key in `.env`

```bash
cp .env.example .env
```

In the BAS file explorer on the left, open `intake-agent/.env`. Paste your key directly after `GROQ_API_KEY=`, with no spaces and no quotes. Leave the other lines as they are. The file should look like this, with your own key:

```
GROQ_API_KEY=gsk_...your key...
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_MODEL=openai/gpt-oss-120b
...
```

Save the file (Ctrl+S). `.env` is listed in `.gitignore`, so git never picks it up.

---

## 5. Check the key and the model before starting anything

This step talks to Groq directly. If it fails, the problem is the key or the model, not the app.

```bash
set -a; . ./.env; set +a
curl -sS https://api.groq.com/openai/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $GROQ_API_KEY" \
  -d "{\"model\":\"$GROQ_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}]}" \
  | jq '{model, answer: .choices[0].message.content, error: .error.message}'
```

**You should see:**

```json
{
  "model": "openai/gpt-oss-120b",
  "answer": "OK",
  "error": null
}
```

- `"error": "Invalid API Key"`: the key in `.env` is wrong or incomplete. Copy it again (step 2) and redo step 5.
- ``"error": "The model `openai/gpt-oss-120b` does not exist or you do not have access to it."``: your account cannot use this model. List the models you can use:

  ```bash
  curl -sS https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY" | jq -r '.data[].id' | sort
  ```

  Put one of them after `GROQ_MODEL=` in `.env` and redo step 5. `GROQ_REASONING_EFFORT` only applies to reasoning models such as `openai/gpt-oss-*`. If you pick a different model and it rejects that setting, leave `GROQ_REASONING_EFFORT=` empty. Results in the README were measured with `openai/gpt-oss-120b`, so your numbers may differ with another model.

---

## 6. Create the database

```bash
cds deploy
```

**You should see** `successfully deployed to db.sqlite`. This creates the file `db.sqlite` with the tables and the 8 synthetic knowledge articles. The file is gitignored.

> Run `cds deploy` again whenever you pull changes to `db/` or `srv/*.cds`. **It deletes all stored runs.**

---

## 7. Start the server (terminal 1)

```bash
npm start 2>&1 | tee /tmp/intake-server.log
```

**You should see**, after a few seconds, a line like:

```
[cds] - server listening on { url: 'http://localhost:4004' }
```

If terminal 1 shows `listen EADDRINUSE: address already in use :::4004` instead, **stop here**. Another server is still running, and your requests would go to it instead of this one. See [Troubleshooting](#troubleshooting).

Leave this terminal open. It shows the server log while you work. Every run prints `[checkpoint] ... next=<node>` lines, and every model call prints a `[model]` line. `tee` also writes the log to `/tmp/intake-server.log`, which step 10 needs.

Use `npm start` rather than `cds watch` for everything in this guide. `cds watch` restarts the server whenever a project file is saved, and that breaks any request that is running at the time.

---

## 8. Try the three actions (terminal 2)

Open a second terminal (**Terminal → New Terminal**), then:

```bash
cd ~/projects/intake-agent
```

**8a. A free-text answer from the model** (`askAgent`):

```bash
curl -sS -X POST http://localhost:4004/odata/v4/agent/askAgent \
  -H "Content-Type: application/json" \
  -d '{"question": "My VPN disconnects every ten minutes. What should I check?"}' | jq -r '.value'
```

You should see a few paragraphs of troubleshooting advice. The wording differs every time.

**8b. Structured fields from a single model call** (`triage`):

```bash
curl -sS -X POST http://localhost:4004/odata/v4/agent/triage \
  -H "Content-Type: application/json" \
  -d '{"text": "Caller: Jorge Alvarez, shift lead Plant 2. Packaging line 3 has stopped. The MES stations on the line show Server not responding."}' \
  | jq '{valid, urgency: .result.urgency, next_action: .result.next_action}'
```

You should see `"valid": true`. In our runs the model said `"urgency": "P1"` but `"next_action": "route_to_group"`: it saw a P1 and did not escalate it. The model's answer can differ.

**8c. The same request through the state graph** (`runIntake`):

```bash
curl -sS -X POST http://localhost:4004/odata/v4/agent/runIntake \
  -H "Content-Type: application/json" \
  -d '{"text": "Caller: Jorge Alvarez, shift lead Plant 2. Packaging line 3 has stopped. The MES stations on the line show Server not responding."}' \
  | jq '{runID, path, owner, overrides}'
```

**You should see** `"path": "escalate_to_human"`, and usually an `overrides` entry like this one:

```json
{ "rule": "p1_signal: production_stopped", "modelSaid": "route_to_group", "codeDecided": "escalate_to_human" }
```

The P1 rule runs in code, so this request escalates whatever the model proposes. If the model itself proposed escalation, `overrides` is empty and `path` is still `escalate_to_human`.

---

## 9. Replay all 30 synthetic requests (terminal 2)

```bash
npm run fixtures:intake -- --label setup
```

This takes **about 3–5 minutes** (191 s and 277 s in two test runs on 22 Sep). The free tier allows 8,000 tokens per minute, so terminal 1 will show lines like `HTTP 429, waiting retry-after=5s`. That is expected: the server waits for as long as Groq asks, then continues.

Terminal 2 prints one line per request, then a `SUMMARY`. **Check these fields:**

| Field | Expected |
|---|---|
| `"httpErrors"` | `[]` |
| `"completedGraph"` | `30` |
| `"escalationsExpectedButNotMade"` | `[]` (**the most important one**: no missed escalations) |
| `"pathMatchesExpected"` | about `"26/30"` to `"28/30"` (the model's answers vary between runs) |

The full result is saved as `test/results/intake-setup-<timestamp>.json`.

---

## 10. Interrupt a run and resume it

After every node, the agent saves the whole run state to the `IntakeRuns` table in `db.sqlite`. If the server dies in the middle of a request, you can later continue that run from the node where it stopped, instead of starting it again.

A run takes only 2–3 seconds, which is too fast to stop by hand at the right moment. The command in 10a does it for you. It waits until the log shows the checkpoint before the `classify` node, then kills the server.

**10a. Start a run and kill the server mid-run (terminal 2):**

```bash
n=$(grep -c "next=classify" /tmp/intake-server.log)
curl -sS -X POST http://localhost:4004/odata/v4/agent/runIntake \
  -H "Content-Type: application/json" \
  -d '{"text": "Name: Oliver Grant\nLocation: Plant 1\nAffected system: Windows login\nDescription: Back from holiday and I forgot my password. After a few tries it says the account is locked."}' > /dev/null &
for i in $(seq 1 600); do
  if [ "$(grep -c "next=classify" /tmp/intake-server.log)" -gt "$n" ]; then pkill -9 -f "[c]ds-serve" && echo "server killed"; break; fi
  sleep 0.05
done
```

**You should see** `server killed` and `curl: (52) Empty reply from server` in terminal 2. The loop gives up after 30 seconds. If you see neither message by then, the run never reached `classify`: check terminal 1 for an error. In terminal 1 the server has stopped, and its last checkpoint line ends in `next=classify`.

**10b. Restart the server (terminal 1)** with the same command as in step 7:

```bash
npm start 2>&1 | tee /tmp/intake-server.log
```

Wait until terminal 1 shows `server listening` again before you go on.

**10c. Find the interrupted run (terminal 2):**

```bash
curl -sS "http://localhost:4004/odata/v4/agent/IntakeRuns?\$filter=status%20eq%20'running'&\$select=ID,status,nextNode" | jq -c '.value'
```

**You should see** one run with `"status":"running"` and `"nextNode":"classify"`. The database still remembers it after the restart.

**10d. Resume it (terminal 2):**

```bash
RUN=$(curl -sS "http://localhost:4004/odata/v4/agent/IntakeRuns?\$filter=status%20eq%20'running'&\$select=ID" | jq -r '.value[0].ID')
curl -sS -X POST http://localhost:4004/odata/v4/agent/resumeIntake \
  -H "Content-Type: application/json" -d "{\"runID\":\"$RUN\"}" \
  | jq '{path, modelCalls, nodes: [.trace[].node], resume: (.trace[] | select(.node=="resume") | .note)}'
```

**You should see:**

```json
{
  "path": "draft_response",
  "modelCalls": 3,
  "nodes": ["extract", "lookup_context", "resume", "classify", "check_policy", "choose_path", "draft_response"],
  "resume": "resumed from checkpoint at classify; 2 earlier nodes not re-run"
}
```

In terminal 1, only `[model] - [classify#1]` and `[model] - [draft_response]` appear after the restart. `extract` did not run again. The model's `path` can occasionally be different (for example `route_to_group`). The resume behaviour is what this step checks.

> **Resuming any run.** A run that is still `running` after a crash, or that ended `failed` (for example after a model error), resumes the same way: `POST /odata/v4/agent/resumeIntake` with its `runID`. Calling it on a `completed` run returns the stored result without calling the model. All runs are listed at `http://localhost:4004/odata/v4/agent/IntakeRuns`.

---

## 11. Release a proposal through the approval gate

Nothing the agent proposes leaves the system on its own. A run stops at `awaiting_approval` until a person with the `approver` role releases it. Mocked users: **`lead`** has that role, **`agent`** does not. There are no passwords, so `-u lead:` is enough.

The run you resumed in step 10 is already waiting. Find it and look at what it proposes:

```bash
curl -sS -u lead: "http://localhost:4004/odata/v4/agent/IntakeRuns?\$filter=status%20eq%20'awaiting_approval'&\$select=ID,status,proposal" | jq '.value[0]'
RUN=$(curl -sS -u lead: "http://localhost:4004/odata/v4/agent/IntakeRuns?\$filter=status%20eq%20'awaiting_approval'&\$select=ID" | jq -r '.value[0].ID')
```

**You should see** `"status": "awaiting_approval"` and a `proposal` holding `path`, `channel`, `recipient` and the message.

Try it as the user without the role, then edit the message as the approver:

```bash
curl -sS -u agent: -X POST http://localhost:4004/odata/v4/agent/editProposal \
  -H "Content-Type: application/json" -d "{\"runID\":\"$RUN\",\"message\":\"nope\"}"
# expected: {"error":{"message":"Forbidden","code":"403",...

curl -sS -u lead: -X POST http://localhost:4004/odata/v4/agent/editProposal \
  -H "Content-Type: application/json" \
  -d "{\"runID\":\"$RUN\",\"message\":\"Hi Oliver, I reset your account - please try again in 5 minutes.\"}" | jq '.proposal | fromjson'
```

Put it on hold and take it back, then approve it:

```bash
curl -sS -u lead: -X POST http://localhost:4004/odata/v4/agent/pauseRun \
  -H "Content-Type: application/json" -d "{\"runID\":\"$RUN\",\"reason\":\"checking with Identity & Access\"}" | jq -c
curl -sS -u lead: -X POST http://localhost:4004/odata/v4/agent/resumeRun \
  -H "Content-Type: application/json" -d "{\"runID\":\"$RUN\"}" | jq -c
curl -sS -u lead: -X POST http://localhost:4004/odata/v4/agent/approveRun \
  -H "Content-Type: application/json" -d "{\"runID\":\"$RUN\"}" | jq '{status, posted: (.posted|fromjson)}'
```

**You should see** `"status": "completed"` and a `posted` object naming the channel, the recipient and `"postedBy": "lead"`.

Check what left the system and who did what:

```bash
curl -sS -u lead: "http://localhost:4004/odata/v4/agent/Outbox?\$select=path,channel,recipient,postedBy" | jq -c '.value'
curl -sS -u lead: "http://localhost:4004/odata/v4/agent/ApprovalEvents?\$filter=runID%20eq%20$RUN&\$select=action,actor,reason&\$orderby=createdAt" | jq -c '[.value[]|{action,actor,reason}]'
```

**You should see** one `Outbox` row for this run, and the audit trail `parked → edited → paused → resumed → approved → posted`.

> Escalations that a **code** rule decided (a P1 signal or a refusal) do not wait here. They post immediately with `postedBy: code`, because the duty manager has to hear about a P1 straight away.

## 12. Stop

Press **Ctrl+C** in terminal 1. When you are done for the day, stop the dev space on the BAS Dev Spaces page.

---

## Troubleshooting

Messages below are quoted exactly as they appear.

| You see | Cause | Fix |
|---|---|---|
| `no such table: intake_IntakeRuns` or `no such table: AgentService_...` | The database was not created, or the schema changed after it was created | Stop the server, run `cds deploy` (step 6), and start it again |
| `GROQ_API_KEY is not set. Copy .env.example to .env and fill it in.` | `.env` is missing, or the key is empty | Step 4, then restart the server (Ctrl+C in terminal 1, then step 7) |
| `Model endpoint returned 401: {"error":{"message":"Invalid API Key",...` (HTTP 502) from `askAgent`, `triage` or `runIntake` | The Groq key in `.env` is wrong | Fix the key in `.env`, check it with step 5, then restart the server |
| ``The model `...` does not exist or you do not have access to it.`` | Your Groq account cannot use the model in `GROQ_MODEL` | Step 5, "list the models" |
| `listen EADDRINUSE: address already in use :::4004` | Another server is still running, perhaps `cds watch` in another terminal | Press Ctrl+C in that terminal. If you cannot find it, run `pkill -f "[c]ds-serve"; pkill -f "[c]ds watch"`, then start again |
| `curl: (7) Failed to connect to localhost port 4004 after 0 ms: Could not connect to server` | The server is not running | Step 7 in terminal 1 |
| Terminal 1: `HTTP 429, waiting retry-after=...` | Groq's free-tier rate limit | Nothing. The request waits and continues |
| Step 10c prints `[]` | The run finished before the kill | Run 10a again |
| `jq: error (at <stdin>:0): Cannot iterate over null (null)` | The previous command returned an error, or `RUN` is empty | Run the command again without the `\| jq ...` part to see the actual response |
| Terminal 1: `tail: /tmp/intake-server.log: file truncated` | Only if you watch the log with `tail -F`: a restart overwrote the log file | Nothing |
| A fixture run shows `fetch failed (UND_ERR_SOCKET)` | The server restarted during the run, usually `cds watch` reacting to a saved file | Use `npm start` (step 7) and do not edit files during the run |

If you are stuck on something that is not in this table, write down the step number and the exact message. That is exactly the kind of gap this guide is meant to close.
