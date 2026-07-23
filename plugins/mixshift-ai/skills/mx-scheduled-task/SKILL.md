---
name: mx-scheduled-task
description: >
  Build or repair a scheduled MixShift task that keeps working with nobody at
  the keyboard: a Cowork scheduled task or a Claude Code cron that pulls
  warehouse data, Amazon reports, health checks, or portfolio scans on a
  schedule. Owns the whole lifecycle: pick the durable anchor folder the task
  can always reach, attach it to the task, set up the service credential inside
  it, generate task instructions that start with the harness preflight so every
  run re-finds its credential and re-pulls brand context from the org store,
  and verify the first run end to end. Also the fix-it skill when an existing
  scheduled task reports not signed in, No credentials found, or missing brand
  context. Credential minting alone belongs to mx-auth-service-setup; this
  skill orchestrates the full task setup around it.
metadata:
  version: "0.1.1"
  author: "MixShift"
trigger_phrases:
  - set up a scheduled task
  - schedule this
  - schedule this skill
  - make this run on a schedule
  - run this every day
  - run this every week
  - run this every Monday
  - run this daily without me
  - run this nightly
  - make this unattended
  - automate this report
  - my scheduled task is failing
  - my scheduled task says not signed in
  - scheduled task lost auth
  - fix my scheduled task
  - scheduled run says no credentials found
---

# Scheduled MixShift tasks that survive fresh sandboxes

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset, use this skill's base directory to locate the plugin root (the base directory is `<plugin root>/skills/<this skill>`) and run `node "<plugin root>/harness/dist/cli.js"` with the same arguments.

A scheduled run starts from nothing: fresh sandbox, no session, no memory of the
session that created it. The one thing a task needs is a persistent folder it can
always reach. Anchor the service credential there and every run can re-establish
everything else by itself: the CLI is re-found, the credential is re-discovered,
and brand context is re-pulled from the MixShift org store. This skill sets that
up front to back, and repairs tasks that were built without it.

## When this skill applies (and when it doesn't)

Run this when the user wants MixShift work to happen on a schedule (daily health
check, weekly portfolio scan, monthly report refresh, recurring report or pricing
pulls), or when an existing scheduled task is broken: it reports "not signed in",
"No credentials found", a missing clients directory, or it worked once and never
again.

Route elsewhere when:

- The user only needs the machine credential itself (CI secret, one-off unattended
  auth): invoke `mx-auth-service-setup` directly.
- The scheduled work never touches MixShift data: the host's own scheduling is
  enough, nothing here applies.
- The user is signing in interactively: `mx-auth-login`.
- The brand has no brand context yet and the scheduled work needs it: run
  `mx-brand-context` first (brand setup), then come back.

## Step 0 - Inventory: what will this task need?

Answer these before touching anything, asking the user only what you cannot
derive:

1. **The work**: which skill or queries run on the schedule, and how often.
2. **The brands**: which brand slugs the work reads (`mixshift brand list` shows
   the registry). Portfolio scans need every brand they cover.
3. **Read or write**: does any step change an Amazon account (bid changes,
   negatives, listing edits)? Almost all scheduled tasks are read-only. Scope the
   credential accordingly in Step 2: read-only unless a write is genuinely part
   of the schedule, and say so to the user.
4. **The surface**, which decides Step 1:
   - **Claude Code or a terminal**: the default `~/.mixshift` is already durable.
     Skip to Step 2 and use it as the anchor.
   - **Cowork desktop**: sandboxed. A scheduled fire can get a brand-new sandbox
     with a re-initialized home (this is the norm on Mac; do not rely on
     workspace reuse on any platform). The folder grant in Step 1 is required.
   - **claude.ai web / cloud sessions**: there is no shell and no durable local
     folder, so CLI-based scheduled tasks are not supported there today. Say so
     plainly and point the user at Cowork desktop or Claude Code instead of
     improvising.

## Step 1 - The durable anchor (Cowork)

The task needs one persistent folder attached to it. Everything the task must
keep lives under that folder; nothing outside it survives.

- **New task**: have the user pick or create a real folder on the machine, for
  example `~/MixShift-Scheduled` (Mac) or `C:\Users\[name]\MixShift-Scheduled`
  (Windows). Creating the task from a Cowork session that has this folder open
  attaches the grant at creation.
- **Existing task (no folder attached)**: the task's own runs can request it.
  During a manual "Run now" with the user present, call the session's
  directory request tool with the folder's full path (it is named
  `request_cowork_directory` in Cowork; some surfaces expose it as
  `request_directory`). The user approves once, the grant is stored on the
  task itself, and every future scheduled fire inherits it. The task's
  settings screen cannot add a folder after creation; the in-run request is
  the retrofit path.
- The generated task instructions (Step 3) include this request as their own
  fallback, so a task repaired this way self-heals on its next attended run.

Tell the user which folder is the anchor and that the credential and any task
state must live under it, nowhere else.

**Multiple scheduled tasks can share one anchor folder and one credential.** A
service credential is a tenant machine credential, not bound to a task, so point
every task at the same anchor and reuse the one credential when its scopes cover
them (mint a separate credential only for finer /admin attribution or
revocation, never because each task "needs its own"). The one thing that does
NOT carry over is the Cowork folder grant: the mount permission is stored per
task, so each task still needs its own one-time approval to reach the shared
folder (its first manual Run-now), even though they all then use the same
credential inside it. So: one folder, one credential, but approve the mount once
per task.

## Step 2 - Service credential, anchored

Invoke `mx-auth-service-setup` and follow it, with one instruction pinned: the
data dir is `[anchor folder]/.mixshift` (on Claude Code, the default
`~/.mixshift`). The admin mints a setup code at https://mcp.mixshift.io/admin,
the user pastes it, and the credential lands inside the anchor.

Scopes: request read-only for read-only work. A monthly forecast refresh does
not need `ads:write` or `listings:write`. One credential per task keeps /admin
attribution and revocation clean.

If a credential from earlier attempts is stranded (minted into a sandbox that no
longer exists), have the user revoke it at /admin. Its secret is unreachable but
still valid until revoked.

## Step 3 - Generate the task instructions

The stored task prompt must assume nothing. Generate it with this preamble
first, filling in the bracketed values, then the actual work steps:

```
STEP 0: MixShift preflight. Must pass before any other work.
Resolve the CLI (scheduled sandboxes have no PATH hook and no $MIXSHIFT_CLI, and
`mixshift` is NOT on PATH — every call must run as `node <cli.js>`):
  MIXSHIFT_CLI="$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)"
If empty: STOP and report that the MixShift plugin is not available in this run.
(Do NOT add a `-path '*mixshift*'` filter: the plugin installs into an ID-named
directory like `plugin_01LC7x...` with no "mixshift" in the path, so that filter
matches nothing on Cowork. The `*/harness/dist/cli.js` shape is specific enough.)

Run the preflight. It discovers the service credential, verifies it against the
service, and pulls brand context for the brands this task uses:
  node "$MIXSHIFT_CLI" task preflight --brand [brand-slug] --json
- READY (exit 0): run the export line from its output (export MIXSHIFT_DATA_DIR=...),
  then proceed. Invoke every MixShift command in this run as:
  node "$MIXSHIFT_CLI" [command], with MIXSHIFT_DATA_DIR exported.
- BLOCKED credential_missing (exit 6): the persistent folder is not attached to
  this run, or it holds no credential yet. If a human is present: call the
  session's directory request tool (request_cowork_directory, or
  request_directory where that is its name) with path [anchor folder], wait
  for approval, and re-run the preflight. If it still reports
  credential_missing, run the mx-auth-service-setup skill with
  MIXSHIFT_DATA_DIR=[anchor folder]/.mixshift, then re-run the preflight. If no
  human is present: STOP and report the preflight output verbatim.
- BLOCKED anything else (exit 7, 8, or 9): STOP and report the blocker and its
  remediation exactly as preflight printed them.
Never run the task's work, and never report success, past a failed preflight.
```

Rules for the rest of the generated prompt:

- Every MixShift call is `node "$MIXSHIFT_CLI" ...`. Never bare `mixshift` in a
  stored prompt: Cowork does not run plugin session hooks, so PATH is not set.
- Outputs and any state files the task keeps between runs go under the anchor
  folder.
- Fail loudly. A run that cannot complete a step reports exactly which step and
  why. It never reports a clean result it did not produce (no "0 issues found"
  on an aborted run).
- In Cowork each Bash call has a hard ceiling around 45 seconds. Long Amazon
  operations must submit, persist the run handle, and poll across separate
  calls (`mixshift pricing runs` is the recovery surface for pricing batches).
  One `task preflight` call per brand keeps calls short when a task covers many
  brands.
- `mixshift feedback` and telemetry may report "fetch failed" from a scheduled
  sandbox. That is a network restriction of the sandbox, not a task failure;
  events queue locally. Do not fail the run over it and do not claim they sent.

If this session has a scheduled-task creation tool available, offer to create
the task directly with the generated instructions. Otherwise hand the user the
block to paste into the task's instructions in the app, and tell them where:
Cowork's scheduled tasks screen (task instructions field).

## Step 4 - Verified first run

Do not call the setup done until one attended run has proven the chain:

1. The user triggers a manual "Run now" and stays present.
2. Approvals that happen exactly once: the folder request (if Step 1 used the
   retrofit path), and the setup code paste (if the credential was not minted in
   Step 2 beforehand).
3. Watch for: preflight READY, brand context `present` or `pulled`, the task's
   own work completing, and its output landing under the anchor folder.
4. State the outcome plainly: what ran, what was written where, and that the
   next scheduled fire needs nobody present.

If the platform never surfaces the folder request or the grant does not stick
(the next run is naked again), fall back: re-create the task from a Cowork
session with the anchor folder open, so the grant attaches at creation. Report
which path worked when sending feedback; this differs by platform version.

## Repairing an existing task

| Symptom in the task's runs | Cause | Fix |
| --- | --- | --- |
| "No credentials found" or "not signed in" every run | No folder grant, or credential anchored in a dead sandbox path | Steps 1, 2, 3: attach the anchor, mint into it, replace the prompt's auth block with the Step 3 preamble |
| Worked while building, dead on the first scheduled fire | Everything lived in the building session's sandbox | Same as above; nothing from the building session survives |
| `mixshift: command not found` | Stored prompt calls bare `mixshift`; Cowork runs no session hooks | Replace every call with `node "$MIXSHIFT_CLI" ...` and resolve `MIXSHIFT_CLI` first (Step 3 preamble) |
| "brand ... not found" / missing context.yaml | Fresh sandbox has no clients dir | Preflight with `--brand [slug]` pulls it from the org store; if the org store has never seen the brand, run `mx-brand-context` interactively first |
| Hardcoded `MIXSHIFT_DATA_DIR` with a `local_[uuid]` path | Prompt froze a per-session path | Replace with the Step 3 preamble; the preflight discovers the live path each run |
| "fetch failed" from feedback or telemetry only | Sandbox egress restriction | Expected today; not a task failure. Events queue locally |
| `reauth_required` / lost Amazon access on a seller | Amazon authorization lapsed, not the task | The merchant re-authorizes in the MixShift platform; the task is fine |

## Hard rules

- **One persistent folder per task; everything durable lives under it.** Never
  anchor a credential in a session home or an unattached workspace path.
- **Never bare `mixshift` in a stored prompt.** Resolve the CLI, then
  `node "$MIXSHIFT_CLI" ...`.
- **Preflight before work, every run.** A failed preflight ends the run with the
  blocker reported verbatim.
- **Read-only scopes unless the schedule genuinely writes.** Name the scopes to
  the user when the credential is minted.
- **No silent success.** A run that skipped or aborted says so; it never emits a
  result that looks like a healthy run.
- **Setup is done only after one verified attended run** (Step 4), never after
  the pieces merely exist.

## Telemetry (required - see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-scheduled-task
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-scheduled-task --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-scheduled-task --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (task set up or repaired and the attended run verified), `failed`
(setup or verification errored), `deferred` (waiting on the user: folder
approval, setup code, or the attended run), `skipped` (routed to another skill
or the surface does not support scheduled tasks).
