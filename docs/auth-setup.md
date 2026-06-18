# Authentication

This doc covers signing in to the MixShift warehouse from the plugin. Three paths:

1. **Token-based browser sign-in** (`mixshift auth login`) — the recommended path for humans. No raw database credentials, no IP whitelist setup.
2. **Service credentials** (`mixshift auth service-setup`) — for unattended runs: scheduled Cowork tasks, cloud automations, CI. No browser, no human at run time. See [Service credentials](#service-credentials-unattended-runs).
3. **Legacy raw-MySQL** (`mixshift auth setup`) — backward compatibility only, documented at the bottom.

The interactive flow is **the same for all four install paths** (Cowork personal, Cowork organization, Claude Code, CLI direct). Only the install ceremony differs.

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
mixshift data run-query "SELECT NOW() AS db_time, USER() AS db_user"
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

## Legacy raw-MySQL path (`mixshift auth setup`)

The legacy path uses raw MySQL credentials retrieved from a MixShift portal page, with a per-user IP whitelist on the warehouse. It's still in the harness for backward compatibility and continues to work — but new installs should use `auth login`. The legacy flow is appropriate when:

- You need direct MySQL connection details for tooling outside the plugin (e.g. MySQL Workbench, a custom BI tool).
- Your environment can't reach `mcp.mixshift.io` for some reason.
- You're explicitly maintaining a CI pipeline that already has the raw-MySQL setup wired.

For everything else, use `auth login`.

### How the legacy path works

Same end state — credentials at `~/.mixshift/auth/credentials` — but with different contents (a `mysql` block instead of a `datahub` block), and a per-user IP whitelist step.

Run in a terminal:

```bash
mixshift auth setup
```

Interactive TTY prompts walk you through:
- **Email** (for telemetry + IP whitelist requests)
- **HostName, Username, Port, Schema, Password** — fetched from `https://www.mydashapplications.com/database-admin` after entering the shared "master password" prompted there.

If your IP isn't whitelisted yet, pass `--request-whitelist` to auto-fire a webhook to MixShift ops, who'll grant access manually (typically within a few hours).

For non-interactive / scripted use, see `mixshift auth setup --from-file <yaml> --password-file <path>` — same mechanism the (now-retired) chat-orchestrated path used. The legacy CLI command remains available; the chat surface no longer drives it.

### Pre-bundling credentials for a team (legacy path)

For team-wide deployments of the legacy path (multi-user agency / org with shared MySQL creds), the admin can pre-bundle:

1. Save credentials to `mixshift-creds.yaml`:

   ```yaml
   email: REPLACE@WITH-YOUR-EMAIL   # each user sets their own
   mysql:
     host: db.mydashapplications.studio
     port: 3306
     user: yourmixshiftuser
     database: yourmixshiftschema
     password: ""
   ```

2. Save the password to `mixshift-password.txt` (just the password, no quotes / labels).
3. Share both via your team's secrets manager.
4. Each user downloads, edits `mixshift-creds.yaml` to set their own `email:`, and runs:

   ```bash
   mixshift auth setup \
     --from-file ~/Downloads/mixshift-creds.yaml \
     --password-file ~/Downloads/mixshift-password.txt \
     --request-whitelist
   ```

Each user still goes through their own IP whitelist if their public IP isn't yet on the allowlist.

This pattern is unnecessary for the recommended `auth login` flow — each user just runs `mixshift auth login` and signs in with their MixShift account.

---

## What's next

- [FAQ](./faq.md) — common questions about multi-user setups, troubleshooting
- [Privacy & telemetry](./privacy.md) — what the plugin collects during beta, how to opt out
- [Cowork personal install](./install/cowork-personal.md)
- [Cowork organization install](./install/cowork-organization.md)
- [Claude Code install](./install/claude-code.md)
- [CLI direct install](./install/cli-direct.md)
