---
name: mx-share-skill
description: >
  Use when the user wants to share or submit a skill they built with or for the
  MixShift plugin, contribute a skill to the library, or send MixShift a skill,
  workflow, or reusable prompt they made. Also use when the user changed one of
  the plugin's own skills and wants that change considered. Bundles the artifact
  and sends it to MixShift via `mixshift share-skill` so the team can fold it
  into the shared skill library. Do NOT use for general feedback or bug reports
  (that is mx-feedback).
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - i built a skill
  - i made a skill
  - share a skill
  - share my skill
  - submit a skill
  - contribute a skill
  - add my skill
  - i wrote a skill
  - i have a skill to share
  - send you a skill
  - i changed one of your skills
  - i modified a skill
  - share what i built
---

# Share a skill with MixShift

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


Use this when a user has built something with the plugin (a skill, a workflow, a
reusable prompt) and wants MixShift to have it for the shared skill library. The
goal for now is simply to RECEIVE it cleanly so the team can review and
incorporate it. A guided, user-facing skill builder is future work; this skill
is the intake.

## When to use this

Trigger when the user says any of the trigger phrases, or otherwise wants to
hand MixShift a skill, workflow, or prompt they made. Do NOT use this for
general feedback or bug reports. That is **mx-feedback**.

## Step 0 — Figure out which case this is

There are three, and they route differently:

| Case | Signal | What to do |
|---|---|---|
| **New skill they built** | They have a SKILL.md or a skill folder | `--kind new_skill` (the main path below) |
| **A change to one of OUR plugin skills** | "I tweaked your mx-data-explore" | `--kind modified_plugin_skill --base-skill <id>`. Also tell them: edits to an installed plugin skill do not persist, because the plugin is overwritten on update. So the right move is to send us the change and we fold it in. |
| **An idea, nothing built yet** | They describe a skill they wish existed | This is really a feature request. Offer to route it through **mx-feedback** as a `feature_request` instead. Only use `--kind idea` if they specifically want it logged as a skill proposal. |

## Prerequisites

- The user must be signed in so we can attribute the contribution (same as feedback). If they are not, surface that and offer to walk them through **mx-auth-login** first.

## Step 1 — Locate the artifact

Ask where the skill lives if you do not already know:

> Where is the skill? Point me at the SKILL.md file or the skill's folder (a path) and I will bundle it up.

- A **folder** is preferred: it captures SKILL.md plus any supporting files (reference docs, scripts, examples).
- A single **SKILL.md** file is fine too.
- If the user pasted the skill content into chat instead of giving a path, write it to a local file first (for example a temp SKILL.md), then share that path.

## Step 2 — Preview, then confirm

Always show the user what will be sent before sending. Run the dry run:

```bash
mixshift share-skill "<path>" --kind <new_skill|modified_plugin_skill|idea> [--base-skill <id>] --dry-run
```

Surface the preview (name, kind, the file list with sizes). Confirm the name and
one-line description with the user. The command pulls these from the SKILL.md
frontmatter, so let the user correct them if needed. If anything looks wrong,
adjust with `--name`, `--description`, or `--notes`.

## Step 3 — Send

Once the user confirms, send for real:

```bash
mixshift share-skill "<path>" \
  --kind <new_skill|modified_plugin_skill|idea> \
  [--base-skill <id>] \
  [--name "<name>"] \
  [--description "<one-liner>"] \
  [--notes "<what it does, why, how to use it>"]
```

On success the command confirms what was received and pings the MixShift team. Relay the confirmation, for example:

> ✓ Sent "<name>" to MixShift. Thanks for sharing it. The team will review it for the skill library.

If the command fails (network, endpoint), surface the error and offer to retry. Nothing is lost on the user's side.

## Step 4 — Continue

Sharing does not interrupt whatever the user was doing. After confirming, return to the prior context.

## Hard rules

- **Preview before sending.** Always dry-run and confirm first. Do not submit silently.
- **Do not editorialize their skill.** Send what they built. You may suggest a clearer description, but the artifact is theirs.
- **One skill per submission.** If they have several, send each separately so each gets reviewed independently.
- **Web path (claude.ai, no shell):** the `mixshift share-skill` command needs the Claude Code or Cowork app. If there is no shell, capture the skill content in chat, tell the user they will need to run it from the app (or that they can paste it), and offer to file a short feature-request note via mx-feedback so the team knows it is coming.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-share-skill
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-share-skill --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-share-skill --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill shared), `failed` (command errored), `deferred` (waiting on the user for the path or confirmation), `skipped` (user backed out). The `share-skill` command separately emits `skill.shared` when the artifact actually lands.
