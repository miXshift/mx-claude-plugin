---
name: mx-keyword-bid-health
description: >
  This skill should be used when the user asks to "run keyword bid review",
  "bid health", "weekly bid check", "bid optimization", or needs weekly
  keyword-level bid optimization review. Surfaces high-ACOS bid reduction
  candidates and scale opportunities with proven conversion volume.
metadata:
  version: "0.5.1"
  author: "MixShift"
trigger_phrases:
  - run keyword bid review
  - bid health
  - weekly bid check
  - bid optimization
  - check keyword bids
---

# Keyword Bid Health Review

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), resolve the bundled CLI by scanning for it once and reuse the path: `MIXSHIFT_CLI="$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)"`, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** Brand context comes exclusively from `context.yaml` and `narrative.md`.
- **Do NOT supplement with general Amazon or e-commerce knowledge** or industry benchmarks not present in the data.
- **Do NOT echo full data tables or raw query output** in your model response. The markdown summary tables (top 20 each bucket) are the deliverable; full row data lives in the prefetch `data.json`.
- **Begin output immediately.** Do not restate these instructions or ask clarifying questions.
- **All warehouse queries go through `mixshift prefetch`** — never inline SQL.

---

## Preflight — Risk Tier 3 (Required)

Run on whatever brand context exists; never fail closed on it. The ONLY hard requirement is that the brand has at least one account (`accounts[].seller_id` + `account_type`, from `mixshift brand add`). Thresholds and targets resolve from the calibration card (Step 1.5) or a labeled default — they never block a run.

```
PREFLIGHT — mx-keyword-bid-health — <brand> — <date>
[ ] Brand resolves with accounts[].seller_id + account_type
      (if absent → stop; ask the user to run `mixshift brand add`)
[ ] Calibration confirmed (Step 1.5): scale_threshold_pct, pullback_threshold_pct,
      acos_target each resolved from brand context, an OCL override, or a labeled
      default (derived from acos_target, else fixed fallback) — never blocks
[ ] objective_calibration present (if absent: note in Bottom Line — global thresholds used)
[ ] Prior-run sidecar loaded from ~/.mixshift/clients/<brand>/runs/mx-keyword-bid-health/
    (most recent <date>-<run-id>.json; if absent, continue and note "no week-over-week baseline yet")
[ ] No active escalation conditions:
      - verdict regresses GREEN→RED without structural_events explanation → surface before delivering
```

Stop only if the brand has no accounts. Missing brand-context fields are expected — use the documented default, label it, and continue; never halt.

---

## Overview

Run this skill to get a weekly keyword-level bid optimization analysis. Two exception-based checks plus a dormant-keyword listing:
1. **High ACOS Keywords** — T-30 chronic bleed candidates with excess spend
2. **Scale Opportunities** — T-30 efficient keywords with proven conversion volume
3. **Dormant Keywords** — had T-30 spend above the floor but went dark in T-7

Output tells you which keywords to cut, which to grow, and which to evaluate for pause.

---

## Execution Steps

### Step 1 — Load brand context

Read `~/.mixshift/clients/<brand-slug>/context.yaml` (or validate via `mixshift brand validate <brand-slug> --json`). Extract mechanically:
- `accounts[*].seller_id`, `accounts[*].account_type`
- `management.attribution_window_days`
- `posture.stance`, `posture.multiplier`
- `brand_terms` (canonical + variants, for brand vs nonbrand classification)
- `campaign_structure.naming_pattern`
- `structural_events[]` filtered to currently active

The bid thresholds (`scale_threshold_pct`, `pullback_threshold_pct`) and `acos_target` come from the calibration card in Step 1.5, not here.

Read `narrative.md` for prose context only.

**Brand context is optional — never fail closed on it.** Run on whatever context is present (the snapshot / `context.yaml`, with the Tier-2 Brand Brain as fallback: `mixshift brand brain status <brand-slug> --json`); the skill sharpens as context accrues but never requires full brand setup. The only hard requirement is `accounts[].seller_id` + `account_type` (from `mixshift brand add`) — if both are absent, stop and say so. When a brand-context field is missing, use the documented default and label it in output rather than stopping: `management.primary_metric` → assume ACoS ("assumed; tell me if it's TACoS"); `management.acos_target_pct` → observational (report ACoS as-is, don't flag vs target; "no ACoS target configured — set with `mixshift brand config <brand-slug>`"); **if `acos_target_pct` is present but `management.acos_target_source` is `default` (a bootstrap placeholder, not the brand's own number), treat it as unconfirmed — do not present it as the brand's target; either the user confirms it on the Step 1.5 card or you run observational and label the value "bootstrap default, not from your data"**; `posture.stance` → `scale`; the bid thresholds → resolved in Step 1.5 (your set value, else derived from `acos_target`, else a fixed fallback — labeled). Load the non-threshold fields in one call via `mixshift brand context resolve <brand-slug> --json` — each carries `{value, source, fetched_at}` (`source: context` = ✓ confirmed, `brain` = ⊙ pre-filled; `null` = use the default above).

### Step 1.5 — Confirm calibration

Get this run's knobs (and let the user sharpen them) via the confirm card:

```bash
mixshift skill config mx-keyword-bid-health --brand <brand-slug> --json
```

The `confirmation` payload's `effective_config` holds the values this run will use, as WHOLE-number percents (e.g. `45` = 45%): `scale_threshold_pct`, `pullback_threshold_pct` (bid math thresholds) and `acos_target` (reference ACoS — an optional override of the brand target). Each is seeded from brand context where set, else absent.

Show the user the card — it lists every field with its source, and on a brand's FIRST run it leads with a `capture_note` nudging the top unset fields. They can:
- **confirm / defer** → run on the shown values: `mixshift skill config mx-keyword-bid-health --brand <brand-slug> --apply '{"action":"confirm"}' --json`
- **edit** → e.g. `... --apply '{"action":"edit","edits":{"pullback_threshold_pct":"50"},"save":true}' --json`. A shared field (`acos_target`) is proposed for brand-wide promotion (recorded for review); the bid thresholds persist to this skill.

**Resolve the working thresholds (whole-number percents) from the returned `effective_config`:**
- `pullback_threshold_pct` — if present, use it; else `acos_target × 1.5`; else (no target) `45`. Label any default in the Bottom Line ("default — set to sharpen").
- `scale_threshold_pct` — if present, use it; else `acos_target × 0.7`; else `30`. Label any default.
- `acos_target` — if absent, run observational (report ACoS as-is, do not flag vs target) per Step 1. If it is present only via the bootstrap placeholder (`management.acos_target_source: default` in the context snapshot) and the user has not confirmed it on this card, treat it as absent for flagging purposes and say so — thresholds derived from an unconfirmed placeholder must be labeled, never presented as the brand's target.

Never block on this step — confirm-as-is is always available.

### Step 2 — Run prefetch

```bash
mixshift prefetch --brand <brand-slug> --skill mx-keyword-bid-health
```

Executes:
- **KBH-01** — T-30 keyword performance (spend, ad sales, ACOS, conversions, clicks, cpc_t30)
- **KBH-01a** — T-7 keyword performance (same columns, _t7 suffix)
- **KBH-02** — Current bid + Amazon bid guidance (SuggestedBid, BidRangeStart, BidRangeEnd) per enabled keyword
- **KBH-03** — Lifetime keyword performance

Artifacts:
- `~/.mixshift/clients/<brand-slug>/runs/mx-keyword-bid-health/<date>/data.json` — full machine-readable
- `~/.mixshift/clients/<brand-slug>/runs/mx-keyword-bid-health/<date>/data.md` — capped markdown summary

Read `data.md` for analysis. If any query failed (exit code 2), surface the failing IDs + friendly errors and stop.

### Step 3 — Classify keywords

For each keyword, join the four query outputs on `(KeywordText, MatchType, CampaignName, AdGroupName)` and classify. `MatchType` arrives lowercase from every KBH query (normalized with `LOWER()` at the SQL layer, because the two warehouse source tables disagree on letter case — an exact-case join across them matches zero rows). If you write any ad-hoc variant of these queries, apply the same normalization before joining.

**Excess Spend formula:**
```
excess_spend = spend_t30 - (adsales_t30 × acos_target / 100)   # acos_target from Step 1.5 (whole %)
if adsales_t30 == 0: excess_spend = spend_t30
```

**High ACOS bucket — bid CUT candidates:**
```
Flag if: spend_t30 ≥ p25(spend_t30)         (only material-spend keywords)
     AND acos_t30 > pullback_threshold_pct   (from Step 1.5)
```
Sort by `excess_spend DESC`. Top 20 to summary table.

**Scale Opportunity bucket — bid RAISE candidates:**
```
Flag if: acos_t30 < scale_threshold_pct   (from Step 1.5)
     AND conversions_t30 ≥ 3
     AND spend_t30 ≥ p25(spend_t30)
```
Sort by `adsales_t30 DESC`. Top 20 to summary table.

**Dormant bucket — pause/evaluate candidates:**
```
Flag if: spend_t7 == 0 (or null)
     AND spend_t30 > spend_floor (default $5)
```
Sort by `spend_t30 DESC`. Top 20 to summary table. **Routing rule: any keyword with spend_t7==0 goes here regardless of T-30 ACOS.**

### Step 4 — Compute recommended bids

**Rec Bid (High ACOS — cut):**
```
cut_ratio = clamp(excess_spend / spend_t30, 0, 1) × posture.multiplier
rec_bid   = current_bid × (1 - cut_ratio)
```

**Rec Bid (Scale — raise):**
```
rec_bid = current_bid × (1 + 0.20 × posture.multiplier)
```

**Headroom rule for nonbrand keywords at the bid range ceiling:**
```
if NOT brand_match(KeywordText, brand_terms):
    headroom_pct = (current_bid - cpc_t7) / current_bid
    if headroom_pct > 0.15:
        hold (do not raise — headroom is the constraint, not the bid)
```

Brand keywords ignore Amazon's suggested range as a floor/ceiling.

**Brand classification:** case-insensitive substring match of KeywordText against the canonical + variant strings in `brand_terms`.

### Step 5 — Apply structural events

For each flagged keyword, check `structural_events[]` for currently-active entries that overlap the keyword's campaign / item group:
- Active price test → annotate "(price test active)" on High-ACOS rows; do NOT suppress
- Recent bid change → annotate "(attribution settling)" on scale rows
- Active promotion → annotate on High-ACOS rows
- Stockout → annotate on Scale rows (conversions may be artificially low)

Annotations color the recommendation; they do not zero it out.

### Step 6 — Compose output

Three tables, each capped at top 20 by sort key. Show all columns; right-align numerics.

**Table 1 — High ACOS (bid cut candidates):**

| Keyword | Match | Campaign | Ad Group | Spend T-30 | Sales T-30 | ACOS T-30 | Conv T-30 | Current Bid | Rec Bid | Excess Spend | Note |

**Table 2 — Scale Opportunities (bid raise candidates):**

| Keyword | Match | Campaign | Ad Group | Spend T-30 | Sales T-30 | ACOS T-30 | Conv T-30 | Current Bid | Rec Bid | Headroom % | Note |

**Table 3 — Dormant Keywords:**

| Keyword | Match | Campaign | Ad Group | Spend T-30 | Spend T-7 | ACOS T-30 | Conv T-30 | Days Since Last Spend | Note |

### Step 7 — Compute verdict

```
total = pullback_count + scale_count
if keywords_reviewed < 5:           verdict = OBSERVATIONAL
elif pullback_count > total × 0.50: verdict = RED
elif pullback_count > scale_count:  verdict = YELLOW
else:                               verdict = GREEN
```

### Step 8 — Bottom Line

Three sentences:
1. **Bid cut totals** — "X keywords flagged for bid cuts. $Y in excess spend at risk."
2. **Scale opportunities** — "Z keywords with proven efficiency available for bid raises ($W ad sales)."
3. **Dormant counsel** — "K keywords went dark in T-7 with prior material spend — review for pause."

Add up to two sentences referencing:
- Week-over-week drift if prior-run sidecar exists (e.g., "Pullback count up from 12 last week to 18.")
- Active structural events that should temper interpretation
- Narrative.md cues (current quarter posture, etc.)

### Step 9 — Self-Review

- [ ] All three buckets surfaced (or explicitly noted empty)
- [ ] Excess Spend formula applied with the resolved acos_target (Step 1.5)
- [ ] Pullback / scale thresholds from the calibration card (Step 1.5); any derived/fallback default labeled
- [ ] Headroom rule applied to nonbrand scale candidates
- [ ] Brand keywords classified using brand_terms (not hardcoded brand strings)
- [ ] Structural events annotated, not used to suppress
- [ ] Dormant routing: spend_t7==0 with material T-30 spend
- [ ] No em dashes in output

### Step 10 — Emit Run Sidecar

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. Sidecars live at `~/.mixshift/clients/<brand-slug>/runs/mx-keyword-bid-health/<data-date>-<run-id>.json`.

Compose the input JSON (write to a temp file, then invoke the harness):

```jsonc
// /tmp/kbh-sidecar-input.json
{
  "skill": "mx-keyword-bid-health",
  "skill_version": "0.5.1",
  "brand_slug": "<brand-slug>",
  "run_kind": "per_account",
  "data_date": "YYYY-MM-DD",   // T-1 (yesterday) for daily-recency analyses
  "verdict": "GREEN|YELLOW|RED|OBSERVATIONAL",
  "context_snapshot": {
    "account_type": "SC|VC",
    "seller_id": 0,
    "primary_metric": "ACOS|TACOS",
    "acos_target_pct": 20,
    "attribution_window_days": 14,
    "posture_stance": "scale|efficiency|defend|clear_bleed",
    "posture_multiplier": 0,
    "bid_health_pullback_threshold_pct": 30,
    "bid_health_scale_threshold_pct": 15
  },
  "headline_metrics": {
    "keywords_reviewed": 0,
    "pullback_count": 0,
    "scale_count": 0,
    "dormant_count": 0,
    "total_excess_spend": 0,
    "scale_adsales_t30": 0,
    "dormant_spend_t30": 0
  },
  "sql_calls": [
    {"id": "KBH-01",  "params": {"seller_id": 0, "run_date": "YYYY-MM-DD", "lookback_days": 30}},
    {"id": "KBH-01a", "params": {"seller_id": 0, "run_date": "YYYY-MM-DD"}},
    {"id": "KBH-02",  "params": {"seller_id": 0}},
    {"id": "KBH-03",  "params": {"seller_id": 0}}
  ],
  "artifacts": {
    "report_html_path": "<path-to-rendered-output>"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/kbh-sidecar-input.json
```

**Verdict rule:** see Step 7.

Sidecars accumulate read-only for retrospective inspection. Compare the current file with the most recent prior run when drift context matters.

---

## Key Constraints

- **Prefetch is the only data path** — no inline SQL, no general Amazon knowledge supplements
- **Excess Spend uses brand's `acos_target_pct`** — not hardcoded
- **Pullback and scale thresholds from `bid_health`** — never hardcode percentiles
- **Brand keywords ignore Amazon range constraints**
- **Structural events annotate, never suppress**
- **Dormant routing is absolute** — spend_t7==0 with material T-30 spend always routes here regardless of T-30 ACOS
- **Top 20 per bucket in output** — full row data lives in `data.json`

## Output Format

1. Header (account, run date, posture, pullback/scale thresholds)
2. Table 1: High ACOS (bid cuts, top 20)
3. Table 2: Scale Opportunities (bid raises, top 20)
4. Table 3: Dormant Keywords (top 20)
5. Summary metrics + verdict
6. Bottom Line with structural-event and WoW drift context

## Live bid refresh (optional, requires Ads API access)

The bids and Amazon guidance in the KBH data pull are warehouse values and can
lag the live account. Before you finalize verdicts or build a change set, you
can optionally refresh both from the Ads API. This is a read step; nothing is
mutated. If the user has not asked for live data and the warehouse pull is
recent, the standard flow is fine.

1. Refresh CURRENT bids. Call `sp.list_keywords` with a filter body of the
   keyword ids you are reviewing:
   `mixshift ads call sp.list_keywords --legacy-seller-id <id> --body-file kw-filter.json --json`
   where `kw-filter.json` is `{ "keywordIdFilter": { "include": ["...", "..."] } }`.
   Use the live `bid` as the before-bid. Never apply a change against a stale
   warehouse before-bid: if the live bid differs from the KBH `current_bid`,
   flag that row and recompute its recommended bid off the live value.
2. Refresh SUGGESTED ranges. Call `sp.bid_recommendations` once per
   (campaignId, adGroupId) pair, one ad group per call: group the flagged rows
   by ad group first. Body:
   `{ "campaignId": "...", "adGroupId": "...", "recommendationType": "BIDS_FOR_EXISTING_AD_GROUP", "targetingExpressions": [ { "type": "KEYWORD_EXACT_MATCH", "value": "..." } ] }`
   with at most 100 expressions per call. These live ranges are fresher than
   the warehouse SuggestedBid and should replace it where present.
3. Failures degrade gracefully. On `ads_not_configured`, `throttled`, or any
   other error, skip the refresh for that batch, note that live values were
   unavailable, and fall back to the warehouse bids and guidance. A failed
   refresh never blocks the review.

For the general Ads API surface (exports, other recommendations, live state),
see mx-amazon-ads.

## Applying bid changes (optional, requires explicit user confirmation)

The verdict tables are recommendations. When the user asks to apply some or
all bid changes, use the audited Ads write surface instead of manual entry:

1. Build the change set from the rows the user selected. `sp.update_keywords`
   takes `{ "keywords": [ { "keywordId": "...", "bid": <new bid> } ] }`. Use
   each row's keyword id from the KBH data pull; if a row carries only
   campaign/ad-group/keyword text, resolve the id first via
   `mixshift ads call sp.list_keywords` with a filter body.
2. Dry-run it (the default; nothing reaches Amazon):
   `mixshift ads call sp.update_keywords --legacy-seller-id <id> --body-file changes.json --json`
3. Show the user the preview AND the `before_state` snapshot (current bids),
   then ask for explicit confirmation of this exact change set. Never skip
   this step, and never include bids that were not in the confirmed table.
4. Only after the user confirms — in a SEPARATE turn, having seen the dry-run — re-run the SAME command with `--commit`. The user's original request (even a specific one) is NOT commit authorization: it authorizes the dry-run, not the mutation; never run the dry-run and the `--commit` in the same turn.
   Report per-item success/error counts and the `audit_id`.

Hard rules: never pass `--commit` without the user's confirmation of this
specific change set; cap change sets at 200 items per call (split larger
sets); on `insufficient_scope` the credential cannot write, so hand the user
the change list for manual application instead.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-keyword-bid-health
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-keyword-bid-health --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-keyword-bid-health --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
