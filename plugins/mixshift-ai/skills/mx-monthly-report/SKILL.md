---
name: mx-monthly-report
version: 1.4.0
description: >
  Generates and publishes a monthly Amazon advertising performance report for a brand
  in MixShift's canonical analytical voice. Covers MoM and YoY comparisons, H-Bridge efficiency analysis,
  item group highlights, forecast beat/miss, and a Looking Ahead section.
  Saves report locally as /monthly-report.html in the brand's reports directory.
  Triggers on: 'write monthly report', 'build monthly report', 'monthly performance report',
               'run monthly report', 'generate monthly report for [brand]'.
author: Claude
last_updated: 2026-04-08
dependencies:
  - MySQL database (campaignmetric, sellermonthmetric, business_reports_dpst_date, vendor_sales_manufacturing_asin)
  - brand context file (required)
sample_input: "Generate monthly report for example brand, March 2026"
sample_output: |
  ## March 2026 Monthly Report — example brand
  Bottom line: OPS $XX.XK (+$X.XK MoM), TACOS X.X% (+/-X.X pts), YoY growth +X.X%
  Full HTML report saved to [local reports dir]/monthly-report.html
standalone: true
handoff_optional: true
---

# Monthly Performance Report Skill

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), resolve the bundled CLI by scanning for it once and reuse the path: `MIXSHIFT_CLI="$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)"`, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


## Before You Start

Read these files:
- **`~/.mixshift/clients/<brand-slug>/context.yaml (validated via `mixshift brand validate <brand-slug>`)`** — compact context snapshot pre-extracted by the pre-fetch script. Required fields: `seller_id`, `account_type`, `primary_metric`, `implied_tacos_pct`, `attribution_window_days`, `tacos_in_bottom_line`, `tacos_reference_line`, `goals.*`, `capture_rate_calibration`, `sub_brands`, `brand_terms`, `structural_events`, `delivery.reports_local_dir`, `delivery.archive_dir`, `reporting.audience`, `reporting.voice_lint`, `attribution_rule`. If absent, fall back to reading `~/.mixshift/clients/<brand-slug>/context.yaml` directly. The efficiency-framing ACoS target (`acos_target`) comes from the calibration card in Step 1.5, not from this list.
- **`~/.mixshift/clients/<brand-slug>/runs/mx-monthly-report/ (most recent <date>-<run-id>.json)`** — prior run sidecar (~65 lines). If present, use for drift context and prior verdict. If absent, skip.
- `~/.mixshift/clients/<brand-slug>/narrative.md` — interpretive prose only (positioning, MoM/YoY narrative cues, per-skill guidance). Do not extract numbers from this file.

**Do NOT read the references/ folder.** Brand context comes exclusively from context.yaml and narrative.md above. The references/ folder contains cross-brand architecture documents that are not inputs to skill execution.

**Brand context is optional — never fail closed on it.** Run on whatever context is present (the snapshot / `context.yaml`, with the Tier-2 Brand Brain as fallback: `mixshift brand brain status <brand-slug> --json`); the report sharpens as context accrues but never requires full brand setup. The only hard requirement is `accounts[].seller_id` + `account_type` (from `mixshift brand add`) — if both are absent, stop and say so. When a brand-context field is missing, use the documented default and label it rather than stopping: `management.primary_metric` → assume ACoS ("assumed; tell me if it's TACoS"); the efficiency-framing ACoS target (`acos_target`) is resolved in Step 1.5, not here (if absent there, run observational — report ACoS as-is, don't frame vs a target); revenue/pacing targets absent → omit the pacing-vs-target line and say so; `posture.stance` → `scale`. Still do NOT invent numbers from prose — label them missing instead. Load the brand-context fields in one call via `mixshift brand context resolve <brand-slug> --json` — each carries `{value, source, fetched_at}` (`source: context` = ✓ confirmed, `brain` = ⊙ pre-filled; `null` = use the default).

**Capture-rate calibration (brand setup v2.3.1+):** the `capture_rate_calibration` field now includes an optional `daily_settlement_curve` sub-block with per-campaign-type and per-day-of-week settlement data. Monthly-report operates primarily on settled month-end figures (`sellermonthmetric` for VC, business-reports for SC) so no fresh-day correction is applied for prior-month metrics. **For in-progress-month MTD projections** where a fresh-day correction would be useful, prefer `daily_settlement_curve.by_campaign_type.sponsoredProducts` over the legacy account-blended `capture_rate_pct` — the curve is more precise and has DOW offsets. Fall back to the legacy `capture_rate_pct` if the curve is absent or the SP row is null.

---

## Audience Flag (REQUIRED — set before writing)

Determine the audience before generating any output:
- `internal` — full report with nav, prior month section, skill-context notes, internal references
- `client` — clean report: no nav tabs, no prior month section, no internal-only context

**Client report rules:**
- No bid health action items
- No internal tool references
- No "confirmed" on plan items not yet shared with client
- No ASIN codes in narrative (use product nicknames)
- No agency-internal language

When audience=client: strip nav, strip prior-month section. Save to same local reports directory.

---

## Anti-Fabrication Rules (No Exceptions)

**Use only data returned by the pre-fetched queries and context.yaml. Do not supplement with general Amazon or e-commerce knowledge, industry benchmarks, or assumed platform dynamics not present in the data.**

1. **DB or screenshot only.** Every number must be from a DB query result or screenshot. No inference.

1a. **Use sellermonthmetric for VC account-level ad metrics.** Do NOT use raw campaignmetric aggregates for ACOS, Ad Sales, ConvR, or AOV. sellermonthmetric is settled.

1b. **For sub-brand ACOS, use campaignmetric JOIN campaign ON campaign.Brand.** Cross-check against platform screenshot. Expect ~0.2–0.6 pt gap.

1c. **For MoM efficiency deltas, require the prior month's settled figure from platform screenshot.** Raw DB prior-month values carry restatement lag.

2. **Multi-month periods require their own DB query.** Never apply single month's growth rate to quarterly figures.

3. **Never invent a product nickname.** Use ItemNickname from database or ask.

4. **Never assert a forward metric value** unless from MixShift Revenue Forecasting Model or confirmed target.

5. **Never reference a seasonal driver** without grounding in the forecasting model's seasonal index.

6. **Never state OOS status** without checking inventory history table.

7. **Bid vs. spend:** Lower spend = consequence of lower bids, not budget decision. Always say "bid pullback."

8. **Attribution window gate:** Check MerchantType. SC: SP=7day, SB=14day, SD=14day. VC: all=14day.

9. **"Blended ACOS" is banned.** Use "ACOS" or "Total ACOS."

10. **Sign all change metrics.** "-8.1 pts" not "8.1 pts."

11. **No invented causality.** Do not write "X drove Y" unless the mechanism is explicit. State the metric, state direction.

12. **No editorial certainty without brand owner validation.** Use "consistent with" for correlated trends.

13. **MoM and YoY labels are mandatory on every delta in prose.**

---

## Verify Step (Run Before Writing Any Narrative)

1. Confirm account type from brand context (SC or VC) before pulling ad metrics
2. Verify every MoM and YoY figure against DB output
3. Scan computed values for suspicious rounding or anomalies
4. Check: any forward-looking assertions? Each needs a model projection or confirmed data
5. Voice scan: em dashes? "blended ACOS"? unsigned deltas? invented causality?
6. Check item group callouts for internal consistency

---

## Step 1.5 — Confirm calibration

Get this run's knobs (and let the user sharpen them) via the confirm card:

```bash
mixshift skill config mx-monthly-report --brand <brand-slug> --json
```

The `confirmation.fields[]` array holds one entry per manifest field (find yours by `field.id`); read `effective_value` for the value this run will use. `acos_target` (reference ACoS for the efficiency narrative / beat-miss framing, an optional override of the brand target) comes back as a fraction in [0,1] (e.g. `0.22` = 22%, not the whole number). Seeded from brand context where set, else absent.

Show the user the card — it lists every field with its source, and on a brand's FIRST run it leads with a `capture_note` nudging the top unset fields. They can:
- **confirm / defer** → run on the shown values: `mixshift skill config mx-monthly-report --brand <brand-slug> --apply '{"action":"confirm"}' --json`
- **edit** → e.g. `... --apply '{"action":"edit","edits":{"acos_target":"22"},"save":true}' --json`. A shared field (`acos_target`) is proposed for brand-wide promotion (recorded for review).

**Resolve the working value (a fraction in [0,1]) from `confirmation.fields[]` (`effective_value`):**
- `acos_target`: reference ACoS for the efficiency narrative / beat-miss framing; if absent, run observational (report ACoS as-is, do not frame vs a target).

Never block on this step — confirm-as-is is always available.

---

## Step 1 — Load Pre-Fetched Data

**Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.

Read the data artifact — **prefer the `.md` file** (pre-formatted markdown tables, no parsing overhead):
```
~/.mixshift/clients/<brand-slug>/runs/mx-monthly-report/<run_date>/data.md
```
Fallback to `data.json` only if the `data.md` file is absent or capped.

This file contains pre-executed results for all queries, keyed by query ID:
- `MPR-01` — VC account-level monthly metrics (sellermonthmetric): `ad_spend, ad_sales, orders, acos, ops` for curr_month, prior_month, and prior_year_month
- `MPR-02` — SC account-level monthly metrics (campaignmetric with attribution CASE block): `ad_spend, ad_sales, orders` for the reporting period with 7d/14d attribution split by campaign type
- `LIB-PT-01` — Price test query (conditional — present only when `structural_events` includes an active price_test): `asin, total_sales, units` for tested vs. untested sub-lines

Only one of MPR-01 or MPR-02 will be populated per run. The pre-fetch script runs both; the model uses whichever applies to the account type.

All queries share the join key: `(SellerID, month)` at account level.

**If the artifact is missing:** Run prefetch now — do not stop and ask the user:
```bash
mixshift prefetch --brand <brand-slug> --skill mx-monthly-report --date <YYYY-MM-DD>
```
Use brand-slug derived from the brand context path and today's date as run_date. Wait for completion, then read the artifact and continue.

### Step 1a: Join Pre-Fetched Query Results

Join pre-fetched query results on the shared key to produce one unified monthly record per row. Use MPR-01 for VC accounts; MPR-02 for SC accounts.

**Determine account type first — then use correct data path:**

| Account type | Ad metrics source | Revenue/Units source |
|---|---|---|
| VC (Vendor Central) | MPR-01 (sellermonthmetric) | vendor_sales_manufacturing_asin (included in MPR-01) |
| SC (Seller Central) | MPR-02 (campaignmetric CASE attribution block) | business_reports_dpst_date (included in MPR-02) |

The 7d/14d CASE block in MPR-02 is the canonical SC attribution rule. It must match `context.yaml::attribution_rule.per_campaign_type` for every client. If they diverge, fix the YAML — do not patch the SQL inline.

**Computed metrics:**
- ACOS = ad_spend / ad_sales * 100
- TACOS = ad_spend / ops * 100
- AOV = ad_sales / orders

**Cross-check:** After computing blended ACOS, verify it matches MixShift platform output. If diverges >0.2 pts, stop and check attribution window.

---

## Step 2 — Parse Screenshot Data

The brand owner provides screenshots for:
1. MoM item group bridge — item group OPS, deltas, ACOS, TACOS
2. Forecast file — projected OPS vs actual, beat/miss by month
3. Prior report (if new template features needed)

Extract all numeric values exactly. Do not round or infer. If conflict with DB totals, surface before writing.

---

## Step 3 — Compute Derived Metrics

```python
# MoM deltas
ops_delta = mar_ops - feb_ops
ops_delta_pct = ops_delta / feb_ops * 100
acos_delta_pts = mar_acos - feb_acos
tacos_delta_pts = mar_tacos - feb_tacos

# YoY deltas
ops_yoy_delta = mar_ops - mar_prior_ops
ops_yoy_pct = ops_yoy_delta / mar_prior_ops * 100

# Beat/miss vs forecast
beat_delta = actual_ops - projected_ops
beat_pct = beat_delta / projected_ops * 100
```

Format all deltas per `report-template.md` formatting rules before writing.

---

## Step 4 — Write the Report

**Begin output immediately. Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.**

Follow the structure and voice rules in `report-template.md` exactly.

**Key checks before finalizing:**
- [ ] Bottom line: conclusion first, mechanism second
- [ ] All change figures consistently signed and truncated (+$3.9K)
- [ ] Units and sessions growth in same format (both %)
- [ ] Volume leader identified correctly from item group OPS totals
- [ ] ACOS driver named directly
- [ ] No sessions column in item group table
- [ ] Forward events in future tense

---

## Step 4.5: Capture the Story Behind an Unexplained Swing

When the draft surfaces a MoM or YoY swing the data alone does not explain (a spend or ACOS jump, an OPS gap versus forecast, a launch-shaped ramp), do not invent a cause (Anti-Fabrication rule 11). Ask the brand owner directly, one plain question per swing that names the metric and window: "What happened here?"

If they name a real cause (a promotion or Prime Day, a stockout, a PR or press moment, a price test, a content or strategy change), record it as a DECLARED stake on the brand timeline so the next report already knows the story and does not have to re-ask:

```bash
mixshift timeline add --brand <brand-slug> \
  --kind structural.<what> \
  --category <best-fit> \
  --source declared \
  --interpretation "<the cause, in the owner's words>" \
  --ts <window-start-ISO> [--end <window-end-ISO>] \
  [--affects marketplace:US] [--affects asin:B0XXXXXXXX]
```

- `--category` is the typed enum; pick the closest fit: `promotional_window` (a promo or Prime Day), `stockout`, `price_test`, `launch`, `content_change`, `strategy_change`, `media_spike` (a PR or press moment), `platform_external`. Full set: `brand_migration`, `media_spike`, `media_spike_recurring`, `portfolio_decision`, `promotional_window`, `promotional_window_recurring`, `stockout`, `price_test`, `launch`, `content_change`, `strategy_change`, `platform_external`.
- `--kind` is `structural.<what>` (free-form, e.g. `structural.promo`, `structural.stockout`); `--category` carries the typed meaning.
- `--source declared` marks it as owner-asserted, not a model guess. `--interpretation` is required and holds what the swing meant.
- `--ts` is the window start; add `--end` for a ranged event (a multi-day promo, a stockout that has since cleared). `--affects` is repeatable and scopes the stake to a marketplace or ASIN when the owner names one.

The command prints the new event id and reports the stake as `unverified`; that is expected on create.

Then cite the stake in the narrative where the swing appears: name the cause and attribute it to the owner, hedged per rule 12 (e.g. "the April OPS lift is consistent with the brand-confirmed Easter promotion, April 8 to 14"). This in-context capture is what separates an annotation layer the team keeps using from one it abandons: the answer becomes a durable record every future report reads.

If the owner does not know or does not answer, do not write a stake and do not assert a cause; describe the pattern and move on per rule 11. This step never blocks delivery.

---

## Step 5 — Pre-Publication Review Gate (MANDATORY)

### Pass 1: Substantiation Review
For every causal claim ("X drove Y"), confirm it's supported by DB data or brand owner context.
Remove claims relying on inference or general knowledge.

### Pass 2: Language ("Squish") Review
Remove "squishy" language: "meaningfully," "significant," "dominant signal," "clean result," "primary vehicle."
Replace with specific data values.

This two-pass gate is a hard requirement before Step 6.

---

## Step 6 — Build and Deliver the Report

Compose the report as **HTML** — the canonical deliverable (a monthly HTML report; manifest artifact `monthly-report.html`, type `report_html`).

Save the report to the brand's local reports directory using the Write tool:
```
~/.mixshift/clients/<brand-slug>/reports/<YYYY-MM>/monthly-report.html
```

The `<YYYY-MM>` segment is the reported month, not the run wall-clock date — e.g., the March 2026 report lives under `reports/2026-03/`.

If `context.yaml::delivery.reports_local_dir` is set, save there instead. Honor that override.

Inspect the most recent prior sidecar under `~/.mixshift/clients/<brand-slug>/runs/mx-monthly-report/` to spot config or verdict drift before publishing.

---

## Step 7 — Update Brand Context File

After report is published, append to the brand's monthly_report_outs section:

```markdown
## [Month] [Year] Monthly Report — Key Numbers
- OPS: $X.XK | Spend: $X.XK | ACOS: X.X% (MoM Δ: X.X pts) | TACOS: X.X%
- vs Forecast: +/-$X.XK, +/-X.X%
- Top item group: [name] $X.XK (+/-$X.XK)
- Notable: [one-line summary of the month's key story]
```

---

## Self-Review Checklist

- [ ] Audience flag set (internal/client)
- [ ] Account type confirmed (SC/VC)
- [ ] All metrics source-verified (DB or screenshot)
- [ ] No em dashes in prose
- [ ] No "blended ACOS"
- [ ] All deltas signed
- [ ] MoM/YoY labels on every delta
- [ ] Item group totals cross-checked vs DB
- [ ] Substantiation review passed
- [ ] Language review passed (no squishy language)
- [ ] Forecast beat/miss included where available
- [ ] Efficiency framing used the resolved `acos_target` (Step 1.5); if absent, framed observational (ACoS as-is, not vs a target)
- [ ] Unexplained MoM/YoY swings: owner asked, any named cause recorded as a declared stake (Step 4.5) and cited in the narrative

---

## Step 8 — Emit Run Sidecar (canonical, drift-detection input)

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. Sidecars live at `~/.mixshift/clients/<brand-slug>/runs/mx-monthly-report/<data-date>-<run-id>.json`. Schema source of truth: `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`.

Use the **last day of the reported month** for `data_date` (e.g., `2026-03-31` for the March report), not the run wall-clock date.

Compose the input JSON (write to a temp file, then invoke the harness). Pick MPR-01 for VC or MPR-02 for SC — never both:

```jsonc
// /tmp/mpr-sidecar-input.json
{
  "skill": "mx-monthly-report",
  "skill_version": "1.4.0",
  "brand_slug": "<brand-slug>",
  "run_kind": "per_account",
  "data_date": "YYYY-MM-DD",
  "verdict": "GREEN|YELLOW|RED|OBSERVATIONAL",
  "context_snapshot": {
    "account_type": "SC|VC",
    "seller_id": 0,
    "primary_metric": "ACOS|TACOS",
    "acos_target_pct": 20,
    "attribution_window_days": 14,
    "tacos_goal_pct": 8,
    "reporting_audience": "client|internal"
  },
  "headline_metrics": {
    "total_spend_curr_month": 0,
    "total_ad_sales_curr_month": 0,
    "total_ops_curr_month": 0,
    "acos_blended": 0,
    "acos_mom_pct_delta": 0,
    "acos_yoy_pct_delta": 0,
    "tacos_blended": 0,
    "ops_mom_pct_delta": 0,
    "ops_yoy_pct_delta": 0,
    "forecast_beat_pct": 0
  },
  "sql_calls": [
    // VC: MPR-01 only
    {"id": "MPR-01", "params": {"seller_id": 0, "curr_month": "YYYY-MM-01", "prior_month": "YYYY-MM-01", "prior_year_month": "YYYY-MM-01"}}
    // SC alternate (replace MPR-01 entry):
    // {"id": "MPR-02", "params": {"seller_id": 0, "prior_month_start": "YYYY-MM-01", "current_month_end": "YYYY-MM-DD"}}
  ],
  "artifacts": {
    "report_html_path": "~/.mixshift/clients/<brand-slug>/reports/<YYYY-MM>/monthly-report.html"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/mpr-sidecar-input.json
```

**Verdict rule:** `GREEN` = on or ahead of pace (vs forecast / monthly target). `YELLOW` = pacing within 10% of target. `RED` = pacing >10% behind target. `OBSERVATIONAL` = first month for a new account or insufficient prior-year data; no MoM/YoY claims made.

Sidecars accumulate read-only for retrospective inspection. Compare the current file with the most recent prior run when drift context matters.


## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-monthly-report
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-monthly-report --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-monthly-report --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
