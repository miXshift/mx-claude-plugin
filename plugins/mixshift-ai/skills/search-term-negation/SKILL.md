---
name: search-term-negation
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

Complete this checklist before Step 0. Stop and surface the failure if any item cannot be checked off.

```
PREFLIGHT — search-term-negation — <brand> — <date>
[ ] Context snapshot loaded: tmp/<brand>-search-term-negation-<date>.context.md
    (fallback: shared/clients/<brand>/context.yaml — extract required fields manually)
[ ] Required fields present and non-null:
      accounts[*].seller_id, accounts[*].account_type
      management.acos_target_pct, management.attribution_window_days
      negation.protected_terms
      *** HARD GATE: if negation.protected_terms absent, STOP. Cannot protect anchors from accidental negation. ***
      negation.lane_rules
      *** HARD GATE: if negation.lane_rules absent, STOP. Cannot classify BORDERLINE terms without lane rules. ***
      brand_terms, sub_brands
      campaign_structure.naming_pattern, campaign_structure.objectives
      paused_campaigns (list — may be empty)
      posture.stance
[ ] Pre-fetch artifact present: tmp/<brand>-search-term-negation-<date>.data.md (or .data.json)
    (if absent: run pre-fetch-data.py — see Step 1)
[ ] Prior-run sidecar loaded: runs/<brand>/search-term-negation/ (most recent)
    (if absent: continue — no baseline yet; note in output)
[ ] No active escalation conditions:
      - verdict regresses GREEN→RED without structural_events explanation → surface before delivering
      - protected_terms breach attempted in prior run → investigate context integrity before proceeding
```

---

## Pre-Work Requirements (Critical)

Before starting the negation workflow, load Tier-3 brand context. Insufficient preparation leads to poor optimization decisions.

### Step 0 — Load Tier-3 brand context

Read the context snapshot, prior run, and narrative:
- **`plugins/mixshift-ai/tmp/<brand-slug>-search-term-negation-<run_date>.context.md`** — compact context snapshot pre-extracted by the pre-fetch script. Required fields: `seller_id`, `account_type`, `acos_target_pct`, `attribution_window_days`, `sub_brands`, `brand_terms`, `negation.protected_terms`, `negation.lane_rules`, `negation.asin_negation.pre_check_lifetime_orders_threshold`, `campaign_structure.naming_pattern`, `campaign_structure.objectives`, `campaign_structure.campaign_types_active`, `paused_campaigns`, `structural_events`, `posture.stance`. If absent, fall back to reading `shared/clients/<brand-slug>/context.yaml` directly.
- **`plugins/mixshift-ai/tmp/<brand-slug>-search-term-negation-prior-run.json`** — prior run sidecar (~65 lines). If present, use for drift context and prior verdict. If absent, skip.
- `shared/clients/<brand-slug>/narrative.md` — prose only (brand positioning, partnerships, lifestyle context, judgment guidance for borderline cases). Do not extract numbers from this file.
- ASIN-level corpora (manual conquest lists, competitor ASIN lists) at `shared/clients/<brand-slug>/corpora/*.csv`.

**Fail closed:** if the context snapshot is absent AND `context.yaml` is absent or fails schema validation, stop and direct user to run the `account-cold-start` skill. Do not infer brand portfolio, lane rules, or ACOS targets from prose.

### Data Access Setup
- Search term performance data (impressions, clicks, cost, sales, conversions)
- Campaign and keyword targeting data
- Historical performance metrics (T-30, T-60, T-90, lifetime)
- ASIN targeting and performance data

---

## Core Workflow

### Step 1: Load Pre-Fetched Data

**Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.

Read the data artifact — **prefer the `.md` file** (pre-formatted markdown tables, no parsing overhead):
```
plugins/mixshift-ai/tmp/<brand-slug>-search-term-negation-<run_date>.data.md
```
Fallback to `.data.json` only if the `.md` file is absent.

This file contains pre-executed results for all queries, keyed by query ID:
- `STN-01` — Window search-term performance pull: `SearchTerm, CampaignName, AdGroupName, KeywordText, MatchType, recordType, window_spend, window_sales, window_orders, window_clicks, window_acos`
- `STN-02` — Scratch-table operative query (model-executed only — NOT pre-fetchable): operates on a caller-prepared scratch table; marked as skip in pre_execution. Run this query inline during execution when needed.
- `STN-03` — Borderline-term historical review (T-30/T-60): `SearchTerm, t30_spend, t30_orders, t60_spend, t60_orders` for on-demand review of borderline/threshold terms
- `STN-04` — Theme analysis pull for phrase-negative assessment: `root_term, theme_label, total_spend, total_orders, campaign_count`

STN-03 and STN-04 are on-demand lookups for borderline and theme terms — they are interactive/conditional and may be run inline during analysis. STN-01 is the primary pre-fetched corpus.

All queries share the join key: `(SellerID, SearchTerm, MatchType, CampaignName, AdGroupName)`.

**If the artifact is missing:** Run the pre-fetch script now — do not stop and ask the user:
```bash
python3 plugins/mixshift-ai/scripts/pre-fetch-data.py \
  --skill search-term-negation --brand <brand-slug> --date <YYYY-MM-DD>
```
Use brand-slug derived from the brand context path and today's date as run_date. Wait for it to complete (it will print "Ready. Run the skill now."), then read the artifact and continue.

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
   - Compare against brand ACOS targets
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

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. This is the input to `scripts/compare-sidecars.py`, which surfaces cross-run drift (edits to `negation.protected_terms` or `negation.lane_rules`, dropped queries, sudden tier-mix shifts, verdict regression). Sidecars live at `<plugin>/runs/<brand-slug>/search-term-negation/<data-date>-<run-id>.json`.

Schema source of truth: `<plugin>/shared/run-sidecar.schema.yaml`.

```bash
python3 <plugin>/scripts/write-sidecar.py \
  --skill search-term-negation \
  --skill-version 1.1 \
  --brand-slug [brand-slug] \
  --data-date YYYY-MM-DD \
  --metrics-json /tmp/stn-headline.json \
  --context-snapshot-json /tmp/stn-context-snapshot.json \
  --sql-calls-json /tmp/stn-sql-calls.json \
  --verdict GREEN|YELLOW|RED|OBSERVATIONAL \
  --report-html /tmp/[brand]-reports/search-term-negation.html
```

Use the **window end date** of the upstream search-term-data-pull artifact for `--data-date`, not the run wall-clock date.

**Required JSON inputs:**

- **`metrics-json`** — emit numeric values only (no `$`, no `%`):
  ```json
  {"phase1_negate_count": 28, "phase2_keep_count": 14,
   "tier_a_keep": 9, "tier_b_negate": 17, "tier_c_review": 11,
   "total_zero_conv_spend": 1820,
   "protected_terms_held_back": 3}
  ```

- **`context-snapshot-json`** — record only the `context.yaml` fields you actually consumed in this run:
  ```json
  {"account_type": "VC", "seller_id": "113",
   "primary_metric": "ACOS", "acos_target_pct": 20,
   "attribution_window_days": 14,
   "protected_terms_count": 12,
   "lane_rules_present": true,
   "asin_negation_lifetime_orders_threshold": 3,
   "paused_campaigns_count": 3}
  ```

- **`sql-calls-json`** — list every library query invoked, with the exact params used (params get hashed for cross-run identity). Search-term-negation typically reuses the upstream STDP artifact plus the STN-* tier-classification queries:
  ```json
  [{"id": "STN-01", "params": {"seller_id": "113", "window_start": "2026-03-26", "window_end": "2026-04-25"}},
   {"id": "STN-02", "params": {"seller_id": "113"}},
   {"id": "STN-03", "params": {"seller_id": "113"}},
   {"id": "STN-04", "params": {"seller_id": "113"}},
   {"id": "STDP-CONSUMED", "params": {"upstream_artifact": "/tmp/[brand]-st-data-pull.json"}}]
  ```

**Verdict rule:** `GREEN` = balanced tier mix (most terms cleanly fall into Tier A keep or Tier B negate; Tier C review burden is small). `YELLOW` = many Tier C terms (review burden is high — lane rules or brand context may be underspecified for this corpus). `RED` = a `negation.protected_terms` breach was attempted (a protected term was a candidate for exact negation — held back, but the attempt itself is a context-integrity signal that requires investigation before next run). `OBSERVATIONAL` = first negation pass for the account or insufficient lifetime corpus to evaluate Tier A confidently.

After writing, run the comparator to surface drift against the prior run:

```bash
# Post-delivery: drift check against prior sidecar
python3 scripts/compare-sidecars.py \
    --brand-slug [brand-slug] \
    --skill search-term-negation
# Exits 0 if clean, 1 if drift detected (config change, metric jump, verdict regression).
# Review drift output before closing the run. Drift is not blocking by default.
```

Exit 0 = no drift. Exit 1 = drift detected (config edit, query dropped, tier-mix jump, protected-term breach, verdict regression). Surface drift findings in the next run's report header, not silently.

---

*Skill version: 1.1 — ported from upstream with full domain logic preserved*
