---
name: keyword-bid-health
description: >
  This skill should be used when the user asks to "run keyword bid review",
  "bid health", "weekly bid check", "bid optimization", or needs weekly
  keyword-level bid optimization review. Surfaces high-ACOS bid reduction
  candidates and scale opportunities with proven conversion volume.
metadata:
  version: "0.2.0"
  author: "MixShift"
  ported-from: "upstream/keyword-bid-health-review"
---

# Keyword Bid Health Review

## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** Brand context comes exclusively from the context snapshot (or `context.yaml` fallback) and `narrative.md`.
- **Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.
- **Do NOT read `.data.md` or `.data.json` directly.** The renderer (Step 2) consumes the data artifact. The model reads only `headline.json`.
- **Do NOT supplement with general Amazon or e-commerce knowledge**, industry benchmarks, or assumed platform dynamics not present in the data.
- **Do NOT call Write or Edit tools. Do NOT echo HTML or CSV content.** The renderer is the single writer of all artifacts.
- **Begin output immediately.** Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.

---

## Preflight — Risk Tier 3 (Required)

Complete this checklist before Step 0. Stop and surface the failure if any item cannot be checked off.

```
PREFLIGHT — keyword-bid-health — <brand> — <date>
[ ] Context snapshot loaded: tmp/<brand>-keyword-bid-health-<date>.context.md
    (fallback: shared/clients/<brand>/context.yaml — extract required fields manually)
[ ] Required fields present and non-null:
      accounts[*].seller_id, accounts[*].account_type
      management.acos_target_pct, management.attribution_window_days
      bid_health.scale_threshold_pct, bid_health.pullback_threshold_pct, bid_health.re_entry_rule
      posture.stance, posture.multiplier
      brand_terms, campaign_structure.naming_pattern
[ ] objective_calibration present (if absent: note in Bottom Line — health-check will use global thresholds)
[ ] Pre-fetch artifact present: tmp/<brand>-keyword-bid-health-<date>.data.json
    (if absent: run pre-fetch-data.py — see Step 1)
[ ] Prior-run sidecar loaded: tmp/<brand>-keyword-bid-health-prior-run.json
    (if absent: continue — no week-over-week baseline yet; note in Bottom Line)
[ ] No active escalation conditions:
      - verdict regresses GREEN→RED without structural_events explanation → surface before delivering
```

---

## Overview

Run this skill to get a weekly keyword-level bid optimization analysis. Two exception-based checks plus a dormant-keyword listing:
1. **High ACOS Keywords** — T-30 chronic bleed candidates with excess spend
2. **Scale Opportunities** — T-30 efficient keywords with proven conversion volume
3. **Dormant Keywords** — had T-30 spend above the floor but went dark in T-7

Output tells you which keywords to cut, which to grow, and which to evaluate for pause.

**Render and write are handled by `scripts/render-keyword-bid-health.py`.** The model's job is to run the renderer, read the compact `headline.json` it produces, and deliver a short Bottom Line plus a `file://` link. The model does not read the `.data.md` artifact, does not call Write/Edit, and does not touch the HTML or CSV files.

## Prerequisites

1. **Tier-3 brand context directory** at `shared/clients/<brand-slug>/`:
   - `context.yaml` — mechanical truth (validated against `shared/clients/_schema/context.schema.yaml`)
   - `narrative.md` — interpretive prose (do not extract numbers from this file)
   - `corpora/` — ASIN lists if needed
2. **Access to MySQL database** for keyword-level metrics (keywordtargetingmetric table)
3. **Pre-fetch artifact present** at `tmp/<brand-slug>-keyword-bid-health-<run_date>.data.json`. If absent, run `pre-fetch-data.py` first (Step 1 below).

**Fail closed:** if `context.yaml` is absent or fails schema validation, stop and direct user to run the `account-cold-start` skill. Do not infer fields from prose.

## Execution Steps

### Step 0: Bootstrap (Parallel Reads)

Fire simultaneously — read ONLY these sources:
1. This SKILL.md
2. **`plugins/mixshift-ai/tmp/<brand-slug>-keyword-bid-health-<run_date>.context.md`** — compact context snapshot. Confirms `seller_id`, `account_type`, `acos_target_pct`, `posture.stance`, `posture.multiplier`, and the bid-health thresholds are present. The renderer reads `context.yaml` directly for the full set of fields it needs (including `brand_terms` and `structural_events`); the snapshot is for the model's situational awareness only.
3. **`plugins/mixshift-ai/tmp/<brand-slug>-keyword-bid-health-prior-run.json`** — prior run sidecar (~65 lines). If present, use for week-over-week drift framing. If absent, skip — no baseline yet.
4. `shared/clients/<brand-slug>/narrative.md` — prose context only (interpretation rules, per-skill guidance). Used to color the Bottom Line.

Emit a one-line bootstrap summary before continuing: `Bootstrap OK — seller_id [X], posture [stance] × [multiplier], pullback [value]%, scale [value]%`

### Step 1: Ensure Pre-Fetch Artifact Exists

**Do NOT read SQL library files. Do NOT execute queries.** Verify the pre-fetch artifact:

```
plugins/mixshift-ai/tmp/<brand-slug>-keyword-bid-health-<run_date>.data.json
```

If it is missing, run the pre-fetch script and wait for it to complete:
```bash
python3 plugins/mixshift-ai/scripts/pre-fetch-data.py \
  --skill keyword-bid-health --brand <brand-slug> --date <YYYY-MM-DD>
```

The script prints "Ready. Run the skill now." when it finishes. **Do not read the resulting `.data.md` or `.data.json` files** — the renderer in Step 2 consumes them directly.

### Step 2: Render Report (Deterministic)

Run the renderer:
```bash
python3 plugins/mixshift-ai/scripts/render-keyword-bid-health.py \
  --brand <brand-slug> --date <YYYY-MM-DD>
```

The renderer reads `data.json` + `context.yaml` + `report-template.html`, classifies keywords (high ACOS / scale / dormant), computes Excess Spend and Rec Bid per row, populates the HTML, writes three full-untruncated CSVs, emits a compact `headline.json`, and writes the run sidecar. Top-20 cap per rendered HTML table; CSVs are unbounded.

Exit codes:
- `0` — success, all artifacts written
- `1` — input missing or malformed (stop and surface to user)
- `2` — self-validation failed (stop and surface to user)
- `3` — unexpected exception

If the renderer exits non-zero, surface the stderr to the user and stop. Do not attempt to render manually.

### Step 3: Read the Headline

Read the compact headline (~500 tokens):
```
plugins/mixshift-ai/tmp/<brand-slug>-keyword-bid-health-<run_date>.headline.json
```

It contains: `verdict`, `verdict_reason`, `counts` (keywords_reviewed, high_acos, scale, dormant), `totals` (excess spend, T-30 ad sales, dormant T-30 spend), `draft_bottom_line`, `drift_vs_prior`, `structural_events_active`, and the artifact paths.

Optionally also read:
- `tmp/<brand-slug>-keyword-bid-health-prior-run.json` — prior sidecar for richer week-over-week framing
- `shared/clients/<brand-slug>/narrative.md` — interpretive cues to weave into the Bottom Line

### Step 4: Deliver

Emit the Bottom Line and the report link in a single response. Output budget: **~1K tokens of prose**. Format:

1. Echo the `draft_bottom_line` from `headline.json` (verbatim or lightly tightened — keep the dollar figures and counts as written).
2. Optionally append **up to two sentences** that:
   - Reference week-over-week drift if `drift_vs_prior` is non-null and meaningful.
   - Ground the verdict in narrative-md context (e.g., "Aligns with the Q2 efficiency posture in narrative.md.").
   - Note any active structural events listed in `structural_events_active` that should temper interpretation.
3. Surface the report link using the absolute path from `artifacts.report_html_path`:
   ```
   Report: file:///<absolute-path-to-html>
   ```

**Hard rules for this step:**
- Do **NOT** call the Write or Edit tool.
- Do **NOT** read `.data.md` or `.data.json` artifacts.
- Do **NOT** echo HTML or CSV content inline.
- Do **NOT** restate the data in tables — the HTML is the deliverable.
- The renderer is the single writer of all artifacts. Your output is prose + a link.

## Key Constraints

- **Pre-fetch is the only data path** — do not run SQL or supplement with general Amazon knowledge.
- **Renderer is the only writer** — model output is bounded to Bottom Line + link, regardless of keyword count.
- **Annotate-only structural events** — the renderer appends short markers (e.g., "price test active") to rationale cells when an active `structural_events` entry overlaps a keyword's classification. It never suppresses or zeros out a recommendation. Confirm with account context before applying any cut on an annotated row.
- **Sidecar drift is not blocking** — `compare-sidecars.py` runs inside the renderer; any drift is captured in `headline.drift_vs_prior` and surfaced in your Bottom Line, never in a hard stop.

## Renderer Reference (informational)

The renderer's logic ports the previous in-skill computation byte-for-byte:

- **Excess Spend:** `spend_t30 − (adsales_t30 × acos_target_pct/100)`; if `adsales_t30 == 0`, excess = full `spend_t30`.
- **High ACOS filter:** `spend_t30 ≥ p25` (from `data.json.post_processing.p25_spend_t30`) AND `acos_t30 > pullback_threshold_pct`. Sort by Excess Spend DESC.
- **Scale filter:** `acos_t30 < scale_threshold_pct` AND `conversions_t30 ≥ 3` AND `spend_t30 ≥ p25`. Sort by `adsales_t30` DESC.
- **Dormant routing:** any row with `spend_t7 == 0` (or null) routes to the Dormant table regardless of T-30 ACOS.
- **Rec Bid (high ACOS):** `(excess_spend / spend_t30) × current_bid × posture.multiplier`, clamped to [0, 1] cut ratio.
- **Rec Bid (scale):** `current_bid × (1 + 0.20 × posture.multiplier)`. Headroom rule for nonbrand at ceiling: if `(current_bid − cpc_t7) / current_bid > 0.15` → hold; else increase. Never renders downward in the scale table.
- **Brand classification:** case-insensitive substring match of the keyword text against the canonical+variant strings in `context.yaml.brand_terms`. Brand keywords ignore Amazon range as a floor/ceiling.
- **Verdict:** `OBSERVATIONAL` if `keywords_reviewed < 5`; `RED` if pullback > 50% of (pullback + scale); `YELLOW` if pullback > scale; else `GREEN`.
- **VCPM:** filtered out at the SQL layer (`KBH-01.sql` line 30: `AND ktm.costType IN ('cpc', '')`). VCPM keywords never reach the skill.

If you need to adjust any of the above, edit `scripts/render-keyword-bid-health.py` — do not patch the model's behavior in this SKILL.md.
