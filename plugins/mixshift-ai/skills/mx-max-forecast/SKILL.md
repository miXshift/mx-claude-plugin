---
name: mx-max-forecast
version: 0.2.0
description: >
  The max tier of forecasting: a revenue forecast for one Amazon account, explained in
  plain language with its measured accuracy, from the MixShift Intelligence service. Serves
  the forecast the MixShift forecasting app published (corrections included) when one
  exists, and otherwise a forecast the gateway computes from the warehouse with the same
  engine, labelled as computed. Checks readiness first and says what would make an account
  forecastable when it is not. On a first forecast nobody has shaped, asks whether the user
  has a sponsored ads budget, and with their yes enters it so the forecast stands on the
  budget instead of an estimate. Never fits a model of its own.
  Triggers on: 'forecast [brand]', 'what will [brand] do next quarter', 'run a forecast',
  'how accurate is the forecast', 'is [brand] forecastable', 'revenue outlook for [brand]',
  'what should I expect next month', 'forecast max', 'use my budget for the forecast',
  'set the [month] budget'.
author: Claude
last_updated: 2026-10-08
dependencies:
  - MixShift Intelligence service (FCT-READINESS-01 and FCT-BASELINE-01 via `mixshift intelligence`)
  - The forecast budget store (`mixshift forecast budget`; the computed forecast reads it, and the forecasting app will once it reads MixShift's forecast store)
  - The token-based sign-in (`mixshift auth login`, or a service credential for unattended runs)
  - Brand context (optional; only the account list is needed)
trigger_phrases:
  - run a forecast
  - forecast for this brand
  - revenue outlook
  - what should I expect next month
  - how accurate is the forecast
  - is this brand forecastable
  - forecast max
  - use my budget for the forecast
sample_input: "What should I expect from Acme Goods over the next six months?"
sample_output: |
  Acme Goods (US seller account): the published forecast covers through December, so three
  months, not the six asked. October is expected at $1.1M (range $0.9M to $1.3M); the three
  months together come to $3.4M on the point figures. This is the forecast the forecasting app
  published on 2026-10-01 with your corrections. One to three months out it has missed by 7%
  in a typical month, and beat last year's same month as a guess in four folds of five.
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
mixshift telemetry emit skill.completed --skill mx-max-forecast --outcome <ok|failed|deferred|skipped> --payload-json '{"source":"<published|computed|none>","reason":"<reason or ok>","budget":"<entered|declined|existing|not_asked>"}'
```

Run it in bash, on one line. If the payload is rejected, run the same command again without
`--payload-json`. `source` is where the figures came from (`published`: the app's copy;
`computed`: the gateway's fit; `none`: no forecast was served). `reason` is the service's
`reason` when nothing was served, else `ok`. `budget` is what Step 3b found: `entered` (the user gave a budget and it was saved),
`declined` (asked; the user had none or said no), `existing` (months already held a budget),
`not_asked` (a published forecast, or a computed one already shaped by corrections). Outcomes: `ok` (a forecast or a readiness answer
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
- **One write, only on the user's yes.** The only thing this skill writes is the account's
  monthly sponsored ads budget, with `mixshift forecast budget set`, after the user has seen
  the exact months and amounts and said yes. Never invent a budget, never take one from brand
  context or a sheet without showing the figures first, and never write a budget for a
  published forecast (the app holds that one). It writes no brand context and no timeline
  event. Other corrections (a stockout month, a one-off) are made in the forecasting app.

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
  account has, the floor (12), when the floor clears if both feeds keep landing (only when
  `floorClearsAt` is present and `floorClearsAt.floor` is a month; when the block is null the
  feeds are not landing monthly and no date can be promised, which `requirements` says), and
  the `requirements` in plain words (a missing ad-spend history is the usual one, and the
  answer names the backfill that would fill it). Outcome `ok`, payload `source: none`,
  `reason: below_floor`.
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

**Published** (`available: true`, `published` set): the figures are the app's document, in
the document's own shape. Each row of `figures.months[]` has `status` (`closed`, `current`,
`open`), `expectation.forecast` (null when the model made none for that month; else `value`
and `band.lower` / `band.upper`), `sales.value` (the actual, closed months), `budget.value`
with `budget.kind` (`actual`, `saved`, or `estimated` when nobody set a budget). `published.at`
and `published.age_days` say when the copy was published and how old it is (never quote
`published.by`: it is a person's address). `figures.backtest` is null or carries `verdict`
(`measured`, `too_few_folds`, `not_measured`) and `byHorizon.h1_3` / `h4_6` / `h7_12`, each
with `apeMedian`, `mae`, `naiveWinsShare`, `n`. `figures.readiness` says what it trained on.
The published window is the calendar year of the document's last closed month: the open
months it holds may be fewer than the horizon asked. Corrections entered in the app since
`published.at` reach the answer on the app's next push.

**Computed** (`available: true`, `source: "computed"`, `published: null`): the figures are
the gateway's fit. `figures.label` is the sentence to repeat. `figures.months[]` starts at the
month after the last complete month and holds `projected_sales`, `lower_limit_95`,
`upper_limit_95` and `budgeted_spend` per month (an estimate when `is_budget_placeholder` is
true: nobody set a budget, the engine carried spend from the history). `figures.training` says the months trained on and the months left out and
why; `figures.corrections.applied` how many correction rows the gateway holds for the account;
`figures.backtest.summary` the measured accuracy (`ape.medianByHorizon[0]` one month out,
`[2]` three months out, `forecast.mae`, `seasonalNaive.forecastMae` against `naiveMae`); `figures.cautions[]` what to warn about;
`figures.servable` false means no spend-driven figure should be planned on it (the fitted
ad-spend effect is negative): say so plainly and give the level only.

**Not served** (`available: false`): say why, from `reason`, in plain words:

| reason | what to say |
|---|---|
| `history_below_floor` | Nothing is published and the warehouse history is below the floor (`computed.training_months`, `computed.readiness`); repeat the readiness answer. |
| `fit_failed` | Nothing is published and the engine could not fit this history; `computed.detail` says why. |
| `withdrawn` | The forecasting app withdrew the forecast; it has to be republished there. |
| `below_floor` | The app's published forecast is below the floor; the app shows what it needs. |
| `units_not_computed` | Units are served only from a published forecast; revenue is available. |
| `scope_not_computed` | A sub-brand forecast needs the app's definitions; the account as a whole is available. |
| `unparseable_vintage` | The published copy cannot be read by this service build; MixShift is on it. |

Never retry the same request, with one exception: `account_too_large_use_async` (readiness or
the baseline on a large account) means re-run that one request ONCE with `--async`, then
`mixshift intelligence poll <runId>` until it is ready and `mixshift intelligence get <runId>
--out <the same file>`. The only other permitted re-run is the one after a budget is saved
(Step 3b), which may itself need `--async` once. Otherwise outcome `ok`, payload `source: none`
with the reason.

### Step 3b. The budget (computed forecasts)

A computed forecast stands on spend. When nobody has entered a budget, the engine estimates
each month's spend from the account's history, and the forecast moves with that guess.

**When to ask.** Ask once, before the full explanation, when all of these hold: `source` is
`computed`, `figures.corrections.applied` is 0, and every row of `figures.months[]` has
`is_budget_placeholder: true`. That is a first forecast nobody has shaped. Do not ask on a
published forecast (the app holds its budget), and do not ask when any month already carries
a budget (`is_budget_placeholder: false`): say which months stand on the user's budget instead
(`budget: existing`).

**Look before asking.** Check the brand's context (`~/.mixshift/clients/<brand-slug>/context.yaml`,
`structural_events` and `goals`) for a stated sponsored ads budget or a link to a budget
sheet. Budgets usually live in a spreadsheet or document the team maintains, often a Google
Sheet. To read one, use the Drive connector's download as CSV (the plain read can return the
layout without the values); if no connector is available, ask the user to paste the months.

**Ask in one message.** Give the headline first (next month's figure and the total, "on
estimated spend of about $X a month"), then: do they have a sponsored ads budget for these
months that the forecast should use? When the context or a sheet holds one, show those months
and amounts and ask whether to use them. The forecast stands on sponsored ad spend only, so a
budget that includes DSP is entered without it: when the sheet splits sponsored and DSP, take
the sponsored line and say so in one clause; when it holds only a total, ask the user for the
sponsored part (never subtract a guess).

**On yes**, save the months the user confirmed: the month in progress or later, at most twelve
months ahead (one call). The note lands on months that have none; a month that already carries
a note keeps it (it usually explains another correction), and the command says which:

```bash
mixshift forecast budget set --scope <scope_id from the answer> \
  --set 2026-10=50000 --set 2026-11=40000 --note "<where the budget came from>"
```

When a month already holds a different budget, run the same command with `--dry-run` first and
show the user what changes before saving.

Then run Step 3 again, with a horizon that covers the last month saved (up to 12): the saved
budget changes the answer, so it is one more metered request, not a cache hit. Compare the
months saved with `figures.months[]` in the new answer and name any saved month the answer does
not use (outside the horizon). Then explain the new answer. **On no**, explain the answer you have
and say the spend is estimated. A refused save (`state_home_elsewhere`, `insufficient_scope`,
`scope_not_yours`) is reported in the CLI's own words; the forecast you already have still
stands. Check what is saved at any time with `mixshift forecast budget show --scope <scope_id>`;
`mixshift forecast budget clear --scope <scope_id> --month YYYY-MM` takes a month back to the
estimate.

The same command serves a later request ("set the November budget to 60k"): confirm the
months and amounts, save, re-run.

### Step 4. Explain it

Lead with the answer, then the basis, then the accuracy, then what would sharpen it. Round
to the precision the range supports (a range of hundreds of thousands gets no cents).

1. **The expectation.** First the open months actually served: computed, every row of
   `months[]`; published, the rows whose `status` is not `closed` and whose
   `expectation.forecast` is set. Count them; when fewer than the horizon asked, say so
   ("the published copy covers through December: three months, not six") and never
   extrapolate. Then: the next month's figure with its own range, and the total of the point
   figures across the served months. The ranges are per month; never add them up as a range
   for the total. Name the spend the figures stand on (`budgeted_spend` or `budget.value`),
   month by month where it differs: the user's budget (`is_budget_placeholder: false`, or
   `budget.kind` `saved`) or an estimate (`is_budget_placeholder: true`, or `budget.kind`
   `estimated`).
2. **Where it comes from.** One sentence. Published: "the forecast the forecasting app
   published on <date> with your corrections". Computed: the label, in full, the first time
   (say "the MixShift service" for the gateway in client-facing text); after that "the
   computed forecast".
3. **How accurate.** Computed: from `backtest.summary`, the median absolute percentage error
   one month out and three months out, and whether the forecast's error beat last year's same
   month as a guess (`seasonalNaive.forecastMae` below `naiveMae`). Published: from
   `figures.backtest.byHorizon.h1_3`, the median error one to three months out (`apeMedian`)
   and the share of folds that beat last year's same month (`naiveWinsShare`); when
   `backtest` is null or its `verdict` is not `measured`, say the accuracy was not measured on
   this copy and quote nothing. In words a client can repeat ("one to three months out it has
   missed by 7% in a typical month"). A floor-verdict account: say the history is one season.
4. **What it stands on.** Months trained on, the months left out and why (currency change,
   partial feed months, months marked draft), corrections applied. Computed: say the gateway
   holds no corrections when `corrections.applied` is 0, and that corrections made in the
   forecasting app reach the answer once the app publishes.
5. **Cautions.** Each entry of `cautions[]` as its own sentence beside the claim it limits.
   `servable: false`: say the figures describe a level, not what spend buys.
6. **Next step.** One line: a budget can be entered or changed here at any time (Step 3b);
   other corrections and publishing happen in the MixShift forecasting app
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
- [ ] Budget: asked only on a first, unshaped computed forecast; written only after the user
      saw the months and amounts and said yes; sponsored only; the answer re-run after a save
- [ ] The forecast is never called the plan
- [ ] No em dashes, no emojis, no internal tool names in the client-facing text
- [ ] Telemetry: `skill.completed` emitted with `source` and `reason`

## Key Constraints

- **One account per forecast.** Never add forecasts across accounts.
- **Revenue only on the computed path.** Units are served from a published forecast.
- **Horizon 1 to 12.** Seven months out and beyond is a planning level on any account:
  the service's own backtests show no training depth beats last year's same month there.
- **Metered.** Readiness and the forecast are each one metered request; cached answers are free
  for a day. Saving a budget is two small requests on the account's usage (a read and a save),
  and the re-run after it is one more forecast request.
- **Sponsored only.** The budget is sponsored ad spend, the basis the computed forecast stands
  on; DSP is not part of it.

## Output Format

1. The expectation for the horizon, with its range, and next month
2. Where it comes from (one sentence)
3. How accurate (one or two sentences, from the backtest)
4. What it stands on (training months, months left out, corrections)
5. Cautions (when any)
6. Next step (the forecasting app)
