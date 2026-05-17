---
name: feedback
description: >
  This skill should be used when the user wants to send feedback to MixShift —
  bug reports, feature requests, comments, "this is broken", "I wish this could
  do X". Routes through `mixshift feedback` which posts to MixShift ops in
  real time and records the feedback for engineering triage. Works mid-session
  alongside any other skill.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - send feedback
  - send feedback to mixshift
  - submit feedback
  - i have feedback
  - report a bug
  - report bug
  - file a bug
  - bug report
  - feature request
  - i have a feature request
  - i wish this could
  - this is broken
  - this isnt working
  - tell mixshift
  - let mixshift know
  - mixshift feedback
  - rate this plugin
  - flag an issue
---

# Send Feedback to MixShift

Use this whenever the user wants to tell MixShift something — a bug, a feature request, a "this is broken", a "wish this did X", or just a comment. The goal is to make feedback as low-friction as possible so we hear from customers in real time as they hit pain.

## When to use this

Trigger when:
- User says any of the trigger phrases listed in the frontmatter
- User explicitly invokes `/feedback` (slash command in Claude Code / Cowork)
- User describes a problem with the plugin (skill not working, query slow, output confusing, etc.) — proactively offer to send feedback
- A skill explicitly invites feedback at the end of a session (e.g. data-explore wraps with "anything you want me to send back to the MixShift team?")

You can also invoke this skill **mid-session** if the user expresses frustration or asks for something the plugin doesn't currently do. Don't make the user wait until the end of the session to file feedback.

## Prerequisites

- The user must have completed `mixshift auth setup` so we have an email to attach to the feedback. If auth isn't set up, surface that and offer to walk them through auth-setup first. (Without an email, the harness rejects feedback with a clear error — but it's friendlier to catch this upfront.)

## Flow

### Step 1 — Get the message + category

If the user already said what they want to send (e.g. "send feedback to mixshift: the export is too slow"), parse that. Otherwise ask:

> What's the feedback? I can categorize it as a bug, feature request, or general comment — or just tell me what's going on and I'll figure out the right tag.

Classify into one of four categories based on the user's wording:

| Category | When |
|---|---|
| `bug` | Something is broken / wrong / not working as expected |
| `feature_request` | "I wish this could…", "can you add…", "would be great if…" |
| `comment` | General observation, praise, "FYI", neutral notes |
| `other` | Doesn't cleanly fit the above |

When in doubt, ask the user which fits — but most of the time the wording makes it obvious.

### Step 2 — Add context (when available)

The CLI accepts three optional context flags. Pass them when you have the information from the surrounding session:

- `--skill <skill-id>` — which skill the user was using when they hit the issue (e.g. `data-explore`, `runaway-spend-check`). If you're being invoked mid-session, you know this.
- `--command <cmd>` — which `mixshift` CLI command, if relevant (e.g. `data export`, `brand discover`).
- `--brand <slug>` — which brand was involved, if any.

Don't ask the user for these — infer from the conversation. If you can't infer, just skip the flag.

### Step 3 — Submit

Run:

```bash
mixshift feedback "<the user's message>" --category <category> [--skill <id>] [--command <cmd>] [--brand <slug>]
```

The harness:
1. Looks up the user's email from `~/.mixshift/profile.yaml`.
2. Posts a structured message to MixShift's Discord ops channel (real-time human attention).
3. Logs the feedback to Supabase (analyzable feedback firehose).
4. Returns success / failure.

If the CLI succeeds, confirm to the user:

> ✓ Sent to MixShift ops. Thanks — this goes to the engineering team and we'll look at it. If it's a bug, we'll usually have an answer within a couple business days; feature requests get triaged into the roadmap.

If the CLI fails (network blip, malformed input), surface the error and offer to retry. Don't silently drop feedback.

### Step 4 — Continue the session

Feedback submission doesn't replace whatever the user was doing. After confirming, return to the prior context. If you were in the middle of a data-explore session, pick back up there.

## Examples

**User mid-session in data-explore:**

> User: "The export is super slow for big tables."
> You:  "That's worth flagging — let me send that to the MixShift team so they can look at the export performance. I'll tag it as a bug since the slowness sounds beyond expected."
> [runs `mixshift feedback "data export is super slow for big tables" --category bug --skill data-explore --command "data export"`]
> "✓ Sent. Want to continue with the export, or try a smaller window for now?"

**User explicitly asks to file feedback:**

> User: "/feedback"
> You:  "What's the feedback?"
> User: "I wish I could filter by ASIN when exporting."
> You:  [classifies as feature_request]
>       [runs `mixshift feedback "I wish I could filter by ASIN when exporting" --category feature_request --skill data-explore`]
>       "✓ Sent as a feature request. Filed under data-explore."

**User says something positive:**

> User: "This is really useful, thanks."
> You:  "Glad to hear it. Want me to pass that along to the MixShift team?"
> User: "Sure."
> You:  [runs `mixshift feedback "This is really useful, thanks." --category comment`]
>       "✓ Sent. They'll appreciate it."

## Hard rules

- **Don't silently submit.** Always confirm with the user before sending, even if the message seems obvious. They may want to tighten it.
- **Don't editorialize the message.** Pass through the user's wording. You can suggest a clearer phrasing, but ultimately the user's words are the user's words.
- **Don't bundle multiple feedback items into one submission.** If the user has three different bugs, send three separate `mixshift feedback` invocations. Each routes / gets triaged / closed independently.
- **Don't use this for IP whitelist requests or table access requests.** Those have dedicated flows:
  - IP whitelist: handled inside `mixshift auth setup`
  - Table access denied: the data-explore skill's error-handling path; uses `mixshift feedback ... --category feature_request` with specific framing

## Output template

```
✓ Sent to MixShift ops. Thanks!
  Category: <bug | feature_request | comment | other>
  <one-sentence summary if helpful>
```

Brief is good. The user already knows what they said.
