---
name: search-term-data-pull
description: "Pure data extraction layer for search term analysis. Pulls window ST report, lifetime performance at three granularity levels, existing negatives, and manual ASIN targets. Outputs structured JSON artifact for downstream skills. No judgment, no LLM analysis — data only."
---

# ST Data Pull

Pure data extraction. No recommendations, no LLM, no judgment calls. Output is a structured JSON artifact that feeds downstream negation and harvest skills.

---

**Use only data returned by the pre-fetched queries and context.yaml. Do not supplement with general Amazon or e-commerce knowledge, industry benchmarks, or assumed platform dynamics not present in the data.**

**Begin output immediately. Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.**

## Data Integrity — Non-Negotiable

- `dtCreatedOn` is the date field in the search term report (NOT `DateTime`)
- `recordType` split is mandatory: 'Keyword Targeting' vs 'Product Attribute Targeting'
- Exclusion mask must be applied before any downstream skill sees the data
- Never pass a row to a downstream skill that is already negated

---

## Execution Flow

**Step 0 — Load Tier-3 brand context:**

Read the context snapshot, prior run, and narrative:
- **`plugins/mixshift-ai/tmp/<brand-slug>-search-term-data-pull-<run_date>.context.md`** — compact context snapshot pre-extracted by the pre-fetch script. Required fields: `seller_id`, `account_type`, `acos_target_pct`, `attribution_window_days`, `sub_brands`, `campaign_structure.naming_pattern`, `negation.protected_terms`, `attribution_rule`, `paused_campaigns`. If absent, fall back to reading `shared/clients/<brand-slug>/context.yaml` directly.
- **`plugins/mixshift-ai/tmp/<brand-slug>-search-term-data-pull-prior-run.json`** — prior run sidecar (~65 lines). If present, use for drift context. If absent, skip.
- `shared/clients/<brand-slug>/narrative.md` — prose context only. Do not extract numbers from this file. Spend floors and order thresholds come from context.yaml (or downstream-skill defaults), never from prose.

**Fail closed:** if the context snapshot is absent AND `context.yaml` is absent or fails schema validation, stop and direct user to run the `account-cold-start` skill.

### Step 1: Load Pre-Fetched Data

**Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.

Read the data artifact — **prefer the `.md` file** (pre-formatted markdown tables, no parsing overhead):
```
plugins/mixshift-ai/tmp/<brand-slug>-search-term-data-pull-<run_date>.data.md
```
Fallback to `.data.json` only if the `.md` file is absent.

This file contains pre-executed results for all queries, keyed by query ID:
- `STDP-01` — Existing negatives (exclusion mask): `CampaignID, AdGroupID, KeywordText, MatchType` — used to build campaign_negatives and adgroup_negatives sets
- `STDP-02` — Manual ASIN targets (dedup mask): `KeywordText` — used to build manual_targets set
- `STDP-03` — Window ST pull: `SearchTerm, recordType, CampaignName, AdGroupName, KeywordText, MatchType, Spend, Sales, Orders, Clicks` for the analysis window
- `STDP-04` — Lifetime performance aggregate (account-wide per ST): `SearchTerm, lifetime_spend, lifetime_sales, lifetime_orders, lifetime_clicks`
- `STDP-05` — Lifetime performance by item group: `SearchTerm, CampaignName, lifetime_spend, lifetime_sales, lifetime_orders` (item_group mapped post-query using brand context taxonomy)
- `STDP-06` — Lifetime performance full specific location: `SearchTerm, CampaignName, AdGroupName, KeywordText, MatchType, lifetime_spend, lifetime_sales, lifetime_orders`
- `STDP-07` — Lifetime ASIN stream aggregate: `KeywordText (ASIN target), lifetime_spend, lifetime_sales, lifetime_orders`

All queries share the join key: `(SellerID, SearchTerm/KeywordText, MatchType, CampaignName, AdGroupName)` as appropriate per query.

**If the artifact is missing:** Run the pre-fetch script now — do not stop and ask the user:
```bash
python3 plugins/mixshift-ai/scripts/pre-fetch-data.py \
  --skill search-term-data-pull --brand <brand-slug> --date <YYYY-MM-DD>
```
Use brand-slug derived from the brand context path and today's date as run_date. Wait for it to complete (it will print "Ready. Run the skill now."), then read the artifact and continue.

### Step 1a: Apply Masks and Partition Streams

Join pre-fetched query results to produce the working dataset:

1. Build exclusion mask from `STDP-01`: `campaign_negatives` and `adgroup_negatives` sets
2. Build dedup mask from `STDP-02`: `manual_targets` set
3. Partition `STDP-03` rows into Stream 1 (Keyword Targeting) and Stream 2 (Product Attribute Targeting) on `recordType`
4. Apply exclusion mask to both streams — remove already-negated rows, log count
5. Apply ASIN dedup mask to Stream 2 only — remove manually targeted ASINs, log count
6. Apply spend floor — remove rows where `window_spend < spend_floor`, log count
7. For `STDP-05` results: map each `CampaignName` to its item group using brand context taxonomy. Label unmapped rows `item_group = "unknown"` and log — do not discard.

**Phase 0a — Existing Negatives (Exclusion Mask)**

Built from `STDP-01` pre-fetched results:
- `campaign_negatives`: {(CampaignID, KeywordText.lower(), MatchType)}
- `adgroup_negatives`: {(CampaignID, AdGroupID, KeywordText.lower(), MatchType)}
- `existing_negatives_by_phrase`: root terms already phrase-negated + which campaigns

**Phase 0b — Manual ASIN Targets (Dedup Mask)**

Built from `STDP-02` pre-fetched results:
- `manual_targets = {strip_asin_wrapper(row.KeywordText)}`

**Phase 1 — Window ST Pull**

From `STDP-03` pre-fetched results:

Post-query:
1. Partition into Stream 1 (Keyword Targeting) and Stream 2 (Product Attribute Targeting)
2. Apply exclusion mask — remove already-negated rows, log count
3. Apply ASIN dedup mask (Stream 2 only) — remove manually targeted ASINs, log count
4. Apply spend floor — remove rows where `window_spend < spend_floor`, log count

**Phase 2a — Lifetime Performance — Aggregate (account-wide per ST)**

Used by: phrase negation mining (n-gram corpus), harvest extraction (account-wide conversion confirmation), exact negation (overall lifetime evidence base).

From `STDP-04` pre-fetched results.

**Phase 2b — Lifetime Performance — By Item Group**

Used by: exact negation (detect cross-context conversion conflicts), relevance checks (item group context), phrase negation (conflict check at item group level).

From `STDP-05` pre-fetched results. Apply the taxonomy mapping in the application layer post-query — do not attempt SQL string parsing of CampaignName directly.

**Why this matters:** A ST converting in BRACELET campaigns with zero orders in SPARTAN is a location-specific bleed. Aggregate shows total orders > 0 (Tier A — keep). Item group shows SPARTAN is bleeding. Without this layer, exact negation cannot safely recommend a location-specific negate for the SPARTAN ad group while preserving the BRACELET traffic.

**Phase 2c — Lifetime Performance — Full Specific Location**

Used by: exact negation (place the negative at the right ad group), harvest extraction (where is the term converting — which ad group to credit).

From `STDP-06` pre-fetched results. Each row = one ST at one Campaign + AdGroup + Keyword + MatchType.

**Phase 2d — Lifetime Performance — ASIN Stream (aggregate)**

Used by: exact negation, harvest extraction. Same as Phase 2a — aggregate only for ASIN stream. Item group and location context for ASIN stream is derived from Phase 1 Stream 2 location data.

From `STDP-07` pre-fetched results.

---

## Output Artifact Structure

Write JSON with these keys:
```
{
  "execution_date": "YYYY-MM-DD",
  "seller_id": "[SELLER_ID]",
  "window_start": "YYYY-MM-DD",
  "window_end": "YYYY-MM-DD",
  "spend_floor": [NUMBER],
  "min_keep_orders": [NUMBER],
  
  "stream1_keyword": [rows from Phase 1 Stream 1 after masks],
  "stream2_asin": [rows from Phase 1 Stream 2 after masks],
  
  "lifetime_keyword_aggregate": [rows from Phase 2a],
  "lifetime_keyword_by_item_group": [rows from Phase 2b with item_group field added],
  "lifetime_keyword_by_location": [rows from Phase 2c],
  "lifetime_asin_aggregate": [rows from Phase 2d],
  
  "exclusion_mask": {
    "campaign_negatives_count": [N],
    "adgroup_negatives_count": [N],
    "existing_negatives_by_phrase": [dict]
  },
  
  "dedup_mask": {
    "manual_targets_count": [N],
    "manual_targets": [list of ASIN strings]
  },
  
  "apply_masks_summary": {
    "stream1_raw_rows": [N],
    "stream1_after_exclusion": [N],
    "stream1_after_spend_floor": [N],
    "stream2_raw_rows": [N],
    "stream2_after_exclusion": [N],
    "stream2_after_dedup": [N],
    "stream2_after_spend_floor": [N]
  }
}
```

---

## Key Rules

- **No filtering of Phase 2 lifetime results**: Lifetime queries pull all historical data regardless of spend floor or exclusion masks. Downstream skills apply their own filtering logic.
- **Aggregation is deterministic**: Same input, same execution date → same JSON output.
- **Item group mapping post-query**: Do not parse CampaignName in SQL. Apply brand context taxonomy in application layer.
- **Paused campaigns**: Include in lifetime corpus (they represent real conversion signal). Apply paused-campaign logic in downstream skills, not here.
- **Multiple rows per day per keyword**: Expected in granular data. Downstream skills aggregate as needed.

---

## Run Time Expectation

Total execution time (all 5 queries + masking logic): 2-5 minutes depending on account size and window length.

---

## Step: Emit Run Sidecar (canonical, drift-detection input)

After delivery (JSON artifact written to `/tmp/[brand]-st-data-pull.json` or runs archive), write a structured JSON sidecar capturing this run's inputs and headline output counts. This is the input to `scripts/compare-sidecars.py`, which surfaces cross-run drift (config edits to attribution window, dropped queries, sudden row-count drop signaling a query failure or a data-pipeline regression, verdict regression). Sidecars live at `<plugin>/runs/<brand-slug>/search-term-data-pull/<data-date>-<run-id>.json`.

Schema source of truth: `<plugin>/shared/run-sidecar.schema.yaml`.

```bash
python3 <plugin>/scripts/write-sidecar.py \
  --skill search-term-data-pull \
  --skill-version 1.1 \
  --brand-slug [brand-slug] \
  --data-date YYYY-MM-DD \
  --metrics-json /tmp/stdp-headline.json \
  --context-snapshot-json /tmp/stdp-context-snapshot.json \
  --sql-calls-json /tmp/stdp-sql-calls.json \
  --verdict GREEN|YELLOW|RED|OBSERVATIONAL \
  --report-html /tmp/[brand]-reports/st-data-pull-summary.html
```

Use the **window end date** for `--data-date`, not the run wall-clock date.

**Required JSON inputs:**

- **`metrics-json`** — emit numeric values only (no `$`, no `%`). `dedup_ratio` is the share of stream2 rows suppressed by the manual-targets dedup mask:
  ```json
  {"terms_pulled_window": 4820, "terms_pulled_lifetime": 18240,
   "existing_negatives_count": 312, "manual_asin_targets_count": 84,
   "dedup_ratio": 0.041}
  ```

- **`context-snapshot-json`** — record only the `context.yaml` fields you actually consumed in this run:
  ```json
  {"account_type": "VC", "seller_id": "113",
   "primary_metric": "ACOS", "acos_target_pct": 20,
   "attribution_window_days": 14,
   "campaign_naming_pattern_present": true,
   "sub_brands_count": 4}
  ```

- **`sql-calls-json`** — list every library query invoked, with the exact params used (params get hashed for cross-run identity). The full STDP-01..07 inventory is the canonical batch for this skill:
  ```json
  [{"id": "STDP-01", "params": {"seller_id": "113", "window_start": "2026-03-26", "window_end": "2026-04-25"}},
   {"id": "STDP-02", "params": {"seller_id": "113"}},
   {"id": "STDP-03", "params": {"seller_id": "113"}},
   {"id": "STDP-04", "params": {"seller_id": "113"}},
   {"id": "STDP-05", "params": {"seller_id": "113"}},
   {"id": "STDP-06", "params": {"seller_id": "113"}},
   {"id": "STDP-07", "params": {"seller_id": "113"}}]
  ```

**Verdict rule:** `GREEN` = successful pull, all 7 queries returned, row counts in expected band for this account. `YELLOW` = row counts <10% of typical for this account (data lag suspected; downstream skills should hold). `RED` = a query failed or returned empty when prior runs were non-empty (pipeline regression — escalate before downstream skills run on a partial dataset). `OBSERVATIONAL` = first pull for the account; no historical band yet.

After writing, run the comparator to surface drift against the prior run:

```bash
# Post-delivery: drift check against prior sidecar
python3 scripts/compare-sidecars.py \
    --brand-slug [brand-slug] \
    --skill search-term-data-pull
# Exits 0 if clean, 1 if drift detected (config change, metric jump, verdict regression).
# Review drift output before closing the run. Drift is not blocking by default.
```

Exit 0 = no drift. Exit 1 = drift detected (config edit, query dropped, row-count jump, verdict regression). Surface drift findings before downstream skills consume the artifact, not silently.

---

*Skill version: 1.1 — pure data extraction layer*
*Ported from upstream with full domain logic preserved*
