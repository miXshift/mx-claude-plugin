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

## Step 2 — Collect non-password inputs in chat

Ask the user for each field below, **one at a time**, EXCEPT the password (which has its own step — see Step 2b). Show suggested defaults where applicable.

| Field | Suggested default | Notes |
|---|---|---|
| Email | (none — ask) | For telemetry + IP whitelist requests |
| MySQL Username | (none — ask) | From the credentials page; e.g. "marpartners", "dash" |
| MySQL HostName | `db.mydashapplications.studio` | Most users; tenant subdomains override (e.g. `marpartners.mydashapplications.studio`) |
| MySQL Port | `3306` | Universal |
| MySQL Schema (database) | (same as Username they just gave) | Typical case — username "marpartners" → schema "marpartners". Sam's `dash` user is an outlier with schema `dashamazon` |

Confirm each field with the user before moving on. If they're unsure, refer them back to the URL from `mixshift welcome`.

## Step 2b — Password handling (CRITICAL)

**Never ask the user to paste the password into chat.** MixShift has no password-rotation feature for these credentials — many external integrations rely on this password being stable. If the password appears in chat history (or worse, gets interpreted by Claude Code's `!` prefix and routed to bash where it lands in error logs), the user has no clean recovery path.

Instead, walk them through this **safer file-based pattern**:

> "MixShift's MySQL passwords can't be rotated without breaking other integrations, so I won't ask you to paste it in chat. Instead, please save it to a text file:
>
> **On Windows:**
> 1. Open Notepad
> 2. Paste your password (only the password — no quotes, no labels, no extra characters or newlines)
> 3. Save as `C:\Users\<your-username>\AppData\Local\Temp\mxpw.txt` (or anywhere convenient — just tell me the exact path)
>
> **On macOS / Linux:**
> 1. Open any text editor
> 2. Paste your password
> 3. Save as `/tmp/mxpw.txt` (or any path you prefer)
>
> Once saved, tell me the path and I'll continue."

When the user gives you the path, use it as the `--password-file` argument to the harness. The harness reads the file directly — the password never appears in chat or in a bash command preview.

**Never echo the password back to the user in chat**, even when confirming inputs. When confirming, mask it as `********` or omit it entirely.

## Step 3 — Write the non-password fields to a temp YAML

Construct a YAML payload **without** the password (just an empty placeholder; the harness reads the real value from `--password-file`):

```yaml
email: <email>
mysql:
  host: <host>
  port: <port>
  user: <user>
  password: ""           # empty placeholder — --password-file supplies the real value
  database: <database>
```

Write to a temp file via heredoc (no password = safe to show in command preview):

```bash
cat > /tmp/mixshift-auth-input.yaml <<'EOF'
email: user@example.com
mysql:
  host: db.mydashapplications.studio
  port: 3306
  user: marpartners
  password: ""
  database: marpartners
EOF
```

On Windows / PowerShell:

```powershell
$content = @"
email: user@example.com
mysql:
  host: db.mydashapplications.studio
  port: 3306
  user: marpartners
  password: ""
  database: marpartners
"@
Set-Content -Path "$env:TEMP\mixshift-auth-input.yaml" -Value $content -Encoding utf8
```

## Step 4 — Run the CLI with `--password-file`

```bash
mixshift auth setup \
  --from-file /tmp/mixshift-auth-input.yaml \
  --password-file /tmp/mxpw.txt \
  --request-whitelist
```

(Use the actual path the user gave you for `--password-file`.)

The harness reads the password from the file directly — it never appears in the command line, chat, or bash command preview. The `--request-whitelist` flag auto-POSTs to the Discord ops channel if the connection test fails with "host not allowed."

## Step 5 — Interpret the exit code

| Exit | Meaning | What to tell the user |
|---|---|---|
| 0 | Auth setup complete, connection verified | "✓ You're connected. Try `mixshift welcome` to see what's next." |
| 1 | Hard failure (bad creds, schema mismatch, etc.) | Pass the friendly error message through |
| 3 | Pending IP whitelist — request sent to MixShift ops | "✓ Credentials saved. Your IP isn't whitelisted yet — we sent a request to MixShift ops. You'll get an email when access is granted (usually within a few hours). Re-run any skill afterwards." |

## Step 6 — Clean up both temp files

**Always** delete BOTH temp files after the command finishes, regardless of outcome:
- The YAML temp file (no password in it now, but still scratch state)
- The password file (contains the plaintext password — most important to delete)

```bash
rm /tmp/mixshift-auth-input.yaml /tmp/mxpw.txt      # POSIX
```

```powershell
Remove-Item "$env:TEMP\mixshift-auth-input.yaml" -ErrorAction SilentlyContinue
Remove-Item "$env:TEMP\mxpw.txt" -ErrorAction SilentlyContinue
```

If the user gave you a non-standard path for the password file, delete that path specifically.

## Hard rules

- **Never ask the user to paste the password into chat** — always use the file-based pattern in Step 2b. MixShift can't easily rotate these passwords, so a leak is a meaningful cost.
- **Never echo the password** back to the user, even when confirming inputs. Mask as `********` or omit.
- **Always delete BOTH temp files** — the password file especially.
- **Never put the password on the command line** (e.g., `--password=...`). It appears in bash command previews + process lists. Use `--password-file` instead.
- If `--from-file` / `--password-file` somehow fail, fall back to: "Open a terminal and run `mixshift auth setup` directly — TTY prompts work there and the password is hidden by the prompt's masking."
- Don't proceed to other skills until exit code 0 or 3 is reached.
