---
name: portfolio-quick-scan
version: 1.0.0
description: >
  Multi-account daily triage. Produces one status card per account answering a single question:
  do I need to log into the platform today? GREEN / YELLOW / RED verdict per account based on
  CI anomalies, TACOS posture, and pacing proximity. No dimensional tables. No keyword data.
  Replaces on each run — this is a point-in-time snapshot.
  Triggers on: 'run portfolio scan', 'quick check all accounts', 'triage all accounts',
               'spring break check', 'multi-account check'.
author: Claude
last_updated: 2026-04-08
dependencies:
  - MySQL database (campaignmetric, business_reports, anomaly_detection_settings, anomaly_detection_MV)
  - portfolio account config file
  - brand context files for all accounts
sample_input: "Run portfolio quick scan"
sample_output: |
  ## Portfolio Quick Scan — 2026-03-24
  
  ### 🟢 example brand — No action required
  Spend $369 (CI: $187-$340 up), ACOS 88% (CI: 29-126%), TACOS 30.4% < 35% target
  March pacing $26,551 | Q1 $69,872 (-$128 vs $70K target)
  Easter sale Day 2 — spend spike expected, TACOS holding.
  
  ### 🟡 example brand — Watch: TACOS 2pts from ceiling
  Spend within CI, TACOS 48% vs 50% target, March pacing $XX
standalone: true
handoff_optional: true
changelog:
  - version: 1.0.0
    change: "Initial skill — directive: multi-account triage, minimal footprint, point-in-time snapshot."
---

# Portfolio Quick Scan

Triage check across all configured accounts. One card per account, one verdict per card. The account manager reads the scan and knows whether to open the platform or go back to what they were doing.

---

## Execution Prerequisites

**Step 0a — Read this SKILL.md.** Already done.

**Step 0b — Load account config:** Read the portfolio account configuration.
Extract the account list. Each entry provides: slug, seller_id, account_type (SC/VC), display_name.

**Step 0c — Load Tier-3 brand context in parallel:**
For each account in the config, read `shared/clients/<brand-slug>/context.yaml` (validated against `shared/clients/_schema/context.schema.yaml`). Extract per-account, mechanically:
- `accounts[].seller_id`, `accounts[].account_type`
- `management.primary_metric`, `management.acos_target_pct`, `management.tacos_in_bottom_line`, `management.tacos_reference_line`
- `goals.monthly_revenue_target`, `goals.quarterly_revenue_target`, `goals.report_quarterly_pacing`
- `posture.stance`, `posture.multiplier`
- `structural_events[]` filtered to currently active (stockouts, price tests, promos — used to downgrade RED to YELLOW)
- `capture_rate_calibration` (VC accounts only — for Adj. ACOS card line)
- `delivery.reports_local_dir`

Also read `shared/clients/<brand-slug>/narrative.md` for prose card-line guidance only. Do not extract numbers from this file.

**Fail closed (per account):** if a given account's `context.yaml` is absent or fails schema validation, render that account's card as an explicit "context missing — run account-cold-start" error card. Do not infer fields from prose. Other accounts continue.

---

## Parallel Execution Rule (MANDATORY)

This skill covers multiple accounts. All independent queries must fire simultaneously.

**Round 1 — fire all simultaneously:**
For every account in the config, in a single invocation block:
- Batch A (campaignmetric: T-1/T-7/T-30 spend, ad sales, ACOS)
- Batch B (total sales or ordered revenue: T-1/T-7/T-30/MTD)
- Batch C (anomaly_detection_settings: CI thresholds + pre-computed pacing)

If there are 3 accounts, fire 9 queries simultaneously.

**Round 2 — fire all simultaneously after Round 1 completes:**
For every account: Batch D (anomaly_detection_MV T-30 daily actuals for CI percentile computation).

Two round trips total, regardless of account count.

---

## Core Logic (Per Account)

After data is collected, apply this logic to produce the status verdict:

### Step 1 — CI Breach Detection
Compute CI bounds from Batch D (same P97.5/P2.5 percentile method).

Flag:
- spend_breach_upper: T-1 Spend > CI upper
- spend_breach_lower: T-1 Spend < CI lower
- acos_breach_upper: T-1 ACOS > CI upper
- tacos_breach_upper: T-1 TACOS > CI upper

### Step 2 — TACOS Posture Check
- tacos_above_target: T-1 TACOS > account's TACOS goal
- tacos_approaching_target: T-1 TACOS within 3pts of goal
- tacos_margin_pts: goal - T-1 TACOS

### Step 3 — Goal Reporting Mode (MANDATORY)

Every account is evaluated in one of three modes depending on data availability.

**Mode A — Active period (mid-month, 3+ current-period days in DB):**
Report MTD actuals vs goal + pacing projection. Standard verdict escalation applies.

**Mode B — Period close-out (day 1-2 of new period, fewer than 3 current-period days):**
Prior period is closed. Report prior period final results vs goals.
No MTD-based YELLOW/RED escalation — current period has no meaningful data yet.
T-1 CI check still runs.

**Mode C — Quarter close-out (quarterly account, quarter just closed, fewer than 3 days of new quarter):**
Report Q1 Final results vs quarterly sales and TACOS goals.
Report prior month (Final) as secondary section.
No Q2 MTD-based escalation.

**Mode determination logic:**
- Count days in current period with campaign data in DB
- Quarterly account + quarter just closed: Mode C
- Current period days < 3: Mode B
- Otherwise: Mode A

### Step 4 — Pacing Check
Compute: `month_pacing = total_sales_mtd + (total_sales_t7_avg × days_remaining)`

**T-7 daily avg — active days correction (mandatory):**
`total_sales_t7_avg = T-7_sum / active_days_in_window`

Active days = days in T-7 window with actual data. For VC accounts (2-day lag), T-7 window typically has 5-6 active days. Dividing by 7 understates the daily rate by 14-28%.

**Default:** Use T-7 with active-day correction for mid-to-late month runs. If MTD day count < 7, fall back to MTD daily avg.

Flag:
- pacing_gap_pct: (month_pacing - monthly_run_rate_target) / monthly_run_rate_target × 100
- pacing_below_target: pacing_gap_pct < -8%

### Step 5 — Verdict Logic

**VC ACCOUNTS (ACOS-managed):**
- **GREEN:** Adjusted T-1 ACOS < acos_goal AND MTD ACOS < acos_goal
- **YELLOW:** Adjusted T-1 ACOS within 3pts of acos_goal OR MTD ACOS approaching ceiling
- **RED:** Adjusted T-1 ACOS > acos_goal AND MTD ACOS > acos_goal (both breached)

Raw ACOS CI breach alone on VC = informational note only, not a status driver.

**SC ACCOUNTS (TACOS-managed):**
- **RED:** acos_breach_upper == true AND tacos_above_target == true
  Both signals required. ACOS breach alone is not intervention.

**Critical check before RED:** If an active structural event (Easter sale, stockout, Prime Day) is in brand context active_conditions, downgrade RED to YELLOW and name the event.

**YELLOW (any of these):**
- spend_breach_upper == true AND tacos_above_target == false (promo ramp / traffic event)
- tacos_approaching_target == true (within 3pts of ceiling)
- pacing_below_target == true (more than 8% behind pace)
- acos_breach_upper == true AND tacos_above_target == false (hot ACOS read but TACOS healthy)

**GREEN:** No RED or YELLOW conditions met.

### Step 6 — Structural Event Check
Before finalizing verdict, cross-reference brand context active_conditions for:
- Active stockouts (inflated TACOS due to sales suppression)
- Active price tests (ACOS distorted)
- Active promotional windows (spend spike expected)

If a structural event explains a breach: keep the status flag but add a context note. A promo-driven spend breach is YELLOW, not RED — label it explicitly.

### Step 7 — Watch Item Sentence
One sentence per account:
- RED: name the specific metric pair that triggered it and what action to take
- YELLOW: name the specific condition and whether to watch or act
- GREEN: "All metrics inside normal range." or "[Structural event] is the likely cause."

---

## Output Format

Single HTML page, replaces on each run (append mode — newest at top, prior runs below).

### Page Structure
```
H1: Portfolio Quick Scan — [date]
P meta: [account count] accounts | Run date: [date] | Data date: T-1 [date]

[One card per account, in config order]
```

### Account Card Structure

**Headline row rule:** First 1-2 rows of every card must be the primary goal metric vs. its target. T-1 CI rows come after.

```
H2: [🟢|🟡|🔴] [Brand Name] — [No action required | Watch: [condition] | Intervention: [condition]]

T1 [Goal metric label]    [value]    Target [goal] ([margin] pts [below|above])    [pacing or MTD context]
T1 Spend                  $[t1]      CI: $[lower]-$[upper]                         T-7 avg $[t7_avg]
T1 ACOS                   [t1]%      CI: [lower]%-[upper]%                         MTD [mtd]%
T1 TACOS                  [t1]%      Target: [goal]% ([margin]pts [below|above])    MTD [mtd]%

March pacing $[pacing] [vs target: $[target] ([gap])] | Q1 $[q1_pacing] vs $[q1_target]

[Watch item sentence — one line]
```

### No Narrative Sections
No dimensional tables. No "Performance by Objective" sections. If AM wants depth, they run the daily health check. This skill's job is triage, not analysis.

---

## Account Config File

Location: portfolio account configuration file.

```yaml
accounts:
  - slug: <brand-slug-1>
    seller_id: <integer-seller-id>
    account_type: SC
    display_name: <Brand 1 Display Name>

  - slug: <brand-slug-2>
    seller_id: <integer-seller-id>
    account_type: SC
    display_name: <Brand 2 Display Name>

  - slug: <brand-slug-3>
    seller_id: <integer-seller-id>
    account_type: VC
    display_name: <Brand 3 Display Name>
```

**Adding a new account:** Add an entry here. Ensure brand context file exists with at minimum: acos_target, tacos_goal, account_type. Skill will error-fail that account gracefully if missing — other accounts still run.

---

## SQL Query Patterns

All queries are parameterized by [SELLER_ID] and [YESTERDAY]. Identical to the daily health check batches — no new queries, reduced scope.

**Batch A:** campaignmetric, all time windows (T-1, T-7, T-30, MTD)
**Batch B:** business_reports_dpst_date for SC; vendor_sales_manufacturing_asin for VC
**Batch C:** anomaly_detection_settings
**Batch D:** anomaly_detection_MV, T-30 daily actuals

Reference: daily health check skill for full query patterns.

No Batch E/F/G (dimensional queries — not needed for triage).
No keyword-level queries (health check drill-down handles that).

---

## Delivery

**Deploy pattern:** Prepend newest run at top, preserve all prior runs below (accumulating log, NOT full-replace).

Write the report and archive it:
```bash
python3 scripts/report-append.py \
  --report-html /tmp/portfolio-reports/portfolio-scan.html \
  --skill portfolio-quick-scan \
  --brand-slug portfolio \
  --data-date YYYY-MM-DD \
  --mode prepend
```


```bash
# Post-delivery: drift check against prior sidecar
python3 scripts/compare-sidecars.py \
    --brand-slug portfolio \
    --skill portfolio-quick-scan
# Exits 0 if clean, 1 if drift detected (config change, metric jump, verdict regression).
# Review drift output before closing the run. Drift is not blocking by default.
```

**Run archive:** Write summary JSON to runs archive:
```json
{
  "data_date": "YYYY-MM-DD",
  "run_date": "YYYY-MM-DD",
  "accounts": [
    { "slug": "<brand-slug-1>", "status": "GREEN", "flags": [], "watch_item": "..." },
    { "slug": "<brand-slug-2>", "status": "YELLOW", "flags": ["tacos_approaching_target"], "watch_item": "..." }
  ]
}
```

---

## Writing Rules

- No em dashes
- No hedging adverbs
- One sentence watch items — number + judgment combined
- "TACOS" not "tacos" or "TACOS%"
- "pts" for percentage point differences
- Status label after badge: "No action required" / "Watch: [condition]" / "Intervention: [metrics]"

---

## Causal Integrity

- Describe the data pattern; do not assert causes without supporting data
- A structural event from brand context can explain a breach — name it explicitly
- Never use day-of-week characterizations without supporting T-30 data

---

## Self-Review (Minimal — Point-in-Time Skill)

Before deploying:
- [ ] Every account in config produced a verdict
- [ ] No account card without all three triage metrics (Spend, ACOS, TACOS)
- [ ] Each RED card names specific metrics that triggered it
- [ ] Each YELLOW card names the specific condition
- [ ] Pacing line present on every card
- [ ] Structural events from brand context cross-referenced
- [ ] No em dashes in output
- [ ] No dimensional tables in output

---

## Relationship to Other Skills

This skill is the intake filter. It answers "which accounts need attention today?"

If an account comes back RED or YELLOW:
- Run the daily health check on that account for the full picture
- Then follow the health check's drill-down sequence

This skill does not replace the daily health check. It replaces manual scanning of 3+ accounts to figure out which one to look at first.

---

## Narrative Discipline Rules

- **No invented causality.** Do not write "X drove Y" unless mechanism is explicit.
- **MoM and YoY labels are mandatory on every delta.** Unlabeled deltas are ambiguous.
- **No editorial certainty without validation.** Use "consistent with" for correlated trends.
- **sellermonthmetric is the settled source for VC account-level ad metrics.** Do not aggregate raw campaignmetric.

---

## Step: Emit Run Sidecar (canonical, drift-detection input)

After delivery, write a structured JSON sidecar capturing this run's portfolio-level inputs and headline outputs. This is the input to `scripts/compare-sidecars.py`, which surfaces cross-run drift at the portfolio level (account roster changed, systemic shift toward RED, verdict regression). Sidecars live at `<plugin>/runs/portfolio/portfolio-quick-scan/<data-date>-<run-id>.json`. Use the literal slug `portfolio` for `--brand-slug` (this skill is the only one that emits a portfolio-level sidecar; per-account sidecars belong to the per-account skills it triggers).

Schema source of truth: `<plugin>/shared/run-sidecar.schema.yaml`.

```bash
python3 <plugin>/scripts/write-sidecar.py \
  --skill portfolio-quick-scan \
  --skill-version 1.0.0 \
  --brand-slug portfolio \
  --run-kind portfolio \
  --data-date YYYY-MM-DD \
  --metrics-json /tmp/pqs-headline.json \
  --context-snapshot-json /tmp/pqs-context-snapshot.json \
  --sql-calls-json /tmp/pqs-sql-calls.json \
  --verdict GREEN|YELLOW|RED|OBSERVATIONAL \
  --report-html /tmp/portfolio-reports/portfolio-scan.html
```

**`--run-kind portfolio` is required** for this skill. It tells `write-sidecar.py` to validate the portfolio-shape `context-snapshot-json` (no per-account sentinel hacks) and downstream comparators to apply portfolio drift rules.

Use the run wall-clock date (the day the scan answers "do I need to log into the platform today?") for `--data-date`.

**Required JSON inputs:**

- **`metrics-json`** — emit numeric values only (no `$`, no `%`). `flagged_accounts` is a JSON array of brand slugs that came back YELLOW or RED:
  ```json
  {"accounts_scanned": 7, "green_count": 4,
   "yellow_count": 2, "red_count": 1,
   "total_spend_today": 8420,
   "flagged_accounts": ["example-brand", "acme-foods", "northwind"]}
  ```

- **`context-snapshot-json`** — portfolio scan does not have a single per-account context.yaml; it iterates. With `--run-kind portfolio`, the schema requires `portfolio_account_count` and `portfolio_config_path`. Optional but recommended: `account_type_mix` (so cross-run drift surfaces a SC↔VC roster shift) and `flagged_account_slugs` (so cross-run drift surfaces *which* accounts trip):
  ```json
  {"portfolio_account_count": 7,
   "portfolio_config_path": "shared/portfolio.yaml",
   "account_type_mix": {"SC": 3, "VC": 4},
   "flagged_account_slugs": ["example-brand", "acme-foods"]}
  ```

- **`sql-calls-json`** — portfolio-quick-scan is a pure consumer; it aggregates per-account `daily-health-check` sidecars and runs no SQL itself. Record the consumption as a structured `UPSTREAM:<skill-name>` pseudo-call so the comparator can chain drift detection across skills (if DHC's query inventory or verdict logic shifts, the portfolio scan inherits the signal).
  ```json
  [{"id": "UPSTREAM:daily-health-check",
    "params": {"sidecar_glob": "runs/*/daily-health-check/2026-04-25-*.json",
               "consumed_metrics": ["verdict", "spend_t1", "acos_t1", "data_lag_pct"],
               "accounts_in_scope": 7, "data_date": "2026-04-25"}}]
  ```

**Verdict rule (portfolio-level):** `GREEN` = all accounts GREEN or YELLOW (no intervention required at the portfolio level today). `YELLOW` = 1–2 accounts RED (per-account drill-downs required, but not a systemic issue). `RED` = ≥3 accounts RED, or a systemic issue spans multiple accounts (e.g., a shared structural event, a vendor-wide data lag). `OBSERVATIONAL` = portfolio config incomplete or several accounts in provisional history tier — verdict suspended.

After writing, run the comparator to surface drift against the prior portfolio scan:

```bash
python3 <plugin>/scripts/compare-sidecars.py --brand-slug portfolio --skill portfolio-quick-scan
```

Exit 0 = no drift. Exit 1 = drift detected (account roster changed, RED count jumped, flagged-accounts list changed materially, verdict regression). Surface drift findings on the portfolio scan header tomorrow, not silently.

