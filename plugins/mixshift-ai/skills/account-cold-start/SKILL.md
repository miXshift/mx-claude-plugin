---
name: account-cold-start
description: "Build a Tier 3 brand context directory for a new Amazon PPC account from scratch. Collects account metadata, runs structured database queries, synthesizes into a typed context.yaml + narrative.md + corpora/, and renders a human-reviewable Brand Context page. Use this skill whenever the user mentions a cold start, new account setup, account onboarding, building brand context, kicking off a new client, or onboarding a brand — even if they don't say 'cold start' explicitly. Always run before any other Amazon PPC skill on an account that doesn't yet have a populated ~/.mixshift/clients/<brand>/context.yaml."
---

# Account Cold Start — Tier 3 Context Builder

**Use only data returned by the prefetched queries, `context.yaml`, `narrative.md`, and source-backed `brand-intelligence.yaml`. Do not supplement with general Amazon or e-commerce knowledge, industry benchmarks, or assumed platform dynamics not present in those inputs.**

**Begin execution immediately. Do not restate these instructions or summarize what you are about to do before your first tool call.** This is a no-preamble rule, not a no-questions rule — Phase 2 AM intake requires numbered questions to the account manager and is part of the procedure, not a preamble. Skipping Phase 2 to "avoid clarifying questions" violates the Phase 2 hard gate below.

**Purpose:** Build a Tier 3 brand context directory for a new account from scratch.
Run before any analytical skill on a new account.
Produces a brand directory under `~/.mixshift/clients/<brand-slug>/` plus a human-reviewable `brand-context.html` ("Brand Context page") rendered by the deterministic renderer.

**Output structure (locked):**
```
~/.mixshift/clients/<brand-slug>/
  context.yaml      # Tier-3 mechanical truth: SellerIDs, sources, ACOS targets,
                    # capture-rate calibration, sub-brands, brand terms,
                    # structural events, posture, campaign_structure,
                    # negation rules, reporting voice. Schema-validated.
  narrative.md      # Tier-3 prose: positioning, management history,
                    # interpretation rules, strategic hypotheses.
                    # Canonical H2 headings the renderer looks for:
                    #   ## Brand Identity
                    #   ## Customer Language Samples
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
  reporting-style.yaml
                    # OPTIONAL. Per-brand monthly report section list, ordering,
                    # variants, and voice notes. Produced by Phase 2 when an AM
                    # uploads a reference report. Consumed by monthly-performance-report
                    # to match the brand's house style. Schema:
                    # shared/clients/_schema/reporting-style.schema.yaml.
                    # When absent, monthly-performance-report uses canonical defaults.
  README.md         # File conventions for this brand.
  brand-context.html           # Brand Context page (human review) — renderer output
  brand-context.headline.json  # ~500-token summary for the model
  brand-context.review.json    # compact review map: buckets, runtime inputs, skill readiness
  runs/account-cold-start/<date>/
    <run-id>.json              # sidecar (auto-emitted by renderer)
    <date>.data.json           # prefetch artifact (full machine-readable)
    <date>.data.md             # prefetch artifact (markdown summary, model-facing)
    <date>.enrichment.json     # Phase 1.5 enrichment output (settlement curve,
                               # stockout candidates, brand-typo clusters)
    <date>.discoveries.json    # typed observations PROPOSED for context promotion
```

**Schema source of truth:** the Zod schema in the harness (mirrored by `shared/clients/_schema/context.schema.yaml`). Validate with `mixshift brand validate <brand-slug>` before declaring complete.

**Fresh sequence:** Phase 0 (Light Training) → Phase 0.25 (Bootstrap Context Shell) → Phase 0.5 (Web/Social Scrub) → Phase 1 (Prefetched Data) → Phase 1a (Draft Context for Enrichment) → Phase 1.5 (Enrich, v2.3+) → Phase 2 (AM Intake) → Phase 3a (Finalize YAML + narrative + corpora) → Phase 3b (Render brand-context.html) → Phase 4 (Validate) → Phase 5 (Final Bottom Line)

**Delta sequence:** Phase 1 (delta prefetch only) → Phase 1.5 (Enrich) → `mixshift brand merge-delta` → Phase 3b (Render brand-context.html) → Phase 4 (Validate) → Phase 5 (Final Bottom Line)

**Modes:**
- `--mode fresh` (default): full cold-start build. Bootstraps a minimal context shell, runs all CS-* queries through prefetch, emits typed YAML + narrative.md + corpora/, enriches, renders, validates, then reports the Bottom Line.
- `--mode delta` (v2.3+): re-run on an existing account to refresh enrichment fields without overwriting AM-edited context. Runs only enrichment-tagged queries (CS-28/29/30/31), patches `capture_rate_calibration.daily_settlement_curve` into context.yaml, refreshes the enrichment artifact, re-renders. AM-curated fields (negation, structural_events, brand_terms, posture, etc.) are never touched.

---

## Hard Rules / Forbidden Reads

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** It contains cross-brand architecture notes, Amazon API references, and legacy prose-style brand .md files for human reference only — they are not skill inputs and will produce inconsistent output if mixed into synthesis. Brand context comes from `context.yaml`, `narrative.md`, optional source-backed `brand-intelligence.yaml`, and renderer-produced compact sidecars.
- **DO read `kickoff.md` at the start of Phase 0** (in the same skill directory). It's the AM-facing intake script — the human-readable companion to this procedure manual. Walking the AM through it is the first concrete step of any cold-start run.
- **Do NOT read SQL library files or run ad hoc SQL.** The only approved data path is `mixshift prefetch`, which writes Phase 1 query results before the model consumes them.
- **Do NOT write or edit `brand-context.html`, `brand-context.headline.json`, `brand-context.review.json`, or the run sidecar manually.** The renderer (Phase 3b) is the single writer of these artifacts.
- **Do NOT echo HTML, full audit tables, or full data tables in your output.** The HTML is the deliverable; your model output is a Bottom Line + `file://` link to the HTML.
- **Do NOT supplement with general Amazon or e-commerce knowledge** not present in the prefetched data or cited `brand-intelligence.yaml` sources.
- **Do NOT mix SC and VC ops paths.** SC accounts use `business_reports_dpst_date` (CS-02); VC accounts use `vendor_sales_manufacturing_asin` (CS-03). Never mix.
- **Do NOT publish live skill output until brand context is reviewed.** Shell-first deployment: shells deployed → AM reviews `brand-context.html` → corrections applied to `context.yaml` → re-render → only then run downstream skills.

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

**Required AM-supplied or discovered inputs:** official website, Amazon storefront if one exists, official social/community surfaces, app/review-marketplace surfaces when relevant, known competitor/reference brand set, and any press/history surfaces that explain the brand's public story. If the AM does not provide competitors, derive them from source-backed public research and current ad-data targeting evidence where available; do not make the AM provide a list unless the data is ambiguous. If unavailable, document the gap in `brand-intelligence.yaml::open_research_gaps`.

**Outputs:** official positioning, Amazon storefront surface, Reddit/forum presence, YouTube positioning, social presence, customer language samples, competitive set, negative press flags, brand awareness stage, source-backed milestone facts, and brand-manager-facing proof points. Write the durable research map to `brand-intelligence.yaml`; feed concise prose into `narrative.md ## Brand Identity` and typed terms/guardrails into `context.yaml::brand_terms` / `negation`. Named competitor/reference brands belong in `context.yaml::negation.competitor_brands` so the renderer can show a Competitive / Reference Brand Dictionary and enrichment can suppress competitor collisions from brand-misspelling review. Keep competitor names separate from protected brand terms: competitors are comparison surfaces, not automatic negatives. If a surface returns zero signal (e.g., no Reddit presence), document it as a baseline finding rather than silently omitting.

**Customer-language auto-population contract:** Do not leave Brand Voice / Buyer Language partial if the brand has enough evidence in public surfaces or CS-31 converting search terms. Build a compact buyer-language corpus from three layers: (1) official product/support wording for intended product jobs, (2) review/forum/editorial language for customer pain and failure modes, and (3) top converting CS-31 search terms for the nouns customers actually type. Write durable prose to `narrative.md` using `## Brand Positioning` or `## Brand Identity` plus `## Customer Language Samples`; write structured examples to `brand-intelligence.yaml::customer_language_corpus`. Use short phrases and intent clusters, not full review dumps. If Amazon reviews or forums are blocked, say so in `open_research_gaps[]` only after using available search-term and official/support language.

**Mindblowing first-paragraph rule:** `brand-intelligence.yaml::hero_narrative` must explain what the brand is, why the public story matters for PPC, and which internal management facts MixShift remembers. It should connect company/product history, category position, competitors, social/press/customer signals, and durable ad-account interpretation. Do not make claims without source-backed evidence or internal context evidence.

**Brand intelligence quality rules:** Proof points must distinguish `strong` / `partial` / `identified_no_counts` / `needs_capture` evidence. Do not turn a dynamic or uncaptured surface (Amazon storefront, social counts, review volume) into a claim; preserve it as a known surface with `needs_capture` until the content is captured. Human-facing review pages should use neutral labels such as "Missing input", "Open context note", and "Review action" instead of raw "Tell AI" prompts.

**Proof point vs. internal metric distinction:** `proof_points[]` must contain public-facing brand facts — certifications, founding history, category position, press mentions, customer proof, social evidence, or competitive context. Internal account data (sales actuals, TACOS percentages, ACOS figures, forecast accuracy scores, SellerID identifiers) are NOT proof points — they belong in `context.yaml` fields and surface through the rendered headline. When public-facing sources are sparse (e.g., a non-English EU market with limited English web presence), do not substitute internal metrics to fill `proof_points[]`. Instead, document the shortfall in `open_research_gaps[]` with a note about which surfaces were attempted and why they yielded insufficient brand-facing content.

**TACOS-primary target rule:** If `management.primary_metric: TACOS`, the human page must lead with the true TACOS goal (`management.tacos_target_pct` or `management.tacos_goal_pct`). `management.acos_target_pct` is only an ACOS-or-better proxy for bid math and must never be labeled as the TACOS target.

**TACOS-primary sales-target rule:** If a brand is managed to TACOS and explicitly has no static monthly/quarterly sales target, do not mark legacy `goals.monthly_total_sales_target` or `goals.quarterly_total_sales_target` manifest fields as missing context. Sales are observed or forecast-supplied at run time; the durable operating target is TACOS.

**Readiness status rule:** Skill Readiness is a Brand Context readiness check, not a same-day artifact availability check. Do not downgrade a skill to `Ready with Caveats` just because it has `upstream_skills` or skill-owned data pulls; those are generated/refreshed during execution. Only real missing context, manifest/context contract drift, or manual runtime uploads should change readiness status.

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

## Phase 1a — Draft Context for Enrichment (fresh mode only)

Before running Phase 1.5 enrichment in fresh mode, update the bootstrap shell into a draft context with the Phase 1 fields that enrichment needs:
- `accounts[]` confirmed and enriched (status, role, marketplace, region from CS-01)
- `brand_terms` (canonical + variants from CS-19/CS-20)
- `negation.competitor_brands` if known from Phase 0.5 or Phase 1
- `capture_rate_calibration` placeholder if attribution-window calibration is applicable

This draft is still not final. Its purpose is to let enrichment detect stockout candidates and brand-name typo clusters using the current brand term dictionary. Phase 2 then confirms which advisory findings should be promoted into durable typed fields.

---

## Phase 1.5 — Enrichment (v2.3+)

After prefetch completes and context exists, run the harness's enrichment to compute three advisory analyses. In fresh mode, run this after Phase 1a. In delta mode, run this against the existing reviewed context.

```bash
mixshift brand enrich --brand <brand-slug> --date <YYYY-MM-DD>
```

It reads the prefetch artifact plus the existing `context.yaml` and writes `runs/account-cold-start/<date>/<date>.enrichment.json` containing:

1. **Daily attribution settlement curve** (from CS-28) — per-campaign-type ACOS at 1d/7d/14d, day-of-week offsets, stability score. Reshaped to `capture_rate_calibration.daily_settlement_curve`. Cells with insufficient data (low-volume campaign types where 1-day or 7-day attribution doesn't accrue) are labeled "insufficient data" rather than `null`.
2. **Stockout candidates** (from CS-29 + CS-30) — contiguous windows ≥3 days where `SellableQuantity = 0` OR Alert active OR `DaysOfSupply < 14`. Each entry includes impacted ad-sales for the window. VC accounts: FBA-only. **Limitation:** ASIN suppression-for-profitability events (Amazon de-ranks an ASIN despite inventory) are not detectable from `mws_inventory_health` — those still require AM input as `structural_events[]`.
3. **Brand-name typo clusters** (v2.3.1+, from CS-31 + `brand_terms` + `negation.competitor_brands`) — converting search terms within Levenshtein 1-2 of any canonical brand term, not already in variants. **Clustered** by `(canonical_match, root_token)` so the AM gets one decision per cluster instead of N flat rows. Plural-only matches (e.g. "polar bottles" vs canonical "polar bottle") and competitor-brand collisions (e.g. "hydrapeak" when canonical is "hydrapak") are filtered out before clustering — competitor-brand prefixes are read from the optional `negation.competitor_brands` list in `context.yaml`.

**Removed in v2.3.1:** Change-point detection. The retroactive listing produced too much noise — most "unexplained" breaks were Q4 ramps and post-holiday drops the AM didn't remember. Forward-looking change-point capture (writing breaks to `structural_events[]` as they emerge from daily runs) is a candidate for a separate skill.

**Delta mode:** after enrichment, run `mixshift brand merge-delta` to patch the settlement curve into `context.yaml` (preserves comments and AM-edited fields):

```bash
mixshift brand merge-delta --brand <brand-slug> --date <YYYY-MM-DD>
```

Detected anomalies stay in `runs/account-cold-start/<date>/<date>.enrichment.json` and are surfaced by the renderer in the "Detected Anomalies (Advisory)" section. They are **not** auto-promoted to typed `structural_events[]` or `brand_terms.variants` — AM confirmation required first. The pending list survives across cold-start runs (additive merge) until the AM confirms or dismisses.

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
- Combine catalog-derived brand terms (Phase 1) with AM-supplied variants (Phase 2) into a single `context.yaml::brand_terms` map. Don't keep two lists.
- If the AM doesn't supply a quarterly revenue target and `goals.report_quarterly_pacing` is false, set `goals.quarterly_revenue_target: null` and do not treat it as missing. If quarterly pacing is true, add a missing-context bucket item.
- If forecast/HCAM/H-Bridge/dimension bridge artifacts exist outside the DB, record them as runtime inputs required, not static context gaps.
- Capture promotions and launches as `structural_events[]` entries with appropriate types — not as free prose.

### Phase 2 sub-step — Reporting Style Intake (optional, high-leverage)

Ask the AM **once** during Phase 2:

> "Do you have an existing monthly performance report you've been delivering for this brand? If yes, share the most recent one (HTML, PDF, Word, or paste). I'll model future reports on its structure — section list, table styles, voice cadence, what you lead with, what you omit. If no, I'll use the canonical defaults; you can refine later."

**When a reference report is provided:**

1. Extract structural signals from the reference:
   - **`sections`** — ordered list of section identifiers (mapping the reference's sections to types in `shared/clients/_schema/reporting-style.schema.yaml::section_types`)
   - **`variants`** — which render variant the brand uses (e.g., `metrics_table: split` vs. `unified`; `forecast_presentation: anchor_cards_plus_table` vs. `inline_metric_row` vs. `forward_projection_table` vs. `none`; `item_group: table_only` vs. `table_plus_deep_dives`)
   - **`voice_notes`** — free-form steering signals captured from the reference's tone, hedging patterns, audience cues
   - **`emphasis`** — `primary_metric` (ACOS or TACOS), `feature_sub_brands[]` (sub-brands that always get a callout), `forecast_lead` tone, `brand_specific_framings[]`
   - **`omit`** — section types the reference explicitly does not include

2. Write `~/.mixshift/clients/<brand-slug>/reporting-style.yaml`. Schema: `shared/clients/_schema/reporting-style.schema.yaml`. Set `source.type: cold_start_inference`, `source.reference_artifact:` to the relative path of the uploaded reference (if you stored it under `~/.mixshift/clients/<brand-slug>/`).

3. Surface a short summary in the cold-start Bottom Line: "Reporting style captured from reference report: N sections, MoM/YoY style = <split|unified>, forecast presentation = <variant>, voice notes recorded." The AM can refine later by editing the file.

**When no reference is provided:**

1. Do NOT write `reporting-style.yaml`. The absence of the file is the signal — monthly-performance-report uses canonical defaults.
2. Note in the cold-start Bottom Line: "No reference report provided; monthly reports will use canonical defaults. To customize later, add `~/.mixshift/clients/<brand-slug>/reporting-style.yaml`."

**Why this is high-leverage:** For brands with established reporting conventions, this single intake step is what makes the first monthly run look like the AM's prior reports rather than a generic template. Without it, the AM has to manually point the skill at the prior report every month (the pre-2.5 pattern) or accept canonical defaults.

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

**Standardized gap text for label_completeness (CS-24):** When all campaigns show `objective_class=unknown`, write the gap as:
`campaign_structure.label_completeness: all <N> active campaigns have objective_class=unknown; custom classifier needed for <brand> naming convention — objective-level analysis unavailable until resolved`

Use "objective-level analysis" (not "objective-level reporting") — the word "reporting" in gap text causes the renderer's bucket classifier to route this gap to `reporting_setup` instead of `operating_rules`, where it belongs.

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
- `proof_points[]` with `title`, `status` (`strong|partial|identified_no_counts|needs_capture`), `summary`, `evidence[]`.
- `customer_language_corpus{}` with compact phrase clusters sourced from CS-31, official/support pages, review/editorial surfaces, forums, or a clear `needs_capture` explanation.
- `ppc_implications[]` explaining how each brand fact changes PPC interpretation.
- `open_research_gaps[]` for dynamic or uncaptured surfaces.

Do not put SellerIDs, targets, thresholds, or SQL in this file. It is public/source-backed brand intelligence plus clearly labeled internal-context implications.

**Competitive set:** source-backed competitor/reference brand names should be duplicated into `context.yaml::negation.competitor_brands` and summarized in `brand-intelligence.yaml::proof_points[]`. If current ASIN targets provide the stronger competitive evidence, write the ASIN rows to `corpora/conq_asins.csv` and cite that corpus in `sources{}`.

---

## Phase 3b — Render brand-context.html (deterministic)

Run the renderer. It reads `context.yaml` + `narrative.md` + `corpora/*.csv` + the schema and audit-labels map, and writes the Brand Context HTML, a compact `headline.json`, the `review.json`, and the run sidecar — all in one call.

```bash
mixshift brand render-context --brand <brand-slug> --date <YYYY-MM-DD>
```

**Outputs (renderer is the only writer):**
- `~/.mixshift/clients/<brand-slug>/brand-context.html` — human-reviewable Brand Context page
- `~/.mixshift/clients/<brand-slug>/brand-context.headline.json` — ~500-token model summary
- `~/.mixshift/clients/<brand-slug>/brand-context.review.json` — compact machine map of missing-context buckets, runtime inputs, and skill readiness
- `~/.mixshift/clients/<brand-slug>/runs/account-cold-start/<date>/<run-id>.json` — sidecar
- Optional copy to `context.delivery.reports_local_dir` (warning-only if path unavailable)

**Verdict logic** (computed by renderer):
- `RED` — any required schema field missing OR validator fails
- `YELLOW` — required fields populated, but `open_gaps` non-empty or `last_updated > 30d`
- `GREEN` — all required + recommended fields populated, no open gaps, fresh
- `OBSERVATIONAL` — Phase 1 only (Phase 2 deferred)

After running the renderer, do not report to the user yet. Continue to Phase 4 validation first. The final response happens in Phase 5 unless unresolved Phase 2 questions require an AM handoff.

**Do NOT write or edit context.yaml mid-render.** The Phase 3a finalization is complete before Phase 3b begins. If you discover a missing field while composing the page, log it in `open_gaps[]`, finish the render, and surface it in Phase 5.

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
4. Re-render `brand-context.html` so the artifacts reflect the corrected state.

Do not hand off to downstream skills with a failing validator.

The legacy SQL drift gate is not yet ported. Today, the manifest's `sql_ids` list is the contract; new SQL must be added to `shared/sql-library/catalog.yaml` + the relevant skill manifest before consumption. The harness's `mixshift sidecar compare` will fill this gap once implemented.

---

## Phase 5 — Final Bottom Line

After validation passes, read **only** `brand-context.headline.json` and `brand-context.review.json` (do not read the HTML).

If the run still has unresolved Phase 2 decisions, true context issues that require AM input, or a YELLOW/OBSERVATIONAL verdict caused by open gaps:
1. Emit a Draft Bottom Line: audit summary (`required_present`/`required_total`, `recommended_present`/`recommended_total`, stale count), true missing-context bucket count, runtime input count, and verdict.
2. Append a `file://` link to the draft `brand-context.html` for the operator's review.
3. Ask the numbered Phase 2 questions immediately in the same response.
4. Stop only to wait for the operator's answers. Do not present the cold start as complete.

If the verdict is GREEN, or the only remaining items are runtime-only uploads / explicitly accepted nice-to-have gaps:
1. Read **only** `brand-context.headline.json` (do not read the HTML).
2. Emit a Bottom Line: audit summary (`required_present`/`required_total`, `recommended_present`/`recommended_total`, stale count), true missing-context bucket count, runtime input count, and verdict.
3. Append a `file://` link to `brand-context.html` for the operator's review.
4. Stop.

The sidecar is auto-emitted by the renderer in Phase 3b; no manual `sidecar write` invocation needed. Sidecar lands at `~/.mixshift/clients/<brand-slug>/runs/account-cold-start/<data-date>/<run-id>.json`.

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

1. The operator reviews `brand-context.html` (link from the Bottom Line). Missing-context buckets show what still needs brand input; runtime-input cards show artifacts supplied manually when downstream skills run.
2. After approval, downstream skills can run: Daily Health Check → Runaway Spend Check → Keyword Bid Health → Monthly Performance Report → others.

---

## Emit Discoveries (`<date>.discoveries.json`)

After the primary deliverable is written, emit typed observations this run surfaced that may warrant context.yaml updates. Discoveries are PROPOSALS, not auto-applied edits. A separate review step promotes them into context.yaml.

Write to:
```
~/.mixshift/clients/<brand-slug>/runs/account-cold-start/<data-date>/<date>.discoveries.json
```

Schema source of truth: `shared/clients/_schema/discoveries.schema.yaml`.

**Categories this skill emits when applicable** (omit a category entirely if no items; do not emit empty arrays):

- `campaign_label_anomalies`
- `stockout_candidates` (mirrored from Phase 1.5 enrichment for context-promotion review)
- `brand_term_typo_candidates` (mirrored from Phase 1.5 enrichment)

If no discoveries surface this run, write a minimal file with `"discoveries": {}`. The presence of the file is itself the signal that the skill considered discoveries and emitted nothing.

---

*Version history: see [CHANGELOG.md](CHANGELOG.md). Current version: v2.5.1.*

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill account-cold-start
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill account-cold-start --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill account-cold-start --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
