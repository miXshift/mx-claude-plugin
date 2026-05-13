---
name: runaway-spend-check
description: >
  This skill should be used when the user asks to "run runaway spend check",
  "check for runaway keywords", "identify overspending keywords", or needs
  daily keyword-level acute runaway spend detection. Flags keywords where T-1 spend
  spiked materially or where high-spend keywords generated zero conversions against
  their historical performance.
metadata:
  version: "0.1.0"
  author: "MixShift"
  ported-from: "upstream/runaway-spend-acos-check"
---

# Runaway Spend Check

## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** Brand context comes exclusively from `context.yaml` and `narrative.md`. The `SQL-REFERENCE.md` file in references/ is not a skill input.
- **Do NOT supplement with general Amazon or e-commerce knowledge**, industry benchmarks, or assumed platform dynamics not present in the data.
- **Do NOT echo full data tables or raw query output** in your model response. The HTML report is the deliverable.
- **Begin output immediately.** Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.

> **Pre-fetch gap (open):** RSC SQL queries (RSC-01, RSC-02) are not yet promoted to the shared library. Until they are, execute Steps 2–3 as inline queries. The pre-fetch pattern will apply once RSC-* IDs are registered in the SQL library and added to `skill.manifest.yaml`.

---

## Preflight — Risk Tier 3 (Required)

Complete this checklist before Step 1. Stop and surface the failure if any item cannot be checked off.

```
PREFLIGHT — runaway-spend-check — <brand> — <date>
[ ] context.yaml loaded from shared/clients/<brand>/context.yaml
[ ] Required fields present and non-null:
      accounts[*].seller_id, accounts[*].account_type
      management.acos_target_pct, management.attribution_window_days
      posture.stance, posture.multiplier
      bid_health.pullback_threshold_pct
      structural_events (list — may be empty)
      paused_campaigns (list — may be empty)
[ ] anomaly_detection_settings row exists for SellerID
    *** HARD GATE: if absent, STOP. Cannot compute CI without thresholds. ***
[ ] Data freshness ≤ 2 days (acute check — stale data produces false negatives)
    *** HARD GATE: if data older than 2 days, STOP and surface to user. ***
[ ] Prior-run sidecar loaded from runs/<brand>/runaway-spend-check/ (most recent)
    (if absent: continue — no baseline yet; note in output header)
[ ] No active escalation conditions:
      - verdict regresses GREEN→RED without structural_events explanation → surface before delivering
```

---

## Overview

Detects acute keyword spend anomalies in real-time. Two exception-based checks:
1. **T-1 Spend or ACOS CI Breach** — spend spiked materially relative to T-30 baseline
2. **Zero T-1 Conversions with Material Spend** — keyword with significant T-30 history generated zero conversions today

This is the second step in the keyword bid management workflow (after daily health check, before keyword bid health review).

## Prerequisites

1. **Tier-3 brand context directory** at `shared/clients/<brand-slug>/`:
   - `context.yaml` — mechanical truth (validated against `shared/clients/_schema/context.schema.yaml`)
   - `narrative.md` — interpretive prose (do not extract numbers from this file)
2. **Access to MySQL database** for keyword metrics (keywordtargetingmetric, anomaly_detection_settings)
3. **Campaign configuration** (enabled vs paused campaigns)

**Fail closed:** if `context.yaml` is absent or fails schema validation, stop and direct user to run the `account-cold-start` skill. Do not infer fields from prose.

## Execution Steps

### Step 1: Load Prerequisites

- Read **`shared/clients/<brand-slug>/context.yaml`** and extract mechanically:
  - `accounts[].seller_id`, `accounts[].account_type`
  - `management.acos_target_pct`, `management.attribution_window_days`
  - `posture.stance`, `posture.multiplier` — informs how aggressively to recommend pause vs. cut
  - `bid_health.pullback_threshold_pct` — companion threshold for runaway classification
  - `structural_events[]` filtered to currently active (price tests, promos, recent bid changes that explain T-1 spikes)
  - `attribution_rule` — per-campaign-type window
  - `paused_campaigns` — exclude from analysis
- Read `shared/clients/<brand-slug>/narrative.md` for prose interpretation (do not extract numbers)
- Verify SellerID matches account

### Step 2: Query T-1 Keyword Metrics

Query the MySQL database for T-1 keyword performance:
- KeywordID, Keyword text, Campaign name, Campaign type
- T-1 Spend, T-1 Ad Sales, T-1 ACOS, T-1 Conversions
- T-30 baseline (Spend, ACOS, Conversions)

**Filters:** Active campaigns only (campaign.State = 'enabled')

### Step 3: Compute Confidence Intervals

From anomaly_detection_settings:
- Get ACOS UpperSensitivityLimit (typically 97.5th percentile)
- Compute T-30 ACOS CI bounds for Spend anomaly detection

### Step 4: Identify Anomalies

**Type 1: T-1 CI Breach**
```
Flag if: T-1_Spend > UpperCI OR T-1_Spend < LowerCI OR T-1_ACOS > UpperCI
```

**Type 2: Zero Conversions with Material History**
```
Flag if: T-30_Conversions >= 1 AND T-1_Conversions = 0 AND T-1_Spend > (T-30_DailyAvg × 1.5)
```

### Step 5: Apply Structural Events

Cross-reference brand context for:
- Active price tests (ACOS elevated)
- Recent bid changes (attribution settling)
- Active promotions (spend spikes planned)
- Stockouts (conversions suppressed)

### Step 6: Compute Excess Spend

For each flagged keyword:
```
Excess_Spend = T-1_Spend if zero conversions, otherwise (T-1_Spend - recoverable_value)
```

**Proportionality heuristic:** Compare flagged keywords' share of total account spend
- < 5% of account spend = localized issue
- 25%+ of account spend = systemic issue, investigate structure

### Step 7: Compose Output

| Keyword | Campaign | T-1 Spend | T-1 ACOS | T-30 ACOS | Flag Type | Excess Spend | Action |
|---------|----------|-----------|----------|-----------|-----------|--------------|--------|
| [kw] | [camp] | $XX | XX% | XX% | ACOS breach | $XX | Pause |

**Summary:** Count of flagged keywords, total excess spend, proportion of account spend

### Step 8: Write Bottom Line

Three elements:
1. **Count and total excess spend** — "3 keywords flagged. $127 in excess spend detected."
2. **Proportionality** — "Represents 12% of account T-1 spend — localized issue."
3. **Recommendation** — "Recommend pausing all three and investigating the Campaign Type structure."

### Step 9: Self-Review

- [ ] Two anomaly types checked (CI breach AND zero conversions)
- [ ] T-1 CI bounds from anomaly_detection_settings (not hardcoded)
- [ ] Material history filter applied to zero-conversion flag
- [ ] Structural events cross-referenced
- [ ] Paused campaigns excluded
- [ ] Excess Spend computed per keyword
- [ ] Proportionality heuristic applied
- [ ] No em dashes in output
- [ ] Bottom Line includes keyword count, excess spend, proportion
- [ ] Recommendations actionable (Pause, Bid Cut, Monitor)

## Key Constraints

- **T-30 baseline always** — never compare single days to other single days
- **Material history check required** — zero conversions on low-spend keywords are noise
- **Structural events checked first** — context can downgrade severity
- **Paused campaigns excluded** — bid actions have no effect
- **CI bounds from settings** — never hardcode percentiles
- **Proportionality matters** — 2% of spend is noise; 25% is systemic

## Output Format

1. Header (account name, run date, T-1 date, CI sensitivity)
2. Flagged keywords table (sorted by excess spend)
3. Summary metrics and proportionality check
4. Bottom Line with keyword count and recommendation
5. Areas to Monitor (if applicable)

SQL queries for this skill (RSC-01, RSC-02) are executed inline until they are promoted to the shared SQL library. See the pre-fetch gap note in Hard Rules above.

### Step 10: Emit Run Sidecar (canonical, drift-detection input)

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. This is the input to `scripts/compare-sidecars.py`, which surfaces cross-run drift (config edits to context.yaml, dropped queries, metric jumps, verdict regression). Sidecars live at `<plugin>/runs/<brand-slug>/runaway-spend-check/<data-date>-<run-id>.json`.

Schema source of truth: `<plugin>/shared/run-sidecar.schema.yaml`.

```bash
python3 <plugin>/scripts/write-sidecar.py \
  --skill runaway-spend-check \
  --skill-version 0.1.0 \
  --brand-slug [brand-slug] \
  --data-date YYYY-MM-DD \
  --metrics-json /tmp/rsc-headline.json \
  --context-snapshot-json /tmp/rsc-context-snapshot.json \
  --sql-calls-json /tmp/rsc-sql-calls.json \
  --verdict GREEN|YELLOW|RED|OBSERVATIONAL \
  --report-html /tmp/[brand]-reports/runaway-spend.html
```

**Required JSON inputs:**

- **`metrics-json`** — emit numeric values only (no `$`, no `%`):
  ```json
  {"runaway_count": 3, "runaway_total_spend": 412,
   "runaway_pct_of_account_spend": 12.4,
   "top_offender_spend": 187, "top_offender_acos": 142.3,
   "zero_conv_flagged_count": 2,
   "ci_breach_flagged_count": 1,
   "excess_spend_total": 318}
  ```

- **`context-snapshot-json`** — record only the `context.yaml` fields you actually consumed in this run:
  ```json
  {"account_type": "SC", "seller_id": "113",
   "primary_metric": "ACOS", "acos_target_pct": 20,
   "attribution_window_days": 7,
   "posture_stance": "scale", "posture_multiplier": 0.2,
   "bid_health_pullback_threshold_pct": 25,
   "attribution_rule": "per-campaign-type"}
  ```

- **`sql-calls-json`** — list every library query invoked, with the exact params used (params get hashed for cross-run identity). RSC currently has no inline SQL in this SKILL.md and no documented RSC-* library entries; record the queries actually fired (likely shared keyword/anomaly queries reused from the DHC family or skill-local queries TBD when SQL-LIBRARY is wired):
  ```json
  [{"id": "RSC-TBD-keyword-t1", "params": {"seller_id": "113", "yesterday": "2026-04-25"}},
   {"id": "RSC-TBD-keyword-t30-baseline", "params": {"seller_id": "113", "lookback_days": 30}},
   {"id": "DHC-04", "params": {"seller_id": "113"}}]
  ```

**Verdict rule:** `GREEN` = no runaway keywords found. `YELLOW` = runaway found but small (under spend floor / localized, e.g. <5% of account spend). `RED` = runaway found above floor and bid cuts or pauses recommended.

After writing, run the comparator to surface drift against the prior run:

```bash
# Post-delivery: drift check against prior sidecar
python3 scripts/compare-sidecars.py \
    --brand-slug [brand-slug] \
    --skill runaway-spend-check
# Exits 0 if clean, 1 if drift detected (config change, metric jump, verdict regression).
# Review drift output before closing the run. Drift is not blocking by default.
```

Exit 0 = no drift. Exit 1 = drift detected (config edit, query dropped, metric jump, verdict regression). Surface drift findings in the next day's report header, not silently.

