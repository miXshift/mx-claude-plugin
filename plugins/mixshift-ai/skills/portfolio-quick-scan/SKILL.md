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
For each account in the config, read `~/.mixshift/clients/<brand-slug>/context.yaml` (schema-validated via `mixshift brand validate <brand-slug>`). Extract per-account, mechanically:
- `accounts[].seller_id`, `accounts[].account_type`
- `management.primary_metric`, `management.acos_target_pct`, `management.tacos_in_bottom_line`, `management.tacos_reference_line`
- `goals.monthly_revenue_target`, `goals.quarterly_revenue_target`, `goals.report_quarterly_pacing`
- `posture.stance`, `posture.multiplier`
- `structural_events[]` filtered to currently active (stockouts, price tests, promos — used to downgrade RED to YELLOW)
- `capture_rate_calibration` (VC accounts only — for Adj. ACOS card line)
- `delivery.reports_local_dir`

Also read `~/.mixshift/clients/<brand-slug>/narrative.md` for prose card-line guidance only. Do not extract numbers from this file.

**Fail closed (per account):** if a given account's `context.yaml` is absent or fails schema validation, render that account's card as an explicit "context missing — run account-cold-start" error card. Do not infer fields from prose. Other accounts continue.

---

## Data Source: per-account daily-health-check sidecars

This skill is a **pure aggregator** of per-account `daily-health-check` runs. It does not query the warehouse directly. The per-account skill (daily-health-check) does the heavy lifting via `mixshift prefetch` + the skill model's classification; portfolio-quick-scan reads the resulting sidecars and composes the cross-account view.

For each account in the portfolio config (today's data_date = T-1):

1. Look for the day's daily-health-check sidecar at:
   ```
   ~/.mixshift/clients/<brand-slug>/runs/daily-health-check/<data-date>-*.json
   ```
   - If multiple exist for the same date (reruns), use the most recent by file mtime.
2. **If a sidecar for today is missing or older than 24 hours**, trigger the per-account skill via:
   ```bash
   mixshift prefetch --brand <brand-slug> --skill daily-health-check --date <YYYY-MM-DD>
   ```
   Then run the daily-health-check skill model on that account to compose its sidecar. Only after the per-account sidecar is on disk should you read it from this skill.
3. **Trigger per-account runs in parallel** — fire all `mixshift prefetch` invocations simultaneously for accounts missing today's sidecar, rather than serializing.

The per-account DHC sidecar carries everything portfolio-quick-scan needs: `verdict`, `headline_metrics` (spend_t1, acos_t1, tacos_t30, pacing_*), `context_snapshot` (account_type, posture, primary_metric), and `structural_events_active`.

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

## No SQL of its own

Portfolio-quick-scan emits no library-SQL itself. All warehouse access happens via per-account `mixshift prefetch --brand <slug> --skill daily-health-check`. Each account's sidecar is the canonical input.

If you find yourself wanting to query the warehouse directly inside portfolio-quick-scan, that signal probably belongs in the daily-health-check skill instead — adding it there keeps the per-account drill-down and the portfolio view in lockstep.

---

## Delivery

Compose the report as **markdown** (default) or HTML (if the user explicitly requests HTML).

Save to:
```
~/.mixshift/portfolio/reports/<YYYY-MM-DD>/portfolio-scan.md
```

If the portfolio config provides `delivery.reports_local_dir`, honor that override. Newer scans are written as new files (one per day); the prior day's scan remains on disk for retrospective comparison.

Drift comparison against the prior portfolio sidecar will be handled by `mixshift sidecar compare` (not yet implemented). For now, manually inspect prior sidecars under `~/.mixshift/clients/portfolio/runs/portfolio-quick-scan/` before delivery if you suspect roster or verdict drift.

**Per-account summary JSON** (optional, alongside the report):
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

After delivery, write a portfolio-level sidecar capturing this run's roster, verdict counts, and flagged accounts. Sidecars live at `~/.mixshift/clients/portfolio/runs/portfolio-quick-scan/<data-date>-<run-id>.json`. Use the literal slug `portfolio` for `brand_slug` — this is the only skill that emits a portfolio-level sidecar; per-account sidecars belong to the per-account skills it triggers. Schema source of truth: `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`.

Use the **data date** (T-1; the day the scan answers "do I need to log in today?") for `data_date`, not the wall-clock run time.

Compose the input JSON (write to a temp file, then invoke the harness):

```jsonc
// /tmp/pqs-sidecar-input.json
{
  "skill": "portfolio-quick-scan",
  "skill_version": "1.1.0",
  "brand_slug": "portfolio",
  "run_kind": "portfolio",
  "data_date": "YYYY-MM-DD",
  "verdict": "GREEN|YELLOW|RED|OBSERVATIONAL",
  "context_snapshot": {
    "portfolio_account_count": 0,
    "portfolio_config_path": "~/.mixshift/portfolio.yaml",
    "account_type_mix": {"SC": 0, "VC": 0},
    "flagged_account_slugs": []
  },
  "headline_metrics": {
    "accounts_scanned": 0,
    "green_count": 0,
    "yellow_count": 0,
    "red_count": 0,
    "total_spend_today": 0
  },
  "sql_calls": [
    {"id": "UPSTREAM:daily-health-check",
     "params": {"sidecar_glob": "runs/*/daily-health-check/YYYY-MM-DD-*.json",
                "consumed_metrics": ["verdict", "spend_t1", "acos_t1", "tacos_t30", "data_lag_pct"],
                "accounts_in_scope": 0, "data_date": "YYYY-MM-DD"}}
  ],
  "artifacts": {
    "report_html_path": "<path-to-rendered-output>"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/pqs-sidecar-input.json
```

**Verdict rule (portfolio-level):** `GREEN` = all accounts GREEN or YELLOW (no intervention required at the portfolio level today). `YELLOW` = 1–2 accounts RED (per-account drill-downs required, but not a systemic issue). `RED` = ≥3 accounts RED, or a systemic issue spans multiple accounts (e.g., a shared structural event, a vendor-wide data lag). `OBSERVATIONAL` = portfolio config incomplete or several accounts in provisional history tier — verdict suspended.

`mixshift sidecar compare` will surface drift against the prior portfolio scan once implemented; until then, sidecars accumulate read-only for retrospective inspection.


## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill portfolio-quick-scan
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill portfolio-quick-scan --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill portfolio-quick-scan --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
