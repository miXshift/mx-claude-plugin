---
name: mx-ppc-relevance-check
version: 1.1.0
description: >
  Semantic relevance classification for search terms and ASIN targets. Operates on
  a provided list of search terms or the Tier B/C set from phase 1 exact-term negation.
  Separate from threshold logic — a term can be low-spend AND relevant (don't negate)
  or high-spend AND irrelevant (negate for different reason). Requires brand-specific
  training and account manager calibration on edge cases. Output is a verdict table with
  confidence scores and reasoning. No action recommendations — this skill classifies,
  it does not decide.
  Triggers on: 'run relevance check', 'check relevance', 'ppc relevance', 'semantic relevance check'.
author: Claude
last_updated: 2026-04-08
dependencies:
  - brand context file (required)
  - MySQL database
  - browser (for ASIN product page lookup)
sample_input: "Run relevance check on these 15 search terms for example brand"
sample_output: |
  ## Relevance Check — example brand — 15 terms
  RELEVANT: 6 | BORDERLINE: 4 | IRRELEVANT: 5
standalone: true
---

# PPC Relevance Check

Classification only. This skill answers one question: does this search term describe a customer
with meaningful purchase intent for this brand's products? It does not recommend negation.

This skill requires the most brand-specific training of any in the negation family.
A relevance verdict for a bracelet brand is meaningless without knowing: what materials
does the brand use? What adjacent categories do they compete in? What are the brand terms?
What terms look irrelevant but actually convert? The brand context file is mandatory input.

---

## ⚠ Judgment Integrity

Relevance is a semantic judgment, not a data judgment. Data informs it but does not determine it:
- "Paracord" appears low-converting in some windows but the brand ranks #1 in paracord affiliate content.
  Data verdict: possibly negate. Relevance verdict: RELEVANT. These are different questions.
- "Gold necklace" has never converted for the brand. Data says negate. Relevance says: wrong category entirely.
  IRRELEVANT is the correct classification AND the data agrees — but for different reasons.

When data and relevance diverge, flag both signals explicitly. The downstream decision-maker
needs to know which force is driving the recommendation.

---

## Execution

**Step 0 — Load Tier-3 brand context (mandatory):**
Read `~/.mixshift/clients/<brand-slug>/context.yaml` (schema-validated by `mixshift brand validate <brand-slug>`) and extract mechanically:

- `accounts[].seller_id`
- `sub_brands[]` — product descriptions, item groups, custom brand labels per sub-brand
- `brand_terms` — canonical + variant brand tokens (drives brand vs nonbrand classification)
- `negation.protected_terms` — anchors that should bias toward RELEVANT
- `negation.lane_rules` — per-lane `relevant` (known converting adjacencies) and `mismatch` (known irrelevant themes) dictionaries
- `negation.asin_negation.pre_check_lifetime_orders_threshold` — for ASIN relevance phase

Also read `~/.mixshift/clients/<brand-slug>/narrative.md` for prose positioning, borderline-theme judgment, and competitive context. Do not extract numbers from this file.

ASIN corpora used for the ASIN relevance phase live at `~/.mixshift/clients/<brand-slug>/corpora/*.csv`.

**Brand context is optional — never fail closed on it.** Run on whatever context is present (the snapshot / `context.yaml`, with the Tier-2 Brand Brain as fallback); the classifier sharpens as context accrues but never requires full brand setup. The only hard requirement is `accounts[].seller_id` + `account_type` (from `mixshift brand add`). When `negation.lane_rules` / `brand_terms` are absent, classify on the data + the brand-name signal alone and label the run "uncalibrated — set lane rules / brand terms with `mixshift brand config <brand-slug>` to sharpen"; do not invent lane rules from prose. Relevance verdicts are recommendations only — no write path — so an uncalibrated run is safe to surface for review. Load the brand-context fields in one call via `mixshift brand context resolve <brand-slug> --json` — each carries `{value, source, fetched_at}` (`source: context` = ✓ confirmed, `brain` = ⊙ pre-filled; `null` = use the default).

**Step 1 — Classify each term:**

For each search term in the input list, construct a context payload and evaluate:

```
Brand: [brand name + product description]
Product positioning: [brand context excerpt]
Known converting adjacencies: [list]
Known irrelevant categories: [list]
Borderline themes: [list]
Search term: [SearchTerm]
Campaign context: [CampaignName + AdGroupName if available]
```

**Verdict options:**
- `RELEVANT`: customer intent plausibly maps to this brand's products
- `BORDERLINE`: ambiguous — could convert in some contexts, not others; requires per-instance data check or AM judgment
- `IRRELEVANT`: customer intent clearly does not map to this brand's products

**Confidence:**
- `HIGH`: classification is unambiguous given brand context
- `MEDIUM`: classification is likely correct but has a caveat (e.g., campaign-context dependent)
- `LOW`: genuine uncertainty — needs manager calibration

**Reasoning (required for every verdict):**
One sentence. Anchors to brand context or product positioning. Never just restates the verdict.

---

## Phase 2 — ASIN Relevance Check (if ASIN stream provided)

For each ASIN target in Tier B/C, fetch the product page using standard ASIN lookup.

Extract: title, first 3 bullets, AI sentiment summary, review tab labels, price tier.

Evaluate product-customer overlap:

**Signals for RELEVANT (keep/harvest):**
- Review tabs: waterproof, durability, adjustability, sporty, outdoor, wristband
- Category: men's bracelets, outdoor accessories, athletic jewelry
- Price tier: $15–$60 (typical ASP range)

**Signals for IRRELEVANT (negate):**
- Review tabs: clasp quality, gemstone, chain style, precious metal
- Category: fine jewelry, fashion jewelry, gold/silver chains
- Price tier: >$100 or <$8

**Harvest signal:**
```
ASIN is converting at good efficiency AND not in manual targets
→ Flag as harvest candidate for follow-up ASIN expansion work
```

---

## Output

### Verdict Table

Columns:
```
Search Term | Campaign | Ad Group | Verdict | Confidence | Reasoning | Data Note
```

`Data Note` column: if lifetime data is available from the database, include:
`[X orders, $Y lifetime spend, Z% ACOS]` — so the reader can see data + classification together.

### Calibration Candidates

After the table, list terms where:
- verdict = BORDERLINE and any lifetime conversions exist
- verdict = IRRELEVANT but lifetime data shows conversions

These are candidates to add to `known_converting_adjacencies` in the brand context file.
Write them only after the account manager validates. Surface the candidates here; manager approves the updates.

### ASIN Verdict Table (if ASIN stream included)

```
ASIN | Product Title | Verdict | Confidence | Reasoning | Harvest Flag
```

---

## Manager Calibration Protocol

This skill improves through feedback. After each run:
1. Surface any verdicts the account manager overrides (negated a RELEVANT term, or kept a BORDERLINE term)
2. Document the override reason
3. Candidate update to brand context file

The relevance model is not static. Amazon search patterns shift, brand positioning evolves,
new adjacencies emerge. The calibration loop is how this skill gets sharper over time.

---

## Delivery

Output delivered inline (not HTML report). Designed for direct account manager review.
Calibration candidates written to brand context file after manager approval.

---

## Tier 2 Behavioral Rules (universal — brand-specific rules live in Tier 3)

**All brand-specific relevance rules are stored in the brand context file under:**
`## PPC Negation Skills — Brand Rules > Search Term Relevance Rules`

Load and apply that section before running any relevance classification. Do not hardcode
brand-specific product lines, validated adjacencies, or known irrelevant categories here.
This skill applies the classification framework; the brand file supplies the facts.

**Universal classification principles (apply to all accounts):**
- A term is RELEVANT if customer intent plausibly maps to the brand's product universe
- A term is BORDERLINE if context-dependent (campaign, item group, or data-dependent)
- A term is IRRELEVANT if customer intent clearly does not map regardless of context
- Lifetime conversion data overrides classification when conflict exists — a converting term
  is never IRRELEVANT regardless of semantic classification
- Product lines not in the brand context file = UNKNOWN, not IRRELEVANT — surface as
  calibration candidate for manager review

---

## Self-Review Checklist

- [ ] Brand context loaded and all four field sets extracted before first verdict
- [ ] Every verdict has a non-trivial one-sentence reasoning (not just "this is irrelevant")
- [ ] Edge cases handled per brand rules — BORDERLINE defaults applied correctly
- [ ] Calibration candidates section present
- [ ] No negate/keep recommendations — output is classification only
- [ ] No em dashes in output

---

## Step: Emit Run Sidecar (canonical, drift-detection input)

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. Sidecars live at `~/.mixshift/clients/<brand-slug>/runs/mx-ppc-relevance-check/<data-date>-<run-id>.json`. Schema source of truth: `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`.

Compose the input JSON (write to a temp file, then invoke the harness):

```jsonc
// /tmp/prc-sidecar-input.json — use the upstream search-term window end date for data_date
{
  "skill": "mx-ppc-relevance-check",
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
    "lane_rules_present": true,
    "protected_terms_count": 0,
    "brand_terms_count": 0
  },
  "headline_metrics": {
    "terms_classified": 0,
    "relevant_count": 0,
    "irrelevant_count": 0,
    "ambiguous_count": 0,
    "protected_terms_held_back": 0
  },
  "sql_calls": [
    {"id": "UPSTREAM:mx-search-term-negation",
     "params": {"sidecar_path": "runs/<brand-slug>/mx-search-term-negation/<latest>.json",
                "input_term_count": 0, "tier_filter": "B,C"}}
  ],
  "artifacts": {
    "report_html_path": "<path-to-rendered-output>"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/prc-sidecar-input.json
```

**Verdict rule:** `GREEN` = clean classification (most terms land in RELEVANT or IRRELEVANT, ambiguous share is small). `YELLOW` = >30% of terms classified AMBIGUOUS (lane rules underspecified — calibration candidates require AM review). `RED` = `lane_rules` conflict detected (a term matches both `relevant` and `mismatch` lanes for the same item group, indicating a context.yaml integrity issue). `OBSERVATIONAL` = brand-context lane_rules incomplete; classification advisory only.

`mixshift sidecar compare` will surface drift against the prior run once implemented; until then, sidecars accumulate read-only for retrospective inspection.


## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-ppc-relevance-check
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-ppc-relevance-check --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-ppc-relevance-check --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
