---
name: mx-runaway-spend-check
description: >
  This skill should be used when the user asks to "run runaway spend check",
  "check for runaway keywords", "identify overspending keywords", or needs
  daily keyword-level acute runaway spend detection. Flags keywords where T-1 spend
  spiked materially or where high-spend keywords generated zero conversions against
  their historical performance.
metadata:
  version: "0.3.0"
  author: "MixShift"
trigger_phrases:
  - run runaway spend check
  - check for runaway keywords
  - identify overspending keywords
  - runaway spend
  - did anything spike yesterday
---

# Runaway Spend Check

## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** Brand context comes exclusively from `context.yaml` and `narrative.md`.
- **Do NOT supplement with general Amazon or e-commerce knowledge** or industry benchmarks not present in the data.
- **Do NOT echo full data tables or raw query output** in your model response. The markdown report is the deliverable.
- **Begin output immediately.** Do not restate these instructions or ask clarifying questions.
- **All warehouse queries go through `mixshift prefetch`**, never inline SQL via the mx-data-explore skill. Prefetch is what produces the audited artifacts and sidecar inputs.

---

## Preflight — Risk Tier 3 (Required)

Complete this checklist before Step 1. Stop and surface the failure if any item cannot be checked off.

```
PREFLIGHT — mx-runaway-spend-check — <brand> — <date>
[ ] Brand context loaded from ~/.mixshift/clients/<brand>/context.yaml
[ ] Required fields present and non-null:
      accounts[*].seller_id, accounts[*].account_type
      management.acos_target_pct, management.attribution_window_days
      posture.stance, posture.multiplier
      bid_health.pullback_threshold_pct
      structural_events (list — may be empty)
      paused_campaigns (list — may be empty)
[ ] anomaly_detection_settings row exists for SellerID (DHC-04 returns ≥1 row)
    *** HARD GATE: if absent, STOP. Cannot compute CI without thresholds. ***
[ ] Data freshness ≤ 2 days for keywordtargetingmetric
    *** HARD GATE: if data older than 2 days, STOP and surface to user. ***
[ ] Prior-run sidecar loaded from ~/.mixshift/clients/<brand>/runs/mx-runaway-spend-check/
    (if absent: continue — no baseline yet; note in output header)
```

If any HARD GATE fails, surface the failure clearly and stop. Do not proceed with a partial run.

---

## Overview

Detects acute keyword spend anomalies in real time. Two exception-based checks:
1. **T-1 Spend or ACOS CI Breach** — spend spiked materially relative to T-30 baseline
2. **Zero T-1 Conversions with Material Spend** — keyword with significant T-30 history generated zero conversions today

This is the second step in the keyword bid management workflow (after daily health check, before keyword bid health review).

---

## Execution Steps

### Step 1 — Load brand context

Read the brand context directly from disk:

- Open `~/.mixshift/clients/<brand-slug>/context.yaml` (YAML — parse mechanically, never interpret prose)
- Open `~/.mixshift/clients/<brand-slug>/narrative.md` only for prose interpretation; **do not extract numbers from it**

If you want a schema-validated round-trip first, run:

```bash
mixshift brand validate <brand-slug> --json
```

Extract mechanically (do NOT infer from narrative prose):
- `accounts[*].seller_id`, `accounts[*].account_type`
- `management.acos_target_pct`, `management.attribution_window_days`
- `posture.stance`, `posture.multiplier`
- `bid_health.pullback_threshold_pct`
- `structural_events[]` filtered to currently active
- `attribution_rule` — per-campaign-type window
- `paused_campaigns` — exclude flagged keywords inside these

**Brand context is optional — never fail closed on it.** Run on whatever context is present (the snapshot / `context.yaml`, with the Tier-2 Brand Brain as fallback: `mixshift brand brain status <brand-slug> --json`); the check sharpens as context accrues but never requires cold-start. The only hard requirement is `accounts[].seller_id` + `account_type` (from `mixshift brand add`) — if both are absent, stop and say so. When a brand-context field is missing, use the documented default and label it rather than stopping: `management.acos_target_pct` → observational (flag absolute spend spikes only, not vs-target); `posture.stance` → `scale`; `bid_health.pullback_threshold_pct` → this skill's default. (This is separate from the `anomaly_detection_settings` data gate below, which still stops the run — that is warehouse data, not brand context.) Load the brand-context fields in one call via `mixshift brand context resolve <brand-slug> --json` — each carries `{value, source, fetched_at}` (`source: context` = ✓ confirmed, `brain` = ⊙ pre-filled; `null` = use the default above).

### Step 2 — Run prefetch

Pull T-1 keyword performance + T-30 baseline + CI thresholds in one batch:

```bash
mixshift prefetch --brand <brand-slug> --skill mx-runaway-spend-check
```

This executes the SQL declared in `skill.manifest.yaml`:
- **RSC-01** — keyword-level T-1 + T-30 metrics joined with campaign state
- **DHC-04** — account-level CI thresholds from `anomaly_detection_settings`

The runner writes:
- `~/.mixshift/clients/<brand>/runs/mx-runaway-spend-check/<date>/data.json` (machine-readable, all rows)
- `~/.mixshift/clients/<brand>/runs/mx-runaway-spend-check/<date>/data.md` (capped markdown summary, ≤ 48 KB)

Read `data.md` for inline analysis. Load the full `data.json` only if you need rows that didn't fit in the markdown cap.

If any query fails, the prefetch exits with code 2 and prints the failing query IDs + friendly errors. Surface the failure and stop.

### Step 3 — Compute Confidence Intervals

From DHC-04's `anomaly_detection_settings` output, locate the row(s) the skill needs:
- Pull `Metric` = `ACOS`, `Spend`, and any others relevant. Extract `UpperSensitivityLimit` and `LowerSensitivityLimit`.
- These are pre-computed percentile cutoffs — do NOT recompute them.
- If the row for the SellerID is missing, **HARD GATE — STOP** (preflight should already have caught this).

### Step 4 — Identify Anomalies

**Type 1: T-1 CI Breach**
```
Flag if: spend_t1 > UpperCI_spend
      OR spend_t1 < LowerCI_spend
      OR acos_t1  > UpperCI_acos
```

**Type 2: Zero Conversions with Material History**
```
Flag if: conversions_t30 >= 1
     AND conversions_t1  = 0
     AND spend_t1 > (spend_t30_daily_avg × 1.5)
```

### Step 4b — Intraday budget usage check (optional, live)

Run this only when the user is asking about TODAY (intraday) or wants to know
whether a T-1 flag is still burning right now. The warehouse data this skill
reads is T-1, so for same-day pacing you can pull live budget consumption from
the Ads API. Skip it for a routine T-1 retrospective.

1. Resolve the account's legacy seller id (the per-marketplace record id,
   same ids as `mixshift amazon merchants`). This is the `--legacy-seller-id`
   the call needs.
2. Collect the Amazon `campaignId` values for the campaigns behind the flagged
   keywords. Write them to a JSON body file, max 100 ids per call:
   `{ "campaignIds": ["...", "..."] }`. Split into multiple files if more than
   100 campaigns are flagged.
3. Call the budget-usage surface (a read; nothing is mutated):
   `mixshift ads call sp.budget_usage --legacy-seller-id <id> --body-file ids.json --json`
4. Read `budgetUsagePercent` and `usageUpdatedTimestamp` per campaign. A
   campaign already at or above 80 percent before midday (local account time)
   strengthens a RED verdict: the budget is on track to exhaust early and the
   spike is live, not a settled T-1 artifact. Note the percent and the
   timestamp next to the affected rows.

If the call returns `ads_not_configured`, `throttled`, or any other failure,
skip the step, note that live budget usage was unavailable, and proceed on the
T-1 warehouse signal alone. This check never blocks or gates the daily run. For
the general Ads API surface (other live reads, recommendations), see
mx-amazon-ads.

### Step 5 — Apply Structural Events

Cross-reference active `structural_events[]` from context:
- Active price tests → ACOS elevated (downgrade severity)
- Recent bid changes → attribution settling (note, don't flag aggressively)
- Active promotions → spend spikes planned (downgrade)
- Stockouts → conversions suppressed (downgrade Type 2 only)

### Step 6 — Compute Excess Spend

```
Excess_Spend = spend_t1                    (if zero-conversions flag)
             | (spend_t1 - recoverable)    (if CI-breach flag with some sales)
```

**Proportionality heuristic:** Compare flagged keywords' share of total account T-1 spend:
- < 5% of account spend = localized issue
- 25%+ of account spend = systemic issue, investigate structure

### Step 7 — Compose Output

| Keyword | Campaign | T-1 Spend | T-1 ACOS | T-30 ACOS | Flag Type | Excess Spend | Action |
|---------|----------|-----------|----------|-----------|-----------|--------------|--------|
| [kw] | [camp] | $XX | XX% | XX% | ACOS breach | $XX | Pause |

Sort by `Excess Spend DESC`. Limit to top 20 — the long tail gets summarized in the bottom-line count.

### Step 8 — Write Bottom Line

Three elements:
1. **Count and total excess spend** — "3 keywords flagged. $127 in excess spend detected."
2. **Proportionality** — "Represents 12% of account T-1 spend — localized issue."
3. **Recommendation** — "Recommend pausing all three and investigating the Campaign Type structure."

### Step 9 — Self-Review

- [ ] Two anomaly types checked (CI breach AND zero conversions)
- [ ] T-1 CI bounds from `anomaly_detection_settings` (not hardcoded)
- [ ] Material history filter applied to zero-conversion flag
- [ ] Structural events cross-referenced
- [ ] Paused campaigns excluded
- [ ] Excess Spend computed per keyword
- [ ] Proportionality heuristic applied
- [ ] No em dashes in output
- [ ] Bottom Line includes keyword count, excess spend, proportion
- [ ] Recommendations actionable (Pause, Bid Cut, Monitor)

### Step 10 — Emit Run Sidecar

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. The sidecar is the input to the (future) cross-run drift comparator.

Compose the sidecar input JSON (write to a temp file, then call the harness):

```jsonc
// /tmp/rsc-sidecar-input.json
{
  "skill": "mx-runaway-spend-check",
  "skill_version": "0.3.0",
  "brand_slug": "<brand-slug>",
  "run_kind": "per_account",
  "data_date": "YYYY-MM-DD",     // T-1 date (yesterday)
  "verdict": "GREEN|YELLOW|RED|OBSERVATIONAL",
  "context_snapshot": {
    "account_type": "SC|VC",
    "seller_id": 0,
    "primary_metric": "ACOS|TACOS",
    "acos_target_pct": 0,
    "attribution_window_days": 0,
    "posture_stance": "scale|efficiency|defend|clear_bleed",
    "posture_multiplier": 0,
    "bid_health_pullback_threshold_pct": 0
  },
  "headline_metrics": {
    "runaway_count": 0,
    "runaway_total_spend": 0,
    "runaway_pct_of_account_spend": 0,
    "top_offender_spend": 0,
    "top_offender_acos": 0,
    "zero_conv_flagged_count": 0,
    "ci_breach_flagged_count": 0,
    "excess_spend_total": 0
  },
  "sql_calls": [
    {"id": "RSC-01", "params": {"seller_id": 0, "yesterday": "YYYY-MM-DD", "lookback_days": 30}},
    {"id": "DHC-04", "params": {"seller_id": 0}}
  ],
  "artifacts": {
    "report_html_path": "<path-to-rendered-report-or-data.md>"
  },
  "structural_events_active": []   // list of event IDs that influenced interpretation
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/rsc-sidecar-input.json
```

**Verdict rule:**
- `GREEN` — no runaway keywords found
- `YELLOW` — runaway found but small (under spend floor / localized, e.g. <5% of account spend)
- `RED` — runaway found above floor; bid cuts or pauses recommended

The sidecar lives at `~/.mixshift/clients/<brand>/runs/mx-runaway-spend-check/<data-date>-<run-id>.json` for future drift comparisons (`mixshift sidecar compare`, coming later).

---

## Key Constraints

- **T-30 baseline always** — never compare single days to other single days
- **Material history check required** — zero conversions on low-spend keywords are noise
- **Structural events checked first** — context can downgrade severity
- **Paused campaigns excluded** — bid actions have no effect
- **CI bounds from settings** — never hardcode percentiles
- **Proportionality matters** — 2% of spend is noise; 25% is systemic

## Output Format

1. Header (account name, run date, T-1 date, CI sensitivity)
2. Flagged keywords table (sorted by excess spend, top 20)
3. Summary metrics and proportionality check
4. Bottom Line with keyword count and recommendation
5. Areas to Monitor (if applicable)

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-runaway-spend-check
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-runaway-spend-check --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-runaway-spend-check --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
