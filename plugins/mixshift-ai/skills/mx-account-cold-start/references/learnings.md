# Account Cold Start — Documented Learnings & Patterns

Patterns discovered during completed cold start runs. Reference these during Phase 1 data interpretation.

## SC Column Naming Validation

- `business_reports_dpst_date` column names: `DateTime`, `SalesAmount`, `UnitsOrdered`, `Sessions` — NOT `date`, `ordered_product_sales`, `units_ordered`
- Query 2 validated 2026-03-06; update this note if column names change in the source system

## SC Item Group Extraction from Campaign Names

- SUBSTRING_INDEX parse of CampaignName is approximate
- Same product line may appear under multiple campaign name suffixes
- Always validate extracted item groups against known item group names from the AM
- Aggregate for reporting; do not trust the parse alone for critical analysis

## Multiple Rows Per Day Per Keyword Safeguard

- Due to multiple ProfileIDs, raw row counts in `keywordtargetingmetric` inflate day counts
- Always aggregate to daily totals in an inner query before counting days
- This applies to any daily-frequency analysis of `keywordtargetingmetric`
- Discovered during runaway spend skill build

## Stockout Interpretation Rule

- When a typically strong month shows flat or declining revenue, cross-reference with Phase 0 known stockouts before inferring demand weakness
- For inventory-constrained businesses (all profits reinvested), stockouts are recurring structural events
- Encode confirmed stockout windows in Tier 3 explicitly
- Do not interpret as demand weakness without confirming via Phase 0 context

## High SP Other-SKU Rate Pattern

- For accounts with broad shared detail pages and many color/style variants, SP other-SKU attribution running at 50-65% is structurally expected
- Do not interpret as unusual cross-sell behavior without checking variant structure
- Account-level ACOS is the correct management metric; ASIN-level TACOS is unreliable

## Coined Brand Terms in Auto Search Term Data

- If the AM has coined a proprietary term that customers are searching for, it may appear in DISC auto search term reports before being directly targeted
- Note in brand term dictionary with "organic traction signal" flag
- This indicates the term is gaining organic search traction without paid targeting

## TACOS-to-ACOS Derivation Formula

When AM provides TACOS target and not ACOS target:

```
Ads % of Sales (3-month trailing) = SUM(Ad Sales) / SUM(Total Sales)
ACOS target = TACOS target / Ads % of Sales
Scale threshold = (TACOS target - 10pts) / Ads % of Sales
```

Note derived values in Tier 3 file with "(derived — confirm with the operator)" label. Review quarterly — the ratio can shift with organic traffic volume.

## Ads % of Sales Stability Rule

- The derivation formula can be correct while the underlying ratio is unstable
- Monthly Ads % of Total Sales can swing 14+ points across the year
- When that ratio is volatile, treat derived ACOS targets as a working proxy, not a fixed truth
- Review phase 2 and encode the seasonality in the goals block

## Campaign Label ≠ Product Line Code

- Do not assume campaign label matches the short code in the product line table
- Example: HCDM is labeled "SUPERFUEL" in campaign names
- Confirm mapping with AM before encoding item group taxonomy
- Same risk exists for any "seasonal rotation" campaign where contained products change without campaign rename

## Attribution Window Improvement Points (VC Accounts with Large Swings)

**When improvement_pts > 3pts, flag as "large-swing VC" in Tier 3.**

The improvement_pts value (e.g., 4.42pts for one account, 6.91pts for another, 7.24pts for another) is the fresh T-1 day correction only. It describes how much a single newly-created day improves from its first read to fully settled.

**DO NOT apply improvement_pts uniformly to MTD ACOS.** MTD is a blend of days at different settlement stages. Applying the full fresh-day correction to MTD overcorrects materially — especially mid-to-late month.

**Correct weighted MTD settlement formula:**
```python
# For each day d in the MTD window:
#   days_elapsed = (last_available_data_date - d).days
#   settlement_fraction = min(days_elapsed / attribution_window, 1.0)
#   remaining_improvement = (1.0 - settlement_fraction) * improvement_pts
# Then:
#   avg_remaining_adj = mean(remaining_improvement across all MTD days)
#   mtd_acos_settled = mtd_acos_raw - avg_remaining_adj
```

**Correct T-1 verdict formula:** Apply full improvement_pts only to T-1 day — that day is fresh. `acos_t1_adj = acos_t1_raw - improvement_pts`

Attribution window by account type:
- SC Sponsored Products = 1-day vs 7-day
- SC Sponsored Brands = 1-day vs 14-day
- VC Sponsored Products = 1-day vs 14-day

## VC Monthly Metric Coverage Check

Before surfacing account-level monthly reports:

```sql
SELECT COUNT(*), MIN(DateTime), MAX(DateTime) 
FROM sellermonthmetric 
WHERE SellerID = [ID]
```

If populated (count > 0): record in Tier 3 `sellermonthmetric_available: true`
If empty: record `false` — monthly reports must use raw campaignmetric aggregates and restatement gap will apply

## ASIN Negation Corpora (Phase 2 acceleration)

Cold start Phase 1 should pull two ASIN training corpora that directly accelerate Phase 2 (ASIN negation review) judgment quality:

1. **Manual targeting corpus by item group** — Pull all ASINs currently in CONQ/PROF manual campaigns, labeled by CampaignName and ItemGroup. These are validated positive examples. Item-group segmentation is mandatory.

2. **Auto-campaign positive ASIN corpus** — Pull ASINs that have generated >= 1 conversion through auto/PAT campaigns (lifetime). These are ground-truth proven-positive examples.

Store both corpora in the Tier 3 brand context file under `## ASIN Negation Corpora` section. Without this, Phase 2 ASIN review starts cold and over-classifies adjacent PDPs as Irrelevant.

**ASIN negation irrelevance rule:** Irrelevance is BUYER REACHABILITY, not form factor match. Only structural mismatches (alt-health pseudoscience, wrong product category entirely, confirmed identity mismatch, bulk fundraiser packs) are irrelevant. Adjacent form factors in the same buyer intent space are relevant.

## Phase 2 AMA as Formal Follow-Up

Do not leave Phase 2 context collection as informal exploration. After Phase 1 completes:

1. Compile the specific questions the data raised that Phase 0 did not explain
2. Route these as a formal short AMA (5-10 minutes) to the AM
3. Ask only those questions — do not run a generic intake form
4. Document AM responses in Phase 2 section of Tier 3 file

## Tentpole Calendar Check (ASP Anomaly Diagnosis)

Before flagging any month as a promotional anomaly from ASP alone:

1. Cross-check against the Amazon tentpole event calendar (Prime Day July, Big Deal Days Oct, BFCM Nov, etc.)
2. This should be the first diagnostic step before asking the AM

## Shell-First Deployment Rule

1. Deploy empty skill page shells before the operator reviews brand context
2. Do not publish live skill output until brand context is reviewed and confirmed
3. Correct gate: shells deployed → AM reviews brand-context → corrections applied → skill pages populated

## Account Manager vs Domain Expert Distinction

For third-party accounts:
- Account manager is the sign-off authority for content and context
- Domain expert is the process/methodology sign-off
- Route context questions to the AM; route methodology questions to the domain expert

## Progressive Design Principle (Client-Facing Output)

Cold start output that reads like a research appendix to a non-technical AM is not useful. Key translation layer rules:

- R², coefficients, and CI values need plain-language "so what" sentences
- Lead with the recommendation, not the methodology
- Detailed data and methodology should be an expansion/drill-down feature, not the default view
- Lead with the most important things to do and see
- Data nerds can expand for the math; everyone else gets the recommendation

---

## Account-Specific Cold Start Notes

### example brand (SC, 2026-03-06)

- Zero Reddit presence for early-stage brands is expected
- Third-party affiliate YouTube inclusion IS a traction signal — extract ASIN from affiliate links
- SC item group extraction from CampaignName is approximate — validate manually
- DSP traffic does not inflate sessions in `business_reports_dpst_date`
- Stockout interpretation rule: Phase 0 context confirmed inventory constraints

### example brand US (SC, 2026-03-10)

- TACOS-to-ACOS derivation: trailing Ads%Sales = 62.9% → ACOS target 79%, scale threshold 63%
- Ads % of Sales volatility: monthly range 48.7%–73.7% (stdev ~6.5pts) — treat derived ACOS targets as working proxy
- Campaign item group taxonomy gap: confirm mapping with AM (e.g., Tags, Metal vs. PhoneCard, Badge)
- Sessions anomaly: Anomalous session spikes (443K vs normal 14-19K) with CVR collapse = bot/scraper traffic — flag in brand context
- Inventory history is mandatory: use mws_inventory_history (not mws_inventory_health) for standard cold start diagnostic
- Multi-marketplace naming: include marketplace suffix (e.g., `example-brand-us-reports` not `example-brand-reports`)

### example brand Labs (SC, 2026-03-15)

- DSP session surge mechanism: when DSP ramps materially (58K–96K clicks/month), Sessions inflate and CVR compresses — encode in Tier 3 and annotate CVR reads
- Campaign label ≠ product line code: HCDM is labeled "SUPERFUEL" — confirm with AM before encoding item group taxonomy
- 50/50 same-SKU / other-SKU cross-sell: at this scale (multi-line fueling brand), 51% other-SKU is structurally expected — encode as baseline
- Ads % of Sales seasonal swing: 14pts across the year (24.6% Oct → 38.1% Jun) — monthly TACOS targets (not derived ACOS) are the correct management targets
- Phase 2 AMA follow-up: explicitly compile residual open questions and route to AM as formal short AMA

### example brand (VC, 2026-03-04)

- VC improvement_pts = 4.42pts (large-swing account) — weighted MTD formula is mandatory
- sellermonthmetric_available: true — use account-level monthly reports without restatement gap concern
- ASIN negation corpus: manual targeting corpus by item group is the validated positive training set
- Item-group segmentation: bracelet corpus ≠ cross corpus ≠ islander corpus — same ASIN can signal different intent in different lanes
- RP own ASINs appear in auto converters: filter B0CC/B0FR/B0BR prefix ASINs from competitor corpus
- LT spend $3–12 with zero conversions = insufficient data for negation decision

---

*Learnings compiled from 4 completed cold starts. Update this file as new patterns emerge.*
