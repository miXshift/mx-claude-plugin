---
name: auth-setup
description: >
  Walk the user through one-time MixShift warehouse auth setup. Collects
  email + MySQL credentials interactively in chat (not via TTY prompts —
  Claude Code's Bash tool can't drive those), writes them to a temp file,
  runs the harness's non-interactive `mixshift auth setup --from-file`,
  and cleans up. Required before any data-touching skill.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - auth setup
  - set up auth
  - run auth setup
  - run mixshift auth setup
  - set up my credentials
  - configure mixshift
  - configure my warehouse access
  - connect to warehouse
  - install credentials
---

# Auth Setup (Claude-chat orchestrated)

Why this skill exists: `mixshift auth setup` in interactive mode uses TTY prompts that don't work inside Claude Code's Bash tool. This skill collects the same inputs **in chat** instead, then runs the CLI's non-interactive `--from-file` mode.

## Step 1 — Show credential-retrieval instructions

```bash
mixshift welcome
```

That command renders the URL + master password the user needs to retrieve their MySQL credentials. Surface its output to the user.

If they've already run `welcome` and have the credentials in hand, skip ahead.

## Step 2 — Collect inputs in chat (ask one at a time)

Ask the user for each field. Show suggested defaults where applicable but don't assume — the credentials page is the source of truth.

| Field | Suggested default | Notes |
|---|---|---|
| Email | (none — ask) | For telemetry + IP whitelist requests |
| MySQL Username | (none — ask) | From the credentials page; e.g. "marpartners", "dash" |
| MySQL Password | (none — ask) | **See "Password input handling" below — DO NOT just say "paste the password"** |
| MySQL HostName | `db.mydashapplications.studio` | Most users; tenant subdomains override (e.g. `marpartners.mydashapplications.studio`) |
| MySQL Port | `3306` | Universal |
| MySQL Schema (database) | (same as Username they just gave) | Typical case — username "marpartners" → schema "marpartners". Sam's `dash` user is an outlier with schema `dashamazon` |

Confirm each field with the user before moving on. If they're unsure, refer them back to the URL from `mixshift welcome`.

### Password input handling — IMPORTANT

Claude Code interprets messages starting with `!` as Bash commands. If the user just pastes their password and it happens to start with `!`, or they hit `!` before pasting, the password will be executed as a shell command — leaking it to a "command not found" error AND leaving it in chat history AND bash logs.

**Always ask the user for the password using one of these safer patterns:**

> "What's your MySQL password? Please paste it in the format `password is: YOUR_PASSWORD_HERE` (not just the bare password — Claude Code can interpret messages starting with `!` as bash commands)."

Or:

> "Paste your MySQL password wrapped in backticks, like \`your_password\` — that way special characters don't get interpreted by Claude Code's input parser."

Then parse the actual password value out of their reply. **Never echo the password back to the user in chat**, even when confirming inputs. When confirming, mask it as `********` or omit it entirely.

If the user's password DID appear bare in chat (e.g., they ignored the format guidance and Claude Code ran it as bash), gently note that the password has been logged and they may want to rotate it on the credentials page after setup.

## Step 3 — Write to a temp file

Construct a YAML payload with this exact shape:

```yaml
email: <email>
mysql:
  host: <host>
  port: <port>
  user: <user>
  password: <password>
  database: <database>
```

Write to a temp file:
- Windows: `$env:TEMP\mixshift-auth-input.yaml` (via PowerShell) or `%TEMP%\mixshift-auth-input.yaml` (cmd) — in practice `C:\Users\<user>\AppData\Local\Temp\mixshift-auth-input.yaml`
- POSIX: `/tmp/mixshift-auth-input.yaml`

Use Bash's heredoc pattern so multi-line YAML writes correctly:

```bash
cat > /tmp/mixshift-auth-input.yaml <<'EOF'
email: user@example.com
mysql:
  host: db.mydashapplications.studio
  port: 3306
  user: marpartners
  password: <their password — keep this line verbatim>
  database: marpartners
EOF
```

On Windows / PowerShell, use `Set-Content` with `-Encoding utf8`:

```powershell
$content = @"
email: user@example.com
mysql:
  host: db.mydashapplications.studio
  port: 3306
  user: marpartners
  password: <their password>
  database: marpartners
"@
Set-Content -Path "$env:TEMP\mixshift-auth-input.yaml" -Value $content -Encoding utf8
```

## Step 4 — Run the CLI

```bash
mixshift auth setup --from-file /tmp/mixshift-auth-input.yaml --request-whitelist
```

The `--request-whitelist` flag tells the harness to auto-POST to the Discord ops channel if the connection test fails with "host not allowed" — saves a step.

## Step 5 — Interpret the exit code

| Exit | Meaning | What to tell the user |
|---|---|---|
| 0 | Auth setup complete, connection verified | "✓ You're connected. Try `mixshift welcome` to see what's next." |
| 1 | Hard failure (bad creds, schema mismatch, etc.) | Pass the friendly error message through |
| 3 | Pending IP whitelist — request sent to MixShift ops | "✓ Credentials saved. Your IP isn't whitelisted yet — we sent a request to MixShift ops. You'll get an email when access is granted (usually within a few hours). Re-run any skill afterwards." |

## Step 6 — Clean up the temp file

**Always** delete the temp file after the command finishes, regardless of outcome — it contains the user's plaintext password.

```bash
rm /tmp/mixshift-auth-input.yaml      # POSIX
```

```powershell
Remove-Item "$env:TEMP\mixshift-auth-input.yaml" -ErrorAction SilentlyContinue   # Windows
```

## Hard rules

- **Never echo the password** back to the user in chat — even when confirming inputs
- **Always delete the temp file** — failure cleanup matters too
- **Use heredoc / here-string syntax** so YAML special characters (`:`, `#`, quotes) in the password don't break the file
- If `--from-file` somehow fails, fall back to: "Open a terminal and run `mixshift auth setup` directly — TTY prompts work there"
- Don't proceed to other skills until exit code 0 or 3 is reached
