---
name: welcome
description: >
  Show the MixShift plugin first-run welcome message. Use when the user says
  "welcome", asks "what is this plugin", asks how to get started, or is new
  and needs orientation on credential retrieval + initial setup steps.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - welcome
  - mixshift welcome
  - run welcome
  - what is mixshift
  - how do I get started
  - first time setup
  - quick start
  - get started with mixshift
  - show me the welcome screen
  - what does this plugin do
---

# Welcome

This skill is a thin wrapper around the `mixshift welcome` CLI command. The CLI renders either a 3-step first-run guide (URL + master password + what commands to run) or a "you're set up, here's what to try" view, depending on the user's current state.

## How to run

Execute the CLI command via Bash:

```bash
mixshift welcome
```

## How to reply

The Bash tool's output block displays the welcome content verbatim above your reply. The user already sees the full three-step walkthrough — URL, master password, field list, what to do next. **Do not re-render that content in your own words.**

Specifically, do NOT:
- Restate Step 1 / Step 2 / Step 3 in prose
- Paraphrase the credential URL, master password, or list of fields
- Compress multiple sub-sections (URL / password / field copy) into a single paragraph — that destroys the deliberate paragraph breaks in the CLI output

Acceptable reply structure (keep it to ~2 sentences total):
- One short acknowledgement of current state, e.g. *"You're at the very start — no credentials yet."*
- One short pointer to the next move, e.g. *"Say 'set up my credentials' once you've got the values from Step 1."*

If the user asks a follow-up about a specific step, reference the CLI output rather than re-stating it (e.g. *"see Step 2 in the output above"*). The author hand-wrote the wording with care; paraphrasing loses nuance and breaks the visual hierarchy.

## When to use

Trigger when the user:
- Says "welcome", "run welcome", "quick start"
- Asks "what is mixshift" or "how do I get started"
- Looks new and needs orientation
- Wants to verify their current setup status

**Don't trigger** for specific workflow requests like "run daily health check" or "export data" — those have their own dedicated skills.

## Output handling

The `mixshift welcome` command writes to stderr (so it shows up correctly in terminals). In Claude's Bash output you'll see the rendered text. Just pass it through to the user.

If the command fails with "command not found" or similar, fall back to a brief one-line message: *"Looks like the plugin's bin path isn't registered. Try restarting Claude Code, or run `node ${CLAUDE_PLUGIN_ROOT}/harness/dist/cli.js welcome` as a fallback."*

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill welcome
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill welcome --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill welcome --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back this turn), `skipped` (user opted out mid-flow).
