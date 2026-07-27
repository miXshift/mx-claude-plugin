---
title: "Universal Rules for Causal Analysis Skills"
brain: domain
owner: mixshift
status: active
created: 2026-03-19
updated: 2026-07-27
tags: [domain, methodology]
---

# Universal Rules for Causal Analysis Skills
**Status:** Active
**Owner:** MixShift
**Created:** 2026-03-19
**Updated:** 2026-04-06
**Validated by:** the operator (see individual rule dates)
**Applies to:** All structured skills in the intelligence layer that perform bridge-style causal analysis (health check, runaway spend, keyword bid health, and any future skill in this family)

> ⚠️ **Scope note:** These rules govern the execution of structured intelligence layer skills. "Bridge methodology" in this document refers to the causal attribution methodology — bridge calculations, deterministic decomposition, TACOS attribution. Skills that do not perform bridge calculations (e.g., ST negation, harvest extraction) are not bridge-methodology skills — they are structured intelligence layer skills. See `intelligence-layer-definition.md` for the full terminology.

> ⚠️ **This is the canonical home for universal rules.** Do not copy these rules into individual SKILL.md files. Reference this document by section instead. If a rule exists here and in a SKILL.md, the SKILL.md version is the duplicate — update or delete it.

---

## 1. Causal Integrity — Non-Negotiable

**Never assert a causal explanation without data that directly supports it.**

This is not just analytical honesty — it is IP integrity. MixShift's patent (App. No. 19/070,768) specifically claims attribution via "deterministic functional relationships, rather than probabilistic statistical inference." Every skill output is a representation of that claim.

**What is permitted:**
- Describe the data pattern: *"ACOS rose 4pp vs. T-30; spend was flat"*
- Label hypotheses explicitly: *"spend mix may have shifted toward Headline Search — campaign-level confirmation needed"*
- State when causation is indeterminate: *"cause is not determinable from available data"*

**What is prohibited:**
- Stating as fact: *"Thursday volume pullback," "seasonal demand shift," "competitive pressure"* without supporting data in the current run
- Using brand context as a causal lookup table — brand context files explain account structure and history; they do not authorize causal explanations for observed data movements unless the current run's queries directly confirm the link
- Writing any sentence with a causal connector ("because," "due to," "consistent with," "driven by") unless the supporting data was queried in this run and is in scope

**When cause is indeterminate:** Describe the pattern. Stop. State what data would confirm the hypothesis. Do not fill the gap with plausible narrative.

**Validated:** domain expert, 2026-03-05. Patent ref: App. No. 19/070,768.

---

## 2. Structural Event Baseline Check

Before citing T-30 as a clean reference baseline for any metric conclusion, cross-reference brand context for known structural events occurring within the T-30 window.

**Structural events that contaminate a T-30 baseline:**
- Stockouts on key ASINs
- Account suspension (partial or full)
- Active price tests on material item groups
- Significant promotional spikes (Easter, Prime Day, etc.)
- Bid pullback initiations (suppresses T-30 spend mean, making CI fire more easily)
- Agency onboarding or major restructure

**When a structural event is present:**
1. Name the distortion explicitly in the relevant section
2. Use T-7 as a cleaner comparison where available
3. In the Bottom Line, name the event and its effect on baseline reliability
4. Never present a structurally contaminated T-30 as a clean historical baseline

**Principle:** Technically accurate data cited for a conclusion it does not cleanly support is a reasoning error — not an analytical one.

**Validated:** domain expert, 2026-03-06.

---

## 3. Run Continuity — Bid Action Awareness

Before surfacing any flag or composing narrative for any dimensional section, complete the following two checks:

**Check 1 — Runs archive:** Read `~/.mixshift/clients/[brand-slug]/runs/` for skill runs in the last 7 days. Know what skills ran and what recommendations were made.

**Check 2 — Actions Log:** Read the brand context "Account Actions Log" for confirmed bid or budget changes in the last 7 days.

**Application:**
- Bid changes take 24-48 hours to appear fully in data
- A spend spike or CPC increase on a keyword that recently had its bid raised is the bid action working — not a runaway event
- When recent bid actions are confirmed, attribute spend or ACOS shifts to those actions before invoking any other explanation
- If change history is unavailable and a bid health run occurred in the prior 3 days: note in the relevant section "Bid adjustments from [date] Bid Health Review may be visible in this period"
- Do not flag a keyword as runaway solely on a single-day spike if that keyword is known to have received a recent bid increase — flag it as "bid-action context — monitor 3-day trend before acting"

**Validated:** domain expert, 2026-03-06.

---

## 4. No Day-of-Week Assumptions

Never attribute T-1 performance to the day of week without data that directly supports it.

**Prohibited patterns:**
- "Low-volume Sunday"
- "Strong Monday"
- "Typical Thursday traffic"
- Any day-of-week characterization that is not explicitly documented in brand context or demonstrated in T-30 daily data for this account

**Permitted:** When single-day conversion counts are low, describe the volume directly: "2 orders on $53 spend." Do not explain it with a calendar pattern.

**Validated:** domain expert, 2026-03-09.

---

## 5. ACOS vs. TACOS Distinction

These are distinct metrics. Always name the one you mean. Never conflate them.

- **ACOS** = Ad Spend / Ad Sales. Advertising efficiency metric. Keyword-level and campaign-level.
- **TACOS** = Ad Spend / Total Sales (organic + ad). Account-level business efficiency metric. Re-entry signal.

**Rules:**
- TACOS direction: lower = better. "Below target" = ahead of goal. "Above target" = behind goal.
- Never use ACOS when you mean TACOS, or vice versa, in any section
- The Bottom Line of the health check requires both — TACOS for the re-entry signal, ACOS for the ad efficiency read
- TACOS is always a lagged metric (T-2 on SC). Never compute TACOS from T-1 figures — state the lag explicitly

---

## 6. Brand Context Consumption Rules

Brand context files (`shared/clients/[brand-slug].md`) are Tier 3 — account-specific truth. Universal rules about how to consume them:


**Brand context is not a causal lookup table.**
The brand context file documents account structure, history, and confirmed conditions. It does not authorize you to state that a condition caused a data movement unless the current run's queries directly confirm the link. "Brand context says this account has stockout seasonality" is not evidence that the current data movement is caused by a stockout — you still need the data.

**Upcoming events vs. active events:**
- Describe a promotional event as "upcoming" until the launch date passes
- Do not use "active" for a promo that hasn't launched
- Promo end dates and evaluation checkpoints must come from brand context — never assumed from prior session discussion

**No regurgitation:**
Use brand context to inform analysis. Never recite it back to the reader. "As noted in brand context..." is noise. The reader does not need the source cited — they need the insight.

---

## 7. ACOS/TACOS Calculation Method

**Universal rule:** Always SUM(spend) / SUM(sales) from period totals. Never average daily ratios.

**Period ratio math:**
- T-7 ACOS = SUM(7-day spend) / SUM(7-day sales) × 100
- T-30 ACOS = SUM(30-day spend) / SUM(30-day sales) × 100
- NOT: average of 7 daily ACOS values, or average of 30 daily ACOS values

**Why:** Daily ACOS values on zero-sale days are undefined (division by zero). Averaging ratios with undefined days produces meaningless results. Period ratio is always correct.

---

## 8. CI Methodology — Keyword-Level Ratio Metrics

**For any keyword-level ratio metric (ACOS, CPC, conversion rate) where zero-denominator days are possible: use rolling 7-day window P90.**

**Method (validated 2026-03-09):**
1. Compute 24 rolling 7-day windows over T-30 (sliding by 1 day each)
2. For each window: `ACOS_w = Σcost_w / Σsales_w`
3. Zero-sale windows: impute at `T-30_ACOS × 3` (worst-case, anchored to keyword baseline)
4. CI Upper = P90 of all valid window values

**Sanity check (mandatory before deploy):** CI Upper ACOS must be ≥ T-30 ACOS. If not, the methodology has an error — stop and fix before deploying.

**For additive metrics (spend, impressions, clicks):** Daily P97.5 across T-30 is correct.

**For campaign-level ratio metrics (not keyword-level):** Rolling window preferred; daily P97.5 is acceptable when zero-sale days at campaign level are rare (they typically are).

**Full standard:** `shared/playbook/ci-methodology-standard.md`

**Validated:** domain expert, 2026-03-09.

---

## 9. Timing and Data Readiness

**Universal rule for all bridge-methodology skills:** Data must be complete before running.

- Do not run before 8:00 AM in the account's local time zone
- For PST-scheduled crons: 6:30 AM PST covers MST accounts
- SC data: business_reports_dpst_date typically complete by 05:00 AM PST
- VC data: check the ops table for the last available date before assuming data is current

**Multi-day runs (e.g., Monday covering Friday + Saturday + Sunday):** Generate one report block per day. Do not aggregate across days.

---

## 10. Prior Run Read — Phase 0

Before building any skill output, read the most recent prior run for the same skill.

**Purpose:** Two things. First, structural drift anchor — compare your output format to the prior run to catch format drift before it reaches the reader. Second, continuity — know what recommendations were made, which were actioned, and whether actioned recommendations are showing expected results.

**How to find the prior run:** Read the brand context for `delivery.local_reports_dir`. The prior HTML file is the source — always read the actual file, never substitute memory of what you think it contains.

**Prior day trend comparison rule:** If comparing today's T-1 against any prior day's performance, the prior day ACOS must come from a fresh DB query on that settled date — not from the prior run's HTML T-1 capture. HTML T-1 values reflect the data state at time of that run (open attribution window), not settled values.

**Validated:** F-007 (prior run substituted with memory) is the specific failure mode this prevents.

---

## How SKILL.md Files Should Reference This Document

In each SKILL.md, replace the full rule block with a one-line reference:

```markdown
> Causal Integrity: see references/universal-rules.md#1-causal-integrity--non-negotiable
> Structural Event Check: see references/universal-rules.md#2-structural-event-baseline-check
> CI Methodology: see references/universal-rules.md#8-ci-methodology--keyword-level-ratio-metrics
```

The model loads this file just-in-time at the phase where the rule applies — not in bulk at session start. Loading a 400-line SKILL.md with embedded copies of every universal rule is the architecture that produces drift. Loading a focused SKILL.md that references this file keeps the model's working context small and the rules authoritative.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-03-19 | Created. Consolidated from 3 SKILL.md files (health-check v1.6, runaway-spend v1.5, mx-keyword-bid-health v1.7). Author: MixShift. |
| 2026-07-27 | Retitled and file renamed; internal methodology codename replaced with product-neutral bridge terminology. Self-reference paths updated to references/universal-rules.md. |
