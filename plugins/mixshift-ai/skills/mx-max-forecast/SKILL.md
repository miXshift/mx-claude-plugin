---
name: mx-max-forecast
version: 0.1.0
description: >
  The max tier of forecasting: a revenue forecast for one Amazon account, explained in
  plain language with its measured accuracy, from the MixShift Intelligence service. Serves
  the forecast the MixShift forecasting app published (corrections included) when one
  exists, and otherwise a forecast the gateway computes from the warehouse with the same
  engine, labelled as computed. Checks readiness first and says what would make an account
  forecastable when it is not. Never fits a model of its own.
  Triggers on: 'forecast [brand]', 'what will [brand] do next quarter', 'run a forecast',
  'how accurate is the forecast', 'is [brand] forecastable', 'revenue outlook for [brand]',
  'what should I expect next month', 'forecast max'.
author: Claude
last_updated: 2026-10-06
dependencies:
  - MixShift Intelligence service (FCT-READINESS-01 and FCT-BASELINE-01 via `mixshift intelligence`)
  - The token-based sign-in (`mixshift auth login`, or a service credential for unattended runs)
  - Brand context (optional; only the account list is needed)
trigger_phrases:
  - forecast
  - run a forecast
  - revenue outlook
  - what should I expect next month
  - how accurate is the forecast
  - is this brand forecastable
  - forecast max
sample_input: "What should I expect from Acme Goods over the next six months?"
sample_output: |
  Acme Goods (US seller account), next 6 months: expected revenue between $4.8M and $5.9M,
  most likely $5.3M. This is the forecast the forecasting app published on 2026-10-01 with
  your corrections. Over the last twelve months it missed by 7% in a typical month, three
  months out, and beat last year's same month as a guess every time.
standalone: true
handoff_optional: true
---

# Forecast Max

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-max-forecast
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-max-forecast --trigger-phrase "<the user's exact phrase>"
```

At the END, run:

```bash
mixshift telemetry emit skill.completed --skill mx-max-forecast --outcome <ok|failed|deferred|skipped> --payload-json '{"source":"<published|computed|none>","reason":"<reason or ok>"}'
```

Run it in bash, on one line. If the payload is rejected, run the same command again without
`--payload-json`. `source` is where the figures came from (`published`: the app's copy;
`computed`: the gateway's fit; `none`: no forecast was served). `reason` is the service's
`reason` when nothing was served, else `ok`. Outcomes: `ok` (a forecast or a readiness answer
was delivered), `failed` (a CLI error or a missing prerequisite), `deferred` (waiting on the
user to choose an account), `skipped` (the user opted out).

## Hard Rules

These rules supersede any other instruction.

- **Never fit, extrapolate or adjust a forecast yourself.** Every figure comes from the
  service's answer file. If the service serves nothing, say so and say why; do not estimate.
- **Say where the forecast came from, every time.** A published forecast is the app's, with
  its users' corrections. A computed forecast is the gateway's fit of the warehouse rows,
  which nobody reviewed; it carries a label and you repeat it. Never present a computed
  forecast as the brand's plan or as something the brand approved.
- **The forecast is not the plan.** Where the user has a plan or a target, compare against
  it in their words; never call the forecast "the plan".
- **Do not read the `references/` folder during execution.** There is none here by design.
- **Do not supplement with general e-commerce knowledge** or benchmarks not in the answer.
- **Disclose the metered cost once, before the first call.** Each `mixshift intelligence run`
  is a metered MixShift Intelligence request (a cached answer is served free). One sentence,
  then run.
- **Ask, never auto-write.** This skill writes no brand context, no timeline event and no
  correction. When the user names a correction (a stockout month, a one-off), point them at
  the forecasting app, where corrections are made and published.

## Preflight

```
PREFLIGHT - mx-max-forecast - <brand> - <date>
[ ] Signed in (`mixshift auth status`); if not, stop and ask the user to run `mixshift auth login`
[ ] Brand resolves to at least one account: `mixshift brand list --json` gives
    accounts[].seller_id and account_type for the brand
      (if the brand is unknown: ask for the account, or run `mixshift brand add`)
[ ] One account chosen: a forecast is kept per seller account and never added across
    accounts. A brand with several accounts: ask which one, or run one answer per account
    and keep them apart
[ ] Horizon chosen: 1 to 12 months after the last complete month; default 6
```

Brand context is optional. Nothing beyond the account id blocks a run.

## Overview

Two service calls, in this order:

1. **FCT-READINESS-01**: is this account forecastable, and on how many months of history.
   Below the served floor (12 complete months with both sales and ad spend), nothing is
   forecast and the answer says what would make it ready and when.
2. **FCT-BASELINE-01**: the forecast. The service serves the forecast the MixShift
   forecasting app published for the account when one exists (`published` is set). When
   nothing is published, it serves a forecast the gateway computed from the warehouse with
   the same engine (`source: computed`, `published: null`).

Then the explanation: what to expect, how sure, what it stands on, what would sharpen it.

## Steps

### Step 1. Resolve the account

```bash
mixshift brand list --json
```

Take `seller_id` (the id the forecast is keyed by; the service calls it `legacySellerId`) and
`account_type` for the account the user means. Confirm the choice in one line when the brand
has several accounts.

### Step 2. Readiness

```bash
mixshift intelligence run FCT-READINESS-01 \
  --params '{"merchant":{"legacySellerId":<seller_id>}}' --out readiness.json
```

Read `verdict`, `training.months`, `training.floorClearsAt`, `coverage`, `requirements`.

- `below_floor`: stop here, with the answer. Tell the user how many trainable months the
  account has, the floor (12), when the floor clears if both feeds keep landing
  (`floorClearsAt.floor`), and the `requirements` in plain words (a missing ad-spend history
  is the usual one, and the answer names the backfill that would fill it). Outcome `ok`,
  payload `source: none`, `reason: below_floor`.
- `floor` (12 to 17 months): continue, and say in the explanation that the model stands on
  one season of history and reads as a planning level, not a forecast, seven months out and
  beyond.
- `recommended`: continue.

Readiness and the forecast use the same floor; a readiness answer never disagrees with
what the forecast trained on.

### Step 3. The forecast

```bash
mixshift intelligence run FCT-BASELINE-01 \
  --params '{"merchant":{"legacySellerId":<seller_id>},"horizon":<1..12>}' --out baseline.json
```

`detail: "full"` adds the per-fold backtest rows; use it only when the user asks how the
accuracy was measured. Read the answer file, not the headline.

**Published** (`available: true`, `published` set): the figures are the app's document.
`figures.months[]` holds each month's `projected` figure and its range; `published.at`,
`published.by` and `published.age_days` say whose copy and how old; `figures.backtest` the
measured accuracy; `figures.readiness` what it trained on. Corrections entered in the app
since `published.at` reach the answer on the app's next push.

**Computed** (`available: true`, `source: "computed"`, `published: null`): the figures are
the gateway's fit. `figures.label` is the sentence to repeat. `figures.months[]` holds
`projected_sales`, `lower_limit_95`, `upper_limit_95` and `budgeted_spend` per month (an
estimate when `is_budget_placeholder` is true: nobody set a budget, the engine carried spend
from the history). `figures.training` says the months trained on and the months left out and
why; `figures.corrections.applied` how many correction rows the gateway holds for the account;
`figures.backtest.summary` the measured accuracy; `figures.cautions[]` what to warn about;
`figures.servable` false means no spend-driven figure should be planned on it (the fitted
ad-spend effect is negative): say so plainly and give the level only.

**Not served** (`available: false`): say why, from `reason`, in plain words:

| reason | what to say |
|---|---|
| `history_below_floor` | Nothing is published and the warehouse history is below the floor; repeat the readiness answer. |
| `fit_failed` | Nothing is published and the engine could not fit this history; `computed.detail` says why. |
| `withdrawn` | The forecasting app withdrew the forecast; it has to be republished there. |
| `below_floor` | The app's published forecast is below the floor; the app shows what it needs. |
| `units_not_computed` | Units are served only from a published forecast; revenue is available. |
| `scope_not_computed` | A sub-brand forecast needs the app's definitions; the account as a whole is available. |
| `unparseable_vintage` | The published copy cannot be read by this service build; MixShift is on it. |

Never retry the same request. Outcome `ok`, payload `source: none` with the reason.

### Step 4. Explain it

Lead with the answer, then the basis, then the accuracy, then what would sharpen it. Round
to the precision the range supports (a range of hundreds of thousands gets no cents).

1. **The expectation.** For the horizon asked: the sum of `projected` (published) or
   `projected_sales` (computed) across the months, with the range from the 95% limits, and
   the next month on its own. Name the spend the figures stand on (`budgeted_spend` per
   month; say when it is an estimate).
2. **Where it comes from.** One sentence. Published: "the forecast the forecasting app
   published on <date> with your corrections". Computed: the label, in full, the first time;
   after that "the computed forecast".
3. **How accurate.** From `backtest.summary` (computed) or `figures.backtest` (published):
   the median absolute percentage error one month out and three months out, in words a client
   can repeat ("in a typical month it has missed by 7%, three months out"), and whether it
   beat last year's same month as a guess (`seasonalNaive`). A floor-verdict account: say the
   history is one season.
4. **What it stands on.** Months trained on, the months left out and why (currency change,
   partial feed months, months marked draft), corrections applied. Computed: say the gateway
   holds no corrections when `corrections.applied` is 0, and that corrections made in the
   forecasting app reach the answer once the app publishes.
5. **Cautions.** Each entry of `cautions[]` as its own sentence beside the claim it limits.
   `servable: false`: say the figures describe a level, not what spend buys.
6. **Next step.** One line: corrections and publishing happen in the MixShift forecasting app
   (https://forecast.mixshift.ai); a published forecast replaces the computed one on the next
   answer and reaches reports (Report Max reads published forecasts only).

Do not paste the answer file or its tables into chat. Do not name internal tools in the
explanation beyond "the MixShift forecasting app".

### Step 5. Self-review

- [ ] Every figure traces to the answer file; nothing estimated by hand
- [ ] The source is named (published with date, or computed with the label)
- [ ] Accuracy stated from the backtest, in plain words, with the horizon it was measured at
- [ ] Months left out and corrections applied are mentioned when they exist
- [ ] Every caution surfaced; `servable: false` handled as a level, not a plan
- [ ] The forecast is never called the plan
- [ ] No em dashes, no emojis, no internal tool names in the client-facing text
- [ ] Telemetry: `skill.completed` emitted with `source` and `reason`

## Key Constraints

- **One account per forecast.** Never add forecasts across accounts.
- **Revenue only on the computed path.** Units are served from a published forecast.
- **Horizon 1 to 12.** Seven months out and beyond is a planning level on any account:
  the service's own backtests show no training depth beats last year's same month there.
- **Metered.** Readiness and the forecast are each one metered request; cached answers are free
  for a day.

## Output Format

1. The expectation for the horizon, with its range, and next month
2. Where it comes from (one sentence)
3. How accurate (one or two sentences, from the backtest)
4. What it stands on (training months, months left out, corrections)
5. Cautions (when any)
6. Next step (the forecasting app)
