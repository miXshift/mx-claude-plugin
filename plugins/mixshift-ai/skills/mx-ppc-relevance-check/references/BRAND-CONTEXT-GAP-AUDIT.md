# Brand Context Gap Audit
**Date:** 2026-04-01
**Author:** MixShift
**Schema reference:** BRAND-CONTEXT-SCHEMA.md
**Purpose:** Identify which brands have gaps against the canonical schema, and which would benefit most from a cold start re-run.

---

## Summary

| Brand | Schema Coverage | Cold Start Re-run Priority | Biggest Gap |
|---|---|---|---|
| example brand | ~85% | Low | Objective config, actions log completeness, brain inputs |
| example brand | ~80% | Medium | Objective config, revenue baseline needs refresh, some brain inputs |
| example brand | ~70% | **HIGH** | Actions log missing, objective config missing, delivery config incomplete |
| example brand | ~75% | Medium | Objective config missing, spend posture thin, brain inputs empty |

---

## example brand — Gap Analysis

### Schema Coverage: ~85% — Most complete file

**Present and correct:**
- Identifiers ✅
- Account type & attribution (including backfill calibration) ✅
- Performance targets (ACOS target, scale threshold, quarterly targets) ✅
- Product portfolio & item groups (comprehensive) ✅
- Brand terms ✅
- Structural events (comprehensive timeline) ✅
- Spend posture ✅
- Account actions log ✅
- Seasonality profile ✅
- Revenue baseline (14 months) ✅
- ST negation rules (comprehensive) ✅
- ASIN identity fit rules (comprehensive, with training set) ✅
- Delivery config ✅

**Gaps (P1/P2):**

| Section | Gap | Severity | Note |
|---|---|---|---|
| Objective Configuration (§4) | Not present | P1 | example brand has multiple campaign objectives (efficiency, growth/awareness for Fahlo lines, launch state for new lines). Currently all evaluated as efficiency. Add objective overrides for Fahlo lines and Spartan in pullback. |
| Account Actions Log | Bid magnitudes missing | P1 | Multiple entries say "specific magnitude not captured." Change History API integration is the fix, but until then the log is partially blind on bid sizes. |
| Brain Inputs (§15) | Empty | P2 | No Discord feedback log, no call transcripts, no monthly report annotations. Will fill organically. |
| Revenue baseline | Needs refresh | P2 | Last updated 2026-03-06. Mar + Apr 2026 data now exists. Refresh on next cold start pass. |
| ProfileID | Not in file | P1 | Required for write layer (Amazon Ads API). Needs to be added before Epic B/C executes. |

**Brand setup re-run recommendation:** Low priority — file is comprehensive. One targeted update session to add objective config and ProfileID would close the critical gaps without needing a full re-run.

---

## example brand — Gap Analysis

### Schema Coverage: ~80% — Well-built, some structural gaps

**Present and correct:**
- Identifiers (SellerID, SellerName, account type) ✅
- Account type & attribution (including VC-specific rules and backfill calibration) ✅
- Performance targets (ACOS target, sub-brand ACOS targets) ✅
- Sub-brand structure ✅
- Product portfolio by sub-brand (comprehensive) ✅
- Structural events (FreshTab 12ct CRAP cycle, Glacier legacy wind-down) ✅
- Revenue baseline ✅
- Seasonality — partial ✅
- ST negation rules — present (from sessions) ✅
- Delivery config ✅

**Gaps (P1/P2):**

| Section | Gap | Severity | Note |
|---|---|---|---|
| Objective Configuration (§4) | Not present | P1 | example brand runs brand defense, awareness (upper funnel), and efficiency campaigns. FreshTab has different ACOS dynamics than example brand Core. Without objective config, the skill applies efficiency logic to awareness/brand-defense campaigns. |
| Spend posture (§8) | Present but thin | P1 | Posture noted in some session context but not formalized in the file. Needs: current posture, re-entry trigger, house-on-fire threshold. |
| Account Actions Log (§9) | Incomplete | P1 | Some bid history from sessions exists but has not been consistently committed to the actions log section. Needs a formal log section. |
| Brand terms (§6) | Not formalized | P1 | Brand variants, example brand sub-brand terms, FreshTab, example brand — not in a formal brand terms section. example brand has complex brand term landscape (parent + sub-brands + legacy Glacier). |
| ProfileID | Not in file | P1 | Required for write layer. |
| Brain Inputs (§15) | Empty | P2 | |
| Revenue baseline | May need refresh | P2 | Last updated 2026-03-23. Confirm whether Apr data needs to be added. |

**Brand setup re-run recommendation:** Medium priority. The file has a solid foundation but is missing objective config and a formal brand terms section — both would meaningfully improve skill output quality. A targeted partial cold start (Phase 2 AM intake + Phase 0 brand terms) would close the gaps without a full Phase 1 re-run.

---

## example brand — Gap Analysis

### Schema Coverage: ~70% — Strong on brand/competitive knowledge, weak on operational skill requirements

**Present and correct:**
- Identifiers (partial — no ProfileID) ✅/⚠️
- Account type & attribution (including DSP vs. sponsored attribution distinction) ✅
- Performance targets (brand/nonbrand ACOS split, revenue goal) ✅
- Product portfolio (product line taxonomy) ✅
- Brand terms ✅
- Competitive set and positioning (exceptionally detailed) ✅
- Seasonality ✅
- Revenue baseline (partial — some months) ✅
- ST negation rules (partial) ✅

**Gaps (P1/P2):**

| Section | Gap | Severity | Note |
|---|---|---|---|
| Account Actions Log (§9) | MISSING | **P0** | No actions log exists in the example brand file. Skills will re-recommend in-flight changes and misread intentional bid changes as anomalies. This is the highest-severity gap. |
| Objective Configuration (§4) | Not present | P1 | example brand has brand defense, acquisition/nonbrand, DSP (view-attribution), and potentially awareness campaigns. No objective overrides defined. |
| Spend posture (§8) | Not formalized | P1 | Current posture not explicitly stated. Re-entry trigger not defined. |
| Structural events (§7) | Thin | P1 | SKU history (UDM rebrand) is captured, but no formal event timeline. Promo calendar noted but not in structured format. |
| Attribution backfill calibration | MISSING | P1 | No T-1 vs T-7/T-14 calibration for example brand SP. The attribution rules section mentions 7-day SP but no empirical calibration data. |
| ProfileID | Not in file | P1 | |
| ASIN identity fit rules (§13) | Not present | P2 | Negation training set doesn't exist for example brand. Would benefit significantly from a Phase 2 training session. |
| Drive file IDs (§14) | Unclear | P1 | Delivery config section may be incomplete — Drive IDs for individual report files not confirmed. |
| Brain inputs (§15) | Empty | P2 | |

**Brand setup re-run recommendation: HIGH PRIORITY.** The actions log is missing entirely, attribution calibration is absent, and objective config doesn't exist. These three gaps together mean every skill run on example brand is operating without critical inputs. A full brand setup re-run (or at minimum a targeted Phase 0 intake + Phase 1 attribution calibration + actions log initialization) is needed before the next production skill run.

---

## example brand — Gap Analysis

### Schema Coverage: ~75% — Good operational foundation, missing newer methodology fields

**Present and correct:**
- Identifiers (SellerID, AmazonSellerID, ProfileID) ✅
- Account type & attribution (including backfill calibration) ✅
- Performance targets (TACOS goal, ACOS target, scale threshold) ✅
- Product portfolio (item groups, known inventory flags) ✅
- Structural events (stockouts, TACOS target reset) ✅
- Revenue baseline (14 months) ✅
- Campaign type reference ✅
- ST negation rules (partial) ✅
- Delivery config ✅

**Gaps (P1/P2):**

| Section | Gap | Severity | Note |
|---|---|---|---|
| Objective Configuration (§4) | Not present | P1 | example brand has SB running at ~99% ACOS structurally — this is brand awareness, not efficiency. Without objective config, the health check and bid health skills flag SB as a chronic bleed requiring intervention. |
| Spend posture (§8) | Present but thin | P1 | Posture context exists in sessions but not formalized in the file. Operating philosophy ("breakeven + brand recognition") is documented but re-entry trigger and house-on-fire threshold are not defined. |
| Account Actions Log (§9) | Incomplete | P1 | Some bid history from sessions exists but the formal log section is sparse. |
| Brand terms (§6) | Not formalized | P1 | example brand brand terms and variants not in a formal section. NFC category has complex brand term landscape. |
| ASIN identity fit rules (§13) | Not present | P2 | No negation training set for example brand — NFC category has many wrong-context ASIN matches that would benefit from a training session. |
| Brain inputs (§15) | Empty | P2 | |

**Brand setup re-run recommendation:** Medium priority. Objective config for SB campaigns is the most impactful missing piece — it's causing false positive intervention recommendations every health check run. A targeted Phase 0 intake + objective config session would close that gap. Full cold start not needed.

---

## Cold Start Priority Queue

1. **example brand — HIGH** — actions log missing (P0), attribution calibration missing (P1), objective config missing (P1). Do before next production run.
2. **example brand — MEDIUM** — objective config (P1), brand terms (P1), actions log incomplete (P1). Partial re-run.
3. **example brand — MEDIUM** — objective config for SB (P1), brand terms (P1). Targeted intake session.
4. **example brand — LOW** — objective config (P1), ProfileID (P1). One update session, not a re-run.

---

## Standard Questions for AM Intake (gap-closing)

These are the questions to ask in Phase 2 of cold start (or a targeted gap-fill session) to close the P1 gaps that DB queries can't answer:

**Objective Configuration:**
1. Which campaign groups are intentionally running above the ACOS target? (Growth/launch mode, not a bleed)
2. Which campaigns are brand defense — managed to impression share, not ACOS?
3. Which campaigns are awareness-only (SB/SD/DSP) — evaluated on DPV and NTB rate, not ACOS?
4. What does the account ACOS need to be before you'd recommend budget cuts instead of bid cuts? (house-on-fire threshold)

**Spend Posture:**
5. What is the current posture — are we growing, holding, or pulling back?
6. What data signal triggers a posture change? (specific metrics, not a date)

**Structural Events:**
7. Any management transitions, agency changes, or strategy pivots in the last 12 months?
8. Any known stockouts, price tests, suspensions, or product line changes in the last 12 months?
9. Any upcoming promotions or events in the next 60 days?

**Attribution:**
10. [For accounts without calibration data] Can we run a T-1 vs T-7/T-14 SP calibration query on the last 90 settled days?

**Brand Terms:**
11. What are all the ways customers spell or search for your brand? (including misspellings, sub-brands, phonetic variants)
12. Any proprietary coined terms that are gaining organic search traction?

---

*This audit should be updated after each cold start re-run. When a gap is closed, mark the field as present in the gap table.*
