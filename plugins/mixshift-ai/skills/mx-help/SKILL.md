---
name: mx-help
description: >
  Navigation and discovery hub for the MixShift plugin. Use when the user asks
  for help, says they are stuck or lost, asks what the plugin or a specific
  skill can do, asks how to do something or where to find something, wants to
  browse or list the available skills, or wants to know how to fix a problem.
  Renders the capability map via `mixshift guide --format chat`, then routes the
  user to the right skill, the `mixshift doctor` diagnostic, feedback, or docs.
  Do NOT use for first-run setup or sign-in (that is mx-welcome), or for actually
  sending feedback (that is mx-feedback); this hub points to those.
metadata:
  version: "0.1.1"
  author: "MixShift"
trigger_phrases:
  - help
  - i need help
  - im stuck
  - i'm stuck
  - i'm lost
  - what can you do
  - what can this do
  - what can this plugin do
  - what can i do here
  - what are my options
  - how do i
  - where do i find
  - where is
  - show me what's available
  - list skills
  - list the skills
  - what skills are there
  - how do i fix
  - navigate
  - capabilities
---

# Help: the MixShift navigation hub

This skill is a thin wrapper around the `mixshift guide` CLI command (named
`guide`, not `help`, because the CLI framework reserves `help`). It renders an
outcome-grouped map of everything the plugin can do. Your job after that is to
take the user to the specific thing they want.

## When to use this

Trigger when the user:
- Says "help", "I'm stuck", "I'm lost", "what are my options"
- Asks "what can this do", "what can I do here", or "what does <skill> do"
- Asks "how do I <something>" or "where do I find <something>"
- Wants to list or browse the available skills
- Asks how to fix a problem, or says something is not working and wants to solve it

Do NOT trigger for:
- First-run setup, sign-in, or "what is MixShift" / "get started". That is **mx-welcome**.
- Actually sending a bug report or feature request. That is **mx-feedback** (this hub points to it).
- A concrete workflow the user already named ("run daily health check", "export data"). Go straight to that skill.

## Step 1 — Render the hub

Run via Bash:

```bash
mixshift guide --format chat
```

Surface the output verbatim as your reply. It is chat-ready markdown (grouped
headings, bolded "say this" phrases). Do NOT wrap it in a code block, do NOT
paraphrase or condense it, and do NOT paste the bash command above it.

### Fallback if the CLI fails

1. `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js guide --format chat` is the same output via an absolute path.
2. **If there is no shell at all (for example claude.ai web):** present the
   capability map yourself, built from the MixShift skills available in this
   session, grouped by outcome. Use this structure and fill each group from the
   skills you can actually see:
   - Get set up & signed in
   - Explore data & pull reports
   - Daily & weekly account health
   - Search terms, negatives & harvesting
   - Live Amazon surfaces (Ads, AMC, DSP)
   - Reporting & analysis
   - Help, feedback & contributing
   For each group, give one or two concrete example phrases the user can say.
   Keep it warm and short, and end by asking which area they want.

## Step 2 — Route the user (the important part)

The map is the menu, not the destination. After rendering:

- **If the user already named what they want** ("how do I export to CSV?", "what does cold start do?"): answer directly. Name the one skill that fits, say in one line what it does, and offer to start it (for example *"That is mx-data-explore. Want me to open it? Just say 'explore my data'."*). Do not make them re-read the whole map. If they ask about "cold start", answer in brand-setup terms: that is **brand setup** (the mx-brand-context skill); it builds the brand context that unlocks the analytical skills, and they can start it by saying *"set up \<brand\>"*.
- **If the user named a rough want but also signals they are unsure or lost** ("load some data, I don't know where to start"; "I want to check my campaigns but don't know where to begin"): give them the option, do not silently pick one path. Lead with the single best-fit skill and offer to start it, and in the same breath offer the broader map as the alternative. For example: *"Sounds like you want to explore your warehouse data, which is mx-data-explore. I can open it right now, or if you'd rather see everything the plugin can do first I can show you the full map. Which would you prefer?"* Then do what they choose.
- **If the user is vague** ("help", "what can this do"): show the map, then ask which area they want. When they pick one, drill in: name the 2 to 3 skills in that area and the exact phrase to start each.
- **Keep it to two steps:** stuck, then area, then the exact thing. Do not bury the answer.

To actually run a skill, tell the user the phrase that triggers it, or, if they clearly want it now, proceed into that skill. This hub never runs the analytical skills itself; it points.

## Step 3 — Troubleshooting ("how do I fix X")

If the user is stuck because something is wrong:

0. **If every `mixshift` command (including `mixshift doctor`) fails with a "command not found"-style error, or hangs with no output at all:** check `node --version` first. Missing Node.js is the most common cause on machines that have never run a terminal tool; the plugin's CLI needs Node 20 or newer, and without it no `mixshift` command can even print an error. Help the user install it (macOS: `brew install node` if Homebrew exists, otherwise the nodejs.org LTS installer; Windows: `winget install OpenJS.NodeJS.LTS`), then retry.
1. Run the diagnostic and read it back in plain language:
   ```bash
   mixshift doctor
   ```
   It reports the running version (and whether it is stale), sign-in state, warehouse connectivity, query-pack compatibility, and telemetry, each with the fix.
2. Map the common cases:
   - Not signed in: offer **mx-welcome** or **mx-auth-login** ("say 'sign me in'").
   - Out of date: surface the doctor's "how to update" line.
   - Service unreachable: surface the doctor's allowlist and proxy remediation.
3. **If it turns out to be a real bug** (not a setup issue), offer to file it via **mx-feedback**: *"Want me to send this to the MixShift team as a bug? Takes a second."* Do not send anything without the user's yes.

## Step 4 — Feedback and sharing

The hub also points two ways outward. Offer these when they fit:
- **Feedback** (bugs, requests, comments): route to **mx-feedback**.
- **Share a skill they built**: route to **mx-share-skill** ("say 'I built a skill'").

## Hard rules

- The CLI owns the map's wording. If the map text needs to change, that is a harness edit in the `guide` command (`commands/help.ts`), not a SKILL.md edit.
- Do not invent skills or capabilities. If the user asks for something the plugin does not do, say so plainly and offer to file it as a feature request via mx-feedback.
- Stay a router. Hand off to the real skill rather than half-doing its job here.

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-help
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-help --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-help --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (hub rendered and the user was routed), `failed` (CLI errored and no fallback worked), `deferred` (waiting on the user to pick an area), `skipped` (user backed out). The `guide` command separately emits `help.viewed` when it renders.
