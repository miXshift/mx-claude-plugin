<!-- SOURCE OF TRUTH: shared/BRAND-CONTEXT-SCHEMA.md. The copies under
skills/*/references/ are synced verbatim so each skill folder stays
self-contained; edit the shared file and re-sync all copies together.
scripts/check-docs.mjs enforces parity. -->

# Brand Context Schema — Canonical Standard
**Version:** 1.0.0
**Date:** 2026-04-01
**Author:** MixShift
**Purpose:** Universal schema for all brand context files (Tier 3). Every field maps to one or more skills that depend on it. Required fields = skill will fail or produce wrong output without them. Optional fields = skill degrades gracefully but is more accurate with them.

---

## Design Principles

1. **Every field has a skill dependency.** If a field doesn't affect a skill output, it doesn't belong in required.
2. **Gaps are surfaced, not silently accepted.** After every skill run, missing required fields generate specific questions.
3. **Future-proof.** The schema has placeholder sections for platform interaction, file uploads, and call transcripts — empty today, populated over time.
4. **One source of truth.** Skills read this file. Nothing is hardcoded in skill files that belongs here.

---

## Section Map

| Section | Required for | Optional for |
|---|---|---|
| 1. Identifiers | All skills | — |
| 2. Account Type & Attribution | All skills | — |
| 3. Performance Targets | Bid Health, Runaway Spend, Health Check | — |
| 4. Objective Configuration | Bid Health, Runaway Spend | Health Check |
| 5. Product Portfolio & Item Groups | All skills | — |
| 6. Brand Terms | Negation skills | Health Check |
| 7. Structural Events | All skills | — |
| 8. Spend Posture | Bid Health, Runaway Spend, Health Check | — |
| 9. Account Actions Log | All skills | — |
| 10. Seasonality Profile | Health Check, brand setup | Bid Health |
| 11. Revenue Baseline | Health Check, brand setup | — |
| 12. ST Negation Rules | Negation skills | — |
| 12A. ASIN Negation Corpora | ASIN negation, brand setup | — |
| 13. ASIN Identity Fit Rules | Negation skills | — |
| 14. Delivery Config | All skills | — |
| 15. Brain Inputs (living) | Future platform use | All skills |

---

## Section 1 — Identifiers (REQUIRED)

```
SellerID: [integer — must match warehouse]
AmazonSellerID: [string — Amazon marketplace seller ID]
ProfileID: [string — Amazon Ads API profile ID for write operations]
SellerName in DB: [string — exact match in relevant table, e.g. "YOLO BRICK ROAD"]
Account manager (MixShift): [name]
Client-side contact: [name + role, if applicable]
Brand setup completed: [YYYY-MM-DD or "not completed"]
Last context refresh: [YYYY-MM-DD]
```

**Gap trigger:** If any of SellerID, AccountType, or ProfileID is missing, ALL skills fail at Phase -1.

---

## Section 2 — Account Type & Attribution (REQUIRED)

```
Account type: SC | VC
Management metric: TACOS | ACOS
Attribution window: SP=[days] | SB=[days] | SD=[days] | DSP=[days]
Attribution basis: click | view | mixed
Ops data source: business_reports_dpst_date [SC] | vendor_sales_manufacturing_asin [VC]
TACOS offset: [description — e.g. "both sides lag by 1 day (SC standard)"]

Attribution Backfill Calibration:
  Window standard: T-1 vs T-[N] on Sponsored Products
  Most recent checkpoint:
    Month: [YYYY-MM]
    Spend: $[X]
    ACOS at 1-day: [X]%
    ACOS at [N]-day: [X]%
    Fresh-day improvement heuristic: [X] pts
    1-day capture rate: [X]%
  Operating read: [one sentence interpretation rule]
```

**Gap trigger:** Missing account type causes wrong data source query (SC/VC branch error). Missing attribution calibration = T-1 ACOS intervention calls will be systematically wrong.

---

## Section 3 — Performance Targets (REQUIRED)

```
ACOS target: [X]% — [derivation note]
Scale threshold: [X]% ACOS — [derivation note]
TACOS goal: <[X]% monthly
Quarterly sales target: $[X] (or "not set")
Annual target: [value or "not set"]

Target derivation notes: [explain how ACOS target was derived if not AM-supplied directly]
```

**Gap trigger:** Missing ACOS target = excess spend formula wrong on every keyword. Missing scale threshold = Scale Opportunities table will not work.

---

## Section 4 — Objective Configuration (REQUIRED for accounts with mixed objectives)

```
Default objective: Efficiency
Campaign objective overrides:
  [Campaign name pattern]: Growth | BrandDefense | Awareness | Launch | Efficiency
  [Campaign name pattern]: [objective]

Objective definitions for this account:
  Efficiency: managed to ACOS target, standard CI and excess spend logic
  Growth: intentionally running above ACOS target to win market share; CI fires on anomaly only; no excess spend flag
  BrandDefense: brand term campaigns; managed to impression share, not ACOS; CI fires on spend anomaly
  Awareness: upper funnel SB/SD; DPV efficiency and NTB rate are the metrics; ACOS is reference only
  Launch: data acquisition mode; no ACOS constraint; volume metrics only

House-on-fire threshold: [X]% blended account ACOS — triggers budget cut recommendation before bid cuts
```

**Gap trigger:** Without objective config, all campaigns are evaluated as Efficiency. Correct for simple accounts; wrong for accounts with Growth or Awareness campaigns.

---

## Section 5 — Product Portfolio & Item Groups (REQUIRED)

```
Item group source: [campaign name parsing | vendor_items.ItemGroup | manual]
Sub-brand structure: [yes/no — if yes, sub-brand source field]

| Item Group | Monthly Spend Range | ACOS Range | Status | Notes |
|---|---|---|---|---|
| [name] | $[min]-$[max] | [X%-Y%] | Active | [key behavior] |
| [name] | $0 | — | Paused | |

Airtime threshold: $[X]/month — below this, omit from narrative unless materially changed
Cross-sell dynamics: [SP same-SKU rate, cross-sell patterns if known]
CTR/color dynamics: [if applicable]
CRAP threshold: [if applicable — e.g. de-advertise risk]
```

**Gap trigger:** Unknown item groups = health check dimensional tables are wrong. Paused lines missing = skill may surface them as anomalous spend drops.

---

## Section 6 — Brand Terms (REQUIRED for negation skills, RECOMMENDED for health check)

```
Primary brand name: [string]
Brand term variants: [list — misspellings, phonetic variants, sub-brands]
Proprietary coined terms: [list — terms RP owns that appear in organic search]
Brand ACOS context: [sentence — e.g. elevated vs. established brands, why]
Brand/NonBrand split tracking: yes | no
```

**Gap trigger:** Missing brand terms = brand/nonbrand segmentation fails; negation skills may negate brand traffic.

---

## Section 7 — Structural Events (REQUIRED)

```
| Period | Event | Interpretation rule |
|---|---|---|
| [YYYY-MM] | [event description] | [how to interpret data from this period] |

Active conditions (update on every session where something changes):
  - [condition name]: [description] — active [date range or "ongoing"]
  - [condition name]: [description]

Upcoming events (known future conditions):
  - [event]: [date range] — [what to expect in data]
```

**Gap trigger:** Unknown structural events = skill incorrectly characterizes distorted data as performance signal. This is the most common source of wrong narrative.

**Typed capture (context.yaml `structural_events[]`):** each event carries `id`, `type`, `interpretation` (required), optional `start`/`end`/`active_through` dates, `affects[]` scope refs, and two flexibility axes: `kind` (freeform lowercase snake_case slug naming what THIS event specifically is; REQUIRED when `type: other`, and cannot be `content_change`/`ads_change`/`corroboration`, which the timeline reserves for MixShift's own audited write records) and `tags[]` (freeform lowercase slug list, max 16). The 12 known types: `brand_migration`, `media_spike`, `media_spike_recurring`, `portfolio_decision`, `promotional_window`, `promotional_window_recurring`, `stockout`, `price_test`, `launch`, `off_amazon_media` (standing off-Amazon media condition: outside demand gen, MMM attribution, non-Amazon ad lines), `assortment_change` (expected catalog rotation: seasonal flavors, planned discontinuations), and `other` (the explicit escape; never force a wrong type on what the user told you, record it as `other` plus a specific `kind`). Event `id`s must be unique within the file. An unrecognized type slug is tolerated rather than rejected, so a newer plugin's taxonomy cannot break the brand on an older install; it syncs under the timeline's `other` category carrying the original slug.

**Timeline sync:** structural events publish AUTOMATICALLY to the org brand timeline as declared stakes after context writes (and on `mixshift context push` / `migrate`); `mixshift timeline sync --brand <slug>` is the explicit backfill or dry-run. An event with no `start` date syncs with recorded-now semantics and an `event_date_known: false` marker, so consumers can tell "when we learned it" from "when it happened".

---

## Section 8 — Spend Posture (REQUIRED)

```
Current posture: scale | efficiency | defend | clear_bleed
Posture rationale: [one sentence: why this posture]
Re-entry trigger: [what data signal triggers posture change, e.g. "Sales AND TACOS both rebounding"]
Re-entry sequence: [order of campaign types to re-enter, e.g. NONBRAND EXACT → BRAND → DISCOVERY]
House-on-fire protocol: [what to do when account ACOS materially exceeds target: budget cut first, then bids]
```

**Vocabulary note:** these four values are the enforced `posture.stance` enum in
`context.yaml`; `mixshift brand validate` rejects anything else. Rough intent:
`scale` = push for growth, `efficiency` = optimize toward the ACOS/TACOS target,
`defend` = hold position, `clear_bleed` = cut losses hard. (Earlier drafts of this
document used Growth/Neutral/Pullback/Efficiency; that vocabulary was never valid
in the validator, so do not write it into context.yaml.)

**Gap trigger:** Wrong posture = Scale Opportunity recommendations are wrong (should be "Hold" under `defend`/`clear_bleed`, "Raise" under `scale`).

---

## Section 9 — Account Actions Log (REQUIRED)

```
| Date | Action | Source | Detail | Data visible from |
|---|---|---|---|---|
| [YYYY-MM-DD] | [bid cut/raise/pause/budget change] | [skill/manual] | [keyword, magnitude if known] | [YYYY-MM-DD] |

Change History API status: not integrated | integrated
```

**Gap trigger:** Missing actions log = bid continuity fails. Skill re-recommends in-flight changes. CI breaches from intentional bid raises get misread as anomalies.

---

## Section 10 — Seasonality Profile (REQUIRED for health check, brand setup)

```
| Period | Shape | Driver | Interpretation rule |
|---|---|---|---|
| Jan | [trough/moderate/peak] | [driver] | [rule] |
| ... | | | |

Key interpretation rules:
  [bullet — e.g. "Apr peak is promo-driven, not structural"]
  [bullet — e.g. "Jul/Aug understated due to recurring Spartan stockout"]
```

**Gap trigger:** Unknown seasonality = health check cannot frame pacing correctly; trough months get flagged as anomalies.

---

## Section 11 — Revenue Baseline (REQUIRED for health check, brand setup)

```
Source: [business_reports_dpst_date | vendor_sales_manufacturing_asin]
SellerID: [X] | Period: [start] to [end]

| Month | Total Revenue | Units | Sessions | CVR% | TACOS/ACOS |
|---|---|---|---|---|---|
| ... | | | | | |

Last refreshed: [YYYY-MM-DD]
Refresh trigger: [e.g. quarterly, or on structural break]
```

**Gap trigger:** Stale baseline = pacing projections and YoY comparisons are wrong.

---

## Section 12 — ST Negation Rules

## Section 12A — ASIN Negation Corpora (REQUIRED for brand setup / ASIN negation)

This section is the new brand setup training layer for Phase 2 ASIN review. It prevents the model from starting PDP judgment cold on every account.

```
Manual targeting corpus by item group/lane:
  | Item Group / Lane | ASIN | Campaign type | Why it matters |
  |---|---|---|---|

Auto/PAT converting ASIN corpus:
  | Item Group / Lane | ASIN | Targeting route | Lifetime orders | Notes |
  |---|---|---|---|---|

Interpretation rules:
  - Manual-targeted ASINs are validated positive examples, not negate candidates
  - Item-group mapping is mandatory; the same ASIN may be valid in one lane and wrong in another
  - Auto/PAT converters are proven-positive PDP examples; use them to calibrate adjacency, not as blanket account-wide protection
  - Location-granularity still governs final negate decisions
```

**Gap trigger:** Missing corpora = ASIN negation skill starts cold and over-classifies adjacent PDPs as Irrelevant or Needs Human Judgment. Treat as P1 degrading for any brand where Phase 2 ASIN review is in scope.

 (REQUIRED for negation skills)

```
Skill parameters:
  acos_target: [X]%
  scale_threshold: [X]%
  min_keep_orders: [N]
  spend_floor: $[X]
  phrase_spend_threshold: $[X]
  paused_item_groups: [list]

Relevance rules:
  RELEVANT (never auto-negate): [list with reasons]
  IRRELEVANT — high confidence exact negate: [list with reasons]
  IRRELEVANT — phrase negative safe: [list with reasons]
  BORDERLINE — needs human judgment: [list with conditions]

Phrase negation conflict log (grams that cannot be phrase-negated — appear in converting STs):
  | Gram | Reason | Converting ST example |
  |---|---|---|
```

---

## Section 12A — ASIN Negation Corpora (REQUIRED for brand setup / ASIN negation)

This section is the new brand setup training layer for Phase 2 ASIN review. It prevents the model from starting PDP judgment cold on every account.

```
Manual targeting corpus by item group/lane:
  | Item Group / Lane | ASIN | Campaign type | Why it matters |
  |---|---|---|---|

Auto/PAT converting ASIN corpus:
  | Item Group / Lane | ASIN | Targeting route | Lifetime orders | Notes |
  |---|---|---|---|---|

Interpretation rules:
  - Manual-targeted ASINs are validated positive examples, not negate candidates
  - Item-group mapping is mandatory; the same ASIN may be valid in one lane and wrong in another
  - Auto/PAT converters are proven-positive PDP examples; use them to calibrate adjacency, not as blanket account-wide protection
  - Location-granularity still governs final negate decisions
```

**Gap trigger:** Missing corpora = ASIN negation skill starts cold and over-classifies adjacent PDPs as Irrelevant or Needs Human Judgment. Treat as P1 degrading for any brand where Phase 2 ASIN review is in scope.

---

## Section 13 — ASIN Identity Fit Rules (REQUIRED for negation skills)

```
Tier 1 — Wrong Form Factor (deterministic, no judgment): [category list]
Tier 2 — Correct Form Factor, Doesn't Fit Brand Identity: [criteria list]

FITS brand identity:
  [construction / material / style / price tier signals]

DOES NOT FIT brand identity:
  [mismatch signals]

ASIN Negation Training Set (operator-validated examples):
  | ASIN | Product | Why Negated | Tier |
  |---|---|---|---|
```

---

## Section 14 — Delivery Config (REQUIRED)

```
Local reports dir: /tmp/[brand]-reports/

Report pages:
  index.html: [URL]
  health-check.html: [URL]
  runaway-spend.html: [URL]
  mx-keyword-bid-health.html: [URL]
  brand-context.html: [URL]

Drive folder: [folder name] | Folder ID: [ID]
Drive file IDs:
  health-check.html: [ID]
  runaway-spend.html: [ID]
  mx-keyword-bid-health.html: [ID]

CSS accent color: [hex — e.g. #2a5c2a for example brand green]
Drive sync command: python3 ~/.mixshift/bin/drive-update.py [file-id] [local-path]
```

---

## Section 15 — Brain Inputs (Living Document)

*This section grows over time. Start empty. Populate through Discord feedback, call transcripts, monthly reports, and platform interactions.*

```
## Discord Feedback Log
| Date | Source | Signal | Applied to skill/context | Status |
|---|---|---|---|---|

## Call Transcript Insights
[Future: client call transcripts → extracted facts → added here]
File location when uploaded: [shared/clients/[brand]/transcripts/]

## Monthly Report Annotations
[Future: AM annotations on monthly reports → key findings extracted here]
File location when uploaded: [shared/clients/[brand]/reports/]

## Platform Interaction History
[Future: logged when client interacts with platform — searches, skill triggers, approved writes]

## Open Questions (gap-driven)
Questions generated from last skill run's gap detection:
| Question | Skill that needs it | Priority | Asked on | Answered |
|---|---|---|---|---|
| [e.g. What is the TACOS target for Q2?] | Health Check | HIGH | [date] | [yes/no] |
```

---

## Gap Severity Tiers

| Tier | Definition | Skill behavior |
|---|---|---|
| **P0 — Blocking** | SellerID, AccountType, ACOS target, Delivery config | Skill refuses to run; surfaces specific missing fields |
| **P1 — Degrading** | Attribution calibration, structural events, spend posture, actions log | Skill runs but outputs a gap warning in self-review; may surface wrong narratives |
| **P2 — Enriching** | Seasonality, revenue baseline, ASIN training set, brain inputs | Skill runs normally; output is less precise; no warning unless explicitly requested |

---

## File Naming Convention

`shared/clients/[brand-slug].md`

Brand slugs: `example-brand` | `example-brand` | `example-brand` | `example-brand` | `[new-brand]`

---

*Schema owner: MixShift. Update this file when new fields are added to any brand context file. Skills read this schema to determine what fields to expect and what questions to generate when fields are missing.*
