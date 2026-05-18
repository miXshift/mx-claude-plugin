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

Execute the CLI command via Bash with the `--format chat` flag:

```bash
mixshift welcome --format chat
```

The `--format chat` flag tells the harness to render markdown formatted for direct chat display (instead of the ASCII-formatted terminal version). Every install renders the same text because the harness owns the wording.

## How to reply

**Surface the bash output verbatim as your chat reply.** The text is already chat-ready markdown — bolded step headings, paragraph breaks at sub-section boundaries, plain prose. Render it as natural chat (NOT inside a code block) so the markdown formatting works.

Specifically:
- Copy the markdown content from the bash output into your reply.
- Do NOT add prose around it ("here's the welcome screen", "let me walk you through…") — the text starts with "Welcome to the MixShift plugin" and is self-contained.
- Do NOT modify, paraphrase, condense, or restructure the text. It's hand-written to land cleanly in chat; edits cause regressions.
- Do NOT also paste the raw bash code block above the rendered version — one display of the welcome is enough.

If the user asks a follow-up about a specific step, reference the rendered text rather than re-rendering it. If the iteration needs to change the wording, that's a harness fix in `welcome.ts::renderWelcomeChat()`, not a SKILL.md edit.

### Fallback

If `mixshift welcome --format chat` fails ("command not found", harness error, etc.), fall back to:

1. `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js welcome --format chat` — same output, absolute path.
2. As a last resort, the older `mixshift welcome` (no --format flag) outputs the terminal-ASCII version. Surface that as-is in a code block; don't try to paraphrase it.

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
