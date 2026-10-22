---
name: mx-budget-balance
description: >
  This skill should be used when the user asks to "run a budget balance",
  "balance my budgets", "weekly budget check", "which campaigns are capped",
  "which campaigns need more budget", "where should budget move", or wants the
  weekly Sponsored Products budget-mix pass, or says "demo budget balance"
  for a guided demo on their own account. Sorts campaigns into RAISE (capped
  and efficient), WIDEN (efficient but underspending, advisory) and CAP (poor
  performers), each with a reason, and previews budget changes within a
  per-change limit. Nothing is applied until the user confirms the exact set.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - budget balance
  - run a budget balance
  - balance my budgets
  - weekly budget check
  - budget mix
  - which campaigns need more budget
  - which campaigns are capped
  - where should budget move
  - demo budget balance
  - budget balance demo
  - walk me through budget balance
---

# Budget Balance (weekly budget-mix pass)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.

## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent or unsafe output.

- **Never commit a budget change without confirmation of that exact change set, in a separate turn after the user has seen the dry run.** The user's request to "balance my budgets" authorizes the analysis and the dry run, never the write. Never run the dry run and `--commit` in the same turn. Never pass `--commit` yourself in a demo.
- **No change larger than the guard.** Every proposed budget moves by at most `max_change_pct` of its current value (default 25 percent), up or down, in one run. If a campaign deserves more, say so and let the next weekly run take the next step. Never round a change past the guard.
- **Never raise a budget above Amazon's suggested budget when one exists.** If Amazon's suggested budget is at or below the current budget, there is no raise: the campaign is held with that reason.
- **Every campaign in a bucket carries a stated reason**, a short sentence built from its own numbers (ACoS, days at cap, utilization, Amazon's time-in-budget). No bucket row without a reason; no reason that is not in the data.
- **Sponsored Products budgets only.** The v1 write path is `sp.update_campaigns`. Sponsored Brands and Sponsored Display campaigns are advisory: never put one in a change set. If the user names one, say it is outside this skill's v1 and that a single named change goes through `mx-amazon-ads`'s own write contract.
- **WIDEN is advisory.** It never produces a budget change. It names the campaign and hands the bid raises to `mx-keyword-bid-health`.
- **An unconfirmed or missing ACoS target means no flags.** If the target is absent, or only a bootstrap placeholder (`management.acos_target_source: default`) the user has not confirmed on the Step 1.5 card, run observational: show the table, label the target, produce no change set.
- **Do NOT supplement with general Amazon knowledge** or benchmarks that are not in the data.
- **Do NOT echo full data tables or raw query output.** The bucket tables (top 15 each) are the deliverable; full rows live in the prefetch `data.json`.
- **All warehouse queries go through `mixshift prefetch`**, never inline SQL.
- **Begin output immediately.** Do not restate these rules.

---

## Preflight - Risk Tier 3 (Required)

```
PREFLIGHT - mx-budget-balance - <brand> - <date>
[ ] Brand resolves with accounts[].seller_id + account_type
      (if absent -> stop; ask the user to run `mixshift brand add`)
[ ] Calibration confirmed (Step 1.5): acos_target, capped_days_threshold, max_change_pct,
      cut_acos_multiple, min_spend each resolved from brand context, an override, or a
      labeled default - never blocks (except: no confirmed ACoS target = observational)
[ ] Write path known: this session can confirm with a human (interactive) or can only
      propose (scheduled routine / service credential) - decides the "Applying" branch
[ ] The Ads write surface is configured (`ads_not_configured` -> the pass still runs;
      the change set is handed over as a list)
```

Stop only if the brand has no accounts.

---

## Overview

A weekly look at where each Sponsored Products campaign's budget is working and where it is not, in three buckets:

1. **RAISE**: budget-capped campaigns that are efficient (ACoS at or under the target). They are leaving efficient sales on the table; they get a budget raise within the guard, never above Amazon's suggested budget.
2. **WIDEN**: efficient campaigns that underspend their budget. More budget will not help; the limit is reach, so the answer is bids (advisory, handed to `mx-keyword-bid-health`).
3. **CAP**: poor performers, well over the target with meaningful spend. They get a budget cut within the guard.

Everything else is HOLD (counted, with the one-line reason, not listed beyond the top few).

---

## Execution Steps

### Step 1 - Load brand context

Read `~/.mixshift/clients/<brand-slug>/context.yaml` (or `mixshift brand context resolve <brand-slug> --json`; each field carries `{value, source}`). Extract:
- `accounts[*].seller_id`, `accounts[*].account_type`
- `management.acos_target_pct` and `management.acos_target_source`
- `posture.stance` (default `scale`, labeled)
- `goals.monthly_total_sales_target` (optional, context only)
- `structural_events[]` that are currently active (price tests, promotions)

Brand context is optional beyond the account. A missing field uses the documented default, labeled in the output, and the run continues; the exception is the ACoS target (Hard Rules).

### Step 1.5 - Confirm calibration

```bash
mixshift skill config mx-budget-balance --brand <brand-slug> --json
```

`confirmation.fields[]` has one entry per knob. Show the user the card; they can confirm, or edit:
- confirm / defer: `mixshift skill config mx-budget-balance --brand <brand-slug> --apply '{"action":"confirm"}' --json`
- edit: `... --apply '{"action":"edit","edits":{"max_change_pct":"15"},"save":true}' --json`

Resolve the working values (whole-number percents) from `effective_config` in the `--apply` response:
- `acos_target`: the confirmed value. Absent, or only the bootstrap placeholder and unconfirmed: observational (Hard Rules).
- `capped_days_threshold`: else 4 (of 14 days).
- `max_change_pct`: else 25. Never above 25 unless the user explicitly sets it higher and accepts that the Ads write guard will flag it.
- `cut_acos_multiple`: else 1.5.
- `min_spend`: else 50 (account currency, over 14 days).

Label every default in the Bottom Line. Never block on this step.

### Step 2 - Run prefetch

```bash
mixshift prefetch --brand <brand-slug> --skill mx-budget-balance
```

Executes (one round, in parallel):
- **BB-01**: per Sponsored Products campaign over the 14 complete days before today: `spend_14d`, `sales_14d`, `orders_14d`, `acos_14d` (Cost / Sales), `avg_daily_budget`, `days_with_spend`, `days_at_cap` (days with Cost at or above 90 percent of that day's budget), `budget_utilization_pct`.
- **BB-02**: the latest settings row per enabled campaign: `DailyBudget`, `BudgetType`, `State`, `PercentTimeInBudget`, `suggestedBudget`, `AmazonCampaignID`.

Read `data.md`. If a query failed (exit code 2), surface the failing id and its friendly error and stop.

Join BB-01 to BB-02 on `CampaignID`. A campaign in BB-01 but not in BB-02 is not enabled now: leave it out and say how many were left out. A campaign in BB-02 with no BB-01 row had no spend in the window: count it as HOLD (no data).

Data quirks to respect: `PercentTimeInBudget` is a fraction (0.84 is 84 percent of the last 7 days in budget) and `-1` or NULL means Amazon returned no recommendation: treat as unknown, never as zero. `suggestedBudget` may be below, equal to, or above the current budget; only above is a raise ceiling. Cost can exceed a day's budget, so utilization above 100 percent is valid.

### Step 2b - Live refresh (optional, requires Ads API access)

Warehouse values lag the live account. Before building a change set, optionally refresh two things. Both are reads; nothing is mutated.

1. Amazon's current suggested budgets for the RAISE candidates:
   `mixshift ads call sp.budget_recommendations --legacy-seller-id <id> --body-file ids.json --json` with `{ "campaignIds": ["..."] }` (Amazon's campaign ids, at most 100 per call). Where present, the live suggested budget replaces `suggestedBudget` from BB-02.
2. Today's pacing: `mixshift ads call sp.budget_usage --legacy-seller-id <id> --body-file ids.json --json` with the same body shape. A RAISE candidate already at or above 80 percent of budget before midday strengthens the reason (note the percent and `usageUpdatedTimestamp`). It never changes a bucket on its own.

On `ads_not_configured`, `throttled`, or any other failure, skip, note that live values were unavailable, and continue on the warehouse values. A failed refresh never blocks the pass.

### Step 3 - Classify

Let `target` be the confirmed `acos_target`, `cap_days` the `capped_days_threshold`, `multiple` the `cut_acos_multiple`. For each campaign (each lands in exactly one bucket, tested in this order):

```
efficient  = acos_14d is not null AND acos_14d <= target AND orders_14d >= 3
capped     = days_at_cap >= cap_days
             OR (PercentTimeInBudget >= 0.5; a value of -1 or NULL does not count)
poor       = spend_14d >= min_spend
             AND (sales_14d = 0 OR acos_14d > target * multiple)

CAP    : poor
RAISE  : efficient AND capped AND an allowed raise exists (Step 4)
WIDEN  : efficient AND NOT capped AND budget_utilization_pct < 50
HOLD   : everything else
```

Reason (one sentence from the campaign's own numbers, required for every row):
- RAISE: "ACoS 18.4 percent against a 25 percent target, at 90+ percent of budget on 9 of 14 days; Amazon suggests 350." Name which capped signal fired (days at cap, or Amazon's time-in-budget).
- WIDEN: "ACoS 19.1 percent against a 25 percent target but only 36 percent of budget used: budget is not the limit, reach is."
- CAP: "ACoS 61 percent against a 25 percent target (2.4 times) on 212 spent in 14 days with 3 orders." If `sales_14d = 0`, say "no sales on N spent in 14 days".
- HOLD reasons worth listing: efficient and capped but Amazon suggests no increase; ACoS between the target and the cut multiple; spend under the minimum.

Annotate (never suppress) from `structural_events`: an active price test or promotion near a CAP campaign is noted "(promo or price test active: ACoS may be distorted)".

### Step 4 - Compute the budgets

```
RAISE:  proposed = current * (1 + max_change_pct/100)
        if a suggested budget exists (live, else BB-02) and suggested > current:
            proposed = min(proposed, suggested)
        if a suggested budget exists and suggested <= current:
            no raise -> HOLD ("Amazon suggests no increase")
CAP:    proposed = max(current * (1 - max_change_pct/100), 1.00)
```

Round to two decimals. Skip any change smaller than 1.00 in absolute terms (not worth a change; HOLD with that reason). `proposed` is never below Amazon's 1.00 minimum and never more than `max_change_pct` away from `current`. If a CAP campaign's `budget_utilization_pct` is under 60, add "the budget was not binding, so the cut saves little; bids are the lever (`mx-keyword-bid-health`)".

`current` is the live budget when the dry run provides one; if the dry run's `before_state` budget differs from BB-02's `DailyBudget`, flag the row and recompute from the live value.

### Step 5 - Compose

Order the tables by posture: `scale` (default) leads with RAISE; `efficiency` or `clear_bleed` leads with CAP. Three tables, top 15 each by spend, right-align numerics.

**RAISE:** Campaign | ACoS 14d | Spend 14d | Days at cap | Current budget | Suggested (Amazon) | Proposed | Change | Reason

**WIDEN (advisory, no change):** Campaign | ACoS 14d | Spend 14d | Utilization % | Current budget | Reason | Next step ("raise bids: run mx-keyword-bid-health")

**CAP:** Campaign | ACoS 14d | Spend 14d | Orders | Current budget | Proposed | Change | Reason

Then a one-line HOLD summary (count, and the top two reasons by count) and a line for Sponsored Brands and Display: "Sponsored Brands and Display are not ranked in v1."

### Step 6 - Verdict

```
cap_share = spend of CAP campaigns / spend of all reviewed campaigns
if observational (no confirmed target) or campaigns_reviewed < 5: OBSERVATIONAL
elif cap_share > 0.30:                                            RED
elif cap_share > 0.10 or raise_count > 0:                         YELLOW
else:                                                             GREEN
```

### Step 7 - Bottom Line

Three sentences:
1. **Raise**: "X efficient campaigns are budget-capped; raising them within the guard adds about $Y a day of budget."
2. **Cap**: "K campaigns are well over target on $W of spend; cutting them within the guard frees about $V a day of budget."
3. **Widen**: "N efficient campaigns are not using their budget; the lever is bids, not budget (see mx-keyword-bid-health)."

Add up to two sentences: the posture and the monthly sales target when set, any default labeled as a default, and any live-data gap. State the net budget change (raises minus cuts, per day) plainly so the user sees the total ad-budget effect.

### Step 8 - Self-review

- [ ] Every row in every bucket has a reason built from its own numbers
- [ ] No proposed change exceeds `max_change_pct`; no raise exceeds an existing suggested budget; no proposed budget is under 1.00
- [ ] WIDEN rows carry no budget change; SB and SD campaigns appear in no change set
- [ ] Capped signals read correctly (-1 and NULL are unknown, not zero)
- [ ] Defaults and the ACoS target's source are labeled; observational when the target is unconfirmed
- [ ] Net daily budget effect stated
- [ ] No em dashes in output

---

## Key Constraints

- **Prefetch is the only warehouse path.** No inline SQL.
- **The guard is a ceiling, not a target.** The proposed step is the smaller of the guard and Amazon's suggestion.
- **Efficiency uses the confirmed ACoS target**, never a hardcoded one.
- **The pass proposes; the user applies.** Every write goes through the audited Ads write surface below.

## Applying budget changes (optional, requires explicit user confirmation)

The tables are recommendations. When the user asks to apply some or all of the RAISE and CAP changes, use the audited Ads write surface, exactly like `mx-keyword-bid-health`'s bid changes:

1. Build the change set from the rows the user selected, using each campaign's Amazon campaign id (`AmazonCampaignID` from BB-02, never the MixShift `CampaignID`). `sp.update_campaigns` takes:
   `{ "campaigns": [ { "campaignId": "...", "budget": { "budget": <new daily budget>, "budgetType": "DAILY" } } ] }`
   Send only the budget field. Cap change sets at 200 items per call (split larger sets).
2. Dry-run it (the default; nothing reaches Amazon):
   `mixshift ads call sp.update_campaigns --legacy-seller-id <id> --body-file changes.json --json`
3. Show the user the preview AND the `before_state` snapshot (current budgets). If a `before_state` budget differs from the one this pass used, flag that row and recompute it from the live value before asking. Ask for explicit confirmation of this exact change set. Never include a campaign that was not in the confirmed table.
4. Only after the user confirms, in a SEPARATE turn, having seen the dry run, re-run the SAME command with `--commit`. The original request is NOT commit authorization. Report per-item success and error counts and the `audit_id`.

Hard rules: never pass `--commit` without the user's confirmation of this specific change set; on `insufficient_scope` the credential cannot write, so hand the user the change list for manual application (or use the propose path below).

### When the session can only propose (scheduled routines, service credentials)

A scheduled routine has no human to confirm, so it never commits. It files a stored proposal instead, with the same body file:

```bash
mixshift ads call sp.update_campaigns --legacy-seller-id <id> --body-file changes.json \
  --propose --title "Weekly budget mix: <n> raises, <m> cuts" \
  --rationale "<the Bottom Line, plus the guard (max change) and the ACoS target used>" --json
```

`--propose` is incompatible with `--commit`. The output carries the proposal id. Tell the user: the proposal is stored for review, nothing was changed on Amazon, and a person approves it later with `mixshift ads proposals approve <id>` (and can read it first with `mixshift ads proposals show <id>`, or turn it down with `mixshift ads proposals reject <id>`). Approval is a human act from a person's own sign-in, in a different session from the one that proposed it: never approve a proposal yourself, on a scheduled run or otherwise. Tell the user to approve it from their own session (or the claude.ai app) after reading it with `show`. Once a person has approved it, a later run or a session whose credential can write applies it with `mixshift ads proposals commit <id>`; the service re-reads the live budgets first and refuses if any changed since the proposal, in which case re-run this pass. If the installed CLI does not recognize `--propose` yet, hand over the change list and say the stored-proposal path needs a newer plugin version.

## Demo ("demo budget balance")

A guided walkthrough on the user's own account, per the demo contract in `shared/skill-runtime-contract.md` ("Demos"): real data, read first, each step ending with the sentence that runs it again. **The demo never commits a change on a live account**: step 4 shows the change set as a dry run and says plainly that nothing was sent.

**Open.** Run the opener and show its output verbatim, then go straight to step 1:

```bash
mixshift demo mx-budget-balance
```

"skip" moves on, "stop" ends, questions are answered before moving on. If the user starts real work, that is the demo succeeding.

### Step 1: Your account and your ACoS target

Resolve the brand and its seller account (`mixshift brand list`, then `mixshift brand context resolve <brand-slug> --json`). Say the ACoS target and where it came from (confirmed, or a bootstrap default that needs confirming). Show the calibration card (`mixshift skill config mx-budget-balance --brand <brand-slug> --json`) in one screen and confirm it as is. If no brand or Sponsored Products account is set up, say what is needed and who does it, describe steps 2 to 4 in one sentence each, and close.

Next time, just say: *"run a budget balance on <brand>"*.

### Step 2: Which campaigns hit their budget

Run `mixshift prefetch --brand <brand-slug> --skill mx-budget-balance`. Show a short table of the five campaigns with the most days at or above 90 percent of budget: campaign, days at cap, budget, ACoS. Say what "capped" means in one sentence: the campaign ran out of daily budget, so shoppers who would have seen it did not. Empty is shown as empty.

Next time, just say: *"which campaigns are capped?"*

### Step 3: The three buckets, with reasons

Classify (Steps 3 and 4 above) and show the top five rows of RAISE, WIDEN and CAP, each with its reason sentence. Say in one sentence what each bucket means and what happens to it: raise, bids instead of budget, cut.

Next time, just say: *"where should budget move?"*

### Step 4: A change set previewed, not sent

Build a change set from the top three RAISE and top three CAP rows, write it to `changes.json`, and run the dry run (no `--commit`): `mixshift ads call sp.update_campaigns --legacy-seller-id <id> --body-file changes.json --json`. Show current budget, new budget and the percent change per campaign (all within the guard), and the Bottom Line's net daily budget effect. Say clearly that nothing was sent to Amazon. If the user wants to apply it, the demo ends there and the "Applying budget changes" section takes over (their yes to that exact preview is the confirmation, in a new turn). If the session can only propose, show the `--propose` form instead of running it.

Next time, just say: *"balance my budgets and show me the change set"*.

### Close

Recap the "next time" sentences from the steps the user saw. Add two or three more they can try: "which of my efficient campaigns are underspending?", "run the bid health review on <brand>", "schedule the budget balance every Monday". Ask what they want to do now. Then:

```bash
mixshift demo mx-budget-balance --finished --steps-shown <n>
```

## Reactive error handling (branch on failure_kind, never on HTTP status)

`ads_not_configured` (the Ads connection is not set up: the pass still runs on the warehouse, and the change set is handed over as a list), `insufficient_scope` (the credential cannot write: propose or hand over), `throttled` (wait and retry once, then skip the live refresh), `bad_request` on a dry run (show Amazon's message; do not resend the same body unchanged), a proposal error such as `proposal_limit_reached` (tell the user to review or reject stored proposals first).

## Telemetry (required)

At the START of every invocation, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-budget-balance
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-budget-balance --trigger-phrase "<the user's exact phrase>"
```

At the END (when the session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-budget-balance --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (the pass ran cleanly), `failed` (CLI errored or a prerequisite was missing), `deferred` (paused waiting for the user, or a proposal filed for later approval), `skipped` (user opted out or a prerequisite guard fired).
