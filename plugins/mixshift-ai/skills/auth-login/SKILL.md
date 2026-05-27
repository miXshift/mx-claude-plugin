---
name: auth-login
description: >
  Sign the user in to the MixShift warehouse via the mx-legacy-auth
  service at mcp.mixshift.io. Opens a browser (PKCE) on shell-capable
  surfaces, or surfaces a device-code URL when no browser / no shell
  is available (claude.ai web, headless WSL, etc.). Collects a
  self-attested work email (person_label) for per-employee session
  attribution. Replaces the legacy raw-MySQL chat flow; the CLI
  `mixshift auth setup` command is still available for users who need
  the legacy path.
metadata:
  version: "0.1.0"
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

# Auth Login (chat-orchestrated, token-based)

Sign the user in to the MixShift warehouse using the mx-legacy-auth service. The user clicks a link, signs in there, and comes back. The plugin stores a short-lived token on their machine — never their raw MySQL password.

## How to frame this for the user

Tell them what's about to happen in one or two sentences. Don't oversell. Example phrasings — pick what fits the conversation, don't recite verbatim:

- *"I'll sign you in to MixShift. You'll click a link, sign in there, and come back — about 30 seconds. Your password stays in your browser; the plugin only stores a short-lived token."*
- *"Quick sign-in: I'll open a browser tab, you sign in, we're done. The plugin holds a token after — no raw passwords on disk."*

Then move. Don't repeat the framing at each step.

## Step 1 — Get the user's work email (person_label)

**Why:** one MixShift tenant credential is shared across many employees in the same org. The `person_label` is a self-attested work email — it lets your admin see *who* in the org did what in their session log. It's not authentication, just attribution.

**Check first:** if `~/.mixshift/auth/credentials` exists and has a `datahub.person_label` from a prior login, reuse it. Tell the user:

> *"Reusing your stored email (alice@marpartners.com). Say so if that's wrong and I'll switch."*

**Otherwise ask once:**

> *"What's your work email? It's just for session attribution, not auth — e.g. you@yourcompany.com."*

Accept anything that parses as `<local>@<domain>.<tld>`. If the user gives something that doesn't look like an email, push back gently and ask again. Don't accept partial values.

## Step 2 — Pick the flow based on what you (Claude) can do

Two paths. The distinguishing factor is whether you have access to a Bash tool.

### Path A — Bash is available (Cowork, Claude Code, terminal)

Two-phase device-code orchestration. Cowork's Bash tool kills processes at ~45s, which is shorter than a typical browser sign-in, so the chat skill drives the flow across multiple short Bash calls instead of one long blocking call.

**Step 2a — Initialize the sign-in:**

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

Capture `device_code` and `login_url`. The other fields don't need to be passed again — `device-poll` only needs `device_code` + `person_label`.

**Step 2b — Send the user to the URL:**

> *"Open this link to sign in: \<login_url\>*
> *Sign in there and come back. Tell me when you're done."*

Don't paste the device code separately — the URL encodes it. The user just signs in on the page.

**Step 2c — Poll for approval when the user returns:**

When the user confirms they signed in (says "done", "ready", etc.), run:

```bash
mixshift auth device-poll <device_code> --person-label "<email-from-step-1>"
```

Default max-wait is 30s (fits comfortably under Cowork's Bash timeout). The CLI returns JSON:

- `{ "state": "approved", "result": { "ok": true, "mode": "device", "email": "<tenant>", "personLabel": "<actor>", "apiBase": "...", "clientId": "...", "durationMs": N } }` — success. Tokens are already saved to `~/.mixshift/auth/credentials` and post-login discovery has fired. Move to Step 3.
- `{ "state": "pending" }` — user hasn't completed sign-in yet. Ask politely (*"Still finishing? I'll check again."*) and re-call `device-poll` with the same `device_code`. Repeat up to a few times before bailing.
- `{ "state": "expired", "error": "<reason>" }` — device code is no longer valid (typically 10 min limit on the server side). Restart from Step 2a with a fresh `device-init`.

### Path B — No Bash (claude.ai web, ChatGPT, other no-shell surfaces)

Use the MCP tools the mx-legacy-auth service exposes. Both are unauthenticated.

**Step B1 — Start the device-code flow:**

Call `mixshift_auth_start` with:

```json
{
  "person_label": "<email-from-step-1>",
  "client_id": "mx-claude-plugin",
  "device_label": "<short description of where the user is, e.g. 'web-claude'>"
}
```

The tool returns `{ deviceCode, loginUrl, expiresAt }`. Save the `deviceCode` for the next step.

**Step B2 — Send the user to the login URL:**

> *"Open this link in any browser and sign in: \<loginUrl\>*
> *Tell me when you're done — I'll finish the sign-in here."*

Don't paste the device_code separately — the loginUrl already encodes it. The user just signs in on the page; the page does the rest server-side.

**Step B3 — Complete the flow when the user confirms:**

When the user says they're done, call `mixshift_auth_complete` with `{ device_code }` (using the value from Step B1). The result is one of:

- `{ ok: true, state: 'approved', access_token, refresh_token, user_id, email, ... }` — success. Go to Step 3.
- `{ ok: true, state: 'pending' }` — they haven't finished. Ask politely: *"It looks like the sign-in isn't complete yet — want me to wait, or did something go wrong?"*
- `{ ok: false, error: 'device_code_unknown_or_expired' }` — restart from Step B1 with a fresh device code.

## Step 3 — Verify with a test query

Confirm warehouse access works through the token.

**In Bash-available surfaces:**

```bash
mixshift data run-query "SELECT NOW() AS db_time, USER() AS db_user"
```

**In claude.ai / web (no Bash):** call the `legacy_query` MCP tool with the same SQL.

Surface the result. If it returns one row, say:

> *"You're signed in — warehouse is reachable. You can run any MixShift skill now."*

If it fails:

- `host_unreachable` → *"Couldn't reach the warehouse. Check your network and try `mixshift auth login` again, or `/feedback` if it keeps failing."*
- `access_denied_db` → *"Signed in, but your account isn't authorized for this database. Send feedback so MixShift ops can look at the grants."*
- Anything else → pass through the friendly message; offer to retry login.

## Step 4 — Bottom line

End with a concise success message. Use what you actually learned, don't speculate. Template:

> *"Signed in as \<person_label\> (tenant: \<tenant_email\>). Token is stored locally at `~/.mixshift/auth/credentials` — only you can read it. Try `daily health check on <brand>` or `explore my data` to use it."*

Don't restate everything from the CLI output (it's already on screen). Don't list features they could try unless they're already in context.

## Storage anchor (do not deviate)

Credentials live LOCALLY at `~/.mixshift/auth/credentials`, file mode 0600 on POSIX, plaintext JSON. They are **never** synced to a MixShift server, never uploaded, never sent off-machine except as the per-call Bearer token to `mcp.mixshift.io` on each query.

The right phrasings are: *"saved locally on your machine"*, *"on disk locally"*, *"only you can read it"*.

Wrong phrasings (have appeared in past sessions — don't repeat):
- ~~"saved server-side"~~
- ~~"synced to MixShift"~~
- ~~"uploaded to the cloud"~~
- ~~"in your MixShift account"~~

The token-based flow shifts the IP-whitelist burden from each user to the mx-legacy-auth service (one static egress IP). That's the win: no per-user IP whitelist requests, no raw MySQL passwords on disk.

## Fallbacks

If the user gets stuck mid-flow:

- **Browser didn't open and no URL was printed:** *"That's unusual — re-run `mixshift auth login --mode device` in your terminal to force the device-code flow. It prints a URL you can open anywhere."*

- **Login page errors or 404s:** *"Hit refresh once. If still broken, the service might be having a hiccup — try again in a minute, or send feedback if it keeps failing."*

- **User says they signed in but no credentials landed:** *"Quick check — does `~/.mixshift/auth/credentials` exist? On Bash: `ls -la ~/.mixshift/auth/credentials`. If missing or empty, the browser callback didn't reach the local server. Re-run `mixshift auth login --mode device` to use the device-code flow instead (no localhost callback needed)."*

- **User needs the legacy raw-MySQL path (rare):** *"The CLI command `mixshift auth setup` still works if you need the legacy raw-MySQL path with per-user IP whitelist. Run it directly in your terminal (TTY prompts only — Claude's Bash tool doesn't drive interactive prompts cleanly). For everyone else, `auth login` is recommended."*

- **User already logged in and wants to switch accounts:** Just re-run the flow. The new login overwrites the old session.

## Hard rules

- **`person_label` is required.** Never skip or default it. The login won't proceed without it.
- **Never ask the user to paste credentials in chat.** The browser collects credentials, not chat. The plugin never touches the user's password.
- **Never echo tokens.** If you need to confirm success, refer to the user by their email or person_label, not the access_token or refresh_token.
- **Credentials stay local.** Use the storage-anchor phrasings above. Never imply they leave the machine.
- **Don't repeat the framing.** Say it once at the start, then act. Don't re-explain at each step.
- **Don't bury the URL.** When the CLI prints a login URL, surface it prominently. Some users want to copy-paste it manually.

## Telemetry (required)

At the START of this skill:

```bash
mixshift telemetry emit skill.invoked --skill auth-login
# If a natural-language trigger matched (NOT a /slash command), also:
mixshift telemetry emit skill.trigger_phrase_matched --skill auth-login --trigger-phrase "<the user's exact phrase>"
```

At the END:

```bash
mixshift telemetry emit skill.completed --skill auth-login --outcome <ok|failed|deferred|skipped>
```

Outcomes:
- `ok` — signed in + the SELECT 1 verify succeeded
- `failed` — CLI exited non-zero, OR the verify query failed
- `deferred` — user backed out without completing the browser step (e.g. *"let me come back to this later"*)
- `skipped` — skill triggered but user said *"not now"* or equivalent before any action

The CLI itself emits `auth.started`, `auth.login_completed`, `auth.refresh_failed`, `user.identified`, and the post-login `brand.discovered` for the wire-level events. `skill.invoked` / `skill.completed` capture the chat-orchestration envelope around them.
