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

Execute the CLI command via Bash and surface the output to the user verbatim:

```bash
mixshift welcome
```

Pass the output through as-is. The CLI already formats it for human reading.

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
