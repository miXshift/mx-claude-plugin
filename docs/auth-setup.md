# Authentication

This doc covers signing in to the MixShift warehouse from the plugin. Two paths:

1. **Token-based browser sign-in** (`mixshift auth login`) — the recommended path for humans. No raw database credentials, no IP whitelist setup.
2. **Service credentials** (`mixshift auth service-setup`) — for unattended runs: scheduled Cowork tasks, cloud automations, CI. No browser, no human at run time. See [Service credentials](#service-credentials-unattended-runs).

The previously documented raw-MySQL setup is retired; see [the note at the bottom](#legacy-raw-mysql-path-mixshift-auth-setup).

The interactive flow is **the same across install paths** (Cowork personal, Cowork organization, Organization-level install via the Claude admin console, Claude Code, CLI direct). Only the install ceremony differs.

Building your own application against the warehouse instead of using the plugin? See [Querying from your own app](#querying-from-your-own-app-direct-api) for the direct HTTP path: mint a token, then post SQL.

Using a different AI client? See [Connecting other AI clients](#connecting-other-ai-clients-cursor-codex) for Cursor and Codex setup against the same MCP server.

---

## What sign-in does

In one sentence: opens your browser, has you sign in with your MixShift account, and stores a short-lived token at `~/.mixshift/auth/credentials` so the plugin can talk to your MixShift warehouse on your behalf.

Concretely:

1. **Collects your work email** (`person_label`) — used to attribute your session in MixShift's admin tooling. Same email you use to log into MixShift is fine. Not stored as auth.
2. **Opens a browser tab** at `https://mcp.mixshift.io/login`.
3. **You sign in** with your MixShift account (email + password). Your credentials stay between you and the sign-in page — the plugin never sees them.
4. **The sign-in page returns** a token pair (24h access + 30d refresh) to the plugin's local callback.
5. **Tokens are written** to `~/.mixshift/auth/credentials` at mode `0600`.
6. **Profile is updated** — `~/.mixshift/profile.yaml` gets your email so downstream commands (telemetry, feedback) know who you are.
7. **Brand registry is auto-populated** — `~/.mixshift/clients/index.yaml` is built from the warehouse so every brand you have access to is immediately listable.

After this, every plugin command uses the access token as a Bearer credential against `https://mcp.mixshift.io/api/query`. Expired access tokens auto-refresh in the background. If the refresh token expires or is revoked, you re-run sign-in.

---

## Don't have a MixShift account yet?

Sign-in requires an existing MixShift account; the plugin does not do registration. If you're brand-new to MixShift:

1. Create your account at `https://www.mydashapplications.com/auth/registration`.
2. Connect your Amazon accounts and activate **ads data** and **retail data** in the Account Manager. Full walkthrough: [Getting started with MixShift](https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift).
3. Wait for the initial data pulls. Most accounts are fully populated within 24-48 hours of activation; large catalogs can take longer ([data timing details](https://know.mixshift.io/en/articles/9584153-how-long-will-it-take-for-my-data-to-populate-in-mixshift)). MixShift emails you when your data is ready.
4. Come back and sign in (below). You can sign in as soon as the account exists, but data-dependent skills only get useful once the initial pulls have landed.

---

## How to sign in

### Method 1 — Chat-driven (Cowork + Claude Code, the recommended path)

In any Cowork or Claude Code chat, say one of:

- "welcome"
- "sign in to mixshift"
- "log me in"
- "set up my credentials"

The chat-driven path handles sign-in inline: it asks for your work email, opens a browser tab, and confirms when you've finished. Typical flow:

```
You:    welcome
Claude: Welcome to the MixShift plugin. You'll need your MixShift
        account (the same email + password you use to log into
        MixShift). I'll set up a sign-in link for you in a moment.
        What's your work email?
You:    you@yourcompany.com
Claude: Click this to sign in: https://mcp.mixshift.io/login?device_code=...
        Use your MixShift login. Tell me when you're done.
You:    [browser opens, you sign in with MixShift credentials, click confirm]
You:    done
Claude: ✓ Signed in as you@yourcompany.com. You have 8 active brands.
        Try "explore my data" or "show my brands".
```

The chat-driven path uses the device-code variant of the flow under the hood — fits comfortably within Cowork's per-command time budget.

### Method 2 — CLI direct (terminal, no Claude)

If you're in your own terminal:

```bash
mixshift auth login --person-label you@yourcompany.com
```

This opens your default browser via PKCE (Proof Key for Code Exchange), spins up a local callback server, and waits for you to complete sign-in. Returns when the browser callback hits.

If your environment can't open a browser (headless WSL, container, SSH'd shell), the harness auto-falls-back to the device-code flow and prints a URL you can open on any device:

```
Browser didn't respond; switching to device-code flow.
Open this URL on any machine: https://mcp.mixshift.io/login?device_code=...
```

### Method 3 — Scripted / CI

The auto-detection in Method 2 makes most scripted use work without changes. To force a specific mode:

```bash
mixshift auth login \
  --person-label you@yourcompany.com \
  --mode device       # or `pkce`, `auto` (default)
```

For development against a non-prod auth service:

```bash
mixshift auth login \
  --person-label dev@example.com \
  --api-base http://localhost:8080 \
  --client-id mx-claude-plugin-dev
```

---

## File locations + ownership

All auth state lives under `~/.mixshift/` on your local machine:

```
~/.mixshift/
├── auth/
│   └── credentials      # JSON, 0600 permissions — tokens + identity
├── profile.yaml         # Your email + plugin defaults overrides
├── clients/             # Per-brand context directories
├── telemetry/           # Local event queue (when telemetry enabled)
└── tmp/                 # Scratch space for prefetch artifacts
```

The `~/.mixshift/` directory is **per-OS-user**. Cowork doesn't share filesystem state across users; same for Claude Code. If two users on the same machine both want to use the plugin, each one's tokens are scoped to their own `~/`.

Inside `auth/credentials` (after a successful login):

```json
{
  "schema_version": 2,
  "created_at": "2026-05-27T17:00:00.000Z",
  "datahub": {
    "api_base": "https://mcp.mixshift.io",
    "access_token": "eyJ... (JWT, 24h TTL)",
    "refresh_token": "<48-byte base64url, 30d TTL>",
    "expires_at": "2026-05-28T17:00:00.000Z",
    "refresh_expires_at": "2026-06-26T17:00:00.000Z",
    "user_id": "3",
    "email": "amazon+clients@dashapplications.com",
    "person_label": "you@yourcompany.com",
    "device_label": "your-hostname",
    "client_id": "mx-claude-plugin"
  }
}
```

The plugin holds tokens, not passwords. Your actual MixShift password is entered on the sign-in page in your browser and never touches the plugin or Claude.

---

## Token lifecycle

| Token | Lifetime | What happens at expiry |
|---|---|---|
| **Access token** (JWT, sign-in) | 24h | The plugin auto-refreshes ~60s before expiry. Transparent to you. |
| **Refresh token** | 30d | When this expires, re-run `mixshift auth login`. Same flow. |
| **Access token** (service credential) | ~1h | The plugin re-mints automatically from the static credential. Nothing for you to do, ever. |

Refresh tokens are **one-time-use** — replaying a rotated refresh token revokes every active session for your user as a defense against token theft. The plugin's refresh logic is gated by a singleton so concurrent requests can't accidentally trigger this.

If you ever see "Your session expired. Run `mixshift auth login`." in chat or terminal, the refresh token expired or was revoked. Re-running sign-in gets you a fresh pair.

---

## Switching accounts

To switch which MixShift account the plugin uses, just re-run sign-in with a different `person_label`:

```bash
mixshift auth login --person-label different@company.com
```

In chat: "sign in as different@company.com" or just re-run the welcome.

The new sign-in overwrites the `datahub` block in `~/.mixshift/auth/credentials`. The old session is left dangling on the auth service until its 30d refresh expires (or you explicitly run `mixshift auth logout` if/when we ship that).

---

## What sign-in does NOT need

- **No raw MySQL credentials.** You don't fetch a host, username, port, or password from anywhere. The auth service holds the database connection server-side.
- **No master password.** That was a guard for the legacy credential-retrieval page; the token flow doesn't use it.
- **No IP whitelist.** The auth service runs from a single static egress IP that's pre-whitelisted on the warehouse. Your IP is irrelevant.
- **No password in chat.** Your MixShift password is entered on the browser sign-in page; it never goes through chat or any plugin command.
- **No file path juggling.** No `--password-file`, no temp YAML, no command-line credentials.
- **No Amazon secrets.** The Amazon SP-API and Ads API credentials are held by MixShift's service server-side. The plugin calls Amazon through the service and never sees an Amazon token or secret.

---

## Verifying it works

After sign-in, the plugin auto-runs a test query and displays your brand count. To verify manually:

```bash
mixshift data query --sql "SELECT NOW() AS db_time, USER() AS db_user"
```

Or in chat: *"show me one row from any table"*.

Either should return a single row of metadata, confirming the warehouse is reachable.

---

## Troubleshooting

**Browser didn't open / nothing happened after I ran `mixshift auth login`.**
PKCE attempts to open your default browser via the OS's native handler (`xdg-open`, `start`, `open`). If that fails — headless environment, container, SSH session — the harness auto-falls-back to the device-code flow and prints a URL. Open that URL on any device with a browser. If you want to force the fallback up front: `--mode device`.

**Sign-in page shows "session expired" or won't accept my credentials.**
The auth page session is short. If you opened the link and let it sit for >5 minutes, re-run `mixshift auth login` to get a fresh URL. If your MixShift credentials are wrong, the sign-in page surfaces the failure — same recovery as the MixShift app itself.

**"Your session expired. Run `mixshift auth login`."**
Your refresh token expired (>30d since last sign-in) or was revoked by the server (e.g. replay protection triggered by a refresh-token race). Run `mixshift auth login` to get a fresh pair.

**The browser callback hangs or times out.**
PKCE binds an ephemeral port on `127.0.0.1` and waits 10 minutes for the callback. If your firewall blocks localhost callbacks (rare), you'll see a timeout. Switch to `--mode device` to bypass.

**I'm in chat (Cowork / Claude Code) and the sign-in URL never appeared.**
The chat-driven flow runs `mixshift auth device-init` via Bash to get the URL. If that command failed, you'll see an error in chat. Most common cause: the harness CLI isn't on PATH inside that chat host. Try `mixshift welcome` first to confirm the CLI is reachable.

**Connection works in the terminal but Claude says "no datahub credentials" in chat.**
The `~/.mixshift/auth/credentials` file is per-OS-user. Cowork's chat backend may run as a different OS user than your terminal. Run `mixshift auth login` from inside the chat host (via Bash tool) so the credentials land in the right `~/.mixshift/`.

---

## Service credentials (unattended runs)

`mixshift auth login` needs a human in a browser, and the tokens it stores rotate on refresh. Neither works for automation: a scheduled Cowork task wakes in a fresh sandbox with nobody at the keyboard, a cloud job reads its secrets from a read-only env, and CI has no browser anywhere. Service credentials cover exactly that.

A service credential is a static `client_id` + `client_secret` pair, issued by your **tenant admin** at `https://mcp.mixshift.io/admin`. It is scoped read-only by default, revocable instantly, and rotatable with zero downtime. (Amazon Ads writes need an explicit `ads:write` scope on the credential, issued by the admin; see below.) Nothing about it changes when the automation uses it, so it survives restarts, redeploys, fresh sandboxes, and long pauses.

### Setup (default: one-time setup code, no secret handling)

The easiest path is chat-driven: in the Claude workspace where the automation will run, say *"set up a service credential"* and the `mx-auth-service-setup` skill drives everything below.

1. Your tenant admin clicks **Create service credential** at `https://mcp.mixshift.io/admin` (they pick a label like `nightly-foep-watch`). The admin gets a one-time **setup code** (`SVC-XXXX-XXXX`, valid 10 minutes).
2. Paste the code where the automation runs (chat is fine: the code is single-use and expires; nobody ever sees the secret):

   ```bash
   mixshift auth service-setup --setup-code SVC-XXXX-XXXX
   ```

   The exchange creates the credential server-side at that moment and writes it directly into this machine's credentials file, then verifies by minting a real token.

3. Done. Every plugin command now authenticates as the service credential when no human sign-in is present. Data queries, report pulls, and pricing calls all work identically.

**Amazon Ads writes from an unattended run** need the credential to carry the `ads:write` scope. An interactive human session holds it implicitly; a service credential needs it issued explicitly by the tenant admin at `https://mcp.mixshift.io/admin`. Without it, reads work but a write returns `insufficient_scope`.

### Setup (raw secret, for CI / secret managers)

When a pipeline holds the secret itself, the admin uses "Create with raw secret" at `/admin` instead and you deliver it via file or env:

```bash
# Secret from a file:
mixshift auth service-setup \
  --client-id svc_abc123... \
  --client-secret-file /path/to/secret.txt \
  --label svc:nightly-foep-watch

# Or from the environment (CI secret managers):
MIXSHIFT_CLIENT_SECRET=... mixshift auth service-setup --client-id svc_abc123...
```

The raw secret is never accepted as a command-line argument (argv leaks into shell history and process listings). Delete the secret file after setup verifies; the credential lives in the credentials file from then on.

### How it works

- The credential is written to the `service` block of `~/.mixshift/auth/credentials` (mode 0600).
- At run time the plugin mints a short-lived (~1h) access token from `https://mcp.mixshift.io/oauth/token` and caches it at `~/.mixshift/auth/service-token-cache.json`. Near expiry it just mints again.
- If you ALSO have a human sign-in (`datahub` block) on the same machine, the human session wins. The service credential is the fallback for environments where no one signed in.
- Telemetry and MixShift audit logs attribute the automation's activity to the credential's `svc:` label, so the admin can always see which automation did what.

### Scheduled Cowork tasks specifically

Configure once inside the scheduled task's workspace (the same place your `MIXSHIFT_DATA_DIR` points, if you use one). Because the credential is static, a fresh sandbox only needs to read the credentials file; there is no browser step and no token rotation to break mid-run.

### When it stops working

One failure mode: HTTP 401 from the token endpoint, which means the credential was **revoked** or **rotated** past its overlap window. The error message says exactly that. Fix: your tenant admin checks the credential at `https://mcp.mixshift.io/admin`, and you re-run `mixshift auth service-setup` with the current secret. The plugin never deletes the block itself; only an admin action can invalidate it.

### Rotation (admin side)

Admins rotate without downtime: rotate at `/admin` (both old and new secrets work during the overlap), update the automation's secret at your own pace, verify it mints, then confirm the rotation (old secret dies). Revocation is instant and kills new token mints immediately.

---

## Querying from your own app (direct API)

If you run your own application (a scheduled job, a sync pipeline, a BI backend) and want to read your warehouse without the plugin, call the API directly. The plugin is only a client of this same HTTP surface: anything `mixshift data query` does, your app can do with two requests. Mint a token, then post SQL.

This path reads **your own tenant database**. A service credential resolves server-side to your dedicated warehouse, which uses the standard MixShift schema, so your queries only ever see your own data. The database user behind the endpoint is **read-only**, so writes are rejected at the database itself.

### 1. Get a service credential

Your tenant admin creates one at `https://mcp.mixshift.io/admin` with "Create with raw secret" and gives you the `client_id` and `client_secret`. It is read-only and revocable at any time. Because raw SQL spans every data domain, this path needs the credential to carry the full read set (`account:read`, `ads:read`, `retail:read`, `brand_analytics:read`), which is the default for a read-only credential. The narrower per-domain scopes apply to the `/v1` endpoints, not to raw SQL. You do not need the plugin or `mixshift auth service-setup` for this path, only the two strings. Keep the secret in your app's secret store, not in source control.

### 2. Mint an access token

Exchange the credential for a short-lived (about 1 hour) bearer token using the OAuth client_credentials grant:

```bash
curl -sS https://mcp.mixshift.io/oauth/token \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"svc_abc123...","client_secret":"..."}'
```

```json
{ "access_token": "eyJ...", "expires_in": 3600 }
```

Mint once per run and reuse the token until it nears expiry. Re-mint when you get a 401.

### 3. Run read-only SQL

Post your statement to `/api/query` with the token as a bearer credential:

```bash
curl -sS https://mcp.mixshift.io/api/query \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT campaignName, SUM(cost) AS spend FROM campaign WHERE SellerID = ? GROUP BY 1","params":[12345],"queryTimeoutMs":60000}'
```

Bind untrusted input with placeholders instead of string-building. `params` accepts a positional array (bind with `?`) or a named object.

A successful call returns rows in an envelope:

```json
{ "ok": true, "rows": [ { "campaignName": "...", "spend": 1234.56 } ], "rowCount": 1, "durationMs": 412 }
```

A failure uses the same envelope with `ok: false`:

```json
{ "ok": false, "kind": "access_denied_table", "table_name": "some_table", "message": "...", "friendly": "..." }
```

`kind` is one of `access_denied_table`, `access_denied_db`, `unknown_table`, `syntax_error`, `timeout`, `host_unreachable`, `too_many_rows`, `response_too_large`, `unknown`. `access_denied_table` means your credential is not granted SELECT on that table, so ask MixShift to extend the grant. A `401` means the token expired or was revoked, so mint a new one.

### Discovering your schema

Two helper endpoints let your app introspect the warehouse, both using the same bearer token and hitting only your tenant database:

- `GET /api/tables` lists your tables: `{ "ok": true, "tables": ["campaign", ...], "rowCount": N, "durationMs": N }`.
- `GET /api/table/<name>` returns that table's columns (a `SHOW COLUMNS` result in the same envelope).

### Notes and limits

- **Read-only.** The database user cannot write. This is enforced at the database, not in your app.
- **Your data only.** The credential is bound to your tenant database, so queries only ever see your own data. You still filter by `SellerID` to pick a seller or marketplace where a table holds several.
- **Schema.** Your database uses the standard MixShift warehouse schema (the `dashamazon` layout). The table and column names you query over MySQL today apply here unchanged.
- **Timeout.** `queryTimeoutMs` sets the statement timeout (MySQL `MAX_EXECUTION_TIME`). It defaults to `60000` (60s) and accepts `1000` to `120000` (1s to 120s); values outside that range are rejected.
- **Result size.** One response is capped at 50,000 rows (`too_many_rows`) and 10 MB serialized (`response_too_large`). The call fails rather than returning a partial slice, so paginate large extracts with `LIMIT`/`OFFSET` or chunk by date or seller.
- **Stability.** This is raw SQL against the warehouse schema, so your queries couple to that schema. We keep it stable, but if you would rather have a versioned contract than raw SQL, ask us about the named-query surface.

---

## Connecting other AI clients (Cursor, Codex)

The same MCP server the Claude plugin talks to is available to any MCP client that speaks the streamable HTTP transport. The endpoint is:

```
https://mcp.mixshift.io/mcp
```

You authenticate with a bearer token. Two ways to get one:

- **Personal use:** open `https://mcp.mixshift.io/login?mode=direct` in a browser, sign in with your MixShift account, and copy the access token it shows. Access tokens last 24 hours; when one expires, mint a new one the same way.
- **Long-lived or shared setups:** ask your tenant admin for a service credential (see [Service credentials](#service-credentials-unattended-runs)), then mint tokens from it with the `client_credentials` grant as shown in [Querying from your own app](#querying-from-your-own-app-direct-api). Service-minted tokens last about 1 hour, so this path fits tooling that can re-mint, not a paste-once config.

### Cursor

Add the server to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global), with the token in an environment variable:

```json
{
  "mcpServers": {
    "mixshift": {
      "url": "https://mcp.mixshift.io/mcp",
      "headers": { "Authorization": "Bearer ${env:MIXSHIFT_MCP_TOKEN}" }
    }
  }
}
```

Set `MIXSHIFT_MCP_TOKEN` in the environment Cursor starts from, then toggle the server on under Settings, MCP. Note that Cursor caps the agent at roughly 40 tools across all enabled MCP servers combined; disable tools you do not use if you run several servers.

### Codex (CLI and IDE extension)

Add the server to `~/.codex/config.toml` (the CLI and the IDE extension share this file):

```toml
[mcp_servers.mixshift]
url = "https://mcp.mixshift.io/mcp"
bearer_token_env_var = "MIXSHIFT_MCP_TOKEN"
```

Set `MIXSHIFT_MCP_TOKEN` in your shell environment. Codex defaults to a 10 second startup timeout and a 60 second per-tool timeout; both are overridable per server (`startup_timeout_sec`, `tool_timeout_sec`) if you run long report pulls. Codex cloud tasks have no MCP configuration surface, so this covers the CLI and IDE only.

### ChatGPT

ChatGPT apps (the section formerly called connectors) authenticate with OAuth rather than a pasted token, and the MixShift server supports ChatGPT's automatic registration, so setup is one URL and a sign-in:

1. In ChatGPT on the web, open Settings, then Apps. Under Advanced settings, enable Developer mode (available on Pro, Plus, Business, Enterprise, and Education plans; on workspace plans an owner has to allow custom apps first under Permissions and Roles).
2. Back in Apps, click Create app. Enter the server URL `https://mcp.mixshift.io/mcp` with authentication set to OAuth.
3. ChatGPT opens the MixShift sign-in page. Sign in with your MixShift account and approve. Done.

Notes: ChatGPT limits each tool call to roughly 45 to 60 seconds, so very long report pulls can time out; ask for smaller windows if that happens. Custom apps work in regular chats via developer mode; deep research mode uses a different app shape and is not supported.

### Claude clients

Two ways to use MixShift from Claude:

**The plugin (recommended).** Installs into Cowork or Claude Code and ships all the MixShift skill workflows plus the raw tools, so it is the richest way to use MixShift from Claude. Sign-in is `mixshift auth login`, the flow at the top of this doc. Pick your install path: [Cowork personal](./install/cowork-personal.md), [Cowork organization](./install/cowork-organization.md), [Organization-level install (Claude admin console)](./install/org-admin-console.md), [Claude Code](./install/claude-code.md), or [CLI direct](./install/cli-direct.md).

**claude.ai custom connectors and Claude Desktop.** Add a custom connector with the server URL `https://mcp.mixshift.io/mcp`. Authentication is OAuth and registration is automatic: sign in with your MixShift account when prompted. No token pasting needed (unlike Cursor and Codex).

---

## Legacy raw-MySQL path (`mixshift auth setup`)

The raw-MySQL path (credentials fetched from the MixShift portal, a per-user IP whitelist, `--from-file`/`--password-file` setup) is retired and no longer supported for new setups. All authentication now goes through the token flow (`mixshift auth login`) or [service credentials](#service-credentials-unattended-runs). The `mixshift auth setup` command remains in the CLI only for backward compatibility with existing installations. If you need direct MySQL access for tooling outside the plugin, contact your MixShift account team.

---

## What's next

- [FAQ](./faq.md) — common questions about multi-user setups, troubleshooting
- [Privacy & telemetry](./privacy.md) — what the plugin collects during beta, how to opt out
- [Cowork personal install](./install/cowork-personal.md)
- [Cowork organization install](./install/cowork-organization.md)
- [Organization-level install (Claude admin console)](./install/org-admin-console.md)
- [Claude Code install](./install/claude-code.md)
- [CLI direct install](./install/cli-direct.md)
