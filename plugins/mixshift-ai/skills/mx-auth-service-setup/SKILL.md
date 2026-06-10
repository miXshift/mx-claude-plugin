---
name: mx-auth-service-setup
description: >
  Set up an admin-issued service credential so MixShift skills can run
  UNATTENDED: scheduled Cowork tasks, daily crons hitting the warehouse or
  the SP-API report/pricing endpoints, CI jobs, cloud automations. Claude
  drives the whole flow: it resolves the correct workspace folder, anchors
  credentials so they survive fresh sandboxes, runs `mixshift auth
  service-setup` itself, verifies with a real token mint, deletes the
  secret file afterwards, and wires the schedule to the right data dir.
  Invoke whenever a user is building something that must run without a
  person present; interactive sign-in belongs to mx-auth-login instead.
metadata:
  version: "0.1.0"
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
  - schedule this skill
  - make this run on a schedule
  - run this daily without me
  - set up a scheduled task
  - cron auth
---

# Service credential setup (chat-orchestrated)

Get a machine credential configured so this workspace's MixShift access works with nobody at the keyboard. The user only does the two things Claude cannot: create the credential in the MixShift admin page (it needs their tenant password), and hand over the secret. Claude does everything else.

## When this skill applies (and when it doesn't)

Run this when the work in front of you will execute UNATTENDED: a Cowork scheduled task, a daily cron pulling warehouse data or SP-API reports/pricing, CI, a cloud automation. Browser sign-ins cannot serve those: nobody is present to click the link, and a fresh scheduled sandbox starts with no session.

If the user just wants to query data right now, route to `mx-auth-login` instead. If a user asks to "schedule" something that never touches MixShift data, you do not need this either. When it is ambiguous, ask once: *"Will this run on its own (schedule, cron, CI), or only while you're here driving it?"*

A user building a scheduled skill usually needs BOTH: their own interactive sign-in for building and testing it now (`mx-auth-login`), and a service credential so the schedule survives without them (this skill).

## Step 0 — Resolve the workspace and the data dir (Claude does this)

This answers "which folder?" so the user never has to guess.

1. Run `pwd` and `echo "$MIXSHIFT_DATA_DIR"` via Bash.
2. **In Cowork, the sandbox home directory does NOT persist across sessions.** A scheduled task wakes in a fresh sandbox; only the project folder survives. So credentials MUST be anchored in the project folder via `MIXSHIFT_DATA_DIR`. Choose the data dir in this order:
   - If `MIXSHIFT_DATA_DIR` is already set (the scheduled skill already uses one), use exactly that value.
   - Otherwise use `<project folder>/.mixshift` (the project folder is your current working directory in Cowork).
3. Tell the user plainly which folder you chose and why, e.g.:

> *"Your scheduled task will run from this project folder, so I'll anchor MixShift credentials at `<abs path>/.mixshift` — that's the one location that survives fresh sandboxes. The schedule must use the same setting; I'll wire that at the end."*

On a regular machine (CLI / Claude Code outside Cowork), the default `~/.mixshift` is fine and no `MIXSHIFT_DATA_DIR` is needed; skip the anchoring talk.

## Step 1 — The user creates the credential (the one admin step)

> *"Open https://mcp.mixshift.io/admin and sign in with your MixShift account login. Click **Create service credential** and name it after this task — I'd suggest `<derived-from-task-name>`. You'll get a client_id (starts with `svc_`) and a secret shown exactly once. Keep that tab open and give me the client_id."*

If the user is not the tenant admin in practice, the same instructions go to whoever holds the tenant login; the flow pauses (`deferred`) until the credential exists.

## Step 2 — Secret handoff (two clean options; Claude handles both)

The secret must never appear in a shell command (argv leaks into history). Offer both paths:

**Option A (preferred): file drop.** Print the exact absolute path, derived from Step 0:

> *"Save the secret into a file at exactly `<project folder>/mixshift-secret.txt` using your file manager or editor — not through chat. Tell me when it's there."*

**Option B: paste in chat.** If the user pastes the secret into chat (many will; do not make them feel bad):
1. Write it to `<project folder>/mixshift-secret.txt` using your FILE-WRITING tool, never `echo`/`printf` through Bash (shell history).
2. Continue the flow normally.
3. After setup succeeds, say once: *"Since the secret passed through chat, transcripts persist it. Have the credential rotated at /admin when convenient: rotation is zero-downtime, and I can walk you through it."*

## Step 3 — Claude runs the setup (not the user)

Run it yourself via Bash, in this workspace, with the data dir from Step 0:

```bash
MIXSHIFT_DATA_DIR="<data dir from step 0>" mixshift auth service-setup \
  --client-id <svc_... from the user> \
  --client-secret-file "<abs path to mixshift-secret.txt>" \
  --label <the label from step 1> \
  --json
```

(Outside Cowork with the default `~/.mixshift`, omit the `MIXSHIFT_DATA_DIR=` prefix.)

Parse the JSON: `"verified": true` means the harness minted a REAL access token from the live service with this credential. That is the proof the credential works end to end.

## Step 4 — Delete the secret file (Claude does it, and explains why it's safe)

After `verified: true`:

```bash
rm "<abs path to mixshift-secret.txt>"
```

Tell the user why this is safe, because they will reasonably wonder:

> *"Deleted the secret file. The credential now lives in `<data dir>/auth/credentials` (file mode 0600), which is what the harness actually reads — the txt file was only the handoff. Verification already minted a real token with it, so nothing else is needed."*

If `verified` was NOT true, do not delete the file; diagnose first (see failure modes).

## Step 5 — Verify data access and wire the schedule

1. Prove the whole chain with a query under the same data dir:

```bash
MIXSHIFT_DATA_DIR="<data dir>" mixshift data run-query "SELECT NOW() AS db_time" --json
```

2. Make the schedule use the same anchor: the scheduled task's instructions (its prompt or skill) must export the same `MIXSHIFT_DATA_DIR` before calling any `mixshift` command. If you can see the scheduled skill's file in this workspace, offer to add it; otherwise state the exact line to include.

3. Bottom line:

> *"Done. Unattended runs in this workspace authenticate as `<svc: label>` — read-only, visible to your admin, revocable or rotatable any time at https://mcp.mixshift.io/admin. The schedule just needs `MIXSHIFT_DATA_DIR=<data dir>` set, which it now has."*

## Failure modes

- **`verified: false` / HTTP 401 `invalid_client` at setup:** the credential was revoked, or the secret was mistyped/rotated past its overlap. Have the user re-check the /admin tab (the secret is shown only once; if it's gone, rotate to get a fresh one) and re-run from Step 2.
- **Query fails with an org-admin / "cannot use this gateway" message:** the credential was created under the wrong tenant login (some tenant logins map to blocked super-admin MySQL users). Have the user sign into /admin with the tenant login they normally use with this plugin and create the credential there; revoke the wrong-tenant one.
- **Query fails `insufficient_scope`:** the credential was scoped down at creation. Raw SQL needs all read scopes; have the admin issue a full-read credential for SQL automations.
- **Scheduled run later aborts "No credentials found":** the schedule is not exporting the same `MIXSHIFT_DATA_DIR`. Fix the schedule's env, not the credential.
- **User can't find the project folder for the file drop:** fall back to Option B (paste in chat + rotation note). Never have them guess paths; you printed the exact one in Step 2.

## Hard rules

- **Never put the secret in a shell command.** No `echo`, no `printf`, no argv. File-writing tool or user file drop only.
- **Never echo the secret back** in any message, log, or confirmation. Refer to the credential by its label or client_id.
- **Delete the secret file only after `verified: true`.**
- **One credential per automation.** Distinct label per scheduled task keeps /admin attribution and revocation surgical.
- **Anchor to the project folder in Cowork.** Sandbox home does not persist; a credential saved there silently dies with the session.

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

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
