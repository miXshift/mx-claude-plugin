# Auth setup

This doc explains what `mixshift auth setup` does, the two ways to drive it (chat-orchestrated vs CLI), how the `--from-file` + `--password-file` mechanism works, and how the IP whitelist flow handles first-time connections.

The auth flow is **the same for all four install paths** (Cowork personal, Cowork organization, Claude Code, CLI direct). Only the install ceremony differs.

---

## What auth setup does

In one sentence: writes a credentials file at `~/.mixshift/auth/credentials` containing your MySQL connection details, validates that the credentials work, and (if needed) asks MixShift ops to grant your IP access to the warehouse.

Concretely:

1. **Collects inputs:** your email + MySQL host / port / username / schema / password.
2. **Validates the shape:** required fields present, port in range, host reachable.
3. **Writes profile:** `~/.mixshift/profile.yaml` with your email.
4. **Writes credentials:** `~/.mixshift/auth/credentials` with the MySQL connection bundle (`host`, `port`, `user`, `database`, `password`).
5. **Tests the connection:** runs a trivial query against the warehouse to confirm everything works.
6. **If the connection fails because your IP isn't whitelisted:** optionally posts a webhook to MixShift ops with your email + public IP. An operator grants access manually (usually within hours); you'll get an email when access is live.

After step 4, the plugin has everything it needs. Steps 5–6 are validation; you can skip them with `--skip-connection-test` for CI / scripted use.

---

## Where the credentials come from

MixShift issues warehouse credentials via a self-service page on the legacy platform:

- **Default URL:** `https://www.mydashapplications.com/database-admin`
- **Your tenant's URL:** if your MixShift account is on a tenant-specific subdomain (e.g. `yourcompany.mydashapplications.studio`), use that. The welcome screen prints the right URL for your tenant.
- **Master password:** prompted when you load the credentials page. It's a value **shared across all MixShift customers** — it's a guard against accidental credential exposure (anyone with the URL but not the password can't see anything), not a per-user secret. `mixshift welcome` prints the master password too.

The credentials page shows five values:

- **HostName** — usually `db.mydashapplications.studio`, sometimes tenant-specific
- **Username** — typically matches your MixShift tenant slug
- **Port** — `3306`
- **Schema** — usually matches Username; the canonical legacy schema is `dashamazon`
- **Password** — your MySQL password (treat like any other production credential)

You paste these into `mixshift auth setup`.

---

## How to run auth setup

### Method 1 — Chat-orchestrated (Cowork + Claude Code, the recommended path)

In any Cowork or Claude Code chat, say:

- "set up my credentials"
- "run auth setup"
- "configure mixshift"

Claude triggers the `auth-setup` skill, which walks you through each value. For the password, **Claude will ask you to save it to a temp file on disk** instead of pasting it directly into chat — this keeps the password out of your chat transcript / scrollback.

Typical flow:

```
You:   set up my credentials
Claude: Walks through email + host + port + username + schema.
Claude: For the password, save it to a text file (e.g. /tmp/mixshift-pw.txt)
        and tell me the path.
You:   /tmp/mixshift-pw.txt
Claude: Runs `mixshift auth setup --from-file <yaml> --password-file /tmp/mixshift-pw.txt`
Claude: ✓ Auth setup complete.
```

Why the file path indirection? Two reasons:
1. **Password isn't echoed.** It doesn't appear in chat history, Claude's context, or any logs.
2. **Cowork / Claude Code Bash tools don't pass a TTY.** Interactive prompts would fail with "User force closed the prompt". The `--from-file` path bypasses prompts entirely.

### Method 2 — CLI direct (terminal, no Claude)

If you're in your own terminal (a real TTY), interactive prompts work:

```bash
mixshift auth setup
```

The harness prompts for each field. Password input is masked with `*`.

### Method 3 — Fully scripted (CI / automation / shared rollout)

Same `--from-file` + `--password-file` flow that the chat-orchestrated path uses internally:

```bash
mixshift auth setup \
  --from-file creds.yaml \
  --password-file pw.txt \
  --request-whitelist
```

YAML schema:

```yaml
email: you@example.com
mysql:
  host: db.mydashapplications.studio
  port: 3306
  user: yourmixshiftuser
  database: yourmixshiftschema
  password: ""   # leave empty; harness uses --password-file
```

The password file is just the password text — no quotes, no labels. The harness aggressively normalizes editor-noise: strips UTF-8 BOM, strips all trailing CR/LF (Notepad-on-Windows habitually adds both; we account for that).

`--request-whitelist` makes the harness auto-fire the IP whitelist webhook if the connection test fails. Without it, the harness asks for confirmation first; with it, no prompt needed.

---

## Pre-bundling credentials for a team

This is the "share with my team" pattern useful for [Cowork organization installs](./install/cowork-organization.md). Today, MixShift legacy uses **a single MySQL login per customer organization** — every user at your org enters the same values. Without pre-bundling, that's 5 people typing the same 5 values; with pre-bundling, it's one command per user.

**Admin side (do once):**

1. Get credentials from the MixShift portal.
2. Save them to `mixshift-creds.yaml` (substitute real values):

   ```yaml
   email: REPLACE@WITH-YOUR-EMAIL   # each user sets their own
   mysql:
     host: db.mydashapplications.studio
     port: 3306
     user: yourmixshiftuser
     database: yourmixshiftschema
     password: ""
   ```

3. Save the password to `mixshift-password.txt` (just the password, nothing else).
4. Share both files via your team's secrets manager (1Password, Doppler, encrypted Slack, etc.). Treat the password file like any other production credential.

**User side (each teammate):**

1. Download both files locally.
2. Edit `mixshift-creds.yaml` to substitute their own email at `email:`.
3. Run:

   ```bash
   mixshift auth setup \
     --from-file ~/Downloads/mixshift-creds.yaml \
     --password-file ~/Downloads/mixshift-password.txt \
     --request-whitelist
   ```

That's it. One command per user. The harness writes `~/.mixshift/auth/credentials` on their machine and tests the connection.

Each user still goes through their own IP whitelist if their public IP isn't yet on the allowlist. IP whitelists are per-IP, not per-MixShift-org.

---

## IP whitelist flow

The MixShift warehouse is firewalled — connections from non-allowlisted IPs are rejected at the network level. First-time users will hit this.

What happens:

1. `mixshift auth setup` writes the credentials, then tests the connection.
2. If the connection fails with a "host not allowed" error, the harness exits with code `3` (= "credentials saved, waiting on whitelist") and prints a message asking whether to send a whitelist request.
3. If you say yes (or pass `--request-whitelist` upfront), the harness:
   - Detects your public IP via `https://api.ipify.org`.
   - Posts a structured message to MixShift's Discord ops channel via webhook (URL is shipped in the plugin defaults; you can override via env var).
   - Message includes: your email, your public IP, your MySQL host (so ops knows which warehouse), a timestamp.
4. A MixShift operator manually grants your IP read access on the warehouse. Typically within a few hours during business hours.
5. You'll get an email confirmation when access is live.
6. Re-run any skill — connection should succeed.

If you want to skip the auto-request and email someone manually, pass `--skip-connection-test` to `mixshift auth setup`. Credentials still get saved; you just don't auto-fire the webhook.

---

## File locations + ownership

All auth state lives under `~/.mixshift/` on your local machine:

```
~/.mixshift/
├── auth/
│   └── credentials      # YAML, 0600 permissions — read by every harness command
├── profile.yaml         # Your email + plugin defaults overrides
├── clients/             # Per-brand context directories (when you onboard brands)
└── tmp/                 # Scratch space for prefetch artifacts
```

The `~/.mixshift/` directory is **per-OS-user**. Cowork doesn't share filesystem state across users; same for Claude Code. If two users on the same machine both want to use the plugin, each one's credentials are scoped to their own `~/`.

Permissions:
- `auth/credentials` is written with `0600` (owner read/write only).
- The rest of `~/.mixshift/` is whatever your umask gives.

---

## Updating credentials

If MixShift rotates your password, or you've moved to a different host/schema, just re-run auth setup:

```bash
mixshift auth setup
```

It overwrites `~/.mixshift/auth/credentials` with the new values. No special "update" command needed — same flow as initial setup.

In chat: "update my credentials" or "re-run auth setup".

---

## Troubleshooting

**"User force closed the prompt".**
You're hitting the non-TTY detection. Either run `mixshift auth setup` in your own terminal (not through Claude Code or Cowork's Bash tool), OR use the chat-orchestrated `--from-file` flow.

**"Password file is empty after stripping BOM and trailing newlines".**
The text file you saved the password to has nothing in it after the harness normalizes editor artifacts. Open the file and confirm there's actual content. Notepad-on-Windows adds a CRLF when you save; the harness strips that, but if you only typed the password with no other content, double-check that the file isn't empty.

**"Connection test failed: ER_ACCESS_DENIED_ERROR".**
Username or password is wrong. Re-check the values on the credentials page; usernames are case-sensitive on some MySQL setups.

**"Connection test failed: Host '...' is not allowed to connect to this MySQL server".**
IP whitelist. See the IP whitelist flow section above.

**"Connection test timed out".**
Either the host is unreachable (network issue, VPN required, etc.) or your IP is silently dropped (whitelist + network filter combined). Try `mysql -h <host> -u <user> -p` directly from your terminal to confirm.

**You want to test without writing files.**
The harness writes `~/.mixshift/auth/credentials` unconditionally during setup — there's no dry-run mode today. Override the data dir with `--data-dir /tmp/test-mixshift` to write somewhere ephemeral.

---

## What's next

- [FAQ](./faq.md) — common questions about multi-user, data visibility, troubleshooting
- [Cowork personal install](./install/cowork-personal.md)
- [Cowork organization install](./install/cowork-organization.md)
- [Claude Code install](./install/claude-code.md)
- [CLI direct install](./install/cli-direct.md)
