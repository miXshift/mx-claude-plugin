---
name: mx-dayparting
description: >
  Dayparting for Amazon Ads: which times of day and days of the week your ads
  earn clearly less or more than their own average, and what a bid change in
  that window would touch. Use it for "when in the day are we wasting ad
  spend", "should we turn bids down overnight", "dayparting", "hour of day
  performance", "which hours convert best", "bid by time of day", "show me
  the heat map". Runs a read-only diagnosis on eight weeks of hourly data:
  one sentence per window with its ACOS, the weekly spend it touches, the
  sales it could cost and how far to trust it. Nothing is applied or
  scheduled; approving and scheduling windows arrives in a later release.
  Needs hourly data (Amazon Marketing Stream) turned on for the account. NOT
  budget moves (mx-budget-balance), keyword bids (mx-keyword-bid-health) or
  changing a live campaign (mx-amazon-ads).
  Uses the MixShift plugin sign-in.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - dayparting
  - day parting
  - when in the day are we wasting ad spend
  - should we turn bids down overnight
  - bids by time of day
  - hour of day performance
  - which hours convert best
  - which hours should we bid down
  - weekday and hour performance
  - show me the dayparting heat map
  - ask to turn on marketing stream for our account
---

# Dayparting (diagnose when in the day your ads earn less or more)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.

## What dayparting is

Dayparting means changing bids, budgets or delivery for certain hours of the day or days of the week, in the account's own time zone, and putting them back afterward. Shoppers do not buy at an even rate through the day, so some windows (often overnight) cost clicks that rarely turn into orders, and others convert better than the daily average. This skill finds those windows from the account's hourly Ads data and says what a change in each would touch.

**This release only diagnoses.** It reads and computes. It changes no bid, budget or campaign, and it schedules nothing. Approving and scheduling windows arrives in a later release; say so when the user asks to "turn it on" or "apply it", and offer to come back to the diagnosis when that ships. Never try to approximate it with `mx-amazon-ads` edits.

## When to use it

- "When in the day are we wasting spend?", "should we bid down overnight?", "which hours convert best?", "dayparting".
- Not budget moves between campaigns (`mx-budget-balance`), not keyword bid health (`mx-keyword-bid-health`), not editing a live campaign (`mx-amazon-ads`).

## Rules this skill must respect

- **Matured data only.** Sales keep arriving for days after a click (7 days for Sponsored Products, 14 for Sponsored Brands and Display). The service reads orders, sales and ROAS only from days old enough to be complete, so the last week or two never makes a window look worse than it is. Never judge a window from `dayparting hours`, whose recent days read low.
- **Eight weeks at least.** No suggestion is made on less than 8 weeks of history. The default look-back is 56 days; do not shorten it to get an answer. If the account is newer, say how long until there is enough.
- **Event days are left out.** A launch, a sale event, a stock-out or an outage skews the pattern. Ask whether any such days fall in the last eight weeks, and pass them with `--exclude-dates`.
- **A cut needs the brand's target ACOS.** A bid cut is only worth proposing against a target, from the brand context (`acos_target`, a whole-number percent) or from the user. If the target is missing, or is only a bootstrap placeholder (`management.acos_target_source: default`), ask the user for it before reading any cut as a recommendation, and run the diagnosis with their number.
- **Say what is held.** A window the service holds back (not enough history, a pattern that is not steady) is not a recommendation. Relay the reason in its words.
- **Money is a size, not a promise.** "Touches about $1,200 a week" is the weekly spend in the window; "risks about $1,100 of sales" assumes sales move in proportion to spend. Never call it savings.
- **Campaign names are not shown yet.** Windows are per account in this release. If the user wants one campaign, use `--campaign-ids` and say names are not shown.

## Step 1: pick the account and the Ads profile

```bash
mixshift amazon merchants --json
```

One merchant in one marketplace is one account; its `legacySellerId` is `--seller-id`. If the seller has more than one Ads profile (for example US and Canada), the command lists them and stops: ask the user which, then pass `--profile-id` (from `mixshift ads profiles`).

## Step 2: get the target ACOS

Read the brand context (`mixshift brand context resolve <brand-slug> --json`) for `acos_target`, and say where it came from. If the brand has no context or the target is a placeholder, ask the user. Pass it as `--target-acos` (`0.28` and `28` both mean 28%).

## Step 3: diagnose first

```bash
mixshift dayparting diagnose --seller-id <id> [--profile-id <id>] --target-acos 0.28 [--exclude-dates 2026-10-06,2026-10-07] [--lookback-days 56] [--campaign-ids <a,b>]
```

The answer is one sentence per proposed window, then what was held back and left out, then a line saying nothing was changed. Example of the shape (made-up figures):

```
- Every day, midnight to 4 am (00:00 to 04:00) runs at 34% ACOS against your 21%; a 30% bid cut touches about $1,200 a week and risks about $1,100 of sales; confidence medium
```

Read each verdict aloud in plain words: the window, its ACOS against the target, what a cut or raise touches, and the confidence. A raise window ("runs at 19.6% ACOS against your 21%; a 15% bid raise touches about $300 a week") is room to spend more where it pays; say so. When the user asks why, run it again with `--verbose` (or read `--json`) and explain the drivers in plain words: conversion rate (fewer clicks turn into orders), cost per click (the clicks cost more), order value (smaller baskets). Do not paste the tables.

**The heat map only on request.** If the user asks to see the hours, run `mixshift dayparting diagnose ... --verbose` and show the hour and weekday tables it prints. Offer it in one line after the verdicts; do not lead with it.

To look at the raw hourly data behind a window (rarely needed): `mixshift dayparting hours --seller-id <id> --from 2026-10-01 --to 2026-10-14` (up to 62 days; `--json` carries every row).

Add `--json` to either command when you need to read the answer yourself; it is the service's answer unchanged.

## When it cannot run

The command says why in the service's own words, then what to do. The common ones:

- **Hourly data is not turned on** (`source_not_enabled`, exit 6) or not for this Ads profile (`account_not_in_scope`, exit 6): hourly data comes from Amazon Marketing Stream, which MixShift turns on account by account. Say so in one sentence and offer to ask. If the user asked for it in their own words (for example "ask to turn on Marketing Stream for our account"), that is their yes; if you offered, wait for a yes in a later turn. Never send it in an unattended run. First make sure they are signed in (`mx-auth-login`), then send exactly:

  ```bash
  mixshift feedback 'Marketing Stream request: please turn on hourly Ads data for our account.' --category feature_request --skill mx-dayparting
  ```

  Keep the opening words `Marketing Stream request:` unchanged and add no account names, seller ids or profile ids. Count it as sent only when the command says the feedback was sent; if it was queued locally, ask the user to email support@mixshift.io instead.
- **The feed has lapsed or has not filled yet** (`source_not_current`, exit 6): say so; MixShift needs to check the activation. Offer the same request, worded as the lapse.
- **No hourly rows in the window, or more than one time zone:** the answer says so with no windows. Relay it.
- **Not signed in, or the credential cannot read Ads data** (exit 2 or 11): `mx-auth-login`, or ask the org admin.

## When it does not fit

- The user wants a window applied or scheduled: not in this release (see above). Offer `mixshift feedback "<what they wanted>" --category feature_request --skill mx-dayparting`, sent only after the user agrees.
- Budget moves go to `mx-budget-balance`; keyword bids to `mx-keyword-bid-health`.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-dayparting
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-dayparting --trigger-phrase "<the user's exact phrase>"
```

At the END (when the session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-dayparting --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (the user got the diagnosis), `failed` (could not run, for example hourly data not turned on, exit 6), `deferred` (a Marketing Stream request is waiting on the user's yes), `skipped` (they wanted a different skill, or wanted a window applied).

You do **not** need to emit per-call events. The harness fires `dayparting.called` on each command with a count and the outcome. It never records an account, profile or campaign id, a figure from the answer, or the answer.
