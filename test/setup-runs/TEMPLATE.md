# SETUP.md run <N>

Copy this file to `run-<N>.md` before each run. The tester fills in parts A–C. The repo owner fills in the "Fix" column afterwards.

## A. Run details

| | |
|---|---|
| Date | |
| Tester | initials or role only, with their consent (this file is public) |
| Seen this project before? | no / yes (how much) |
| Environment | new BAS dev space on own BTP trial / other: ... |
| SETUP.md version | commit hash of SETUP.md used (`git log -1 --format=%h -- SETUP.md`) |
| Start time / end time | |
| Help given during the run | none / describe exactly what was said (anything other than "none" must be logged as a stopping point) |

## B. Stopping points

A stopping point is any moment the tester **had to stop**. This includes:

- an error;
- output that did not match the "You should see" text;
- an instruction that was unclear;
- having to guess, search, or ask.

Copy messages **exactly**, including typos. Do not summarise them.

| # | Step | What happened (exact message or screen text) | What SETUP.md said to expect | Minutes lost | How the tester got past it (or "stuck") | Fix (repo owner, with commit) |
|---|---|---|---|---|---|---|
| 1 | | | | | | |

## C. Results

- Step 5: `answer` was `OK`? yes / no
- Step 9 SUMMARY:
  - `httpErrors`:
  - `completedGraph`:
  - `escalationsExpectedButNotMade`:
  - `pathMatchesExpected`:
- Step 10c: a run with `"status":"running"` and `"nextNode":"classify"` appeared? yes / no
- Step 10d: the `resume` note, copied exactly:
- Step 10d: terminal 1 showed only `classify#1` and `draft_response` model calls after the restart? yes / no
- Completed every step using only SETUP.md, with no help? yes / no
