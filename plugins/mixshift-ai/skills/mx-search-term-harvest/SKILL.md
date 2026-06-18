---
name: mx-search-term-harvest
description: "Identify search terms and ASIN targets converting efficiently under auto or broad match that are not yet in explicit keyword targeting. Promotes high-performing auto terms to explicit campaigns. Pure harvest logic — no negation, no relevance judgment."
---

# ST Harvest Extraction

## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** Brand context comes exclusively from `context.yaml` and `narrative.md`.
- **Do NOT supplement with general Amazon or e-commerce knowledge**, industry benchmarks, or assumed platform dynamics not present in the data.
- **Do NOT echo full data tables or raw query output** in your model response. The harvest output is the deliverable.
- **Begin output immediately.** Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.

---

## Preflight — Risk Tier 3 (Required)

Run on whatever brand context exists; never fail closed on it. The ONLY hard requirement is that the brand has at least one account (`accounts[].seller_id` + `account_type`, from `mixshift brand add`). The ACoS ceiling resolves from the calibration card (Step 1.5) or runs observational — it never blocks a run. The upstream ST data-pull artifact is a genuine data dependency and IS a hard gate.

```
PREFLIGHT — mx-search-term-harvest — <brand> — <date>
[ ] Brand resolves with accounts[].seller_id + account_type
      (if absent → stop; ask the user to run `mixshift brand add`)
[ ] Calibration confirmed (Step 1.5): acos_target resolved from brand context,
      an OCL override, or run observational — never blocks
[ ] Upstream mx-search-term-data-pull artifact present
    *** HARD GATE: if absent, STOP. Cannot run harvest without ST corpus. ***
[ ] STH-01 prefetch artifact present: ~/.mixshift/clients/<brand>/runs/mx-search-term-harvest/<date>/data.json
    (if absent: run `mixshift prefetch --brand <brand> --skill mx-search-term-harvest` — see Step 1)
[ ] Prior-run sidecar loaded from ~/.mixshift/clients/<brand>/runs/mx-search-term-harvest/ (most recent)
    (if absent: continue — no baseline yet)
[ ] Confirm no harvest candidate is in negation.lane_rules mismatch list before promoting
```

Stop only if the brand has no accounts or the upstream ST data-pull artifact is absent. Missing brand-context fields are expected — use the documented default, label it, and continue; never halt.

---

The auto campaigns are your market research engine. When a search term is converting efficiently there, you're leaving money on the table by not targeting it explicitly.

This skill finds those terms and recommends promotion to explicit targeting.

---

## Core Principle

The original monolithic negation skill buried harvest as an afterthought. Harvest is the primary signal. A converting term discovered in auto/broad at 0.9% ACOS is a far higher-value finding than a non-converting term to negate. The negation action saves wasted spend. The harvest action grows revenue.

---

## Execution

**Step 0 — Load inputs:**
- Data artifact: ST data pull output (JSON)
- **Tier-3 brand context** at `~/.mixshift/clients/<brand-slug>/context.yaml`. Extract mechanically:
  - `accounts[].seller_id`
  - `sub_brands[]` and `campaign_structure.naming_pattern`, `campaign_structure.account_codes`, `campaign_structure.objectives` — drive item-group taxonomy mapping and placement campaign naming
  - `brand_terms` — for brand-adjacent term routing (BRAND vs RSCH-NONBRAND placement)
  - `negation.lane_rules` — confirm harvest candidates are not in a `mismatch` list before promoting (schema-validated by `mixshift brand validate <brand-slug>`)
  - `paused_campaigns` — exclude from harvest recommendations and starting-bid CPC math
  - `posture.stance` — informs starting-bid conservatism
- `~/.mixshift/clients/<brand-slug>/narrative.md` — prose interpretation only (account norms for "unusual bid" sanity check). Do not extract numbers from this file.

ASIN harvest cross-references manual conquest lists in `~/.mixshift/clients/<brand-slug>/corpora/*.csv` when available.

**Brand context is optional — never fail closed on it.** Run on whatever context is present (the snapshot / `context.yaml`, Tier-2 Brand Brain as fallback); harvest sharpens as context accrues but never requires cold-start. The only hard requirement is `accounts[].seller_id` + `account_type` (from `mixshift brand add`) — plus the upstream ST data-pull artifact (a data dependency, gated below). The ACoS ceiling (`acos_target`) comes from the calibration card in Step 1.5, not here; when it is absent, run observational (surface harvest candidates by absolute efficiency, do not bar vs a target). When `campaign_structure.*` item-group taxonomy is missing, omit the "Recommended Campaign" placement and say so. Do not infer ACOS target or taxonomy from prose — label them missing instead. Load the structured brand-context fields (taxonomy, brand_terms, lane_rules) in one call via `mixshift brand context resolve <brand-slug> --json` — each carries `{value, source, fetched_at}` (`source: context` = ✓ confirmed, `brain` = ⊙ pre-filled; `null` = use the default).

**Paused campaign rule (mandatory):** A ST converting in a paused campaign is valid signal for the corpus and lifetime data — include it. But never recommend promoting a ST to explicit targeting inside a paused campaign. Do not credit a paused campaign's CPC data for starting bid calculations. Filter paused campaign rows from harvest recommendations.

**Granularity slices from the artifact:**
- `lifetime_keyword_aggregate` — confirm account-wide conversion before promoting
- `lifetime_keyword_by_item_group` — determine which item group the ST is performing in
- `lifetime_keyword_by_location` — identify which specific ad group is capturing the converting traffic
- `stream1_keyword` — window location data for CPC calculation

**Step 1.5 — Confirm calibration**

Get this run's knob (and let the user sharpen it) via the confirm card:

```bash
mixshift skill config mx-search-term-harvest --brand <brand-slug> --json
```

The `confirmation` payload's `effective_config` holds the value this run will use, as a WHOLE-number percent (e.g. `22` = 22%): `acos_target` — the ACoS ceiling a converting term must beat to be a harvest candidate; if absent, run observational (surface efficient converters on ACoS as-is, do not bar vs a target). It is seeded from brand context where set, else absent.

Show the user the card — it lists the field with its source, and on a brand's FIRST run it leads with a `capture_note` nudging the top unset fields. They can:
- **confirm / defer** → run on the shown value: `mixshift skill config mx-search-term-harvest --brand <brand-slug> --apply '{"action":"confirm"}' --json`
- **edit** → e.g. `... --apply '{"action":"edit","edits":{"acos_target":"22"},"save":true}' --json`. `acos_target` is a shared field — it persists to brand context for every skill.

**Resolve the working ACoS ceiling (whole-number percent) from the returned `effective_config`:**
- `acos_target` — if present, use it; if absent, run observational (surface efficient converters on ACoS as-is, do not bar vs a target).

Never block on this step — confirm-as-is is always available.

**Step 1 — Run prefetch:**

```bash
mixshift prefetch --brand <brand-slug> --skill mx-search-term-harvest
```

This executes **STH-01** (explicit keyword inventory — the mask used to filter out already-targeted terms). Read the resulting `data.md` (or `data.json` for full rows) at:

```
~/.mixshift/clients/<brand-slug>/runs/mx-search-term-harvest/<date>/data.md
```

Build: `explicit_keywords = {row.KeywordText.lower() for row in STH-01.rows}`

The lifetime/window search-term corpus itself comes from the upstream `mx-search-term-data-pull` artifact at `~/.mixshift/clients/<brand-slug>/runs/mx-search-term-data-pull/<latest-date>/data.json`. If absent, run that skill first.

---

## Phase 1 — Tier S Classification (Keyword Stream)

From the data artifact Stream 1, classify as Tier S (`acos_target` is the Step-1.5 resolved value, whole %; if absent, run observational — surface efficient converters on ACoS as-is, do not apply the `acos_target`-gated tiers below):

```
lifetime_orders >= min_keep_orders
AND lifetime_acos <= acos_target * 0.75          # acos_target from Step 1.5 (whole %)
AND SearchTerm.lower() NOT IN explicit_keywords
```

The `acos_target * 0.75` threshold identifies terms performing well below the account target — these are the highest-priority extraction candidates. They have proven efficiency and unexploited scale potential.

**Secondary Tier S (converting but not exceptional):**
```
lifetime_orders >= min_keep_orders
AND lifetime_acos <= acos_target                 # acos_target from Step 1.5 (whole %)
AND SearchTerm.lower() NOT IN explicit_keywords
```

Label these as `harvest_tier: primary` vs `harvest_tier: secondary` in output.

---

## Phase 2 — ASIN Harvest Classification

From the data artifact Stream 2, classify ASIN targets as harvest candidates (`acos_target` is the Step-1.5 resolved value, whole %; if absent, run observational — surface efficient converters on ACoS as-is, do not apply the `acos_target` gate):

```
lifetime_orders >= min_keep_orders
AND lifetime_acos <= acos_target                 # acos_target from Step 1.5 (whole %)
AND bare_asin NOT IN manual_targets (from data artifact)
```

These are competitor ASINs or adjacent ASINs that are converting on conquest placement in auto campaigns — not yet explicitly targeted.

---

## Phase 3 — Campaign Placement Recommendation

For each harvest candidate, recommend the specific campaign and match type to add it to:

**Keyword stream placement logic:**
- Non-brand term, proven conversion → `RSCH-NONBRAND-EXACT-[ItemGroup]` (exact match)
- If no exact campaign exists for the item group → `RSCH-NONBRAND-PHRASE-[ItemGroup]`
- Brand-adjacent term (check brand term dictionary) → `BRAND-[ItemGroup]`
- Determine item group from campaign name where ST was discovered (use item group taxonomy from brand context)

**ASIN stream placement logic:**
- ASIN is a competitor product → `CONQ-NONBRAND-ASIN-[ItemGroup]`
- ASIN is an adjacent product (same buyer, different category) → `PROF-[ItemGroup]` or new conquest ad group
- If campaign structure unclear → flag as "placement TBD — needs AM review"

---

## Phase 4 — Bid Recommendation

For each harvest candidate, surface the observed CPC from window data as a bid starting point:

```
observed_cpc = window_spend / window_clicks (if window_clicks > 0)
recommended_starting_bid = observed_cpc * 1.1  (10% above observed to ensure delivery)
```

Flag if `recommended_starting_bid` would be unusual given account norms (from brand context).
Do not recommend bids outside the account's typical range without flagging.

---

## Output Structure

### Section 1: Keyword Harvest Candidates

Sorted by lifetime conversion count DESC (most proven performers first), then by ACOS ASC.

Columns:
```
Search Term | Harvest Tier | Lifetime Spend | Lifetime Orders | Lifetime ACOS |
vs ACOS Target | Current Capture (Campaign/Ad Group) | Recommended Campaign |
Recommended Match Type | Suggested Starting Bid
```

### Section 2: ASIN Harvest Candidates

Sorted by lifetime conversion count DESC.

Columns:
```
ASIN | Product Title (from data artifact or TBD) | Lifetime Spend | Lifetime Orders |
Lifetime ACOS | Already in Manual? | Recommended Campaign | Placement Rationale
```

### Footer

```
Keyword harvest candidates: [N] primary | [N] secondary
ASIN harvest candidates: [N]
Note: [N] terms are already in explicit targeting — excluded
```

---

## Brand Context Feedback Loop

Every harvest candidate that is confirmed by the account manager and added to explicit targeting should be added to the brand context file's `known_converting_adjacencies` list. This prevents future relevance check runs from mis-classifying them as BORDERLINE.

After AM approves extractions, flag the following for brand context update:
- Any ST not already in `known_converting_adjacencies` that is being promoted
- Any ASIN not already in `known_competitor_asins` that is being targeted

---

## Delivery

Append to negation report (Section 4) or deliver as standalone output if run independently.
Write to runs archive with timestamp: `YYYY-MM-DD-harvest.json`

---

## Step: Emit Run Sidecar (canonical, drift-detection input)

After delivery (harvest output written to runs archive as `YYYY-MM-DD-harvest.json`), write a structured JSON sidecar capturing this run's inputs and headline outputs. Sidecars live at `~/.mixshift/clients/<brand-slug>/runs/mx-search-term-harvest/<data-date>-<run-id>.json`. Schema source of truth: `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`.

Use the **window end date** of the upstream mx-search-term-data-pull artifact for `data_date`, not the run wall-clock date.

Compose the input JSON (write to a temp file, then invoke the harness):

```jsonc
// /tmp/sth-sidecar-input.json
{
  "skill": "mx-search-term-harvest",
  "skill_version": "1.1.0",
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
    "brand_terms_count": 0,
    "lane_rules_present": true,
    "paused_campaigns_count": 0
  },
  "headline_metrics": {
    "harvest_candidates_count": 0,
    "auto_to_phrase_count": 0,
    "auto_to_exact_count": 0,
    "expected_keep_acos": 0,
    "keywords_already_explicit_excluded": 0
  },
  "sql_calls": [
    {"id": "STH-01", "params": {"seller_id": 0, "window_start": "YYYY-MM-DD", "window_end": "YYYY-MM-DD", "acos_target_pct": 20}},
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
mixshift sidecar write --input-file /tmp/sth-sidecar-input.json
```

**Verdict rule:** `GREEN` = balanced harvest mix (candidates split between auto-to-phrase and auto-to-exact; conversion-rich auto traffic is being captured). `YELLOW` = many candidates already explicit (corpus saturation — auto campaigns are doing their discovery job but explicit campaigns may be over-built; reduce harvest cadence). `RED` = zero candidates (auto campaigns are not running or not generating measurable conversion volume — escalate to campaign structure review). `OBSERVATIONAL` = window too short or first run after cold-start; no historical band yet.

`mixshift sidecar compare` will surface drift against the prior run once implemented; until then, sidecars accumulate read-only for retrospective inspection.

---

*Skill version: 1.1.0 — focused harvest extraction*
*Ported from upstream with full domain logic preserved*

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-search-term-harvest
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-search-term-harvest --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-search-term-harvest --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
