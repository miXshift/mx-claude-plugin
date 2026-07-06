---
name: mx-auth-login
description: >
  Authenticate against the MixShift warehouse via the mx-legacy-auth
  service at mcp.mixshift.io. Routes by scenario: interactive sign-in
  (device-code or PKCE browser flow) when a human is present, service
  credentials (admin-issued, OAuth client_credentials) for unattended
  runs like scheduled Cowork tasks and CI, and a paste-token direct
  mode for claude.ai web where no shell exists. Collects a
  self-attested work email (person_label) for per-employee session
  attribution on the interactive paths. Replaces the retired legacy
  raw-MySQL path; the CLI `mixshift auth setup` command exists only
  for backward compatibility and should not be recommended.
metadata:
  version: "0.2.1"
  author: "MixShift"
trigger_phrases:
  - sign in to mixshift
  - log me in to mixshift
  - log in to mixshift
  - mixshift login
  - run auth login
  - auth login
  - connect to mixshift
  - connect mixshift
  - set up my credentials
  - set up mixshift credentials
  - configure mixshift
  - authenticate mixshift
---

# Auth (chat-orchestrated, token-based)

Authenticate the user (or their automation) against the MixShift warehouse. Humans click a link and sign in with their MixShift account; automations use an admin-issued service credential. The plugin stores tokens locally — never a raw MySQL password.

## Step 0 — Route by scenario

Ask yourself one question: **will a human be present every time this credential gets used?**

| Signals in the conversation | Route |
|---|---|
| User wants to query data now, says "sign in", first-run welcome | **Path A** (interactive, device-code) — the default |
| "scheduled task", "cron", "runs at 9am", "automation", "CI", "when I'm not around", "service credential", auth failing inside a scheduled Cowork task | **Invoke the `mx-auth-service-setup` skill** — it orchestrates the whole machine-credential flow |
| claude.ai web / no Bash tool available | **Path D** (direct mode, paste token) |

When in doubt, ask: *"Is this for you to use right now, or for something that runs on its own (a schedule, automation, CI)?"* One question, then route. A user setting up a scheduled skill usually needs BOTH: their own interactive sign-in for building it, and a service credential so the schedule survives without them.

## How to frame this for the user

One or two sentences, then move. Don't repeat the framing at each step.

- Interactive: *"I'll sign you in to MixShift. You'll click a link, sign in there, and come back — about 30 seconds. Your password stays in your browser; the plugin only stores a short-lived token."*
- Service: *"Scheduled runs can't click sign-in links, so they use a service credential — a machine key your MixShift admin creates. One-time setup, then the schedule authenticates itself forever."*

## Step 1 — Get the user's work email (person_label) [Paths A and D only]

**Why:** one MixShift tenant credential is shared across many employees in the same org. The `person_label` is a self-attested work email — it lets your admin see *who* in the org did what in their session log. It's not authentication, just attribution. (Path C skips this: service credentials carry their own `svc:` label, chosen by the admin at creation.)

**Check first:** if `~/.mixshift/auth/credentials` exists and has a `datahub.person_label` from a prior login, reuse it. Tell the user:

> *"Reusing your stored email (alice@marpartners.com). Say so if that's wrong and I'll switch."*

**Otherwise ask once:**

> *"What's your work email? It's just for session attribution, not auth — e.g. you@yourcompany.com."*

Accept anything that parses as `<local>@<domain>.<tld>`. If the user gives something that doesn't look like an email, push back gently and ask again. Don't accept partial values.

## Path A — Interactive sign-in (Cowork, Claude Code, terminal)

Two-phase device-code orchestration. Cowork's Bash tool kills processes at ~45s, which is shorter than a typical browser sign-in, so the chat skill drives the flow across multiple short Bash calls instead of one long blocking call.

**Step A1 — Initialize the sign-in:**

```bash
mixshift auth device-init --person-label "<email-from-step-1>"
```

The CLI returns JSON immediately and exits:

```json
{
  "device_code": "DY57-6CJD",
  "login_url": "https://mcp.mixshift.io/login?device_code=DY57-6CJD&...",
  "expires_at": "<ISO timestamp>",
  "api_base": "https://mcp.mixshift.io",
  "person_label": "<email>",
  "device_label": "<hostname>",
  "client_id": "mx-claude-plugin"
}
```

Capture `device_code` and `login_url`. The other fields don't need to be passed again; `device-poll` only needs `device_code` + `person_label`.

(If `mixshift` isn't found, e.g. it isn't on PATH inside this sandbox, run the same command via `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js auth device-init ...`.)

**If device-init returns `{ "ok": false, "error": "<message>" }`** instead of the JSON above, the request to `mcp.mixshift.io` never completed, almost always the Cowork / Claude Code sandbox egress allowlist. Do NOT send a link or retry in a loop. Surface the message and go to **"If the sandbox is blocking sign-in"** below.

**Step A2 — Send the user to the URL:**

> *"Open this link to sign in: \<login_url\>*
> *Use your MixShift login — the same email + password you use to log into MixShift. Your credentials stay on the sign-in page; the plugin only holds a token after.*
> *Tell me when you're done."*

Don't paste the device code separately — the URL encodes it. The user just signs in on the page.

Include one heads-up with the link: after they approve, the page may say "return to your CLI". That just means come back to this chat and say "done"; there is no separate CLI step.

**Step A3 — Poll for approval when the user returns:**

When the user confirms they signed in (says "done", "ready", etc.), run:

```bash
mixshift auth device-poll <device_code> --person-label "<email-from-step-1>"
```

Default max-wait is 30s (fits comfortably under Cowork's Bash timeout). The CLI returns JSON:

- `{ "state": "approved", "result": { ... } }` — success. Tokens are already saved to `~/.mixshift/auth/credentials` and post-login discovery has fired. Move to the verify step.
- `{ "state": "pending" }` — user hasn't completed sign-in yet. Ask politely (*"Still finishing? I'll check again."*) and re-call `device-poll` with the same `device_code`. Repeat up to a few times before bailing.
- `{ "state": "expired", "error": "<reason>" }`: device code is no longer valid (typically 10 min limit on the server side). Restart from Step A1 with a fresh `device-init`.
- `{ "ok": false, "error": "<message>" }`: the poll request itself couldn't reach `mcp.mixshift.io` (network/sandbox), not a sign-in state. Don't keep polling; go to **"If the sandbox is blocking sign-in"** below.

## Path C — Service credential (unattended runs): delegate

Machine credentials for scheduled Cowork tasks, crons, CI, and cloud automations have their own dedicated skill: **invoke `mx-auth-service-setup`** and follow it. It owns the whole flow — workspace + MIXSHIFT_DATA_DIR resolution (critical in Cowork, where sandbox homes don't persist), admin credential creation at /admin, secret handoff without argv exposure, running `mixshift auth service-setup` itself, deleting the secret file after verification, and wiring the schedule to the same data dir. Do not inline those steps here; the dedicated skill is the source of truth.

One precedence fact worth knowing on THIS path: if a human sign-in (`datahub` block) and a service credential both exist in the same data dir, the human session wins and the service credential is the fallback.

## Path D — claude.ai web (no Bash, MCP connector)

There is no shell and no local disk, so the plugin cannot store tokens for the user. The user mints tokens themselves and pastes the access token into the connector configuration:

> *"Open https://mcp.mixshift.io/login?mode=direct in a browser tab, sign in with your MixShift login plus your work email, and the page will show you an access token. Paste that into the connector's Authorization header configuration (Bearer token). Tokens last 24h; revisit the page to mint a fresh one."*

Do NOT attempt to call auth bootstrap MCP tools — they no longer exist on the service (auth moved to the HTTP transport layer). If a tool named `mixshift_auth_start` or `mixshift_auth_complete` appears in older instructions, those instructions are stale.

## If the sandbox is blocking sign-in (Cowork / Claude Code egress)

`device-init` or `device-poll` returning `{ "ok": false, "error": "<message>" }` with a "could not reach mcp.mixshift.io" / network message means the **host sandbox's egress allowlist doesn't include `mcp.mixshift.io`**, so the request never leaves the sandbox. This is an environment or org policy setting (the user's Claude org or corporate network), not a MixShift outage, and most individual setups are unaffected. Don't loop the command, and don't tell the user to run `mixshift` in their own terminal: the bundled CLI isn't on a normal terminal's PATH, so that just yields "command not found."

Lead with `doctor`, which confirms the cause and prints the exact remediation:

1. **Diagnose:** run `mixshift doctor` (or `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js doctor`). It reports whether the service is reachable and, if not, the required allowlist domains.
2. **Fix the allowlist** (pick the row for your plan; add BOTH `mcp.mixshift.io` and `*.amazonaws.com`, the second for SP-API report downloads):
   - **Cowork, personal Pro/Max:** open Settings > Capabilities (claude.ai/settings/capabilities) > "Code execution and file creation", enable "Allow network egress", add both domains under "Additional allowed domains", then start a **new** conversation. If they do not take under "Package managers only" mode, set the mode to "All domains".
   - **Cowork, Team/Enterprise:** an org admin adds the same domains under Organization settings > Capabilities > Code execution, then a **new** conversation.
   - **Standalone Claude Code:** add them to `~/.claude/settings.json` under `sandbox.network.allowedDomains`, then start a new session.
3. **Or use a surface that isn't sandbox-blocked:** sign in from **claude.ai web** (Path D, paste-token), or run MixShift from a **normal Claude Code terminal** session where egress isn't restricted.

Then re-run the sign-in. Emit `skill.completed --outcome failed` for the blocked attempt so the funnel reflects it.

## Verify (all paths)

Confirm warehouse access works through the token:

```bash
mixshift data query --sql "SELECT NOW() AS db_time, USER() AS db_user"
```

(On claude.ai use the `legacy_query` MCP tool with the same SQL once the connector has the token.)

If it returns one row: *"You're signed in — warehouse is reachable."* For Path C add: *"Your scheduled runs will authenticate as \<svc: label\>."*

If it fails:

- `host_unreachable` → couldn't reach `mcp.mixshift.io`. This is usually the sandbox egress allowlist: run `mixshift doctor` and see **"If the sandbox is blocking sign-in"** above. (If `doctor` shows the service reachable, retry, or `/mx-feedback` if it persists.)
- `access_denied_db` → *"Signed in, but your account isn't authorized for this database. Send feedback so MixShift ops can look at the grants."*
- `insufficient_scope` (service credentials only) → *"This credential was scoped down and can't use the full data gateway. Ask your admin to issue one with all read scopes."*
- Anything else → pass through the friendly message; offer to retry.

## Bottom line

End with a concise success message. Use what you actually learned, don't speculate.

- Path A/D: *"Signed in as \<person_label\> (tenant: \<tenant_email\>). Token is stored locally at `~/.mixshift/auth/credentials` — only you can read it."*
- Path C: *"Service credential \<svc: label\> is configured and verified. Unattended runs on this machine authenticate as that label, and your admin can see, rotate, or revoke it at /admin any time."*

Don't restate everything from the CLI output (it's already on screen). Don't list features they could try unless they're already in context.

## Storage anchor (do not deviate)

Credentials live LOCALLY at `~/.mixshift/auth/credentials`, file mode 0600 on POSIX, plaintext JSON. Service installs also keep a short-lived minted token cache at `~/.mixshift/auth/service-token-cache.json`. They are **never** synced to a MixShift server, never uploaded, never sent off-machine except as the per-call Bearer token to `mcp.mixshift.io` on each query.

The right phrasings are: *"saved locally on your machine"*, *"on disk locally"*, *"only you can read it"*.

Wrong phrasings (have appeared in past sessions — don't repeat):
- ~~"saved server-side"~~
- ~~"synced to MixShift"~~
- ~~"uploaded to the cloud"~~
- ~~"in your MixShift account"~~

The token-based flow shifts the IP-whitelist burden from each user to the mx-legacy-auth service (one static egress IP). That's the win: no per-user IP whitelist requests, no raw MySQL passwords on disk.

## Fallbacks

In Cowork / Claude Code chat you drive Path A (device-init + device-poll) inline. Do **not** tell the user to run `mixshift ...` in a separate terminal: the bundled CLI is only on PATH *inside* the chat session, so a standalone terminal returns "command not found." The terminal suggestions below apply ONLY to users who have separately installed `mixshift` as a system command. For a sandbox or egress block, use **"If the sandbox is blocking sign-in"** above, not a terminal.

If the user gets stuck mid-flow:

- **Every `mixshift` command fails with a "command not found"-style error, or hangs with no output at all:** check `node --version` first. Missing Node.js is the most common cause on machines that have never run a terminal tool; the plugin's CLI needs Node 20 or newer, and without it no `mixshift` command can even print an error. Help the user install it (macOS: `brew install node` if Homebrew exists, otherwise the nodejs.org LTS installer; Windows: `winget install OpenJS.NodeJS.LTS`), then retry.

- **`device-init` printed no `login_url` (and no network error):** just re-run Step A1. If it returns `{ "ok": false, ... }`, treat it as the sandbox block above.

- **Login page errors or 404s:** *"Hit refresh once. If still broken, the service might be having a hiccup — try again in a minute, or send feedback if it keeps failing."*

- **User says they signed in but no credentials landed:** re-run Step A3 (`device-poll`) with the same `device_code`. In the chat flow the poll (not a browser callback) is what writes credentials. If `device-poll` returns a network error, it's the sandbox block above.

- **Scheduled task aborts with "No credentials found":** the task's sandbox has no credential. Route to Path C — and check `MIXSHIFT_DATA_DIR`: the service credential must live in the data dir the scheduled task actually reads.

- **Service credential 401 invalid_client:** revoked or rotated. Admin checks /admin; re-run `service-setup` with the current secret. (Path C failure section has the full phrasing.)

- **User asks about the legacy raw-MySQL path (`mixshift auth setup`):** that path is retired, and per-user IP whitelisting is gone with it. The command remains in the CLI only for backward compatibility; do not recommend it. Say: *"The old `auth setup` raw-MySQL path has been retired. `mixshift auth login` is the supported way to sign in, and unattended runs use a service credential (the mx-auth-service-setup flow)."*

- **User already logged in and wants to switch accounts:** Just re-run the flow. The new login overwrites the old session.

## Hard rules

- **`person_label` is required on interactive paths.** Never skip or default it. The login won't proceed without it.
- **Never ask the user to paste credentials in chat.** Passwords belong in the browser; service-credential secrets belong in a file or env var. If a secret lands in chat anyway, finish the job and then recommend rotation.
- **Never echo tokens or secrets.** Refer to the user by email or label, never by token value. Never cat the credentials file or the secret file into chat output.
- **Credentials stay local.** Use the storage-anchor phrasings above. Never imply they leave the machine.
- **Don't repeat the framing.** Say it once at the start, then act.
- **Don't bury the URL.** When the CLI prints a login URL, surface it prominently.

## Telemetry (required)

At the START of this skill:

```bash
mixshift telemetry emit skill.invoked --skill mx-auth-login
# If a natural-language trigger matched (NOT a /slash command), also:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-auth-login --trigger-phrase "<the user's exact phrase>"
```

At the END:

```bash
mixshift telemetry emit skill.completed --skill mx-auth-login --outcome <ok|failed|deferred|skipped>
```

Outcomes:
- `ok` — signed in (or service credential configured) + the verify query succeeded
- `failed` — CLI exited non-zero, OR the verify query failed
- `deferred` — user backed out without completing (e.g. *"let me come back to this later"*, or admin not available to issue the credential yet)
- `skipped` — skill triggered but user said *"not now"* or equivalent before any action

The CLI itself emits `auth.started`, `auth.login_completed`, `auth.refresh_failed`, `user.identified`, and the post-login `brand.discovered` for the wire-level events. `skill.invoked` / `skill.completed` capture the chat-orchestration envelope around them.
