---
name: mx-welcome
description: >
  Show the MixShift plugin first-run welcome message. Use when the user says
  "welcome", asks "what is this plugin", asks how to get started, or is new
  and needs orientation on credential retrieval + initial setup steps.
metadata:
  version: "0.1.2"
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

This skill is a thin wrapper around the `mixshift welcome` CLI command. The CLI renders one of two views depending on the user's current state:

- **Not signed in:** a 2-step first-run guide (sign in → try something).
- **Signed in:** a "here's what to try" view with the user's brand counts and a state-aware navigation ladder.

In the **not-signed-in** case, this skill does NOT stop at rendering — it also drives the sign-in inline. See "What to do" below.

## What to do (overall flow)

1. **Run the Node.js preflight** (see "Step 0: preflight" below). Every `mixshift` command runs on Node.js; if Node is missing, nothing else in this flow can work, so check it first.
2. **Render the welcome text** via the CLI (see "Render the welcome text" below).
3. **Inspect the rendered output for the user's state line.** The output ends with one of:
   - `Current state: ✗ not signed in yet` → go to step 4 (drive sign-in inline).
   - `Current state: ✓ ...` → done. Welcome content is self-contained for returning users; surface it and stop. Do not invoke any other skill.
4. **If not signed in, drive the sign-in inline** (see "Drive the sign-in inline" below). This is mandatory — don't wait for the user to say "sign in to mixshift" or any other phrase. The welcome copy has already told them you'll set up the sign-in link next; you MUST follow through.

## Step 0: preflight (check Node.js before anything else)

Before running ANY `mixshift` command (including the telemetry emits below), verify Node.js is available. Run via Bash:

```bash
node --version
```

- **If it prints v20 or newer** (for example `v22.11.0`): continue to "Render the welcome text".
- **If the command fails, `node` is not found, or the version is below 20:** STOP. Do not attempt any `mixshift` command. The plugin's CLI has a Node shebang, so without Node every command fails before it can print a friendly error (on some hosts the tool calls just churn with no output at all). Instead:
  1. Tell the user plainly: the MixShift plugin needs Node.js (version 20 or newer) on this machine, and it is not installed yet. This is a quick one-time install, common on machines that have never run developer tooling.
  2. Offer to install it for them:
     - **macOS:** check for Homebrew first (`brew --version`). If present, run `brew install node`. If not, point them at the official installer at https://nodejs.org (choose the LTS version); installing Homebrew first is a bigger detour than they need.
     - **Windows:** run `winget install OpenJS.NodeJS.LTS`.
  3. After the install, re-run `node --version` to confirm. A fresh install sometimes is not on PATH until a new session; if the check still fails right after a successful install, ask the user to fully restart the Claude app (or open a new session) and say "welcome" again.
  4. Once `node --version` succeeds, continue the welcome flow from "Render the welcome text". (Skip the telemetry emits for the portion of the flow that ran before Node existed; emit from this point on as normal.)

## Render the welcome text

Execute the CLI command via Bash with the `--format chat` flag:

```bash
mixshift welcome --format chat
```

The `--format chat` flag tells the harness to render markdown formatted for direct chat display (instead of the ASCII-formatted terminal version). Every install renders the same text because the harness owns the wording.

**Surface the bash output verbatim as your chat reply.** The text is already chat-ready markdown — bolded step headings, paragraph breaks at sub-section boundaries, plain prose. Render it as natural chat (NOT inside a code block) so the markdown formatting works.

Specifically:
- Copy the markdown content from the bash output into your reply.
- Do NOT add prose around it ("here's the welcome screen", "let me walk you through…") — the text starts with "Welcome to the MixShift plugin" and is self-contained.
- Do NOT modify, paraphrase, condense, or restructure the text. It's hand-written to land cleanly in chat; edits cause regressions.
- Do NOT also paste the raw bash code block above the rendered version — one display of the welcome is enough.

If the user asks a follow-up about a specific step, reference the rendered text rather than re-rendering it. If the iteration needs to change the wording, that's a harness fix in `welcome.ts::renderWelcomeChat()`, not a SKILL.md edit.

### Fallback if the CLI fails

If `mixshift welcome --format chat` fails ("command not found", harness error, etc.), fall back in order:

1. `node "$MIXSHIFT_CLI" welcome --format chat` — same output, absolute path.
2. If `$MIXSHIFT_CLI` is also empty (normal in Cowork, which does not run the session hook that sets it), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked and run `node "$MIXSHIFT_CLI" welcome --format chat`. This is the first thing a new Cowork user hits, so do NOT skip it and do NOT conclude the plugin is missing: `mixshift` being off PATH with `$MIXSHIFT_CLI` unset is expected here; the CLI ships inside the plugin directory (an ID-named folder a PATH or npm check will not show), which the scan finds.
3. As a last resort, the older `mixshift welcome` (no --format flag) outputs the terminal-ASCII version. Surface that as-is in a code block; don't try to paraphrase it.

## Drive the sign-in inline (REQUIRED for not-signed-in users)

This section is the most important part of the skill. If the rendered welcome shows `Current state: ✗ not signed in yet`, you MUST continue with these steps in the SAME chat turn. Don't end your reply with just the welcome text — keep going.

The welcome copy already told the user: *"I'll set up a sign-in link for you right after this."* If you stop at the rendered welcome, you broke that promise. Follow through. Two legitimate stops: a network-blocked `device-init` (step 2), and a user with no MixShift account (next paragraph). Handle both explicitly instead of stranding the user.

**If the user says they have no MixShift account** (or asks how to get one), do not drive the sign-in; there is nothing to sign in to yet. The rendered welcome already includes the "No MixShift account yet?" pointer. Reinforce it conversationally: create an account at https://www.mydashapplications.com/auth/registration, then connect Amazon accounts and activate ads + retail data (walkthrough: https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift). Set the expectation that most accounts are fully populated within 24-48 hours of activation, large catalogs can take longer, and MixShift emails them when data is ready. Invite them back: say "welcome" then and sign-in continues from Step 1 here. Emit `skill.completed --outcome ok` (the registration handoff is the correct outcome for a brand-new user) and end the turn.

1. **Collect their work email.** Ask once, in plain language: *"What's your work email? (Used for session attribution — the same one you use to log into MixShift is fine.)"* Skip this prompt if a stored email exists (check `~/.mixshift/auth/credentials` for `datahub.person_label` from a prior login, or `~/.mixshift/profile.yaml::user.email`).
2. **Initialize the sign-in flow.** Run `mixshift auth device-init --person-label "<email>"` via Bash (if `mixshift` isn't found, run the same args via `node "$MIXSHIFT_CLI"`).
   - **On success**, the JSON carries `device_code` and `login_url`; capture both and continue to step 3.
   - **If it returns `{ "ok": false, "error": "<message>" }`** (a network failure, typically the Cowork / Claude Code sandbox egress allowlist not including `mcp.mixshift.io`): **stop here. Do NOT send a sign-in link you can't complete.** Surface the `error` text, have the user run `mixshift doctor` for the full diagnosis, and point them to mx-auth-login's **"If the sandbox is blocking sign-in"** section for remediation plus no-sandbox alternatives. Emit `skill.completed --outcome failed` and end. Don't loop device-init.
3. **Prep the user + send them the link** in one chat reply:
   > *"Click this to sign in: \<login_url\>*
   > *Use your MixShift login — same email + password you use for MixShift. Tell me when you're done."*

   Include one heads-up with the link: after they approve, the page may say "return to your CLI". That just means come back to this chat and say "done"; there is no separate CLI step.
4. **Poll for approval when they confirm.** When the user says they're done, run `mixshift auth device-poll <device_code> --person-label "<email>"`. On `pending` re-poll politely; on `expired` restart from step 2; on `approved` move to verification.
5. **Verify + bottom line.** Run `mixshift data query --sql "SELECT 1"` to confirm the warehouse is reachable, then show a concise success message + 1-2 things they can try next.

For the detailed dispatch logic (Bash path vs MCP path on claude.ai, error envelopes, specific fallbacks), defer to the `mx-auth-login` skill's SKILL.md — those rules apply here verbatim. The welcome's job is just to remove the "say 'sign in to mixshift'" middleman so the new user gets a sign-in link without having to know any magic phrase.

## When to use this skill

Trigger when the user:
- Says "welcome", "run welcome", "quick start"
- Asks "what is mixshift" or "how do I get started"
- Looks new and needs orientation
- Wants to verify their current setup status

**Don't trigger** for specific workflow requests like "run daily health check" or "export data" — those have their own dedicated skills.

## Output handling

The `mixshift welcome` command writes to stderr (so it shows up correctly in terminals). In Claude's Bash output you'll see the rendered text. Just pass it through to the user.

If the command fails with "command not found" or similar, scan for the CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked and retry as `node "$MIXSHIFT_CLI" welcome`. Only if that scan also comes back empty, fall back to a brief message: *"The plugin's CLI could not be located in this session. Try restarting Claude Code / Cowork, or open a new session."* Do not tell the user the plugin is not installed; an off-PATH `mixshift` is expected in Cowork.

## One-time note for users from before Org Brain

If a returning user set up brands locally before Org Brain shipped, that brand context may live only on this machine. Mention once (skip it for brand-new users, and do not belabor it) that they can publish that local brand context to the shared org store so teammates work from the same brand setup, with a single `mixshift context migrate`. It seeds the org store from the local brand dirs one time; no need to repeat it.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-welcome
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-welcome --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-welcome --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back this turn), `skipped` (user opted out mid-flow).
