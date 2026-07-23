---
name: mx-search-term-data-pull
description: "Pure data extraction layer for search term analysis. Pulls window ST report, lifetime performance at three granularity levels, existing negatives, and manual ASIN targets. Outputs structured JSON artifact for downstream skills. No judgment, no LLM analysis — data only."
---

# ST Data Pull

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), resolve the bundled CLI by scanning for it once and reuse the path: `MIXSHIFT_CLI="$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)"`, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


Pure data extraction. No recommendations, no LLM, no judgment calls. Output is a structured JSON artifact that feeds downstream negation and harvest skills.

---

**Use only data returned by the pre-fetched queries and context.yaml. Do not supplement with general Amazon or e-commerce knowledge, industry benchmarks, or assumed platform dynamics not present in the data.**

**Begin output immediately. Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.**

## Data Integrity — Non-Negotiable

- The source table is `keywordtargetingmetric` (the live base metric table); `DateTime` is its per-day date field, used for the analysis window
- `recordType` split is mandatory: 'Keyword Targeting' vs 'Product Attribute Targeting'
- Exclusion mask must be applied before any downstream skill sees the data
- Never pass a row to a downstream skill that is already negated

---

## Execution Flow

**Step 0 — Load Tier-3 brand context:**

Read the context snapshot, prior run, and narrative:
- **`~/.mixshift/clients/<brand-slug>/context.yaml (validated via `mixshift brand validate <brand-slug>`)`** — compact context snapshot pre-extracted by the pre-fetch script. Required fields: `seller_id`, `account_type`, `acos_target_pct`, `attribution_window_days`, `sub_brands`, `campaign_structure.naming_pattern`, `negation.protected_terms`, `attribution_rule`, `paused_campaigns`. If absent, fall back to reading `~/.mixshift/clients/<brand-slug>/context.yaml` directly.
- **`~/.mixshift/clients/<brand-slug>/runs/mx-search-term-data-pull/ (most recent <date>-<run-id>.json)`** — prior run sidecar (~65 lines). If present, use for drift context. If absent, skip.
- `~/.mixshift/clients/<brand-slug>/narrative.md` — prose context only. Do not extract numbers from this file. Spend floors and order thresholds come from context.yaml (or downstream-skill defaults), never from prose.

**Brand context is optional — never fail closed on it.** Run on whatever context is present (the snapshot / `context.yaml`, Tier-2 Brand Brain as fallback); this pure-data layer sharpens as context accrues but never requires full brand setup. The only hard requirement is `accounts[].seller_id` + `account_type` (from `mixshift brand add`). When a field this skill uses (item-group taxonomy via `campaign_structure.naming_pattern`, `negation.protected_terms` for masking) is missing, fall back to the documented default and label it rather than stopping. Load the brand-context fields in one call via `mixshift brand context resolve <brand-slug> --json` — each carries `{value, source, fetched_at}` (`source: context` = ✓ confirmed, `brain` = ⊙ pre-filled; `null` = use the default).

### Step 1: Load Pre-Fetched Data

**Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.

Read the data artifact — **prefer the `.md` file** (pre-formatted markdown tables, no parsing overhead):
```
~/.mixshift/clients/<brand-slug>/runs/mx-search-term-data-pull/<run_date>/data.md
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

**If the artifact is missing:** Run prefetch now — do not stop and ask the user:
```bash
mixshift prefetch --brand <brand-slug> --skill mx-search-term-data-pull --date <YYYY-MM-DD>
```
Use brand-slug derived from the brand context path and today's date as run_date. Wait for completion, then read the artifact and continue.

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

After delivery, write a structured JSON sidecar capturing this run's inputs and headline output counts. Sidecars live at `~/.mixshift/clients/<brand-slug>/runs/mx-search-term-data-pull/<data-date>-<run-id>.json`. Schema source of truth: `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`.

Use the **window end date** for `data_date`, not the run wall-clock date.

Compose the input JSON (write to a temp file, then invoke the harness):

```jsonc
// /tmp/stdp-sidecar-input.json
{
  "skill": "mx-search-term-data-pull",
  "skill_version": "1.2.0",
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
    "campaign_naming_pattern_present": true,
    "sub_brands_count": 0
  },
  "headline_metrics": {
    "terms_pulled_window": 0,
    "terms_pulled_lifetime": 0,
    "existing_negatives_count": 0,
    "manual_asin_targets_count": 0,
    "dedup_ratio": 0
  },
  "sql_calls": [
    {"id": "STDP-01", "params": {"seller_id": 0, "window_start": "YYYY-MM-DD", "window_end": "YYYY-MM-DD"}},
    {"id": "STDP-02", "params": {"seller_id": 0}},
    {"id": "STDP-03", "params": {"seller_id": 0}},
    {"id": "STDP-04", "params": {"seller_id": 0}},
    {"id": "STDP-05", "params": {"seller_id": 0}},
    {"id": "STDP-06", "params": {"seller_id": 0}},
    {"id": "STDP-07", "params": {"seller_id": 0}}
  ],
  "artifacts": {
    "report_html_path": "<path-to-data.md-or-rendered-summary>"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/stdp-sidecar-input.json
```

**Verdict rule:** `GREEN` = successful pull, all 7 queries returned, row counts in expected band for this account. `YELLOW` = row counts <10% of typical for this account (data lag suspected; downstream skills should hold). `RED` = a query failed or returned empty when prior runs were non-empty (pipeline regression — escalate before downstream skills run on a partial dataset). `OBSERVATIONAL` = first pull for the account; no historical band yet.

`mixshift sidecar compare` will surface drift against the prior run once implemented; until then, sidecars accumulate read-only for retrospective inspection.

---

*Skill version: 1.2.0 — pure data extraction layer*
*Ported from upstream with full domain logic preserved*

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-search-term-data-pull
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-search-term-data-pull --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-search-term-data-pull --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
