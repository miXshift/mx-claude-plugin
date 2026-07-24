---
name: mx-auth-service-setup
description: >
  Set up an admin-issued service credential so MixShift skills can run
  UNATTENDED: scheduled Cowork tasks, daily crons hitting the warehouse or
  the SP-API report/pricing endpoints, CI jobs, cloud automations. The
  default flow needs no secret handling at all: the admin mints a one-time
  SETUP CODE at /admin, the user pastes the code in chat (safe by design:
  single-use, 10-minute TTL), and Claude exchanges it so the credential
  lands directly in this machine's credentials file. Claude also resolves
  the correct workspace folder, anchors credentials in a persistent folder so
  scheduled runs can rediscover them, verifies with a real token mint, and
  wires the schedule to locate the right data dir. Invoke whenever a user is building something that must
  run without a person present; interactive sign-in belongs to
  mx-auth-login instead, and the full scheduled-task lifecycle (anchor
  folder, generated task instructions, verified first run) belongs to
  mx-scheduled-task; this skill is the credential step inside it.
metadata:
  version: "0.3.1"
  author: "MixShift"
trigger_phrases:
  - set up a service credential
  - service credential
  - service token
  - service account token
  - auth for my scheduled task
  - scheduled task auth
  - unattended auth
  - headless auth
  - auth for automation
  - cron auth
---

# Service credential setup (chat-orchestrated)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), resolve the bundled CLI by scanning for it once and reuse the path: `MIXSHIFT_CLI="$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)"`, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


Get a machine credential configured so this workspace's MixShift access works with nobody at the keyboard. The user only does the two things Claude cannot: create the credential in the MixShift admin page (it needs their tenant password), and hand over the secret. Claude does everything else.

## When this skill applies (and when it doesn't)

Run this when the work in front of you will execute UNATTENDED: a Cowork scheduled task, a daily cron pulling warehouse data or SP-API reports/pricing, CI, a cloud automation. Browser sign-ins cannot serve those: nobody is present to click the link, and a fresh scheduled sandbox starts with no session.

If the user just wants to query data right now, route to `mx-auth-login` instead. If a user asks to "schedule" something that never touches MixShift data, you do not need this either. When it is ambiguous, ask once: *"Will this run on its own (schedule, cron, CI), or only while you're here driving it?"*

If the user is setting up or fixing a whole scheduled task (not just its credential), invoke `mx-scheduled-task` and let it drive; it calls back into this skill for the credential step with the anchor folder already decided.

A user building a scheduled skill usually needs BOTH: their own interactive sign-in for building and testing it now (`mx-auth-login`), and a service credential so the schedule survives without them (this skill).

## Step 0 — Resolve the workspace and the data dir (Claude does this)

This answers "which folder?" so the user never has to guess.

1. Run `pwd` and `echo "$MIXSHIFT_DATA_DIR"` via Bash.
2. **In Cowork the sandbox path is NOT stable across runs.** The working directory carries a session/run UUID (e.g. `…/local_<uuid>/outputs/…`) that CHANGES the next time the schedule fires, so a credential addressed by today's absolute path is gone tomorrow — a hardcoded `MIXSHIFT_DATA_DIR` makes a scheduled run abort with "No credentials found." Two rules follow:
   - **Anchor the credential in a PERSISTENT folder.** If `MIXSHIFT_DATA_DIR` is already set for the task, use exactly that. Otherwise anchor inside a folder ATTACHED to the scheduled task (a user-selected folder the task mounts every run): `MIXSHIFT_DATA_DIR=<that folder>/.mixshift`.
   - **No durable folder available? STOP. Do not anchor into the session home.** If the working directory is itself a session sandbox path (it contains a session UUID, or `pwd` is a bare `/sessions/<name>` home) and no attached folder exists, a credential written "successfully" here evaporates before the next scheduled fire, and every re-mint repeats the loss. Say exactly that to the user, then fix the anchor FIRST: invoke `mx-scheduled-task`, which attaches a persistent folder to the task (directory request plus one Run-now approval) and returns here with a real anchor. Never proceed on the hope that the sandbox persists.
   - **The schedule LOCATES the credential at runtime — it never hardcodes the path** (wired in Step 5). Because the absolute path is not stable, the schedule discovers its credential each run.
   - Outside Cowork (CLI / Claude Code), the default `~/.mixshift` is already persistent — use it, no `MIXSHIFT_DATA_DIR` needed, and skip the rest of this dance.
3. Tell the user plainly where you anchored the credential, whether that location is genuinely durable (an attached folder or a real home directory, not a session sandbox), and that the schedule will rediscover it at runtime (not by a stored absolute path).

## Step 1 — The user gets a SETUP CODE (the one admin step)

> *"Open https://mcp.mixshift.io/admin and sign in with your MixShift account login. Click **Create service credential** and name it after this task — I'd suggest `<derived-from-task-name>`. You'll get a one-time **setup code** that looks like `SVC-XXXX-XXXX`. Paste that code here — it's safe in chat: single-use, expires in 10 minutes, and nobody ever sees the actual secret."*

If the user is not the tenant admin in practice, the same instructions go to whoever holds the tenant login; the flow pauses (`deferred`) until the code exists.

## Step 2 — Claude exchanges the code (default path; no secret handling)

When the user pastes the code, run the setup yourself via Bash, in this workspace, with the data dir from Step 0:

```bash
MIXSHIFT_DATA_DIR="<data dir from step 0>" mixshift auth service-setup \
  --setup-code <SVC-XXXX-XXXX from the user> \
  --json
```

(Outside Cowork with the default `~/.mixshift`, omit the `MIXSHIFT_DATA_DIR=` prefix.)

The exchange creates the credential server-side at that moment and writes it straight into this machine's credentials file. The secret never appears in chat, in a file the user touches, or in any shell command. Parse the JSON: `"verified": true` means the harness then minted a REAL access token with the new credential — proof it works end to end. There is no secret file to clean up on this path.

## Step 2-alt — Raw secret fallback (older admin flow / CI)

Only when the user has a raw `client_id` + secret instead of a setup code (the admin used "Create with raw secret", or a CI pipeline holds the secret in a secret manager):

1. The secret must never appear in a shell command (argv leaks into history). Have the user save it into `<project folder>/mixshift-secret.txt` via their file manager, or if they paste it in chat, write it to that file with your FILE-WRITING tool (never `echo`/`printf`) and recommend a zero-downtime rotation at /admin afterwards since transcripts persist.
2. Run:

```bash
MIXSHIFT_DATA_DIR="<data dir from step 0>" mixshift auth service-setup \
  --client-id <svc_...> \
  --client-secret-file "<abs path to mixshift-secret.txt>" \
  --label <the label> \
  --json
```

3. After `verified: true`, delete the secret file yourself (`rm "<abs path>"`) and tell the user why that is safe: the credential now lives in `<data dir>/auth/credentials` (mode 0600), which is what the harness actually reads; the txt file was only the handoff. If `verified` was NOT true, keep the file and diagnose first.

## Step 5 — Verify data access and wire the schedule

1. Prove the whole chain with a query under the same data dir:

```bash
MIXSHIFT_DATA_DIR="<data dir>" mixshift data query --sql "SELECT NOW() AS db_time" --json
```

2. Wire the schedule to DISCOVER the credential at runtime — do NOT hardcode the absolute path (its session UUID changes between runs). **For new or rewritten task prompts, prefer the harness preflight**: after resolving `MIXSHIFT_CLI` (see below), the task runs `node "$MIXSHIFT_CLI" task preflight --brand <slug> --json` as its first step. Preflight performs this same discovery in code, verifies the credential with a real token mint, seeds brand context from the org store, and reports a specific blocker with a distinct exit code when something is missing; `mx-scheduled-task` generates the full preamble. The raw shell block below remains correct and is what preflight internalizes:

```bash
# Find the persisted credential in this run's sandbox and point the CLI at it.
CRED="$(find /sessions -maxdepth 7 -type f -path '*/.mixshift/auth/credentials' 2>/dev/null | head -1)"
export MIXSHIFT_DATA_DIR="$(dirname "$(dirname "$CRED")")"
# If CRED is empty, STOP and report the credential is missing (re-run this setup) —
# never proceed (or report success) as if all is well.

# Resolve the harness CLI the same way. Cowork does NOT run plugin session
# hooks (verified 2026-07-16), so in a scheduled sandbox neither `mixshift`
# on PATH nor $MIXSHIFT_CLI can be assumed. NEVER write bare `mixshift ...`
# into a scheduled task's stored prompt; resolve the entrypoint first.
# Do NOT add a `-path '*mixshift*'` filter: the plugin installs into an
# ID-named directory (e.g. plugin_01LC7x...) with no "mixshift" in the path,
# so that filter matches nothing on Cowork. `*/harness/dist/cli.js` is enough.
MIXSHIFT_CLI="${MIXSHIFT_CLI:-$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)}"
# Then invoke every command as: node "$MIXSHIFT_CLI" <cmd> <args>
# If MIXSHIFT_CLI resolves empty, STOP and report the plugin payload is missing.
```

This runtime discovery is the proven pattern for Cowork scheduled tasks. If you can see the scheduled skill's file in this workspace, offer to add that block; otherwise hand the user the exact lines. Offer the same fix for any EXISTING scheduled task whose stored prompt still calls bare `mixshift` — those prompts break silently when the plugin updates. (Outside Cowork, the default `~/.mixshift` is found automatically and the session hook provides `mixshift`/`$MIXSHIFT_CLI` — no block needed.)

3. Bottom line:

> *"Done. Unattended runs in this workspace authenticate as `<svc: label>` — read-only, visible to your admin, revocable or rotatable any time at https://mcp.mixshift.io/admin. The schedule just needs `MIXSHIFT_DATA_DIR=<data dir>` set, which it now has."*

## Failure modes

- **"Unknown, expired, or already-used setup code":** codes are single-use and last 10 minutes. The admin mints a fresh one at /admin (one click) and the user pastes the new code. Nothing else to undo.
- **`verified: false` / HTTP 401 `invalid_client` at setup (raw path):** the credential was revoked, or the secret was mistyped/rotated past its overlap. Have the user re-check the /admin tab (the secret is shown only once; if it's gone, rotate to get a fresh one) and re-run from Step 2-alt.
- **Query fails with an org-admin / "cannot use this gateway" message:** the credential was created under the wrong tenant login (some tenant logins map to blocked super-admin MySQL users). Have the user sign into /admin with the tenant login they normally use with this plugin and create the credential there; revoke the wrong-tenant one.
- **Query fails `insufficient_scope`:** the credential was scoped down at creation. Raw SQL needs all read scopes; have the admin issue a full-read credential for SQL automations.
- **Scheduled run later aborts "No credentials found":** the schedule hardcoded a per-session `MIXSHIFT_DATA_DIR` whose UUID has since changed, or the credential was not anchored in a persistent folder. Fix the schedule to DISCOVER the path at runtime (the Step 5 `find /sessions …` block, or better, the `task preflight` preamble from `mx-scheduled-task`) and ensure the credential lives in a folder that survives across runs — don't re-create the credential.
- **Setup "succeeds" but every scheduled fire starts unauthenticated anyway:** the credential was anchored into a session home because no folder was attached to the task (the Step 0 STOP case was skipped). Re-minting will not help; each new credential lands in the next throwaway sandbox. Attach a persistent folder to the task first (invoke `mx-scheduled-task`; on Cowork this is a directory request approved once during a manual Run-now), then mint ONE credential into it and revoke the stranded ones at /admin.
- **User can't find the project folder for the file drop:** fall back to Option B (paste in chat + rotation note). Never have them guess paths; you printed the exact one in Step 2.

## Hard rules

- **The setup CODE in argv is fine** (single-use, 10-minute TTL, burned on exchange). The raw SECRET never is: no `echo`, no `printf`, no argv — file-writing tool or user file drop only, on the fallback path.
- **Never echo the secret back** in any message, log, or confirmation. Refer to the credential by its label or client_id.
- **On the raw path, delete the secret file only after `verified: true`.**
- **One credential can serve many tasks.** A service credential is a tenant machine credential, not bound to a task, so multiple scheduled tasks sharing one anchor folder can all use the same credential (as long as its scopes cover them). Mint a distinct per-task credential only when you want finer /admin attribution or revocation, not because each task needs its own. (Note: the Cowork folder GRANT is still per-task even when the credential is shared, see mx-scheduled-task.)
- **Anchor in a persistent folder; the schedule discovers the path at runtime.** The Cowork sandbox path carries a session UUID that changes between runs, so NEVER hardcode an absolute `MIXSHIFT_DATA_DIR` into a schedule. Anchor the credential in a folder attached to the task and have the schedule locate it each run (`task preflight`, or the Step 5 `find /sessions …` block). A credential addressed by a stale per-session path silently dies "No credentials found."
- **No durable folder means STOP, not improvise.** Writing the credential into a session home and reporting success is the one failure that costs the user a setup code per scheduled fire. Fix the anchor first (`mx-scheduled-task`), then mint.
- **Default to read-only scopes.** Ask for write scopes only when the scheduled work itself writes, and name them to the user.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-auth-service-setup
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-auth-service-setup --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-auth-service-setup --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (credential configured + verified + secret file cleaned up), `failed` (setup or verification errored), `deferred` (waiting on the admin to create the credential), `skipped` (turned out interactive-only; routed to mx-auth-login).
