---
name: mx-search-term-negation
description: "Universal workflow for Amazon PPC search term irrelevance analysis and negative keyword strategy. Use when conducting systematic review of search term performance to identify irrelevant traffic and implement surgical negative keywords."
---

# Search Term Negation Analysis

Systematic workflow for analyzing Amazon PPC search terms to identify irrelevant traffic and implement negative keywords.

## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** Brand context comes exclusively from the context snapshot (or `context.yaml` fallback) and `narrative.md`.
- **Do NOT supplement with general Amazon or e-commerce knowledge**, industry benchmarks, or assumed platform dynamics not present in the data.
- **Do NOT echo full data tables or raw query output** in your model response. The HTML report is the deliverable.
- **Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs (except STN-02 and STN-03/STN-04 on-demand queries noted in Step 1).
- **Begin output immediately.** Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.

---

## Preflight — Risk Tier 3 (Required)

Run on whatever brand context exists; never fail closed on it. The ONLY hard requirement is that the brand has at least one account (`accounts[].seller_id` + `account_type`, from `mixshift brand add`). The ACoS reference resolves from the calibration card (Step 0.5) or runs observational — it never blocks a run. Structured negation context (`negation.lane_rules`, `negation.protected_terms`, `brand_terms`, `sub_brands`) is read from context via the resolver and defaulted-and-labeled when absent per Step 0.

```
PREFLIGHT — mx-search-term-negation — <brand> — <date>
[ ] Brand resolves with accounts[*].seller_id + account_type
      (if absent → stop; ask the user to run `mixshift brand add`)
[ ] Calibration confirmed (Step 0.5): acos_target resolved from brand context, an
      OCL override, or run observational (no target → judge ACoS as-is) — never blocks
[ ] negation.lane_rules present
      (if absent: default to {} and classify BORDERLINE terms conservatively — route to
       review, never auto-negate; label "uncalibrated — set lane rules to sharpen")
[ ] negation.protected_terms present
      (if absent: default to [] and WARN prominently ("no protected terms configured —
       review candidates so brand anchors aren't negated; set with `mixshift brand config`");
       the dry-run default + confirm-before-`--commit` write gate is the real protection)
[ ] Pre-fetch artifact present: ~/.mixshift/clients/<brand>/runs/mx-search-term-negation/<date>/data.md (or data.json)
    (if absent: run prefetch — see Step 1)
[ ] Prior-run sidecar loaded: runs/<brand>/mx-search-term-negation/ (most recent)
    (if absent: continue — no baseline yet; note in output)
[ ] No active escalation conditions:
      - negation.lane_rules absent (cannot classify cleanly without lane boundaries) → surface, then run conservatively
      - Tier A keep candidate volume > 80% of corpus (likely context misconfiguration) → surface before delivering
      - verdict regresses GREEN→RED without structural_events explanation → surface before delivering
      - protected_terms breach attempted in prior run → investigate context integrity before proceeding
```

Stop only if the brand has no accounts. Missing brand-context fields are expected — use the documented default, label it, and continue; never halt.

---

## Pre-Work Requirements (Critical)

Before starting the negation workflow, load Tier-3 brand context. Insufficient preparation leads to poor optimization decisions.

### Step 0 — Load Tier-3 brand context

Read the context snapshot, prior run, and narrative:
- **`~/.mixshift/clients/<brand-slug>/context.yaml (validated via `mixshift brand validate <brand-slug>`)`** — compact context snapshot pre-extracted by the pre-fetch script. Fields: `seller_id`, `account_type`, `attribution_window_days`, `sub_brands`, `brand_terms`, `negation.protected_terms`, `negation.lane_rules`, `negation.asin_negation.pre_check_lifetime_orders_threshold`, `campaign_structure.naming_pattern`, `campaign_structure.objectives`, `campaign_structure.campaign_types_active`, `paused_campaigns`, `structural_events`, `posture.stance`. The ACoS reference (`acos_target`) comes from the calibration card in Step 0.5, not here. If absent, fall back to reading `~/.mixshift/clients/<brand-slug>/context.yaml` directly.
- **`~/.mixshift/clients/<brand-slug>/runs/mx-search-term-negation/ (most recent <date>-<run-id>.json)`** — prior run sidecar (~65 lines). If present, use for drift context and prior verdict. If absent, skip.
- `~/.mixshift/clients/<brand-slug>/narrative.md` — prose only (brand positioning, partnerships, lifestyle context, judgment guidance for borderline cases). Do not extract numbers from this file.
- ASIN-level corpora (manual conquest lists, competitor ASIN lists) at `~/.mixshift/clients/<brand-slug>/corpora/*.csv`.

**Brand context is optional — never fail closed on it.** Run on whatever context is present (snapshot / `context.yaml`, Tier-2 Brand Brain as fallback); negation sharpens as context accrues but never requires cold-start. The only hard requirement is `accounts[].seller_id` + `account_type` (from `mixshift brand add`). When `negation.protected_terms` / `negation.lane_rules` / brand portfolio are missing, default + label per the preflight SAFETY notes above rather than stopping — and rely on the dry-run-default + confirm-before-`--commit` write gate as the safety net. Do not infer these from prose; label them missing. The ACoS reference comes from the calibration card in Step 0.5, not here — if absent there, the review runs observational (judge ACoS as-is, don't flag vs a target). Load the structured negation fields (`negation.protected_terms`, `negation.lane_rules`, `brand_terms`, `sub_brands`, etc.) in one call via `mixshift brand context resolve <brand-slug> --json` — each carries `{value, source, fetched_at}` (`source: context` = ✓ confirmed, `brain` = ⊙ pre-filled; `null` = use the default).

### Data Access Setup
- Search term performance data (impressions, clicks, cost, sales, conversions)
- Campaign and keyword targeting data
- Historical performance metrics (T-30, T-60, T-90, lifetime)
- ASIN targeting and performance data

### Step 0.5 — Confirm calibration

Get this run's knobs (and let the user sharpen them) via the confirm card:

```bash
mixshift skill config mx-search-term-negation --brand <brand-slug> --json
```

The `confirmation` payload's `effective_config` holds the values this run will use, as WHOLE-number percents (e.g. `45` = 45%): `acos_target` (the reference ACoS used to judge efficiency — an optional override of the brand target). Seeded from brand context where set, else absent.

Show the user the card — it lists every field with its source, and on a brand's FIRST run it leads with a `capture_note` nudging the top unset fields. They can:
- **confirm / defer** → run on the shown values: `mixshift skill config mx-search-term-negation --brand <brand-slug> --apply '{"action":"confirm"}' --json`
- **edit** → e.g. `... --apply '{"action":"edit","edits":{"acos_target":"22"},"save":true}' --json`. `acos_target` is the shared brand target and persists to brand context for every skill.

**Resolve the working reference (whole-number percent) from the returned `effective_config`:**
- `acos_target` — if absent, run observational (judge efficiency on ACoS as-is, do not flag vs a target).

Never block on this step — confirm-as-is is always available.

---

## Core Workflow

### Step 1: Load Pre-Fetched Data

**Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.

Read the data artifact — **prefer the `.md` file** (pre-formatted markdown tables, no parsing overhead):
```
~/.mixshift/clients/<brand-slug>/runs/mx-search-term-negation/<run_date>/data.md
```
Fallback to `.data.json` only if the `.md` file is absent.

This file contains pre-executed results for all queries, keyed by query ID:
- `STN-01` — Window search-term performance pull: `SearchTerm, CampaignName, AdGroupName, KeywordText, MatchType, recordType, window_spend, window_sales, window_orders, window_clicks, window_acos`
- `STN-02` — Scratch-table operative query (model-executed only — NOT pre-fetchable): operates on a caller-prepared scratch table; marked as skip in pre_execution. Run this query inline during execution when needed.
- `STN-03` — Borderline-term historical review (T-30/T-60): `SearchTerm, t30_spend, t30_orders, t60_spend, t60_orders` for on-demand review of borderline/threshold terms
- `STN-04` — Theme analysis pull for phrase-negative assessment: `root_term, theme_label, total_spend, total_orders, campaign_count`

STN-03 and STN-04 are on-demand lookups for borderline and theme terms — they are interactive/conditional and may be run inline during analysis. STN-01 is the primary pre-fetched corpus.

All queries share the join key: `(SellerID, SearchTerm, MatchType, CampaignName, AdGroupName)`.

**If the artifact is missing:** Run prefetch now — do not stop and ask the user:
```bash
mixshift prefetch --brand <brand-slug> --skill mx-search-term-negation --date <YYYY-MM-DD>
```
Use brand-slug derived from the brand context path and today's date as run_date. Wait for completion, then read the artifact and continue.

### Step 1a: Data Preparation and Filtering

Join pre-fetched query results on the shared key to produce one unified record per search term per location. STN-01 is the primary dataset; STN-03 and STN-04 supplement inline for borderline and theme analysis passes.

**Objective**: Create clean dataset focused on genuinely unknown search terms.

1. **Use pre-fetched STN-01 data** for the analysis period (typically T-3 to T-7 for weekly reviews)
2. **Filter and remove pre-validated terms**:
   - Manual ASIN targets (already validated)
   - Brand terms (inherently relevant)
   - Previously reviewed terms (unless performance changed significantly)
3. **Process ASIN targeting data**:
   - Extract actual ASINs from keyword targeting
   - Identify overlap between manual ASIN targeting and auto discovery
   - Remove duplicate ASIN discoveries already manually targeted
4. **Create clean review dataset** with only genuinely unknown search terms

### Step 2: Performance Health Checks

**Objective**: Identify terms requiring bid optimization vs negation.

1. **Aggregate performance analysis**:
   - Calculate ACOS for each campaign type/product line
   - Compare against the resolved `acos_target` (Step 0.5; whole %). If no target was resolved, judge efficiency on ACoS as-is and do not flag vs a target (observational).
   - Flag anomalous group performance
2. **Individual term trend analysis**:
   - Pull T-30, T-60, T-90, lifetime performance for high-spend terms
   - Identify recent degradation vs historical trends
   - Correlate with known external factors (stockouts, seasonality)
3. **Optimization vs negation decision**:
   - **Bid reduction**: Terms with relevant intent but degrading efficiency
   - **Negation**: Terms with fundamental relevance issues regardless of performance

### Step 3: Systematic Irrelevance Analysis

**Objective**: Identify search terms that represent fundamentally different customer intent than brand positioning.

#### Category-Based Review Pattern
1. **Sort by spend** (highest first) to prioritize impact
2. **Group by semantic themes** (materials, product types, demographics, character names)
3. **Apply brand positioning filter**:
   - Does this search represent a customer who would buy our products?
   - Is this the same product category or complementary category?
   - Does this align with our brand positioning and target demographic?

#### Specific Red Flags
- **Wrong product category**: Wrong product type for the catalog
- **Competitor brand names**: Unless part of conquest strategy
- **Wrong materials**: Material mismatches for the product
- **Wrong demographics**: Wrong age, gender, or intended user
- **Character/pop culture**: Licensed characters only
- **Different lifestyle positioning**: Luxury vs budget misalignment
- **Typos with unclear intent**: Unless patterns show consistent conversion

### Step 4: Historical Impact Analysis

**Objective**: Quantify waste and validate negation decisions.

For each flagged irrelevant theme:
1. **Pull lifetime performance** for all variations
2. **Calculate total impact**:
   - Total spend across all campaigns
   - Total conversions (if any)
   - Conversion rate and ACOS
3. **Identify campaign spread**: Which campaigns are affected
4. **Build business case**: Annual waste projection if not negated

### Step 5: Negation Implementation Strategy

**Objective**: Implement surgical negatives that block irrelevant traffic without restricting valid terms.

#### Negation Type Decision Framework
- **Exact negative**: Specific irrelevant terms (wrong product format, specific brand names)
- **Phrase negative**: Broader category mismatches (wrong materials, themes, demographics)
- **Campaign level**: Systematic category mismatches affecting multiple campaigns
- **Ad group level**: Product-specific irrelevance

#### Implementation Pattern
1. **Start conservative**: Exact negatives first, phrase negatives for clear category mismatches
2. **Document rationale**: Record why each negative was applied
3. **Monitor impact**: Track impression and click volume changes post-implementation

### Step 6: ASIN Discovery Review

**Objective**: Graduate profitable auto-discovered ASINs to manual targeting and negative irrelevant ones.

1. **Performance analysis**: Pull lifetime data for all auto-discovered ASINs
2. **Manual targeting threshold**: Typically >= 3-4 conversions → add to manual campaigns
3. **Thematic relevance review**: Assess product alignment with brand positioning
4. **Negation decision**: No conversions + category mismatch → exact negative ASIN

---

## Quality Control

### Brand Knowledge Validation
- Verify all negation decisions against comprehensive brand portfolio
- Confirm partnership implications
- Double-check product category assumptions

### Performance Context
- Consider seasonal factors, stockouts, and recent changes
- Don't overreact to short-term performance fluctuations
- Maintain focus on customer intent vs temporary metrics

### Implementation Testing
- Start with highest-impact negatives first
- Monitor impression and traffic volume changes
- Be prepared to remove negatives if they over-restrict valid traffic

---

## Success Metrics

- **Waste reduction**: Decreased spend on zero-converting irrelevant terms
- **Efficiency improvement**: Better ACOS on remaining traffic
- **Relevance score**: Higher percentage of search terms aligned with brand positioning
- **Discovery optimization**: More manual targeting of profitable auto-discovered terms

---

## Common Pitfalls

- **Over-negating**: Blocking potentially relevant long-tail variations
- **Under-negating**: Allowing obvious category mismatches to continue bleeding spend
- **Ignoring brand context**: Negating terms that serve secondary product lines
- **Performance myopia**: Focusing only on recent metrics without historical context
- **Incomplete category knowledge**: Missing product portfolio nuances

---

## Workflow Patterns Reference

All SQL queries are pre-fetched before skill execution. Do not read the references/ folder during skill execution. Decision framework templates, category mismatch patterns, and quality control checklists are embedded in the steps above and in brand context (narrative.md).

---

## Step: Emit Run Sidecar (canonical, drift-detection input)

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. Sidecars live at `~/.mixshift/clients/<brand-slug>/runs/mx-search-term-negation/<data-date>-<run-id>.json`. Schema source of truth: `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`.

Use the **window end date** of the upstream mx-search-term-data-pull artifact for `data_date`, not the run wall-clock date.

Compose the input JSON (write to a temp file, then invoke the harness):

```jsonc
// /tmp/stn-sidecar-input.json
{
  "skill": "mx-search-term-negation",
  "skill_version": "1.4.0",
  "brand_slug": "<brand-slug>",
  "run_kind": "per_account",
  "data_date": "YYYY-MM-DD",
  "verdict": "GREEN|YELLOW|RED|OBSERVATIONAL",
  "context_snapshot": {
    "account_type": "SC|VC",
    "seller_id": 0,
    "primary_metric": "ACOS",
    "acos_target_pct": 20,
    "attribution_window_days": 14,
    "protected_terms_count": 0,
    "lane_rules_present": true,
    "asin_negation_lifetime_orders_threshold": 3,
    "paused_campaigns_count": 0
  },
  "headline_metrics": {
    "phase1_negate_count": 0,
    "phase2_keep_count": 0,
    "tier_a_keep": 0,
    "tier_b_negate": 0,
    "tier_c_review": 0,
    "total_zero_conv_spend": 0,
    "protected_terms_held_back": 0
  },
  "sql_calls": [
    {"id": "STN-01", "params": {"seller_id": 0, "window_start": "YYYY-MM-DD", "window_end": "YYYY-MM-DD"}},
    {"id": "STN-02", "params": {"seller_id": 0}},
    {"id": "STN-03", "params": {"seller_id": 0}},
    {"id": "STN-04", "params": {"seller_id": 0}},
    {"id": "UPSTREAM:mx-search-term-data-pull",
     "params": {"sidecar_path": "runs/<brand-slug>/mx-search-term-data-pull/<latest>.json"}}
  ],
  "artifacts": {
    "report_html_path": "<path-to-rendered-output>"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/stn-sidecar-input.json
```

**Verdict rule:** `GREEN` = balanced tier mix (most terms cleanly fall into Tier A keep or Tier B negate; Tier C review burden is small). `YELLOW` = many Tier C terms (review burden is high — lane rules or brand context may be underspecified for this corpus). `RED` = a `negation.protected_terms` breach was attempted (a protected term was a candidate for exact negation — held back, but the attempt itself is a context-integrity signal that requires investigation before next run). `OBSERVATIONAL` = first negation pass for the account or insufficient lifetime corpus to evaluate Tier A confidently.

`mixshift sidecar compare` will surface drift against the prior run once implemented; until then, sidecars accumulate read-only for retrospective inspection.

---

*Skill version: 1.4.0 — ported from upstream with full domain logic preserved*

## Applying negatives (optional, requires explicit user confirmation)

Negation verdicts are recommendations. When the user asks to apply approved
negatives, use the audited Ads write surface instead of manual entry:

1. Build the change set from the approved terms at their matched locations.
   Ad-group level: `sp.create_negative_keywords` with
   `{ "negativeKeywords": [ { "campaignId": "...", "adGroupId": "...",
   "keywordText": "...", "matchType": "NEGATIVE_EXACT", "state": "ENABLED" } ] }`.
   Campaign level: `sp.create_campaign_negative_keywords`. Use the Amazon
   campaign/ad-group ids from the pulled rows; resolve missing ids via
   `mixshift ads call sp.list_campaigns` / `sp.list_ad_groups`.
2. Live conflict check (do this before the dry run). Read the negatives that
   already exist in the live account and drop any change-set term that is
   already negated at the same location and match type, so the dry run only
   carries genuinely new negatives:
   - Ad-group negatives: `mixshift ads call sp.list_negative_keywords --legacy-seller-id <id> --body-file camp-filter.json --json`
   - Campaign negatives: `mixshift ads call sp.list_campaign_negative_keywords --legacy-seller-id <id> --body-file camp-filter.json --json`
   where `camp-filter.json` is `{ "campaignIdFilter": { "include": ["...", "..."] } }`
   for the campaigns in your set. A term is a duplicate when the same
   keyword text, match type, and location (campaign for campaign-level,
   campaign plus ad group for ad-group level) already carry an enabled
   negative. Report the skipped-as-already-negated count alongside the preview
   so the user sees what was filtered out. If the list calls fail
   (`ads_not_configured`, `throttled`, or any error), note that the live
   conflict check was skipped and proceed; the create call is idempotent-safe
   to preview either way.
3. Dry-run it (the default; nothing reaches Amazon):
   `mixshift ads call sp.create_negative_keywords --legacy-seller-id <id> --body-file negatives.json --json`
4. Show the user the preview and ask for explicit confirmation of this exact
   set. Phrase negatives have blast radius: NEGATIVE_PHRASE entries deserve a
   second look in the preview before anyone confirms.
5. Only after the user confirms — in a SEPARATE turn, having seen the dry-run — re-run the SAME command with `--commit`. The user's original request (even a specific one) is NOT commit authorization: it authorizes the dry-run, not the mutation; never run the dry-run and the `--commit` in the same turn.
   Report per-item success/error counts and the `audit_id`.

Hard rules: never pass `--commit` without the user's confirmation of this
specific change set; cap change sets at 200 items per call; on
`insufficient_scope` hand the user the negation list for manual application.

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-search-term-negation
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-search-term-negation --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-search-term-negation --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
