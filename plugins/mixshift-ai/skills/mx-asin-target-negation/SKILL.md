---
name: mx-asin-target-negation
version: 1.8.1
description: >
  Phase 2 negation review for ASIN targets matched through auto campaigns, category targeting,
  and other Product Attribute Targeting paths. Pulls ASIN-triggered rows for a configurable
  window, suppresses ASINs already under manual targeting, evaluates PDP/form-factor overlap,
  joins lifetime performance by location (campaign + ad group), and separates clean negate
  candidates from review/watch buckets.
  Triggers on: 'run asin negation review', 'asin target negations', 'pdp overlap review',
               'phase 2 negations', 'asin exact negations'.
author: Claude
last_updated: 2026-04-08
dependencies:
  - MySQL database (keywordtargetingmetric, targetexpressionsmetric, keywordtargeting)
  - brand context file (required)
  - browser (for PDP inspection)
sample_input: "Run ASIN target negation review for example brand, 2026-03-27 through 2026-03-29"
sample_output: |
  ## ASIN Target Negation Review — example brand (2026-03-27 through 2026-03-29)
  Bottom line: 6 PDPs surfaced as irrelevant never-converted ASIN targets, 4 relevant-looking
  but persistent losers surfaced for review, and 9 ASINs were suppressed because they are
  already manually targeted.
  Delivery: an HTML report with sections All ASIN Targets, Irrelevant Never Converted,
  Relevant-Looking Persistent Losers, Protected Manual Targets, Watchlist.
standalone: true
handoff_optional: true
changelog:
  - version: 1.8.1
    change: "Names, not IDs: ANEG-01 now returns CampaignName as MAX(CampaignName) (a display column, grain unchanged at target/campaign) so the report's Campaign column shows the name, not the numeric CampaignID. CampaignName is denormalized + rename-variable, so it is aggregated, NOT added to GROUP BY (that would split a target's LifetimeOrders across name snapshots and defeat the negation gate). The report renders ASIN targets as `PDP Title (ASIN)` and points to `mixshift data asin-titles` for any missing titles; the raw ASIN stays visible for the apply step."
  - version: 1.8.0
    change: "Added a live conflict check to the Applying ASIN negations flow: before the dry run, read existing negative targets via sp.list_negative_targets and sp.list_campaign_negative_targets (campaignIdFilter bodies), match the ASIN inside each clause's expression array per location, drop duplicates, and report the skipped count with the preview. Frontmatter version realigned with the manifest (prior 1.5.0 was stale against manifest 1.7.0)."
  - version: 1.5.0
    change: "CRITICAL data fix: Phase 3 lifetime join now queries BOTH keywordtargetingmetric AND targetexpressionsmetric and UNIONs before aggregating. Manual asinSameAs/asinCategorySameAs CONQ/PROF targets only record performance in targetexpressionsmetric. Reference case: $9.78/0 orders in keywordtargetingmetric vs $21.73/2 orders in targetexpressionsmetric."
  - version: 1.4.0
    change: "Training corpus architecture established by item group. Corpus Layer 1 = manual conquest ASIN lists by item group. Corpus Layer 2 = auto-ASIN lifetime converters. Brand setup Phase 1 includes both corpus pulls. Updated heuristics: removed erroneous irrelevant calls for link/cuff/leather/paracord/cord bracelet PDPs. Added item-group context rule."
  - version: 1.3.0
    change: "Irrelevance rule correction: Irrelevant = buyer is categorically unreachable, NOT style/form-factor mismatch alone. Bracelet-adjacent form factors (link, cuff, leather braided, paracord, charm) are NOT irrelevant. LT spend with zero conversions = insufficient data, not negation signal."
  - version: 1.2.0
    change: "Corrected Phase 3 lifetime join to location granularity (campaign+adgroup). Clarified relevance-first workflow. Added selective location-specific negate routing."
  - version: 1.1.0
    change: "Added pre-run prerequisites. PDP review step is now mandatory. Added item-group mismatch context."
  - version: 1.0.0
    change: "Initial skill. Architecture: manual-target suppression first, PDP overlap second, lifetime performance third."
---

# ASIN Target Negation Review

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), resolve the bundled CLI by scanning for it once and reuse the path: `MIXSHIFT_CLI="$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)"`, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


This skill answers one question: for ASIN targets entered through automatic, category, substitute, complement, or related Product Attribute Targeting paths, which ASINs should be negated exact now, and which should instead be reviewed or watched?

This is Phase 2 because the judgment problem is different from exact search-term negation. Search terms are language-intent review. ASIN targets are PDP overlap review: product class, form factor, buyer intent, and competitive adjacency.

---

## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** Brand context comes exclusively from the context snapshot (or `context.yaml` fallback) and `narrative.md`.
- **Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.
- **Do NOT supplement with general Amazon or e-commerce knowledge**, industry benchmarks, or assumed platform dynamics not present in the data.
- **Do NOT echo full data tables or raw query output** in your model response. The HTML report is the deliverable.
- **Begin output immediately.** Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.

---

## Preflight — Risk Tier 3 (Required)

Run on whatever brand context exists; never fail closed on it. The ONLY hard requirement is that the brand has at least one account (`accounts[].seller_id` + `account_type`, from `mixshift brand add`). The negate-eligibility floor and ACoS target resolve from the calibration card (Step 0d) or a labeled default — they never block a run.

```
PREFLIGHT — mx-asin-target-negation — <brand> — <date>
[ ] Brand resolves with accounts[].seller_id + account_type
      (if absent → stop; ask the user to run `mixshift brand add`)
[ ] Calibration confirmed (Step 0d): pre_check_lifetime_orders, acos_target each
      resolved from brand context, an OCL override, or a labeled default — never blocks
[ ] negation.lane_rules / negation.protected_terms loaded from brand context
      (if absent: note and continue — structured negation context still read via the resolver)
[ ] corpora/conq_asins.csv present at ~/.mixshift/clients/<brand>/corpora/
    (if absent: surface warning — Layer 1 suppression mask unavailable; continue with Layer 2 only)
[ ] Data artifact present: ~/.mixshift/clients/<brand>/runs/mx-asin-target-negation/<date>/data.md (or data.json)
    (if absent: run pre-fetch-data.py — see Step 1)
[ ] Prior-run sidecar loaded: ~/.mixshift/clients/<brand>/runs/mx-asin-target-negation/<latest>.json
    (if absent: continue — no baseline yet)
[ ] No active escalation conditions:
      - verdict regresses GREEN→RED without structural_events explanation → surface before delivering
```

Stop only if the brand has no accounts. Missing brand-context fields are expected — use the documented default, label it, and continue; never halt.

---

## Execution Prerequisites

**Step 0a — Read this SKILL.md.** Already done.

**Step 0b — Load brand context (from pre-fetched snapshot):** Read `~/.mixshift/clients/<brand-slug>/context.yaml (direct read, OR run `mixshift brand validate <brand-slug> --json` for a parsed JSON view)` — compact context snapshot pre-extracted by the pre-fetch script. Extract: `seller_id`, `account_type`, `negation.lane_rules`, `negation.protected_terms`, `sub_brands`, `campaign_structure.naming_pattern`, `attribution_window_days`, `posture.stance`, `structural_events`. If absent, fall back to reading `~/.mixshift/clients/<brand-slug>/context.yaml` directly. The lifetime-orders pre-check floor (`pre_check_lifetime_orders`) and `acos_target` come from the calibration card in Step 0d, not here.

Read **`~/.mixshift/clients/<brand-slug>/runs/mx-asin-target-negation/ (pick the most recent `<date>-<run-id>.json` sidecar)`** — prior run sidecar (~65 lines). If present, use for drift context. If absent, skip.

Also read `~/.mixshift/clients/<brand-slug>/narrative.md` for prose interpretation only (PAT route guidance, lane judgment notes). Do not extract numbers from this file.

If the skill consumes manual conquest ASIN lists, read `~/.mixshift/clients/<brand-slug>/corpora/*.csv`.

**Brand context is optional — never fail closed on it.** Run on whatever context is present (snapshot / `context.yaml`, Tier-2 Brand Brain as fallback); the review sharpens as context accrues but never requires full brand setup. The only hard requirement is `accounts[].seller_id` + `account_type` (from `mixshift brand add`). When `negation.lane_rules` / `protected_terms` are missing, default + label rather than stopping; the conquest corpus (`corpora/conq_asins.csv`) already degrades with a warning. The negate-eligibility floor and ACoS target resolve in Step 0d (your set value, else a labeled default) — they never block. Negations are dry-run by default and require explicit confirm before `--commit` — that write gate is the safety net. Do not infer fields from prose. Load the brand-context fields in one call via `mixshift brand context resolve <brand-slug> --json` — each carries `{value, source, fetched_at}` (`source: context` = ✓ confirmed, `brain` = ⊙ pre-filled; `null` = use the default).

**Step 0c — Confirm PDP review is in scope.** This phase requires actual PDP overlap assessment. Do not defer PDP review to the human. Inspect the PDP (title, form factor, category, price) and classify overlap before routing to a bucket.

### Step 0d — Confirm calibration

Get this run's knobs (and let the user sharpen them) via the confirm card:

```bash
mixshift skill config mx-asin-target-negation --brand <brand-slug> --json
```

The show command above returns `confirmation.fields[]`, one entry per manifest field (find yours by `field.id`). Its `effective_value` is the calibration layer's internal [0,1] fraction, useful only for the confirm card display, not the shape this skill consumes. After the user confirms or edits below, resolve the working values from `effective_config` in that `--apply` response instead: percent fields come back denormalized to whole numbers there (e.g. `22` = 22%), matching every formula in this skill. `pre_check_lifetime_orders` is an integer count (the minimum lifetime orders at a location before an ASIN target is eligible to negate), unaffected by the percent bridge; `acos_target` (an optional override of the brand target) resolves to a whole-number percent. Each is seeded from brand context where set, else absent.

Show the user the card — it lists every field with its source, and on a brand's FIRST run it leads with a `capture_note` nudging the top unset fields. They can:
- **confirm / defer** → run on the shown values: `mixshift skill config mx-asin-target-negation --brand <brand-slug> --apply '{"action":"confirm"}' --json`
- **edit** → e.g. `... --apply '{"action":"edit","edits":{"pre_check_lifetime_orders":"40"},"save":true}' --json`. A shared field (`acos_target`) is proposed for brand-wide promotion (recorded for review); the pre-check floor persists to this skill.

**Resolve the working values from `effective_config` (the `--apply` response):**
- `pre_check_lifetime_orders`: the minimum lifetime orders at a location before an ASIN target is eligible to negate; defaults to 25 when unset.
- `acos_target`: a whole-number percent. If absent, run observational (report ACoS as-is, do not flag vs target).

Never block on this step — confirm-as-is is always available.

---

## Scope

### Included
- Product Attribute Targeting rows only (`recordType = 'Product Attribute Targeting'`)
- Auto / category / substitute / complement / related ASIN-triggered traffic
- Window-level ASIN target review
- Lifetime performance by target ASIN
- PDP/form-factor overlap assessment

### Explicitly Excluded
- Keyword-targeted search terms
- Phrase negative logic
- Keyword harvest logic
- Manual ASIN targeting optimization (those ASINs are suppressed here)

---

## Core Design Rule

The order matters:
1. Suppress ASINs already manually targeted
2. Evaluate PDP overlap / relevance — this is the primary judgment gate
3. For ASINs that pass relevance (Close / Adjacent / Weak): join lifetime performance by location (campaign + ad group), not account-wide aggregate
4. Route to clean negate, review, or watch buckets

**Location-granularity rule:**
Lifetime performance must be broken down by campaign + ad group, not collapsed to an account-wide aggregate per ASIN. An ASIN may convert in one item-group lane but bleed in another. The negate decision is location-specific: negate only at the exact campaign/ad group where lifetime conversions are zero, even if the same ASIN converts elsewhere in the account.

Do not let poor performance override a clear manual-target suppression. Do not let a plausible-looking PDP hide chronic bad lifetime economics.

---

## Step 1: Load Pre-Fetched Data

**Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.

Read the data artifact — **prefer the `.md` file** (pre-formatted markdown tables, no parsing overhead):
```
~/.mixshift/clients/<brand-slug>/runs/mx-asin-target-negation/<run_date>/data.md
```
Fallback to `.data.json` only if the `.md` file is absent.

This file contains pre-executed results for all queries, keyed by query ID:
- `ANEG-01` — Corpus Layer 2: auto-campaign ASIN lifetime converters (`keywordtargetingmetric` WHERE `recordType = 'Product Attribute Targeting'` AND `lifetime_conversions >= 1`): `KeywordText (ASIN), lifetime_spend, lifetime_orders`
- `ANEG-02` — Window pull (PAT rows only): `SearchTerm, KeywordText, CampaignName, AdGroupName, MatchType, window_spend, window_sales, window_orders, window_clicks` for the review window
- `ANEG-03` — Manual ASIN targets (suppression mask): `KeywordText (ASIN)` of currently enabled manual targets from `keywordtargeting`
- `ANEG-04` — Lifetime performance by location (UNION of `keywordtargetingmetric` + `targetexpressionsmetric`): `SearchTerm/KeywordText (ASIN), CampaignName, AdGroupName, lifetime_spend, lifetime_sales, lifetime_orders, lifetime_clicks, lifetime_acos`

All queries share the join key: `(SellerID, normalized_asin_target, CampaignName, AdGroupName)`.

**If the artifact is missing:** Run prefetch now — do not stop and ask the user:
```bash
mixshift prefetch --brand <brand-slug> --skill mx-asin-target-negation --date <YYYY-MM-DD>
```
Use brand-slug derived from the brand context path and today's date as run_date. Wait for completion, then read the artifact and continue.

### Step 1a: Join Pre-Fetched Query Results

Join pre-fetched query results on the shared key to produce one unified record per ASIN target per location. ANEG-02 forms the base window pull; ANEG-03 provides the suppression mask; ANEG-04 provides lifetime performance by location; ANEG-01 provides the Corpus Layer 2 positive examples pre-check.

---

## Phase 0 — Window Pull (PAT rows only)

From `ANEG-02` pre-fetched results.

**Normalize target ASIN:**
The canonical target identifier is the actual ASIN target, not raw SearchTerm text.

Normalization rules:
- If SearchTerm is a valid ASIN, use it
- Else extract the ASIN from KeywordText where possible
- Else mark row as unresolved_target and route to QA/watchlist

---

## Phase 1 — Manual Target Suppression

From `ANEG-03` pre-fetched results (currently enabled manual ASIN targets from keywordtargeting).

For any normalized ASIN in the window set:
- if that ASIN is already manually targeted, route to Protected Manual Targets
- do not recommend negation in this phase

---

## Phase 2 — PDP Overlap Review

For each remaining ASIN, inspect the PDP.

Minimum context to gather:
- title
- primary image / form factor
- bullet summary
- price band if available
- rating/review count if available

Question: Is this PDP close enough in product form factor, buyer intent, and merchandising lane that the brand should reasonably compete or appear here?

### PDP overlap classes
- **Close**: clearly same lane / strong competitive adjacency
- **Adjacent**: similar enough that presence could make sense
- **Weak**: plausible on the surface but not a strong overlap
- **Irrelevant**: wrong form factor, wrong product class, wrong buyer intent

**Universal evaluation rule:**
Irrelevance test is BUYER REACHABILITY, not form factor match. Irrelevant = the buyer of this product is categorically unreachable by the brand. Wrong gender, wrong product category entirely (socks, patches, alt-health devices), confirmed identity mismatch, or bulk/wholesale product. Form factor mismatch alone is NOT irrelevance when the buyer is in the men's bracelet purchase space.

For brands like example brand: bracelet-adjacent form factors (link bracelets, cuff bracelets, leather braided, paracord, charm bracelets, Catholic cross cuffs) are NOT irrelevant. The brand competes on buyer intent across these form factors.

**Hard Irrelevant (safe to negate):**
- watch bands / straps
- necklaces / earrings / rings (unless bracelet-adjacent)
- urn / memorial jewelry
- kids novelty items where brand clearly should not compete
- clearly female-coded fashion jewelry outside brand lane
- unrelated accessories: socks, patches, alt-health wristbands, cologne
- bulk/wholesale fundraiser packs (50-pack silicone wristbands, etc.)
- confirmed identity mismatch
- alt-health pseudoscience wristbands (EMF, magnetic therapy)

**NOT Irrelevant by default:**
- bracelet-adjacent form factors (link, cuff, leather braided, paracord, charm bracelet)
- religious bracelet adjacency to brand Cross item group
- military/patriotic bracelet adjacency to brand Spartan item group
- waterproof/rugged outdoor bracelet adjacency to brand core values
- any ASIN that appears in brand's validated manual targeting corpus

**Special rule: LT data sufficiency**
If LT spend is low ($3-12) with zero conversions: classify as insufficient data (hold), not Irrelevant.

---

## Phase 3 — Lifetime Performance Join (by location)

**Only run for ASINs that passed Phase 2 relevance as Close / Adjacent / Weak.**
ASINs classified as Irrelevant skip directly to routing.

**CRITICAL — TWO TABLE REQUIREMENT:**
ASIN lifetime performance lives across two tables. Query BOTH and UNION before aggregating:

| Table | Coverage |
|---|---|
| `keywordtargetingmetric` | SP keyword-triggered auto/DISC PAT rows |
| `targetexpressionsmetric` | SP manual asinSameAs/asinCategorySameAs PAT + SD targeting expression rows |

Manual CONQ/PROF asinSameAs targets record performance in targetexpressionsmetric only.

**Level 1 — By Location (primary negate decision slice):**

From `ANEG-04` pre-fetched results (UNION of `keywordtargetingmetric` + `targetexpressionsmetric`, aggregated by location).

**Level 2 — Account-wide aggregate (context only):**
Use for context only — do NOT use account-wide aggregate alone to drive negate vs. keep decisions.

**Rule:** If an ASIN converts in Campaign A but not in Campaign B, negate only in Campaign B.

---

## Phase 4 — Routing Logic

### 1. Protected Manual Targets
ASIN is already manually targeted. Suppress from negation review.

### 2. Irrelevant Never Converted
Use when:
- PDP overlap = Irrelevant
- lifetime_orders at this location = 0

Clean exact-negate bucket.

### 3. Relevant-Looking, Location-Specific Negate Candidate
Use when:
- PDP overlap = Close, Adjacent, or Weak
- lifetime performance at this location shows zero or near-zero conversions
- same ASIN may convert at other locations (doesn't protect this location)

Action: negate exact at this specific campaign/ad group only.

### 4. Relevant-Looking Persistent Losers
Use when:
- PDP overlap = Close, Adjacent, or Weak
- lifetime performance at location is poor
- account-wide lifetime also shows weak or absent conversions

Surface for manager review. Key value-add over human-only PDP review.

### 5. Watchlist / Mixed Signal
Use when:
- PDP overlap = Irrelevant but has conversion history elsewhere
- overlap is Weak / ambiguous with mixed data
- target normalization unresolved

### 6. Hold
No action.

---

## Output tabs

1. **All ASIN Targets**
2. **Irrelevant Never Converted**
3. **Relevant-Looking Persistent Losers**
4. **Protected Manual Targets**
5. **Watchlist**

Recommended columns:
- Campaign
- Ad Group
- Match Type
- Keyword / Target Expression
- Target ASIN
- PDP Title
- PDP Overlap Class
- Window Spend / Sales / Orders / Clicks / ACOS
- Lifetime Spend / Sales / Orders / Clicks / ACOS
- Recommendation
- Reason

**Names, not IDs.** The Campaign column must show `CampaignName` (ANEG-01
returns it) — never the bare numeric `CampaignID`. Show the Target ASIN as
`PDP Title (ASIN)` so a reader can tell what the ASIN is without looking it up;
the PDP Title already comes from the Phase 2 PDP inspection, and for any ASIN
you still lack a title for, resolve it with
`mixshift data asin-titles --seller-id <N> --asins <list> --json` (falls back to
mx-amazon-retail `catalog.search_items` for ASINs not in the catalog). Keep the
raw ASIN visible — the apply step negates by ASIN, so the id must stay in the row.

---

## Recommendation Rule

Only Irrelevant Never Converted should be treated as a clean exact-negation recommendation set.

Relevant-Looking Persistent Losers are surfaced because they are easy for humans to miss, but they should remain a review bucket, not an automatic negate bucket.

---

## Training Corpus Architecture (for ASIN pre-checks)

The manual targeting list IS the positive training set. Before Phase 2 PDP review, use two corpus layers to calibrate judgment:

### Corpus Layer 1 — Validated Competitor Universe
- The ASINs a brand has added to manual CONQ/PROF campaigns represent PDPs where conversion confidence exists
- Stored by item group
- If a new auto-targeted ASIN resembles something in this corpus, default to Close/Adjacent, not Irrelevant
- Item group segmentation is critical

### Corpus Layer 2 — Auto-Campaign Positive Examples
- ASINs that have generated 1+ conversion through auto campaigns (lifetime) = proven positive examples
- Pull from keywordtargetingmetric WHERE recordType = 'Product Attribute Targeting' AND lifetime AttributedConversions14day >= 1
- Use as pre-Phase 2 check: if ASIN is on this list, hold, not negate

---

## Self-Review Checklist

- [ ] Every account in config produced a verdict
- [ ] Manual target suppression completed before PDP review
- [ ] PDP assessment performed (not deferred)
- [ ] Both keywordtargetingmetric AND targetexpressionsmetric queried
- [ ] Location-granular lifetime performance used (not account-wide aggregate)
- [ ] Item-group context applied where relevant
- [ ] Clean negate candidates vs. review candidates clearly separated
- [ ] Pre-check lifetime-orders floor and acos_target taken from the calibration card (Step 0d); any default labeled
- [ ] No em dashes in output

---

## Step: Emit Run Sidecar (canonical, drift-detection input)

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. Sidecars live at `~/.mixshift/clients/<brand-slug>/runs/mx-asin-target-negation/<data-date>-<run-id>.json`. Schema source of truth: `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`.

Use the **window end date** (last day of the analysis window) for `data_date`, not the run wall-clock date.

Compose the input JSON (write to a temp file, then invoke the harness):

```jsonc
// /tmp/aneg-sidecar-input.json
{
  "skill": "mx-asin-target-negation",
  "skill_version": "1.8.1",
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
    "asin_negation_lifetime_orders_threshold": 3,
    "posture_stance": "scale"
  },
  "headline_metrics": {
    "negate_recommended_count": 0,
    "keep_count": 0,
    "total_spend_reviewed": 0,
    "total_orders_reviewed": 0,
    "expected_monthly_savings": 0
  },
  "sql_calls": [
    {"id": "ANEG-01", "params": {"seller_id": 0, "window_start": "YYYY-MM-DD", "window_end": "YYYY-MM-DD"}},
    {"id": "ANEG-02", "params": {"seller_id": 0, "window_start": "YYYY-MM-DD", "window_end": "YYYY-MM-DD"}},
    {"id": "ANEG-03", "params": {"seller_id": 0}},
    {"id": "ANEG-04", "params": {"seller_id": 0}}
  ],
  "artifacts": {
    "report_html_path": "<path-to-rendered-output>"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/aneg-sidecar-input.json
```

**Verdict rule:** `GREEN` = ≤5 negation recommendations (routine cleanup). `YELLOW` = 5–25 negations (worth a review pass, may signal a category-targeting drift). `RED` = >25 negations (signal of broader targeting problem upstream — escalate to relevance check or campaign structure review before applying). `OBSERVATIONAL` = window too short or insufficient lifetime data; recommendations held back.

Sidecars accumulate read-only for retrospective inspection. Compare the current file with the most recent prior run when drift context matters.


## Applying ASIN negations (optional, requires explicit user confirmation)

The negate/review/watch buckets are recommendations. When the user asks to
apply the clean-negate bucket, use the audited Ads write surface:

1. Build the change set from the approved ASINs at their matched locations.
   Ad-group level: `sp.create_negative_targets` with
   `{ "negativeTargetingClauses": [ { "campaignId": "...", "adGroupId": "...",
   "state": "ENABLED", "expression": [ { "type": "ASIN_SAME_AS",
   "value": "B0..." } ] } ] }`. Campaign level:
   `sp.create_campaign_negative_targets`. Use the Amazon ids from the pulled
   rows; resolve missing ids via `mixshift ads call sp.list_campaigns` /
   `sp.list_ad_groups`.
2. Live conflict check (do this before the dry run). Read the negative targets
   that already exist in the live account and drop any approved ASIN that is
   already negated at the same location, so the dry run only carries genuinely
   new negative targets:
   - Ad-group negative targets: `mixshift ads call sp.list_negative_targets --legacy-seller-id <id> --body-file camp-filter.json --json`
   - Campaign negative targets: `mixshift ads call sp.list_campaign_negative_targets --legacy-seller-id <id> --body-file camp-filter.json --json`
   where `camp-filter.json` is `{ "campaignIdFilter": { "include": ["...", "..."] } }`
   for the campaigns in your set. The ASIN lives inside each clause's
   `expression` array as `{ "type": "ASIN_SAME_AS", "value": "B0..." }`: match
   on that value per location (campaign for campaign-level, campaign plus ad
   group for ad-group level) and treat an existing enabled clause for the same
   ASIN at the same location as a duplicate. Report the skipped-as-already-
   negated count alongside the preview. If the list calls fail
   (`ads_not_configured`, `throttled`, or any error), note that the live
   conflict check was skipped and proceed.
3. Dry-run it (the default; nothing reaches Amazon):
   `mixshift ads call sp.create_negative_targets --legacy-seller-id <id> --body-file negations.json --json`
4. Show the user the preview and ask for explicit confirmation of this exact
   set. Only the clean-negate bucket is eligible; review/watch ASINs never go
   in a change set without their own explicit user decision.
5. Only after the user confirms — in a SEPARATE turn, having seen the dry-run — re-run the SAME command with `--commit`. The user's original request (even a specific one) is NOT commit authorization: it authorizes the dry-run, not the mutation; never run the dry-run and the `--commit` in the same turn.
   Report per-item success/error counts and the `audit_id`.

Hard rules: never pass `--commit` without the user's confirmation of this
specific change set; cap change sets at 200 items per call; on
`insufficient_scope` hand the user the negation list for manual application.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-asin-target-negation
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-asin-target-negation --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-asin-target-negation --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
