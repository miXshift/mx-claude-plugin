---
name: ppc-relevance-check
version: 1.0.0
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
Read `shared/clients/<brand-slug>/context.yaml` (validated against `shared/clients/_schema/context.schema.yaml`) and extract mechanically:

- `accounts[].seller_id`
- `sub_brands[]` — product descriptions, item groups, custom brand labels per sub-brand
- `brand_terms` — canonical + variant brand tokens (drives brand vs nonbrand classification)
- `negation.protected_terms` — anchors that should bias toward RELEVANT
- `negation.lane_rules` — per-lane `relevant` (known converting adjacencies) and `mismatch` (known irrelevant themes) dictionaries
- `negation.asin_negation.pre_check_lifetime_orders_threshold` — for ASIN relevance phase

Also read `shared/clients/<brand-slug>/narrative.md` for prose positioning, borderline-theme judgment, and competitive context. Do not extract numbers from this file.

ASIN corpora used for the ASIN relevance phase live at `shared/clients/<brand-slug>/corpora/*.csv`.

**Fail closed:** if `context.yaml` is absent or fails schema validation, stop and direct user to run the `account-cold-start` skill. Do not infer lane rules or brand terms from prose.

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

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. This is the input to `scripts/compare-sidecars.py`, which surfaces cross-run drift (config edits to `negation.lane_rules` or `negation.protected_terms`, classification-mix shift, verdict regression). Sidecars live at `<plugin>/runs/<brand-slug>/ppc-relevance-check/<data-date>-<run-id>.json`.

Schema source of truth: `<plugin>/shared/run-sidecar.schema.yaml`.

```bash
python3 <plugin>/scripts/write-sidecar.py \
  --skill ppc-relevance-check \
  --skill-version 1.0.0 \
  --brand-slug [brand-slug] \
  --data-date YYYY-MM-DD \
  --metrics-json /tmp/prc-headline.json \
  --context-snapshot-json /tmp/prc-context-snapshot.json \
  --sql-calls-json /tmp/prc-sql-calls.json \
  --verdict GREEN|YELLOW|RED|OBSERVATIONAL \
  --report-html /tmp/[brand]-reports/ppc-relevance-check.html
```

Use the **window end date** of the upstream search-term batch being classified for `--data-date`, not the run wall-clock date.

**Required JSON inputs:**

- **`metrics-json`** — emit numeric values only (no `$`, no `%`):
  ```json
  {"terms_classified": 142, "relevant_count": 88,
   "irrelevant_count": 31, "ambiguous_count": 23,
   "protected_terms_held_back": 4}
  ```

- **`context-snapshot-json`** — record only the `context.yaml` fields you actually consumed in this run:
  ```json
  {"account_type": "VC", "seller_id": "113",
   "primary_metric": "ACOS", "acos_target_pct": 20,
   "attribution_window_days": 14,
   "lane_rules_present": true,
   "protected_terms_count": 12,
   "brand_terms_count": 8}
  ```

- **`sql-calls-json`** — ppc-relevance-check is a pure consumer; it operates on a provided list (typically the Tier B/C set from upstream `search-term-negation` Phase 1) and runs no SQL. Record the consumption as a structured `UPSTREAM:<skill-name>` pseudo-call so the comparator can chain drift detection across skills.
  ```json
  [{"id": "UPSTREAM:search-term-negation",
    "params": {"sidecar_path": "runs/[brand-slug]/search-term-negation/<latest>.json",
               "consumed_metrics": ["tier_b_count", "tier_c_count"],
               "input_term_count": 142, "tier_filter": "B,C"}}]
  ```

**Verdict rule:** `GREEN` = clean classification (most terms land in RELEVANT or IRRELEVANT, ambiguous share is small). `YELLOW` = >30% of terms classified AMBIGUOUS (lane rules underspecified for this corpus — calibration candidates require AM review). `RED` = `lane_rules` conflict detected (a term matches both `relevant` and `mismatch` lanes for the same item group, indicating a context.yaml integrity issue). `OBSERVATIONAL` = brand-context lane_rules incomplete; classification advisory only.

After writing, run the comparator to surface drift against the prior run:

```bash
python3 <plugin>/scripts/compare-sidecars.py --brand-slug [brand-slug] --skill ppc-relevance-check
```

Exit 0 = no drift. Exit 1 = drift detected (lane_rules edit, classification-mix shift, verdict regression). Surface drift findings in the next run's report header, not silently.

