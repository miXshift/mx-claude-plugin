---
name: account-cold-start
description: "Build a Tier 3 brand context directory for a new Amazon PPC account from scratch. Collect account metadata, run structured database queries, synthesize into a typed context.yaml + narrative.md + corpora/, and render a human-reviewable Brand Context page. Run before any other skill execution on a new account."
---

# Account Cold Start — Tier 3 Context Builder

**Use only data returned by the pre-fetched queries, `context.yaml`, `narrative.md`, and source-backed `brand-intelligence.yaml`. Do not supplement with general Amazon or e-commerce knowledge, industry benchmarks, or assumed platform dynamics not present in those inputs.**

**Begin output immediately. Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.**

**Purpose:** Build a Tier 3 brand context directory for a new account from scratch.
Run before any skill execution on a new account.
Produces a directory at `<plugin>/shared/clients/<brand-slug>/` plus a human-reviewable
`brand-context.html` ("Brand Context page") rendered to `tmp/`.

**Output structure (locked):**
```
shared/clients/<brand-slug>/
  context.yaml      # Tier-3 mechanical truth: SellerIDs, sources, ACOS targets,
                    # capture-rate calibration, sub-brands, brand terms,
                    # structural events, posture, campaign_structure,
                    # negation rules, reporting voice. Schema-validated.
  narrative.md      # Tier-3 prose: positioning, management history,
                    # interpretation rules, strategic hypotheses.
                    # Canonical H2 headings the renderer looks for:
                    #   ## Brand Identity
                    #   ## Current Quarter Context
                    #   ## Historical Notes
  brand-intelligence.yaml
                    # Required unless web access is unavailable or AM explicitly skips:
                    # source-backed web/social/market research:
                    # hero narrative, proof points, source map, PPC implications,
                    # and open research gaps. Human-facing "wow" layer; downstream
                    # skills may read this file directly instead of ingesting HTML.
  corpora/
    conq_asins.csv  # Layer 1 manual-targeting ASINs by item-group.
    *.csv           # Other extracted lists (history tables, etc.).
  README.md         # File conventions for this brand.

tmp/
  <brand>-account-cold-start-<date>.html           # Brand Context page (human review)
  <brand>-account-cold-start-<date>.headline.json  # ~500-token summary for the model
  <brand>-account-cold-start-<date>.review.json    # compact review map: buckets, runtime inputs, skill readiness
runs/<brand>/account-cold-start/<date>-<run-id>.json   # sidecar (auto-emitted by renderer)
```

**Schema source of truth:** `shared/clients/_schema/context.schema.yaml`.
Reference example (read this before starting): `shared/clients/example-brand/context.yaml`.

**Execution root:** Run all shell commands from the plugin root (`plugins/mixshift-amazon-ppc/`). Command examples below assume that working directory and use `python scripts/...`.

**Fresh sequence:** Phase 0 (Light Training) → Phase 0.25 (Bootstrap Context Shell) → Phase 0.5 (Web/Social Scrub) → Phase 1 (Pre-Fetched Data) → Phase 1a (Draft Context for Enrichment) → Phase 1.5 (Enrich, v2.3+) → Phase 2 (AM Intake) → Phase 3a (Finalize YAML+narrative+corpora) → Phase 3b (Render brand-context.html) → Phase 4 (Validate) → Phase 5 (Final Bottom Line)

**Delta sequence:** Phase 1 (delta pre-fetch only) → Phase 1.5 (Enrich) → merge-context-delta.py → Phase 3b (Render brand-context.html) → Phase 4 (Validate) → Phase 5 (Final Bottom Line)

**Modes:**
- `--mode fresh` (default): full cold-start build. Creates a minimal bootstrap context shell, runs all CS-* queries through pre-fetch, emits typed YAML + narrative.md + corpora/, enriches, renders, validates, then reports the Bottom Line.
- `--mode delta` (cold-start v2.3+): re-run on an existing account to refresh enrichment fields without overwriting AM-edited context. Runs only enrichment-tagged queries (CS-28/29/30/31), patches `capture_rate_calibration.daily_settlement_curve` into context.yaml, refreshes `tmp/<brand>-...enrichment.json`, re-renders. AM-curated fields (negation, structural_events, brand_terms, posture, etc.) are never touched.

---

## Hard Rules / Forbidden Reads

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** It contains cross-brand architecture documents and legacy prose-style brand .md files that are not skill inputs. Brand context comes from `context.yaml`, `narrative.md`, optional source-backed `brand-intelligence.yaml`, and renderer-produced compact sidecars.
- **DO read `kickoff.md` at the start of Phase 0.** It's the AM-facing intake script — the human-readable companion to this procedure manual. Walking the AM through it is the first concrete step of any cold-start run.
- **Do NOT read the SQL library files or run ad hoc SQL.** The only approved data path is the deterministic pre-fetch harness (`python scripts/pre-fetch-data.py ...`), which writes Phase 1 query results before the model consumes them.
- **Do NOT write or edit `brand-context.html`, `brand-context.headline.json`, `brand-context.review.json`, or the run sidecar manually.** The renderer (Phase 3b) is the single writer of these artifacts.
- **Do NOT echo HTML, full audit tables, or full data tables in your output.** The HTML is the deliverable; your model output is a Bottom Line + `file://` link to the HTML.
- **Do NOT supplement with general Amazon or e-commerce knowledge** not present in the pre-fetched data or cited `brand-intelligence.yaml` sources.
- **Do NOT mix SC and VC ops paths.** SC accounts use `business_reports_dpst_date` (CS-02); VC accounts use `vendor_sales_manufacturing_asin` (CS-03). Never mix.
- **Do NOT publish live skill output until brand context is reviewed.** Shell-first deployment: shells deployed → AM reviews `brand-context.html` → corrections applied to `context.yaml` → re-run renderer → only then run downstream skills.

---

## Phase 0 — Light Training (required before Phase 1)

Read `kickoff.md` and walk the AM through Steps 1–2 before any DB queries. The full intake script — opening lines, "tell me about" prompts, and buyer-intent boundary questions — lives there.

**Why this order matters:** Without Phase 0 context, Phase 1 data gets misread. A confirmed organic unit decline may be a deliberate SKU de-listing; a large revenue miss may be an intentional brand transition; a high-spend month may be a media event, not a seasonal peak. Phase 0 is the interpretive filter that makes Phase 1 meaningful.

**Capture targets:** structural events, anomaly windows, account roles/wind-down notes → `context.yaml`. Management-history paragraph (if one exists) → `narrative.md ## Historical Notes`.

---

## Phase 0.25 — Bootstrap Context Shell (fresh mode only)

Before running pre-fetch on a never-before-seen account, create a minimal shell with the deterministic helper:
```bash
python scripts/bootstrap-context.py \
  --brand <brand-slug> \
  --brand-name "<Brand Name>" \
  --seller-id <seller-id> \
  --seller-name "<Seller Name>" \
  --account-type <SC|VC> \
  --date <YYYY-MM-DD>
```

For multi-SellerID accounts, use repeated `--account` entries:
```bash
python scripts/bootstrap-context.py \
  --brand <brand-slug> \
  --brand-name "<Brand Name>" \
  --date <YYYY-MM-DD> \
  --account "<seller-id>|<seller-name>|<SC|VC>|active|primary" \
  --account "<seller-id>|<seller-name>|<SC|VC>|wind_down|legacy"
```

The helper writes:
```
shared/clients/<brand-slug>/context.yaml
```

The shell exists only so `pre-fetch-data.py` can bind SellerID(s), run date, and account type. It is allowed to be schema-incomplete at this point, and it must be completed before validation or downstream skills consume it.

Minimum shell fields:
- `schema_version`
- `brand_slug`
- `brand_name`
- `last_updated`
- `accounts[]` with `seller_id`, `seller_name`, `account_type`, `status`, and `role`

If SellerID or account type is unknown, pause before pre-fetch and ask the AM. Do not invent those fields.

Do not validate or publish the shell. It is a temporary scaffold that Phase 3a replaces with complete Tier-3 context. If the helper reports that `context.yaml` already exists, do not overwrite it; continue with the existing context.

---

## Phase 0.5 — Web & Social Scrub

Run after Phase 0, before Phase 1. The AM doesn't need to be present. Search sequence and target signals are documented in `kickoff.md` Step 3.

**Required AM-supplied or discovered inputs:** official website, Amazon storefront if one exists, official social/community surfaces, app/review-marketplace surfaces when relevant, known competitor/reference brand set, and any press/history surfaces that explain the brand's public story. If the AM does not provide competitors, derive them from source-backed public research and current ad-data targeting evidence where available; do not make the AM provide a list unless the data is ambiguous. If unavailable, document the gap in `brand-intelligence.yaml::open_research_gaps`.

**Outputs:** official positioning, Amazon storefront surface, Reddit/forum presence, YouTube positioning, social presence, customer language samples, competitive set, negative press flags, brand awareness stage, source-backed milestone facts, and brand-manager-facing proof points. Write the durable research map to `brand-intelligence.yaml`; feed concise prose into `narrative.md ## Brand Identity` and typed terms/guardrails into `context.yaml::brand_terms` / `negation`. Named competitor/reference brands belong in `context.yaml::negation.competitor_brands` so the renderer can show a Competitive / Reference Brand Dictionary and enrichment can suppress competitor collisions from brand-misspelling review. Keep competitor names separate from protected brand terms: competitors are comparison surfaces, not automatic negatives. If a surface returns zero signal (e.g., no Reddit presence), document it as a baseline finding rather than silently omitting.

**Customer-language auto-population contract (v2.4.10):** Do not leave Brand Voice / Buyer Language partial if the brand has enough evidence in public surfaces or CS-31 converting search terms. Build a compact buyer-language corpus from three layers: (1) official product/support wording for intended product jobs, (2) review/forum/editorial language for customer pain and failure modes, and (3) top converting CS-31 search terms for the nouns customers actually type. Write durable prose to `narrative.md` using `## Brand Positioning` or `## Brand Identity` plus `## Customer Language Samples`; write structured examples to `brand-intelligence.yaml::customer_language_corpus`. Use short phrases and intent clusters, not full review dumps. If Amazon reviews or forums are blocked, say so in `open_research_gaps[]` only after using available search-term and official/support language.

**Mindblowing first-paragraph rule:** `brand-intelligence.yaml::hero_narrative` must explain what the brand is, why the public story matters for PPC, and which internal management facts MixShift remembers. It should connect company/product history, category position, competitors, social/press/customer signals, and durable ad-account interpretation. Do not make claims without source-backed evidence or internal context evidence.

**Brand intelligence quality rules:** Proof points must distinguish `strong` / `partial` / `identified_no_counts` / `needs_capture` evidence. Do not turn a dynamic or uncaptured surface (Amazon storefront, social counts, review volume) into a claim; preserve it as a known surface with `needs_capture` until the content is captured. Human-facing review pages should use neutral labels such as "Missing input", "Open context note", and "Review action" instead of raw "Tell AI" prompts.

**TACOS-primary target rule:** If `management.primary_metric: TACOS`, the human page must lead with the true TACOS goal (`management.tacos_target_pct` or `management.tacos_goal_pct`). `management.acos_target_pct` is only an ACOS-or-better proxy for bid math and must never be labeled as the TACOS target.

**TACOS-primary sales-target rule:** If a brand is managed to TACOS and explicitly has no static monthly/quarterly sales target, do not mark legacy `goals.monthly_total_sales_target` or `goals.quarterly_total_sales_target` manifest fields as missing context. Sales are observed or forecast-supplied at run time; the durable operating target is TACOS.

**Readiness status rule:** Skill Readiness is a Brand Context readiness check, not a same-day artifact availability check. Do not downgrade a skill to `Ready with Caveats` just because it has `upstream_skills` or skill-owned data pulls; those are generated/refreshed during execution. Only real missing context, manifest/context contract drift, or manual runtime uploads should change readiness status.

---

## Phase 1 — Load Pre-Fetched Data

All query results are staged by the deterministic pre-fetch harness before the model consumes them. Read the artifact — **prefer the `.md` file** (pre-formatted markdown tables, no parsing overhead):
```
tmp/<brand-slug>-account-cold-start-<run_date>.data.md
```
Fallback to `.data.json` only if the `.md` file is absent.

Efficiency rule: in fresh mode, read only the model-facing CS-01 through CS-27 sections needed for synthesis. CS-28/29/30/31 raw rows stay in `.data.json` and appear as row-count stubs in `.data.md`. Do not paste or inspect those raw rows manually. Exception: Phase 3a must run a bounded aggregation over CS-31 to extract top converting customer-language phrases by brand lane / product job; consume only the compact aggregate, not the full row set. In delta mode, verify the pre-fetch artifact exists and continue directly to Phase 1.5; do not read `.data.md` unless pre-fetch failed and you need the error.

This file contains pre-executed results keyed by query ID:
- `CS-01` — Identity check: confirms SellerID exists and account type (SC/VC)
- `CS-02` — SC account-level monthly revenue baseline
- `CS-03` — VC account-level monthly revenue baseline
- `CS-04` through `CS-15` — Independent account structure queries: ACOS baseline, attribution calibration, sub-brand/item group structure, brand term dictionary, negatives inventory, budget utilization, keyword spend concentration, objective config, label completeness gaps
- `CS-16` — Inventory history stub (confirmed empty-column 2026-04-27)
- `CS-17` through `CS-27` — Additional VC/SC-specific structure and calibration queries
- `CS-28` (v2.3) — Daily attribution settlement curve by campaign type × DOW (90d window). Reshaped into `capture_rate_calibration.daily_settlement_curve` by `enrich-context.py`. Multi-seller via `:seller_id_list`.
- `CS-29` (v2.3) — `mws_inventory_health` historical snapshots, FBA-only, pre-filtered to "in-trouble" rows. Used by `enrich-context.py` to detect contiguous OOS windows ≥3 days. VC accounts: data is FBA-only. Multi-seller via `:seller_id_list`.
- `CS-30` (v2.3) — Daily account-level ad metrics (spend / sales / ACOS / CVR / CTR) over trailing 365 days. Used by `enrich-context.py` for stockout-window revenue impact. Multi-seller via `:seller_id_list`.
- `CS-31` (v2.3) — Trailing-90-day converting search-term corpus. Used by `enrich-context.py` for brand-name typo detection (Levenshtein 1-2 vs `brand_terms`, with plural and competitor-brand filters) and by Phase 3a for a compact customer-language corpus. Multi-seller via `:seller_id_list`.

**If the artifact is missing:** confirm the bootstrap context shell exists, creating it with `bootstrap-context.py` if needed, then run the pre-fetch script — do not stop and ask the user unless SellerID or account type is unknown:
```bash
# Fresh cold-start (full query battery):
python scripts/pre-fetch-data.py \
  --skill account-cold-start --brand <brand-slug> --date <YYYY-MM-DD>

# Delta-mode re-run (cold-start v2.3+; runs only CS-28/29/30/31):
python scripts/pre-fetch-data.py \
  --skill account-cold-start --brand <brand-slug> --date <YYYY-MM-DD> --mode delta
```
Wait for "Ready. Run the skill now.", then read the artifact and continue.

**HARD GATE:** If CS-01 is absent or returns no row for the SellerID, **STOP IMMEDIATELY.** Do not proceed with a partial dataset. Report the failed query and the error.

**Key execution rules:**
- CS-01 must be confirmed before consuming any other query results
- SC accounts use CS-02 for ops data; VC accounts use CS-03. Never mix paths.
- Multi-SellerID accounts: pre-fetch runs queries with `IN (id1, id2, ...)` throughout
- Apply all exclusion masks (existing negatives, manual ASIN targets) before processing
- Spend floor filter: remove rows where `window_spend < spend_floor`

**Phase 1 outputs to capture for Tier 3:**
- Account and seller identification confirmed
- 24-month revenue baseline by month when available (seasonal shape, trend, YoY context, anomaly separation)
- 24-month ACOS baseline by month and by campaign type when available
- Attribution window calibration (improvement points expected as window closes)
- Sub-brand and item group structure
- Brand term dictionary (catalog-derived ASINs and keyword variants)
- Enabled negatives inventory
- Budget utilization classification, keyword spend concentration
- Objective config (campaign-level intent classification)
- Label completeness gaps

**Phase 1 enrichment inputs (v2.3+):** raw rows for CS-28/29/30/31 — consumed by Phase 1.5, not directly synthesized into prose here.

**Phase 1 customer-language input (v2.4.10+):** CS-31 also supports Phase 3a buyer-language synthesis. Aggregate top converting search terms by lane/product job (brand core, sub-brand/product family, cleaning/support language, fit/function language, competitor/reference language). Use this only to populate concise language samples and relevance guardrails; do not turn the raw table into prose.

---

## Phase 1a — Draft Context for Enrichment (fresh mode only)

Before running `enrich-context.py` in fresh mode, update the bootstrap shell into a draft context with the Phase 1 fields that enrichment needs:
- `accounts[]`
- `brand_terms`
- `negation.competitor_brands` if known from Phase 0.5 or Phase 1
- `capture_rate_calibration` placeholder if attribution-window calibration is applicable

This draft is still not final. Its purpose is to let enrichment detect stockout candidates and brand-name typo clusters using the current brand term dictionary. Phase 2 then confirms which advisory findings should be promoted into durable typed fields.

---

## Phase 1.5 — Enrichment (v2.3+)

After pre-fetch completes and context exists, run `enrich-context.py` to compute three advisory analyses. In fresh mode, run this after Phase 1a. In delta mode, run this against the existing reviewed context.

```bash
python scripts/enrich-context.py \
  --brand <brand-slug> --date <YYYY-MM-DD>
```

It reads `tmp/<brand>-account-cold-start-<date>.data.json` plus the existing `context.yaml` and writes `tmp/<brand>-account-cold-start-<date>.enrichment.json` containing:

1. **Daily attribution settlement curve** (from CS-28) — per-campaign-type ACOS at 1d/7d/14d, day-of-week offsets, stability score. Reshaped to `capture_rate_calibration.daily_settlement_curve`. Cells with insufficient data (low-volume campaign types where 1-day or 7-day attribution doesn't accrue) are labeled "insufficient data" rather than `null`.
2. **Stockout candidates** (from CS-29 + CS-30) — contiguous windows ≥3 days where `SellableQuantity = 0` OR Alert active OR `DaysOfSupply < 14`. Each entry includes impacted ad-sales for the window. VC accounts: FBA-only. **Limitation:** ASIN suppression-for-profitability events (Amazon de-ranks an ASIN despite inventory) are not detectable from `mws_inventory_health` — those still require AM input as `structural_events[]`.
3. **Brand-name typo clusters** (v2.3.1+, from CS-31 + `brand_terms` + `negation.competitor_brands`) — converting search terms within Levenshtein 1-2 of any canonical brand term, not already in variants. **Clustered** by `(canonical_match, root_token)` so the AM gets one decision per cluster instead of N flat rows. Plural-only matches (e.g. "&lt;brand&gt;s" vs canonical "&lt;brand&gt;") and competitor-brand collisions (e.g. "&lt;competitor-brand&gt;" when canonical is "&lt;your-brand&gt;") are filtered out before clustering — competitor-brand prefixes are read from the optional `negation.competitor_brands` list in `context.yaml`.

**Removed in v2.3.1:** Change-point detection. The retroactive listing produced too much noise — most "unexplained" breaks were Q4 ramps and post-holiday drops the AM didn't remember. Forward-looking change-point capture (writing breaks to `structural_events[]` as they emerge from daily runs) is a candidate for a separate skill.

**Delta mode:** after `enrich-context.py`, run `merge-context-delta.py` to patch the settlement curve into `context.yaml` (preserves comments and AM-edited fields):
```bash
python scripts/merge-context-delta.py \
  --brand <brand-slug> --date <YYYY-MM-DD>
```
Detected anomalies stay in `tmp/<brand>-...enrichment.json` and are surfaced by the renderer in the "Detected Anomalies (Advisory)" section. They are **not** auto-promoted to typed `structural_events[]` or `brand_terms.variants` — AM confirmation required first. (missing ItemGroup or Objective labels)

---

## Phase 2 — AM Intake (collect from account manager)

Walk the AM through `kickoff.md` Step 4. The full question list and rationale live there.

**Hard gate:** Phase 2 is not optional in fresh mode. After Phase 1/1.5 and the web/social scrub, synthesize the smallest sufficient numbered question set from unresolved AM decisions, data anomalies that need business context, and renderer/review gaps. Ask those questions immediately and wait for answers before finalizing Phase 3a, running a final Phase 3b render, or emitting a final Phase 5 Bottom Line.

**Draft exception:** If the operator explicitly asks for a preview before answering Phase 2, you may render a draft Brand Context page. Label it as draft/observational in your response, include the file link, then continue directly into the numbered Phase 2 questions. Do not stop as if the cold start is complete.

**Question construction rules:**
- Ask numbered questions, not passive "Tell AI" prompts.
- Include the data-derived hypothesis when useful, then ask the operator to confirm, correct, or mark unknown/not applicable.
- Prioritize required operating decisions first, then high-impact anomalies, then optional context that would improve downstream skill quality.
- Keep runtime-only uploads separate. Forecast, HCAM/H-Bridge, vertical bridges, and monthly-report screenshots should be recorded as runtime inputs required, not treated as missing Brand Context unless the operator says they do not exist.
- If a question can be answered by the automated data review, answer it yourself and cite the finding in context rather than asking the operator.
- Before asking about stockouts, check CS-16/CS-29 inventory signals plus sales, sessions/glance views when available, and daily revenue/unit patterns. If the data shows an inventory trough but no confirmed per-ASIN OOS window, record an advisory `inventory_trough`/structural note instead of asking the operator to confirm a stockout.
- Before asking whether a promo or deal caused a spike, check revenue, units, ASP/price proxy, spend, and conversion/session patterns. If ASP held while units spiked, treat it as deal placement or demand surge rather than a discount unless price history proves markdown.

**Critical execution rules** (model behavior, not AM-facing prose):
- If TACOS is primary metric, derive ACOS thresholds from posture and the historical SC vs. ad-attributed ratio.
- Combine catalog-derived brand terms (Phase 1) with AM-supplied variants (Phase 2) into a single `context.yaml::brand_terms` map. Don't keep two lists.
- If the AM doesn't supply a quarterly revenue target and `goals.report_quarterly_pacing` is false, set `goals.quarterly_revenue_target: null` and do not treat it as missing. If quarterly pacing is true, add a missing-context bucket item.
- If forecast/HCAM/H-Bridge/dimension bridge artifacts exist outside the DB, record them as runtime inputs required, not static context gaps.
- Capture promotions and launches as `structural_events[]` entries with appropriate types — not as free prose.

---

## Phase 3a — Finalize context.yaml + narrative.md + corpora/

Create or update the directory `shared/clients/<brand-slug>/` and finalize three artifact classes. **Mechanical truth goes in `context.yaml`; prose goes in `narrative.md`; lists go in `corpora/*.csv`. Never put SellerIDs, ACOS targets, or thresholds into prose** — they belong in YAML.

### context.yaml (mechanical Tier-3, schema-validated)

Populate every required and applicable optional section per `_schema/context.schema.yaml`. Mapping from Phase 0/1/2 collection to YAML sections:

| YAML section | Source phase | Notes |
|---|---|---|
| `accounts[]` | Phase 0 | One entry per SellerID. `account_type ∈ {SC, VC}`. `status ∈ {active, wind_down, inactive}`. |
| `sources` | Phase 0 + Phase 1 verification | `ad_metrics` is always `campaignmetric`. `ops_revenue` is `vendor_sales_manufacturing_asin` (VC) or `business_reports_dpst_date` (SC). |
| `management` | Phase 2 | `primary_metric ∈ {ACOS, TACOS}`. `acos_target_pct` numeric. `attribution_window_days` integer. |
| `capture_rate_calibration` | Phase 1 calibration query (VC SP) | Required if `attribution_window_days > 1`. Include `per_subbrand` map and `settlement_application_rule` text. |
| `sub_brands[]` | Phase 1 + Phase 2 | One entry per CustomBrand. List `item_groups`. |
| `brand_terms` | Phase 1 catalog + Phase 2 variants | Per sub-brand: `canonical[]` and `variants[]`. |
| `bid_health` | Phase 2 | `scale_threshold_pct`, `pullback_threshold_pct`, `re_entry_rule`. |
| `posture` | Phase 2 | `stance ∈ {scale, efficiency, defend, clear_bleed}`. `multiplier ∈ [0.0, 1.0]`. |
| `goals` | Phase 2 | Use explicit `null` for absent targets — never omit the key. |
| `structural_events[]` | Phase 0 | Type from enum. Always include `interpretation`. |
| `objective_calibration` | Phase 1 | Per-objective expected ACOS — used by health-check skills, not flag thresholds. |
| `campaign_structure` | Phase 1 | `naming_pattern` with `{Token}` placeholders. `objectives` token map. |
| `paused_campaigns[]` | Phase 1 | List campaign names from DB where `state='paused'`. |
| `negation` | Phase 0.5 + Phase 2 | `protected_terms[]`, `lane_rules{}`, `asin_negation.pre_check_lifetime_orders_threshold`. |
| `reporting` | Phase 2 | `audience ∈ {executive, account_manager, analyst}`. `voice_lint[]` regexes. |
| `delivery` | Phase 2 + Phase 3 setup | Local reports dir, archive path. |
| `open_gaps[]` | Whatever you couldn't populate | Explicit list — do not silently omit. |

Do not publish placeholder Phase 2 values as final context. If you use provisional, data-derived targets or event interpretations to frame questions, keep them clearly marked as unconfirmed in `open_gaps[]` until the operator confirms or corrects them.

### Brand Context page source contract

Every visible page section must map to a compact, targeted source so downstream skills do not ingest the full HTML. The renderer emits this map in `review.json::brand_context_source_map`.

| Brand Context page section | Primary source | Missing/runtime behavior |
|---|---|---|
| What I Know About This Brand | `brand-intelligence.yaml::hero_narrative` first, then `narrative.md ## Brand Identity` fallback | Missing hero becomes Brand Voice / Buyer Language gap. |
| Proof cards | `brand-intelligence.yaml::proof_points[]` + `sources{}` | Dynamic surfaces use `needs_capture`. |
| Runtime Inputs Required | `goals.forecast_tracking`, known Monthly Report bridge contract, and runtime-tagged `open_gaps[]` | Forecast/bridge artifacts are manual runtime uploads, not incomplete Brand Brain. |
| Skill Readiness | Downstream `skill.manifest.yaml` files + `context.yaml` | Contract drift becomes manifest cleanup warning when safe defaults exist. |
| Account Snapshot / targets | `context.yaml::accounts`, `management`, `posture` | TACOS-primary pages lead with TACOS goal; ACOS target is proxy only. |
| Sub-brand / item groups / brand terms | `context.yaml::sub_brands`, `brand_terms`, `negation.competitor_brands`, `corpora/` | Ambiguous taxonomy becomes Product & ASIN Coverage gap; competitor/reference brands render separately from protected terms and misspellings. |
| Active Conditions / structural events | `context.yaml::active_watch`, `structural_events`, `narrative.md ## Current Quarter Context` | Unconfirmed events stay advisory/missing-context, not facts. |
| Attribution Backfill Calibration | `context.yaml::capture_rate_calibration` and `attribution_rule` | SC pages must distinguish SP 7d from SB/SD 14d when populated. |
| Missing Context Buckets | `open_gaps[]`, schema audit, brand intelligence gaps | Raw prompts stay in `review.json`; main page shows buckets. |

### narrative.md (prose-only Tier-3)

For interpretation that doesn't fit a typed field. Use these canonical H2 headings — the renderer (Phase 3b) injects each into a specific spot in `brand-context.html`:

- `## Brand Identity` or `## Brand Positioning` — who this brand is, positioning, customer language. **Drives the Brand Identity section** of the audit page.
- `## Customer Language Samples` or `## Buyer Language` — concise customer/review/forum/search-term phrases by lane and product job. Required for a GREEN Brand Voice / Buyer Language bucket unless web/review/search evidence is genuinely unavailable.
- `## Current Quarter Context` — what's happening right now that AI should know. Drives the Active Conditions lead-in.
- `## Historical Notes` — management transitions, strategic pivots, brand migrations. Drives a footer-adjacent block.
- Other H2 headings render as a generic appendix.

**Forbidden in narrative.md:** SellerIDs, ACOS targets, thresholds, SQL, ASIN lists. Those belong in `context.yaml` or `corpora/`.

### corpora/*.csv

- `conq_asins.csv`: columns `asin, item_group, sub_brand, layer, sub_label`. Layer 1 = manually-targeted; Layer 2 = lifetime-converting auto.
- Other extracted lists (5-year history tables, monthly-actuals snapshots) go here, one CSV per logical list.

### brand-intelligence.yaml (source-backed wow layer)

Create this file for every fresh cold start unless web access is unavailable or the AM explicitly skips public research. Required shape:
- `sources{}` with official site, Amazon storefront if present, review/app/social/press/competitor sources as applicable.
- `hero_narrative` for the human-facing "What I Know About This Brand" lead paragraph.
- `proof_points[]` with `title`, `status`, `summary`, and `evidence[]`.
- `customer_language_corpus{}` with compact phrase clusters sourced from CS-31, official/support pages, review/editorial surfaces, forums, or a clear `needs_capture` explanation.
- `ppc_implications[]` explaining how each brand fact changes PPC interpretation.
- `open_research_gaps[]` for dynamic or uncaptured surfaces.

Do not put SellerIDs, targets, thresholds, or SQL in this file. It is public/source-backed brand intelligence plus clearly labeled internal-context implications.

**Competitive set contract:** source-backed competitor/reference brand names should be duplicated into `context.yaml::negation.competitor_brands` and summarized in `brand-intelligence.yaml::proof_points[]`. If current ASIN targets provide the stronger competitive evidence, cite that corpus in `brand-intelligence.yaml::sources{}` and write the ASIN rows to `corpora/conq_asins.csv`; do not mark the competitive set partial only because the competitor proof comes from internal ad-data rather than public web pages.

---

## Phase 3b — Render brand-context.html (deterministic)

Run the renderer. It reads `context.yaml` + `narrative.md` + `corpora/*.csv` + the schema and audit-labels map, and writes the Brand Context HTML, a compact `headline.json`, and the run sidecar — all in one call.

```bash
python scripts/render-brand-context.py \
  --brand <brand-slug> --date <YYYY-MM-DD>
```

**Outputs (renderer is the only writer):**
- `tmp/<brand>-account-cold-start-<date>.html` — human-reviewable Brand Context page
- `tmp/<brand>-account-cold-start-<date>.headline.json` — ~500-token model summary
- `tmp/<brand>-account-cold-start-<date>.review.json` — compact machine map of missing-context buckets, runtime inputs, and skill readiness
- `runs/<brand>/account-cold-start/<date>-<run-id>.json` — sidecar
- Optional copy to `context.delivery.reports_local_dir` (warning-only if path unavailable)

**Verdict logic** (computed by renderer):
- `RED` — any required schema field missing OR validator fails
- `YELLOW` — required fields populated, but `open_gaps` non-empty or `last_updated > 30d`
- `GREEN` — all required + recommended fields populated, no open gaps, fresh
- `OBSERVATIONAL` — Phase 1 only (Phase 2 deferred)

After running the renderer, do not report to the user yet. Continue to Phase 4 validation first. The final response happens in Phase 5 unless unresolved Phase 2 questions require an AM handoff.

---

## Phase 4 — Validate before declaring complete

Run the validator. Fail closed on errors:

```bash
python scripts/validate-context.py shared/clients/<brand-slug>
```

Then run the SQL drift gate to confirm any new SQL added during Phase 1:

```bash
python scripts/check-sql-drift.py
```

If either fails, fix and re-run Phase 3 (the renderer will pick up the corrected context.yaml). Do not hand off to downstream skills with a failing validator.

---

## Phase 5 — Final Bottom Line

After validation passes, read **only** `headline.json` and `review.json` (do not read the HTML).

If the run still has unresolved Phase 2 decisions, true context issues that require AM input, or a YELLOW/OBSERVATIONAL verdict caused by open gaps:
1. Emit a Draft Bottom Line: audit summary (`required_present`/`required_total`, `recommended_present`/`recommended_total`, stale count), true missing-context bucket count, runtime input count, and verdict.
2. Append a `file://` link to the draft HTML for operator review.
3. Ask the numbered Phase 2 questions immediately in the same response.
4. Stop only to wait for operator's answers. Do not present the cold start as complete.

If the verdict is GREEN, or the only remaining items are runtime-only uploads / explicitly accepted nice-to-have gaps:
1. Read **only** `headline.json` (do not read the HTML).
2. Emit a Bottom Line: audit summary (`required_present`/`required_total`, `recommended_present`/`recommended_total`, stale count), true missing-context bucket count, runtime input count, and verdict.
3. Append a `file://` link to the HTML for operator review.
4. Stop.

---

## Key Interpretation Rules (apply throughout)

- **Cross-reference everything against Phase 0.** An unusual pattern in Phase 1 data is either explained by Phase 0 context or is a genuine question for Phase 2. Never assume anomalies are random.
- **Airtime threshold for item groups:** <$5K/month → track in file, omit from reports. Surface only if materially changed.
- **ASIN-level TACOS is unreliable.** Account-level ACOS is the only clean management metric.
- **VC ops data path:** Always the runs archive data. Never use SC path for VC.
- **Management history matters.** If the account changed management or strategy mid-period, treat trend signals as unreliable until sufficient post-transition data accumulates.
- **Settlement application (VC accounts):** Use weighted formula for MTD ACOS — do not apply full improvement_pts uniformly. Formula in CS-06/CS-07 results.
- **VC monthly metric coverage:** Verify `sellermonthmetric` is populated. If empty, monthly reports must use raw campaign metric aggregates.

---

## Cold Start Patterns (apply during synthesis)

- SC column naming conventions and validation
- Item group extraction from campaign names (approximate — validate manually)
- Multiple rows per day per keyword in granular tables (always aggregate to daily totals)
- Stockout interpretation rules
- High SP other-SKU rates as structurally expected
- Coined brand terms in auto search term data
- TACOS-to-ACOS derivation from trailing 3-month ratios
- Ads % of Sales stability rules
- Campaign label vs product line code mismatches
- Phase 2 AMA as formal follow-up, not informal exploration

---

## Next Steps After Cold Start

1. the operator reviews `brand-context.html` (link from headline.json). Missing-context buckets show what still needs brand input; runtime-input cards show artifacts that are supplied manually when a downstream skill runs.
2. After approval, downstream skills can run: Daily Health Check → Runaway Spend Check → Keyword Bid Health.

---

*v2.4.12 - NZHC readiness cleanup: renderer treats runtime forecast/default delivery/voice-lint/future-market notes as non-blocking, accepts `brand-intelligence.yaml::source_map`, treats skill-owned/defaultable fields as ready for readiness checks, and Cold Start must data-check stockout/promo questions before asking the AM.*

*v2.4.11 - Phase 2 QA hard gate: fresh Cold Starts must ask numbered AM questions immediately when unresolved operating decisions or data anomalies remain, and may not stop after a YELLOW/OBSERVATIONAL draft render as if complete.*

*v2.4.10 - Buyer-language autopopulation contract: fresh Cold Starts must build a compact customer-language corpus from official/support/review/forum surfaces plus bounded CS-31 converting search-term aggregation, write it to `narrative.md` and `brand-intelligence.yaml::customer_language_corpus`, and avoid leaving Brand Voice partial when evidence is available.*

*v2.4.9 - Brand Identity fallback bugfix: stub narrative with no brand-intelligence hero now renders the intended missing-input stub instead of taking the source-backed fallback path.*

*v2.4.8 - Skill-readiness semantics cleanup: upstream skill/data-pull dependencies no longer downgrade Brand Context readiness; they are execution orchestration unless a manual runtime upload or real missing context exists.*

*v2.4.7 - TACOS-primary readiness cleanup: explicit no-sales-target accounts no longer show stale monthly/quarterly sales-target manifest warnings; empty paused_campaigns lists are treated as "none known"; stockout checks may close gaps with automated sales/session evidence when inventory snapshots are unavailable.*

*v2.4.6 - Competitive dictionary contract: Cold Start now carries source-backed competitor/reference brands in `negation.competitor_brands`, renders them separately from protected brand terms/misspellings, and treats ASIN-target corpora as valid competitive-set evidence.*

*v2.4.5 - Cold Start coverage contract: intake now asks for website, Amazon storefront, social/review surfaces, runtime forecast/bridge artifacts, and brand-manager wow facts; `brand-intelligence.yaml` is expected for fresh starts; renderer emits a source map for Brand Context page sections.*

*v2.4.4 - TACOS-primary target cleanup: Brand Context pages now lead with the true TACOS goal and label ACOS thresholds as bid-math proxies only, preventing ACOS proxy values from being misread as TACOS targets.*

*v2.4.3 — Brand Context polish: proof cards now style partial/needs-capture evidence honestly, enrichment advisories use neutral review-action language instead of raw follow-up prompts, and single-brand accounts are not penalized for intentionally empty `sub_brands`.*

*v2.4.2 — example brand readiness cleanup: CS-01 identity now uses the account-level `seller` table and pre-fetch hard-stops on empty identity; readiness treats manifest/context-contract drift as caveats instead of false "Blocked by Context" statuses where safe defaults exist.*

*v2.4.1 — Brand intelligence polish: proof chips are source-linked, the Brand Identity section can fall back to `brand-intelligence.yaml`, and Brand Voice gaps distinguish missing customer-language corpus from missing source-backed narrative.*

*v2.4.0 — Source-backed brand intelligence sidecar: Cold Start can write optional `brand-intelligence.yaml` for public web/social proof points, source map, PPC implications, and open research gaps without bloating `context.yaml` or requiring downstream skills to ingest HTML.*

*v2.3.6 — Brand Brain narrative refresh: the top "What I Know About This Brand" section now opens with a brand-intelligence paragraph, surfaces structural milestones and search-boundary knowledge from `context.yaml`, and uses `narrative.md` Brand Identity prose when available.*

*v2.3.5 — Brand Brain review refresh: renderer separates true missing context from manual runtime inputs, groups gaps into review buckets, adds skill-readiness status, and emits `review.json` for targeted machine consumption.*

*v2.3.4 — token-efficiency cleanup: CS-28/29/30/31 enrichment rows stay in canonical `.data.json` and are omitted from model-facing `.data.md`; the model reads only synthesis-needed CS-01 through CS-27 tables in fresh mode and skips `.data.md` in delta mode.*

*v2.3.3 — added deterministic `scripts/bootstrap-context.py` handoff for true fresh starts so the model no longer hand-writes the first context shell.*

*v2.3.2 — execution-contract cleanup: explicit bootstrap context shell for true fresh starts, fresh vs delta sequence split, pre-fetch wording clarified as the only approved data path, commands standardized to plugin-root execution, and validation moved before final Bottom Line.*

*v2.3.1 — typo clustering + plural/competitor-brand filters + multi-seller `:seller_id_list` binding (fixes latent CS-25/26 bug; CS-28/29/30/31 now span all `accounts[].seller_id`s); removed retroactive change-point detection; renderer shows "insufficient data" instead of null for low-volume settlement-curve cells.*

*v2.3.0 — automated enrichment (settlement curve, stockout candidates, typo candidates) + delta-update mode for re-running on existing accounts without overwriting AM-edited context.*
