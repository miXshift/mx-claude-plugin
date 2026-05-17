# Install in Claude Code

**Who this is for:** You use Claude Code (Anthropic's terminal-based Claude CLI) instead of, or in addition to, Cowork desktop. Plugins in Claude Code install via slash commands.

If you use Cowork, you want [Cowork — Personal install](./cowork-personal.md) or [Cowork — Organization install](./cowork-organization.md) instead.

---

## Prereqs

- Claude Code installed and working (`claude` command available in your terminal)
- An active MixShift customer account with warehouse access
- `node` ≥ 20 on your machine (the bundled CLI requires it)

You can install the plugin into any Claude Code session — it lives on your local machine, per-user.

---

## Step 1 — Add the marketplace

In any Claude Code session, run:

```
/plugin marketplace add miXshift/mx-claude-plugin
```

Claude Code fetches the marketplace manifest from the public GitHub repo. This is a per-user operation — only your Claude Code install knows about the marketplace, not anyone else's.

## Step 2 — Install the plugin

```
/plugin install mixshift-ai@mx-claude-plugin
```

(The `@mx-claude-plugin` suffix tells Claude Code which marketplace to install from. Necessary if you have multiple marketplaces registered, harmless otherwise.)

Confirm:

```
/plugin
```

Should list `mixshift-ai` with version `0.3.0` (or newer).

## Step 3 — First run

In Claude Code chat, say:

- "welcome"
- "how do I get started"

Claude runs the welcome skill via the Bash tool. You'll see the credential URL, master password, and the three-step quickstart.

## Step 4 — Get warehouse credentials

Same as the Cowork flow:

1. Open the credential-retrieval URL printed by `mixshift welcome` (default `https://www.mydashapplications.com/database-admin`).
2. Enter the master password (also printed by welcome).
3. Copy HostName, Port, Username, Schema, Password.

## Step 5 — Run auth setup

Two options in Claude Code:

### Option A — Chat-orchestrated (same as Cowork)

Say "set up my credentials". Claude walks you through the values. Your password goes through a temp file (Claude asks you to save it locally and provide the path) — the harness reads it with `--password-file` and never echoes it.

### Option B — Direct terminal command (Claude Code only)

If you're already in a terminal, you can skip the chat orchestration and just run:

```bash
mixshift auth setup
```

Claude Code's Bash tool doesn't pass a TTY, but if you run the command in **your own terminal** (not through Claude), you'll get interactive prompts for each field. The password prompt masks input with `*`.

If you want to avoid prompts entirely:

```bash
mixshift auth setup --from-file creds.yaml --password-file pw.txt --request-whitelist
```

(See [auth setup deep dive](../auth-setup.md) for the YAML schema and the `--password-file` mechanics.)

## Step 6 — Verify

```bash
mixshift welcome
```

Should print the "you are already set up" view.

Then try data exploration:

```
"what tables can I query"
"show me a sample of campaignmetric for seller [your SellerID]"
"export [brand]'s campaign data for last week to CSV"
```

Or from a terminal directly:

```bash
mixshift data list-tables
mixshift data sample --table campaignmetric --seller-id <N> --limit 10
mixshift brand discover --json
```

---

## Updates

```
/plugin update mixshift-ai
```

Or to update all installed plugins:

```
/plugin update --all
```

Auth credentials carry over across plugin updates.

---

## Troubleshooting

**"Marketplace not found" when running `/plugin marketplace add`.**
Confirm the GitHub repo is reachable from your machine: `curl -sI https://github.com/miXshift/mx-claude-plugin/blob/main/.claude-plugin/marketplace.json` should return a 200 (or redirect). If you're behind a corporate proxy, configure `git` to use it; Claude Code uses `git` under the hood for marketplace fetches.

**"command not found: mixshift" after install.**
Claude Code should auto-add the plugin's `bin/` directory to the Bash tool's PATH. If it doesn't, you have two workarounds:
- Run via the absolute path: `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js welcome`
- Add the bin path to your shell's PATH manually: `export PATH="$HOME/.claude/plugins/mxshift-ai/bin:$PATH"` (exact path may vary)

**Connection test hangs during auth setup.**
Your IP isn't on the MixShift warehouse allowlist. The harness should ask permission to send a whitelist request; if you skipped that prompt, re-run with `--request-whitelist`:
```bash
mixshift auth setup --request-whitelist
```

**"User force closed the prompt".**
You're hitting the non-TTY detection. Either run `mixshift auth setup` in your own terminal (not through Claude Code's Bash tool) OR use the chat-orchestrated `--from-file` flow.

---

## What's next

- [Auth setup deep dive](../auth-setup.md)
- [FAQ](../faq.md)
- [CLI direct install](./cli-direct.md) — if you want the harness CLI without going through a plugin host at all (e.g. for scripting or CI)
