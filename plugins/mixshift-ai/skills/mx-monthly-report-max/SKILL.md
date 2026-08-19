---
name: mx-monthly-report-max
version: 0.1.0
description: >
  Composes and publishes the intelligence-powered monthly Amazon performance report:
  every figure is served by the MixShift Intelligence service (H-Bridge ops + ads +
  cross-domain envelope), typed through a figure/claim contract with mechanical
  validators, and rendered deterministically. The smart tier alongside mx-monthly-report.
  Covers MoM and YoY comparisons, bridge decompositions, item-group highlights,
  forecast beat/miss, and Looking Ahead. Saves report as local HTML.
  Triggers on: 'monthly report max', 'max monthly report', 'smart monthly report',
               'monthly report with intelligence for [brand]'.
author: Claude
last_updated: 2026-08-12
dependencies:
  - MixShift Intelligence service enrollment (INS-MONTHLY-01 via `mixshift intelligence`)
  - harness report-contract (typed figure/claim validators + fixtures)
  - brand context (context.yaml / narrative.md; degrade-and-label when absent)
sample_input: "Smart monthly report for example brand, July 2026"
sample_output: |
  ## July 2026 Monthly Report — example brand
  Bottom line: OPS $X.XXM (−$X.XK MoM), TACOS X.X% (+X.X pts), YoY +X.X%
  Full HTML report saved to [local reports dir]/monthly-report.html
standalone: true
handoff_optional: true
---

# Monthly Performance Report Max

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), resolve the bundled CLI by scanning for it once and reuse the path: `MIXSHIFT_CLI="$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)"`, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.

**What this skill is:** the model's ONE job here is composing claims and prose against typed
figures. Everything upstream of that is the intelligence service; everything downstream is
deterministic code. The engine computes; the extractor types the figures; you write; the
validators refuse a document that quotes a number without its basis, a superlative without its
population, or a caveat-carrying figure without its caveat; the renderer writes the HTML.

**How it differs from `mx-monthly-report`:** that skill is the standard tier and stays
exactly as it is. This one is the smart tier — engine-served figures, additive-exact bridge
decompositions with footing checks, evidence-as-data, and mechanical claim validation at the
render seam. If the account's tenant is not enrolled in MixShift Intelligence, say so and
offer the standard tier instead; do not half-run this one.

**Why it is shaped this way:** nine claim errors shipped in one client-facing tab of a
July 2026 report, caught by a cold reviewer rather than the build — and the rules that would
have caught four of them were already written in the v1 skill the day they shipped. A rule in
prose is checked by the same attention that wrote the sentence. The incident history behind
every rule lives in [`rules-provenance.md`](rules-provenance.md); read an entry whenever a
rule below feels arbitrary. New defects route by scope per the append protocol at the top of
that file.

**Terminology:** anything public-bound says "H-Bridge" or "MixShift bridge methodology".

---

## Preflight

1. **Brand context — degrade and label, never fail closed.** Load the brand-context fields in
   one call via `mixshift brand context resolve <brand-slug> --json` (each carries
   `{value, source, fetched_at}`), with `~/.mixshift/clients/<brand-slug>/context.yaml` +
   `narrative.md` as the underlying files and the Tier-2 Brand Brain as fallback. The only
   hard requirement is an account identity (`seller_id` + `account_type`) — if both are
   absent, stop and say so. Any other missing field gets its documented default, labeled in
   the report — never invented, never a stop. Do not extract numbers from narrative prose.
2. **Freshness:** honor the context-freshness window (35 days; prior-closed-month backfill
   exception applies) and the prior-run sidecar under
   `~/.mixshift/clients/<brand-slug>/runs/mx-monthly-report-max/` when present.
3. **Audience flag** (`internal` | `client`) before any writing. Client mode: no nav, no
   prior-month section, no internal tool references, no raw ASIN codes (nicknames from
   context.yaml only), no agency-internal language, no unshipped plan items as "confirmed".
4. **Metered disclosure:** one monthly report consumes one metered intelligence request.
   Re-renders re-read the envelope artifact on disk; they never re-run the entry. Say this
   before the first run of the session.

---

## The pipeline

### Step 1 — Acquire the run bundle

INS-MONTHLY-01 returns one **composite bundle** for the whole run, not a single response —
one MoM pair and one YoY pair, each an ops + ads companion, nested inside it:

```bash
mixshift intelligence run INS-MONTHLY-01 --params-file p.json --out run.json
```

(params: `{"merchant": {"sellerId", "marketplaceId"}, "month", "grouping", "includeYoY"}`;
oversize accounts return an async handle — poll with `mixshift intelligence poll`, never
cancel on time.) The bundle shape is `{ok, mom: {ops, ads, crossDomain}, yoy: {ops, ads,
crossDomain} | null, headline, limitations, meta}` — where the YoY leg's `ads` and
`crossDomain` are ALWAYS null, because exactly one ads bridge runs per request, against the
MoM window. That is the leg's scope, not missing data, and the run says so in its own
limitations. `run.json` is never fed to the extractor as-is — Step 2 pulls
each nested envelope out by name, one period-prefixed figures document per envelope.

On `not_enrolled` or a service error: **degrade and label** — name the degradation in the
report header and offer the standard-tier skill; never fail closed, never silently
substitute locally-computed numbers for engine ones.

**Re-pull on the day you publish, and diff.** Amazon restates recent months — measured on
live accounts at magnitudes from low hundreds to ~$10K within days of a build. If two runs
disagree, it is time, not grain. A figure quoted from a stale envelope is a defect.

### Step 2 — Extract typed figures per envelope (never read raw envelope JSON)

The bundle nests its envelopes, so extract each one the report needs by name instead of
feeding `run.json` straight in: `mom.ops` for the retail/bridge figures plus the
`crossDomain` cross-domain block (it rides the ops leg of the pair, never the ads leg),
`mom.ads` for the ads figures, and `yoy.ops` when `includeYoY` was set. Each `--select`
produces its own figures document (typed Figure objects with `source_path` into the
envelope, basis/unit metadata, envelope caveats mapped into the caveat registry); require
`--check` to pass on every one of them (required fields, envelope-rooted source paths,
delta = p2 − p1, the ads SKU-split identity, bridge legs footing to net):

```bash
mixshift report extract run.json --select mom.ops --check --out figures.mom.ops.json
mixshift report extract run.json --select mom.ads --check --out figures.mom.ads.json
mixshift report extract run.json --select yoy.ops --check --out figures.yoy.ops.json  # only when includeYoY
```

**Every id a `--select` produces is prefixed with its period** — `mom.*` or `yoy.*` ahead of
the usual domain shape, e.g. `mom.ops.ops.p1` and `yoy.ops.ops.p1` from the same metric in
two different periods. MoM and YoY figures therefore never collide, even once every document
this step produced is composed into one report. Never build or expect a bare, unprefixed id
(`ops.ops.p1`) from a `--select` extraction — that shape belongs to a plain, non-composite
response only, which this pipeline never hands the extractor.

Record `source.engineVersion` off the `mom.ops` figures document for the sidecar, and
compose the report against the full set of figures documents together — the period prefix is
what makes that merge safe. Reading a 40–120KB envelope "carefully" in context is the
reason-from-the-fragment-you-kept failure this step exists to prevent, composite bundle or
not.

### Step 3 — Residual SQL (declared, shrinking)

The envelope serves campaign-TYPE tables (ads runs with `labelGroupBy: "CampaignType"`) and
SKU-level product-line revenue (asin-grain runs) on engines ≥ 0.1.0 — **re-probe per engine,
not per report**. Items below the insight serving threshold get no entity row — carry the
account-total remainder explicitly rather than fabricating rows.

Where residual SQL is still used (older engines only), it is pre-fetched only, recorded in
the sidecar, no inline SQL, and two guards stay with it:

- **Attribution completeness (SC):** for SB/SD rows, `ad_sales_14d < ad_sales_7d` is
  impossible with complete data — flag, halt, offer paste-in or proceed-with-note; record
  `attribution_state`.
- **Item-group classification (SC):** when the tables come from the ENVELOPE, the engine's
  own operational item groups are authoritative — verify entity rows foot to the account
  total. `context.yaml::item_group_mapping` applies only to residual-SQL classification
  (first-match-wins, fallback group), with the per-group SKU listing emitted for
  confirmation. SKU titles are diagnostic input, never display strings.

### Step 4 — Runtime inputs (forecast)

The forecast upload must contain actuals **through the report month** or it is not provided:
suppress the YTD/MoM beat-miss cards, the forecast table, and every "vs. forecast /
projected / ahead / behind" phrase entirely — no fallback to a prior upload, no synthesis
from trend. Surface the forecast state in the console output. Fixed vocabulary: "the
MixShift revenue forecasting model" (first mention) / "the forecasting model" (the model) /
"the forecast" (the number). "Plan" is banned.

### Step 5 — Compose `report-data.json` (the model's actual work)

Every number is a `figure_ref` into figures.json; every sentence that asserts something is a
typed claim (Figure / Derived / Claim / Caveat / Section — the harness report-contract). A
`figure_ref` built from a composite extraction names its period explicitly — `mom.ops.ops.p1`
for the MoM figure, `yoy.ops.ops.p1` for the YoY figure of the same metric — never the bare
`ops.ops.p1` shape. There is exactly one report-data.json and its figures come from every
document Step 2 produced, so a `figure_ref` that drops the period is not just wrong style: on
a bare id, MoM and YoY read as the same figure.

- **Claims carry their kind**, and the kind carries obligations: `superlative`/`quantifier`
  need a population with `complete: true` plus a machine-checkable form — until the envelope
  serves the census, topDrivers populations are `complete: false` and such claims **degrade
  to observations** (correct behavior, not a gap). `causal` needs a mechanism and tested
  alternatives; a decomposition leg is `tracking`, and tracking text may not use causal
  verbs. `comparison` may not mix bases.
- **Computing anything locally requires a `Derived`** with `inputs[]` and a written
  `why_not_published`. For a figure the engine publishes, that sentence cannot honestly be
  written — which is the point. The one standing legitimate Derived: the day-normalised
  ex-event rate on older engines (see engine-pending rules).
- **Caveats travel by reference to every quotation site.** A blocking caveat renders in
  every section that quotes its figure — including the executive summary.
- **Prose strings are written here, in the data file** — composing inside HTML markup
  produces template-shaped prose. Shared content (a table or Bottom Line appearing in both
  executive and full views) is authored ONCE and injected into both.

### Step 6 — Validate, then review

Mechanical, all must pass, on every report built this session (a fix applied to one
marketplace and left standing in its siblings is this skill's most-repeated historical
defect):

```bash
mixshift report validate <report-data.json>      # the harness report-contract validators
python helpers/prose-lint.py <rendered.html>     # after Step 7's render
```

Then the judgment passes:

- **Pass 0 — does the report answer the question it exists to answer?** With a current
  forecast, the job is explaining the variance: name the largest component, size it, and
  test the alternative explanations **in the report** (availability, seasonality, price,
  calendar, mix, ad efficiency). The framing you were handed is a hypothesis, not a
  finding — a "getting worse" story must survive a like-for-like rebuild (event-adjusted,
  matched windows) before it ships. Without a forecast the same discipline applies against
  the prior period.
- **Substantiation:** every causal or comparative claim names its figure; every
  residual-SQL number names why the envelope could not serve it. Emit `.review.json`
  (schema: `helpers/mpr-review-schema.json`) with honest counts and the validator exit
  codes — an empty corrections list means you found nothing, not that you skipped the pass.

### Step 7 — Render, deliver, record

Render `report-data.json` through the deterministic renderer to
`<delivery.reports_local_dir>/monthly-report.html`. The renderer is the single HTML writer:
it signs and formats every delta from the figure's unit/precision, sets visual accents from
value sign (never prose tone), injects shared blocks once, suppresses forecast sections
unless provided-current, and places caveats at quotation sites. **Corrections go to
report-data.json, never the HTML.** Then:

- **Sidecar:** the standard inputs plus envelope run ids, `engineVersion`, catalog
  revisions, and the four state fields (forecast / attribution / item-group classification /
  context freshness). Surface drift vs the prior sidecar in next month's header.
- **Discoveries** (`.discoveries.json`): typed proposals only — mapping corrections, context
  value disagreements, watch candidates, structural-event candidates. Humans promote.

---

## Judgment rules (the residue that is genuinely yours)

**Analytical:**

- **C1 — cross-item discovery.** For the largest declining lines, read the halo flows both
  ways from the envelope (confirm direction against the legend — Sources = halo-IN,
  Targets = halo-OUT). An item whose demand is created by another item's advertising is
  invisible at group grain and has been a third of an account's entire decline. Size the
  pair; **carry the confound** (an event in the comparison period is part of the fall);
  state it as tracking, never cause.
- **C1a — run C1 on every item named in a spend recommendation**, not only the biggest
  decline. The deciding measure is **(same-SKU ad sales + halo-out) ÷ ad spend** against
  account ROAS — price-neutral, counts passed-on sales. A line has been recommended for
  budget at $0.38/dollar while the just-cut line earned $1.34.
- **C2/C3 — event-shift and clean comparator.** Check surge windows in BOTH periods before
  attributing anything to demand; rebuild moved-event comparisons on a daily-rate basis; and
  re-measure any move against the nearest event-free month before drawing a conclusion.
- **C4 — cover-build direction.** Rising weeks-of-cover is a restock only if inventory rose;
  on flat stock and falling demand it is a demand finding, and calling it a restock inverts
  the meaning. A $0 cascade contribution means zero *contribution*, never "the lever held
  still."
- **Probe before declaring a limit.** Never write "the engine cannot do X" from a run you
  did not create: request the grain, read the manifest entry and reason code, report an
  override as a run-scoped defect. Fallbacks are declared, with their proxy checked.
- **Test the mechanism before publishing it** — and publish the test, including when the
  intuitive answer loses. A failed hypothesis has been the strongest finding in its section.
- **Re-derivation upgrades findings as often as it catches errors.** Both directions pay.

**Writing:**

- Conclusion first, mechanism second. Sign every change figure, including adjective-shaped
  ones. MoM/YoY labels on every delta in prose. Plain spoken register, US spelling — if a
  phrase would not survive being read aloud on a client call, rewrite it. No internal report
  names in client copy — say what the data means and attach the dollars.
- **Every bullet stands alone:** the thing named, the move sized, the comparison that makes
  it a problem, the action in the lead. These get pasted into emails months later.
- **Every callout sentence must change a decision** — restating what a ratio implies, or
  defending an item against a charge nobody made, is noise. When two callouts share a causal
  mechanism, mirror their structure, place them adjacent, and state the magnitude comparison
  explicitly.
- No editorial certainty without brand-owner validation — "consistent with" for correlated
  trends. Never assert a forward metric without the forecasting model or a confirmed target.
  Never reference a seasonal driver without the model's seasonal index. Never state OOS
  without the availability data.
- **Sweep every fix across every sibling report in the session before replying** — fix it
  where raised, grep the siblings for the same construction, fix or justify each, and say
  which reports were swept.

---

## Engine-pending rules (verbatim residents until the engine adopts them)

These are methodology-universal truths that belong in the engine as finding-suppression
rules or published caveats. Until they exist there, they bind here. Provenance has each
one's story.

1. **The blended-benchmark non-finding.** Never treat a line's gap to the blended account
   conversion rate as a finding: conversion correlates with price point, so the top of the
   ladder sits below the blend by construction, every month. This extends to share gaps and
   revenue-per-session — revenue/session = conversion × ASP, so a cheap item trips it every
   month. **Decompose the ratio before reporting it**; a drill signal is a place to look,
   never a finding. Test: if the line's position vs the average would be the same in a good
   month and a bad one, it is not evidence.
2. **Attribution of a total to a component takes absolute contributions, not growth rates.**
   A component can grow fastest and remain a minority of the change — sum the components in
   currency and check the share before writing "X drove".
3. **"Bid pullback," not budget language**, when spend fell because bids fell.
4. **`exSurgePctChange` is not day-count normalised.** On engines ≥ 0.1.0 the evidence
   block's window-comparability statements publish the correctly day-normalised ex-event
   per-selling-day change — quote that and skip the local Derived. On older engines, compute
   `(period − event) ÷ (days − event_days)` yourself and show the working.
5. **A decomposition leg can oppose the blended metric of the same name — that is mix.**
   Label the lever as per-line and explain the mix in prose; a reader who spots the
   contradiction without the reason distrusts the whole table.
6. **Reconcile statement-level figures against their metric totals** before publishing —
   statement builders have quoted one entity's value as a period total.

---

## Where things live (do not re-create them here)

| Concern | Home |
|---|---|
| Figure/claim/caveat contract, validators, the nine shipped errors as must-fail CI fixtures | harness `src/lib/report-contract/` (borrow map: [`components.yaml`](components.yaml)) |
| Incident history + append protocol | [`rules-provenance.md`](rules-provenance.md) |
| Per-brand voice, section list, banned-terms additions | brand context (`reporting.*` fields) |
| Scalar knobs (targets, thresholds) | calibration card + manifest-declared context fields |
| Brand facts, structural events, item-group mapping | `~/.mixshift/clients/<brand>/context.yaml` |
| Prose quality enforcement | `helpers/prose-lint.py` |

---

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-monthly-report-max
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-monthly-report-max --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-monthly-report-max --outcome <ok|failed|deferred|skipped>
```
