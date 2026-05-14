---
name: account-cold-start
description: "Build a Tier 3 brand context directory for a new Amazon PPC account from scratch. Collect account metadata, run structured database queries, synthesize into a typed context.yaml + narrative.md + corpora/, and produce a human-reviewable Brand Context summary. Run before any other skill execution on a new account."
---

# Account Cold Start — Tier 3 Context Builder

**Use only data returned by the prefetched queries, `context.yaml`, `narrative.md`, and source-backed `brand-intelligence.json`. Do not supplement with general Amazon or e-commerce knowledge, industry benchmarks, or assumed platform dynamics not present in those inputs.**

**Begin output immediately. Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.**

**Purpose:** Build a Tier 3 brand context directory for a new account from scratch.
Run before any analytical skill on a new account.
Produces a brand directory under `~/.mixshift/clients/<brand-slug>/` plus a human-reviewable `brand-context.md` summary.

**Output structure (locked):**
```
~/.mixshift/clients/<brand-slug>/
  context.yaml      # Tier-3 mechanical truth: SellerIDs, sources, ACOS targets,
                    # capture-rate calibration, sub-brands, brand terms,
                    # structural events, posture, campaign_structure,
                    # negation rules, reporting voice. Schema-validated.
  narrative.md      # Tier-3 prose: positioning, management history,
                    # interpretation rules, strategic hypotheses.
                    # Canonical H2 headings:
                    #   ## Brand Identity
                    #   ## Customer Language Samples
                    #   ## Current Quarter Context
                    #   ## Historical Notes
  brand-intelligence.json
                    # Optional source-backed web/social/market research:
                    # hero narrative, proof points, source map, PPC implications,
                    # open research gaps.
  corpora/
    conq_asins.csv  # Layer 1 manual-targeting ASINs by item-group.
    *.csv           # Other extracted lists.
  brand-context.md  # Human review artifact (model-generated)
  README.md         # File conventions for this brand.

~/.mixshift/clients/<brand-slug>/runs/account-cold-start/
  <date>-<run-id>.json   # sidecar (emitted via `mixshift sidecar write`)
```

**Schema source of truth:** The Zod schema in the harness. Validate with `mixshift brand validate <brand-slug>` before declaring complete.

**Fresh sequence:** Phase 0 (Light Training) → Phase 0.25 (Bootstrap Context Shell) → Phase 0.5 (Web/Social Scrub) → Phase 1 (Prefetched Data) → Phase 1a (Draft Context) → Phase 2 (AM Intake) → Phase 3a (Finalize YAML + narrative + corpora) → Phase 3b (Compose brand-context.md) → Phase 4 (Validate) → Phase 5 (Final Bottom Line)

**Modes:**
- **Fresh** (default): full cold-start build. Bootstraps a minimal context shell, runs all CS-* queries through prefetch, emits typed YAML + narrative.md + corpora/, composes brand-context.md, validates, then reports the Bottom Line.
- **Delta**: re-run on an existing account to refresh enrichment fields without overwriting AM-edited context. **Deferred** — the v2.3 enrichment scripts (settlement-curve computation, stockout-window stitching, brand-typo clustering) haven't been ported to TypeScript yet. CS-28..31 prefetch successfully but the structural analysis is left to a future milestone.

---

## Hard Rules / Forbidden Reads

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** It contains cross-brand architecture documents and legacy prose-style brand .md files that are not skill inputs.
- **DO read `kickoff.md` at the start of Phase 0** (in the same skill directory). It's the AM-facing intake script — the human-readable companion to this procedure manual.
- **Do NOT read SQL library files or run ad hoc SQL.** The only approved data path is `mixshift prefetch`, which writes Phase 1 query results before the model consumes them.
- **Do NOT echo full audit tables or full data tables in your output.** Your model output is the brand-context.md (with a `file://` link) + a Bottom Line.
- **Do NOT supplement with general Amazon or e-commerce knowledge** not present in the prefetched data or cited `brand-intelligence.json` sources.
- **Do NOT mix SC and VC ops paths.** SC accounts use `business_reports_dpst_date` (CS-02); VC accounts use `vendor_sales_manufacturing_asin` (CS-03). Never mix.
- **Do NOT publish live skill output until brand context is reviewed.** Shell-first deployment: shells deployed → AM reviews `brand-context.md` → corrections applied to `context.yaml` → re-render → only then run downstream skills.

---

## Phase 0 — Light Training (required before Phase 1)

Read `kickoff.md` and walk the AM through Steps 1–2 before any DB queries. The full intake script — opening lines, "tell me about" prompts, and buyer-intent boundary questions — lives there.

**Why this order matters:** Without Phase 0 context, Phase 1 data gets misread. A confirmed organic unit decline may be a deliberate SKU de-listing; a large revenue miss may be an intentional brand transition; a high-spend month may be a media event, not a seasonal peak. Phase 0 is the interpretive filter that makes Phase 1 meaningful.

**Capture targets:** structural events, anomaly windows, account roles/wind-down notes → `context.yaml`. Management-history paragraph (if one exists) → `narrative.md ## Historical Notes`.

---

## Phase 0.25 — Bootstrap Context Shell (fresh mode only)

Before running prefetch on a never-before-seen account, create a minimal shell using the harness. Two paths:

**A. If brand discovery already mapped the SellerID(s):**
```bash
mixshift brand add <brand-slug>
```
This is the normal onboarding path. It reads warehouse seller rows for the slug, builds a context.yaml skeleton (schema_version, brand_slug, brand_name, last_updated, accounts[], sources, management with sensible defaults), and writes it to `~/.mixshift/clients/<brand-slug>/`.

**B. If you need to build the shell manually for an edge-case account:**
```bash
mixshift bootstrap --brand <brand-slug> --brand-name "<Brand Name>" --seller-id <seller-id> --account-type <SC|VC>
```

The shell exists so prefetch can bind SellerID(s), run date, and account type. It is allowed to be schema-incomplete at this point — Phase 3a finalizes it. The shell must be completed before validation or downstream skill consumption.

Minimum shell fields:
- `schema_version`, `brand_slug`, `brand_name`, `last_updated`
- `accounts[]` with `seller_id`, `seller_name`, `account_type`, `status`, `role`

If SellerID or account type is unknown, pause before prefetch and ask the AM. Do not invent those fields. If `context.yaml` already exists, do not overwrite — continue with the existing context.

---

## Phase 0.5 — Web & Social Scrub

Run after Phase 0, before Phase 1. The AM doesn't need to be present. Search sequence and target signals are documented in `kickoff.md` Step 3.

**Required AM-supplied or discovered inputs:** official website, Amazon storefront if one exists, official social/community surfaces, app/review-marketplace surfaces when relevant, known competitor/reference brand set, and any press/history surfaces that explain the brand's public story. If the AM doesn't provide competitors, derive them from public research and current ad-data targeting evidence. If unavailable, document the gap in `brand-intelligence.json::open_research_gaps`.

**Outputs:** official positioning, Amazon storefront surface, Reddit/forum presence, YouTube positioning, social presence, customer language samples, competitive set, negative press flags, brand awareness stage, source-backed milestone facts, brand-manager-facing proof points. Write the durable research map to `brand-intelligence.json`; feed concise prose into `narrative.md ## Brand Identity` and typed terms/guardrails into `context.yaml::brand_terms` / `negation`. Named competitor/reference brands belong in `context.yaml::negation.competitor_brands` (separate from protected brand terms — competitors are comparison surfaces, not automatic negatives).

**Customer-language auto-population:** Do not leave Brand Voice / Buyer Language partial if the brand has enough evidence in public surfaces or CS-31 converting search terms. Build a compact buyer-language corpus from three layers: (1) official product/support wording, (2) review/forum/editorial language for pain and failure modes, (3) top converting CS-31 search terms for the nouns customers actually type. Write prose to `narrative.md` (`## Brand Positioning` + `## Customer Language Samples`); write structured examples to `brand-intelligence.json::customer_language_corpus`.

**TACOS-primary target rule:** If `management.primary_metric: TACOS`, the human-facing brand-context.md must lead with the true TACOS goal (`management.tacos_target_pct` or `management.tacos_goal_pct`). `management.acos_target_pct` is only an ACOS-or-better proxy for bid math — never label it as the TACOS target.

---

## Phase 1 — Load Prefetched Data

Run the harness's prefetch command, which executes the catalog SQL declared in `skill.manifest.yaml`:

```bash
mixshift prefetch --brand <brand-slug> --skill account-cold-start --date <YYYY-MM-DD>
```

The runner executes CS-01..CS-31 in three rounds (see manifest `batch_plan`):
- **Round 1:** `CS-01` — identity check (must confirm SellerID before other queries proceed)
- **Round 2:** `CS-02..CS-15` — revenue baselines, ACOS history, attribution calibration, sub-brand / item-group structure, brand terms, negatives inventory
- **Round 3:** `CS-16..CS-27` — additional structure + calibration queries; `CS-28..CS-31` — v2.3 enrichment inputs (settlement curve, inventory history, daily metrics, search-term corpus)

Artifacts:
- `~/.mixshift/clients/<brand-slug>/runs/account-cold-start/<date>/data.json` — full machine-readable
- `~/.mixshift/clients/<brand-slug>/runs/account-cold-start/<date>/data.md` — capped markdown summary

Read `data.md` for synthesis. The full row sets (especially CS-28..31 which can run to thousands of rows) live in `data.json` — load that file directly when you need rows the markdown cap omitted.

**HARD GATE:** If CS-01 is absent or returns no row for the SellerID, **STOP IMMEDIATELY.** Do not proceed with a partial dataset. Report the failed query and the error.

**Key execution rules:**
- SC accounts use CS-02 for ops data; VC accounts use CS-03. Never mix paths.
- CS-09/CS-11/CS-12/CS-13/CS-19/CS-25 apply to VC only; CS-10/CS-20 apply to SC only. Non-matching queries return empty rows — discard.
- CS-16 references `mws_inventory_history` (confirmed empty-column stub 2026-04-27); always returns empty.
- Multi-SellerID accounts: queries use `:seller_id_list` and span every SellerID in `accounts[]`.

**Phase 1 outputs to capture for Tier 3:**
- Account and seller identification confirmed (CS-01)
- 24-month revenue baseline by month (CS-02/CS-03/CS-11)
- 24-month ACOS baseline by month and by campaign type (CS-04/CS-05/CS-18)
- Attribution window calibration improvement points (CS-06/CS-07/CS-08)
- Sub-brand and item-group structure (CS-09/CS-10/CS-12/CS-13/CS-19/CS-25)
- Brand term dictionary (catalog-derived) (CS-19/CS-20)
- Enabled negatives inventory (CS-21)
- Budget utilization and keyword spend concentration (CS-22/CS-23)
- Objective config and label completeness gaps (CS-24/CS-27)

**v2.3 enrichment rows (CS-28..31):** prefetched but post-processing not yet ported. Read the headers for awareness; defer detailed analysis. CS-31's converting-search-term corpus is still useful for Phase 3a buyer-language synthesis (aggregate top N terms by lane / product job — bounded aggregation, not full row consumption).

---

## Phase 1a — Draft Context for AM Intake (fresh mode only)

Update the bootstrap shell with the Phase 1 fields you've extracted so far:
- `accounts[]` confirmed and enriched (status, role, marketplace, region from CS-01)
- `brand_terms` (canonical + variants from CS-19/CS-20)
- `negation.competitor_brands` if known from Phase 0.5 or Phase 1
- `capture_rate_calibration` placeholder if attribution-window calibration is applicable

This draft is still not final. It exists so Phase 2 (AM intake) can be framed around real data rather than abstract questions.

---

## Phase 2 — AM Intake (collect from account manager)

Walk the AM through `kickoff.md` Step 4. The full question list and rationale live there.

**Hard gate:** Phase 2 is not optional in fresh mode. After Phase 1 and the web/social scrub, synthesize the smallest sufficient numbered question set from unresolved AM decisions, data anomalies needing business context, and review gaps. Ask those questions immediately and wait for answers before finalizing Phase 3a.

**Draft exception:** If the operator explicitly asks for a preview before answering Phase 2, you may render a draft brand-context.md. Label it as draft / observational, include the file link, then continue directly into the numbered Phase 2 questions. Do not stop as if the cold start is complete.

**Question construction rules:**
- Ask numbered questions, not passive "Tell AI" prompts.
- Include the data-derived hypothesis when useful, then ask the operator to confirm, correct, or mark unknown / not applicable.
- Prioritize required operating decisions first, then high-impact anomalies, then optional context that would improve downstream skill quality.
- Keep runtime-only uploads separate. Forecast, HCAM/H-Bridge, monthly-report screenshots are runtime inputs, not Brand Context gaps unless the operator says they do not exist.
- If a question can be answered by the automated data review, answer it yourself and cite the finding in context rather than asking the operator.
- Before asking about stockouts, check CS-16 / inventory signals + revenue + session patterns. If data shows an inventory trough but no per-ASIN OOS window, record an advisory note instead of asking the operator to confirm a stockout.
- Before asking whether a promo caused a spike, check revenue, units, ASP/price proxy, spend, conversion. If ASP held while units spiked, treat as deal placement or demand surge rather than discount unless price history proves markdown.

**Critical execution rules** (model behavior, not AM-facing prose):
- If TACOS is primary metric, derive ACOS thresholds from posture and the historical SC vs. ad-attributed ratio.
- Combine catalog-derived brand terms (Phase 1) with AM-supplied variants (Phase 2) into a single `context.yaml::brand_terms`. Don't keep two lists.
- If the AM doesn't supply a quarterly revenue target and `goals.report_quarterly_pacing` is false, set `goals.quarterly_revenue_target: null` and do not treat it as missing.
- Capture promotions and launches as `structural_events[]` entries with appropriate types — not as free prose.

---

## Phase 3a — Finalize context.yaml + narrative.md + corpora/

Finalize `~/.mixshift/clients/<brand-slug>/`. **Mechanical truth goes in `context.yaml`; prose goes in `narrative.md`; lists go in `corpora/*.csv`. Never put SellerIDs, ACOS targets, or thresholds into prose** — they belong in YAML.

### context.yaml (mechanical Tier-3, schema-validated)

Populate every required and applicable optional section per the Zod schema (run `mixshift brand validate <brand-slug>` to see the schema-required fields). Mapping from Phase 0/1/2 collection to YAML sections:

| YAML section | Source phase | Notes |
|---|---|---|
| `accounts[]` | Phase 0 | One entry per SellerID. `account_type ∈ {SC, VC}`. `status ∈ {active, wind_down, inactive}`. `role ∈ {primary, legacy, secondary}`. |
| `sources` | Phase 0 + Phase 1 verification | `ad_metrics` is always `campaignmetric`. `ops_revenue` is `vendor_sales_manufacturing_asin` (VC) or `business_reports_dpst_date` (SC). |
| `management` | Phase 2 | `primary_metric ∈ {ACOS, TACOS}`. `acos_target_pct` numeric. `attribution_window_days` integer. |
| `capture_rate_calibration` | Phase 1 (CS-06/CS-07/CS-28) | Required if `attribution_window_days > 1`. Daily-curve sub-block (`daily_settlement_curve`) deferred until enrichment is ported. |
| `sub_brands[]` | Phase 1 + Phase 2 | One entry per CustomBrand. List `item_groups`. |
| `brand_terms` | Phase 1 catalog + Phase 2 variants | Per sub-brand: `canonical[]` and `variants[]`. |
| `bid_health` | Phase 2 | `scale_threshold_pct`, `pullback_threshold_pct`. |
| `posture` | Phase 2 | `stance ∈ {scale, efficiency, defend, clear_bleed}`. `multiplier ∈ [0.0, 1.0]`. |
| `goals` | Phase 2 | Use explicit `null` for absent targets — never omit the key. |
| `structural_events[]` | Phase 0 | Type from enum. Always include `interpretation`. |
| `objective_calibration` | Phase 1 (CS-24) | Per-objective expected ACOS — used by health-check skills. |
| `campaign_structure` | Phase 1 (CS-22) | `naming_pattern` with `{Token}` placeholders. `objectives` token map. |
| `paused_campaigns[]` | Phase 1 | List campaign names where `state='paused'`. |
| `negation` | Phase 0.5 + Phase 2 | `protected_terms[]`, `lane_rules{}`, `asin_negation.pre_check_lifetime_orders_threshold`. |
| `reporting` | Phase 2 | `audience ∈ {executive, account_manager, analyst}`. `voice_lint[]` regexes. |
| `delivery` | Phase 2 + Phase 3 setup | Local reports dir, archive path. |
| `open_gaps[]` | Whatever you couldn't populate | Explicit list — do not silently omit. |

Do not publish placeholder Phase 2 values as final context. Provisional, data-derived targets used to frame questions stay in `open_gaps[]` until the operator confirms.

### narrative.md (prose-only Tier-3)

For interpretation that doesn't fit a typed field. Use these canonical H2 headings:

- `## Brand Identity` or `## Brand Positioning` — who this brand is, positioning, customer language. Drives the Brand Identity section of the brand-context.md.
- `## Customer Language Samples` or `## Buyer Language` — concise customer/review/forum/search-term phrases by lane and product job. Required unless web/review/search evidence is genuinely unavailable.
- `## Current Quarter Context` — what's happening right now that AI should know. Drives the Active Conditions lead-in.
- `## Historical Notes` — management transitions, strategic pivots, brand migrations. Drives a footer-adjacent block.
- Other H2 headings render as a generic appendix.

**Forbidden in narrative.md:** SellerIDs, ACOS targets, thresholds, SQL, ASIN lists. Those belong in `context.yaml` or `corpora/`.

### corpora/*.csv

- `conq_asins.csv`: columns `asin, item_group, sub_brand, layer, sub_label`. Layer 1 = manually-targeted; Layer 2 = lifetime-converting auto.
- Other extracted lists (5-year history tables, monthly-actuals snapshots) go here, one CSV per logical list.

### brand-intelligence.json (source-backed wow layer)

Create this file for every fresh cold start unless web access is unavailable or the AM explicitly skips public research. Required shape:
- `sources{}` with official site, Amazon storefront if present, review/app/social/press/competitor sources as applicable.
- `hero_narrative` for the human-facing "What I Know About This Brand" lead paragraph.
- `proof_points[]` with `title`, `status` (`strong|partial|identified_no_counts|needs_capture`), `summary`, `evidence[]`.
- `customer_language_corpus{}` with compact phrase clusters sourced from CS-31, official/support pages, review/editorial surfaces, forums, or a clear `needs_capture` explanation.
- `ppc_implications[]` explaining how each brand fact changes PPC interpretation.
- `open_research_gaps[]` for dynamic or uncaptured surfaces.

Do not put SellerIDs, targets, thresholds, or SQL in this file. It is public/source-backed brand intelligence plus clearly labeled internal-context implications.

**Competitive set:** source-backed competitor/reference brand names should be duplicated into `context.yaml::negation.competitor_brands` and summarized in `brand-intelligence.json::proof_points[]`. If current ASIN targets provide the stronger competitive evidence, write the ASIN rows to `corpora/conq_asins.csv` and cite that corpus in `sources{}`.

---

## Phase 3b — Compose brand-context.md (model-rendered)

In the new harness architecture, the skill model is the renderer. Compose a markdown summary at:

```
~/.mixshift/clients/<brand-slug>/brand-context.md
```

The brand-context.md is the human-review artifact. It must include:

1. **Brand Identity** — Hero narrative from `brand-intelligence.json::hero_narrative` or `narrative.md ## Brand Identity`. Lead paragraph that explains what the brand is, why the public story matters for PPC, and what internal management facts MixShift remembers.
2. **Account Snapshot** — SellerIDs, account types (SC/VC), marketplaces, posture, primary_metric + target (TACOS-primary leads with TACOS goal, never the ACOS proxy).
3. **Sub-brand and Item-group Structure** — table from `context.yaml::sub_brands` + `brand_terms` + `corpora/`.
4. **Active Conditions** — `structural_events[]` filtered to currently active + `narrative.md ## Current Quarter Context`.
5. **Proof Cards** — from `brand-intelligence.json::proof_points[]`. Render `partial` and `needs_capture` cards honestly (don't dress them up as `strong`).
6. **Competitive / Reference Brand Dictionary** — from `negation.competitor_brands`, separate from protected brand terms / misspellings.
7. **Attribution Backfill Calibration** — `capture_rate_calibration` summary. SC pages distinguish SP 7d from SB/SD 14d when populated.
8. **Missing Context Buckets** — `open_gaps[]` grouped by category (required, recommended, runtime input, accepted gap).
9. **Skill Readiness** — for each downstream skill (daily-health-check, runaway-spend-check, etc.), state whether brand context is sufficient or what's missing.
10. **Verdict footer** — `GREEN | YELLOW | RED | OBSERVATIONAL` with reason.

**Verdict logic:**
- `RED` — any required schema field missing OR `mixshift brand validate` fails
- `YELLOW` — required fields populated, but `open_gaps` non-empty or `last_updated > 30d`
- `GREEN` — all required + recommended fields populated, no open gaps, fresh
- `OBSERVATIONAL` — Phase 1 only (Phase 2 deferred / draft mode)

**Do NOT write or edit context.yaml mid-render.** The Phase 3a finalization is complete before Phase 3b begins. If you discover a missing field while composing brand-context.md, log it in `open_gaps[]`, finish the render, and surface it in Phase 5.

---

## Phase 4 — Validate before declaring complete

Validate the finalized context.yaml against the Zod schema:

```bash
mixshift brand validate <brand-slug> --json
```

If validation fails:
1. Read the JSON error output.
2. Fix the offending field(s) in `context.yaml`.
3. Re-run validation.
4. Re-render brand-context.md so the file reflects the corrected state.

Do not hand off to downstream skills with a failing validator.

(The legacy SQL drift gate is not yet ported. Today, the manifest's `sql_ids` list is the contract; new SQL must be added to `shared/sql-library/catalog.yaml` + the relevant skill manifest before consumption. The harness's `mixshift sidecar compare` will fill this gap once implemented.)

---

## Phase 5 — Final Bottom Line + Emit Sidecar

After Phase 4 passes:

1. **Bottom Line response** — audit summary in 3–4 sentences:
   - Required fields present / total, recommended fields present / total, stale count
   - True missing-context bucket count, runtime input count
   - Verdict (`GREEN | YELLOW | RED | OBSERVATIONAL`) with one-sentence rationale
   - `file://` link to `~/.mixshift/clients/<brand-slug>/brand-context.md`
2. **If unresolved Phase 2 decisions remain** — emit a Draft Bottom Line, append the file link, then ask the numbered Phase 2 questions immediately in the same response. Stop only to wait for operator's answers. Do not present the cold start as complete.

### Emit sidecar

Compose the sidecar input JSON (write to a temp file, then invoke the harness):

```jsonc
// /tmp/cs-sidecar-input.json
{
  "skill": "account-cold-start",
  "skill_version": "2.5.0",
  "brand_slug": "<brand-slug>",
  "run_kind": "per_account",
  "data_date": "YYYY-MM-DD",
  "verdict": "GREEN|YELLOW|RED|OBSERVATIONAL",
  "context_snapshot": {
    "account_type": "SC|VC",
    "seller_id": 0,
    "primary_metric": "ACOS|TACOS",
    "acos_target_pct": 20,
    "attribution_window_days": 14
  },
  "headline_metrics": {
    "required_present": 0,
    "required_total": 0,
    "recommended_present": 0,
    "recommended_total": 0,
    "open_gaps_count": 0,
    "runtime_input_count": 0,
    "stale_field_count": 0
  },
  "sql_calls": [
    {"id": "CS-01", "params": {"seller_id": 0}},
    {"id": "CS-04", "params": {"seller_id": 0}}
    // ... one entry per CS-* invoked. Include the SC-specific OR VC-specific
    // ones that applied to this account (not both).
  ],
  "artifacts": {
    "report_html_path": "~/.mixshift/clients/<brand-slug>/brand-context.md"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/cs-sidecar-input.json
```

`mixshift sidecar compare` will surface drift against the prior cold-start once implemented; until then, the sidecar lands at `~/.mixshift/clients/<brand-slug>/runs/account-cold-start/<data-date>-<run-id>.json` for retrospective review.

---

## Key Interpretation Rules (apply throughout)

- **Cross-reference everything against Phase 0.** An unusual Phase 1 pattern is either explained by Phase 0 context or is a genuine question for Phase 2. Never assume anomalies are random.
- **Airtime threshold for item groups:** <$5K/month → track in file, omit from reports. Surface only if materially changed.
- **ASIN-level TACOS is unreliable.** Account-level ACOS is the only clean management metric.
- **VC ops data path:** Always `vendor_sales_manufacturing_asin` (CS-03). Never use SC path for VC.
- **Management history matters.** If the account changed management or strategy mid-period, treat trend signals as unreliable until sufficient post-transition data accumulates.
- **Settlement application (VC accounts):** Use weighted formula for MTD ACOS — do not apply full improvement_pts uniformly. Formula in CS-06/CS-07 results.
- **VC monthly metric coverage:** Verify `sellermonthmetric` is populated. If empty, monthly reports must use raw `campaignmetric` aggregates.

---

## Cold Start Patterns (apply during synthesis)

- SC column naming conventions and validation
- Item group extraction from campaign names (approximate — validate manually)
- Multiple rows per day per keyword in granular tables (always aggregate to daily totals)
- Stockout interpretation rules
- High SP other-SKU rates as structurally expected
- Coined brand terms in auto search-term data
- TACOS-to-ACOS derivation from trailing 3-month ratios
- Ads % of Sales stability rules
- Campaign label vs product line code mismatches
- Phase 2 AMA as formal follow-up, not informal exploration

---

## Next Steps After Cold Start

1. The operator reviews `brand-context.md` (link from the Bottom Line). Missing-context buckets show what still needs brand input; runtime-input cards show artifacts supplied manually when downstream skills run.
2. After approval, downstream skills can run: Daily Health Check → Runaway Spend Check → Keyword Bid Health → others.

---

## Deferred from legacy v2.3.x (TypeScript ports pending)

The following enrichment behaviors existed in the legacy Python implementation and aren't ported yet. The relevant CS queries still prefetch successfully — the analysis just lives in a future milestone:

- **Daily attribution settlement curve** (CS-28) — reshape into `capture_rate_calibration.daily_settlement_curve` with per-CT and DOW offsets.
- **Stockout-window detection** (CS-29 + CS-30) — stitch contiguous ≥3-day windows of `SellableQuantity=0` / Alert active / DaysOfSupply<14.
- **Brand-name typo clustering** (CS-31 + brand_terms + competitor_brands) — Levenshtein 1-2 hits clustered by (canonical_match, root_token).
- **Delta mode** — re-run enrichment-only against an existing context, merge into `capture_rate_calibration.daily_settlement_curve` without overwriting AM-edited fields.

For a fresh cold start today, prefetch CS-28..31 (they're declared in the batch_plan), note their row counts in `brand-context.md::Open Research Gaps`, and proceed without the structural analysis. When the enrichment is ported, this section moves into Phase 1.5 and the deferred note goes away.
