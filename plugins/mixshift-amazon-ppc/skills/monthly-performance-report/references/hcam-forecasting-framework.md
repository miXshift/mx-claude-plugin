---
title: "Intelligence Layer: HCAM + Forecasting (Counterfactuals) Framework"
brain: domain
owner: mixshift
status: active
created: 2026-02-18
updated: 2026-04-06
tags: [domain, hcam, intelligence-layer, methodology, forecasting]
---

# Intelligence Layer: HCAM + Forecasting (Counterfactuals) Framework
*Source: the operator session 2026-02-09*
*Updated: 2026-04-06 — terminology aligned to intelligence-layer-definition.md*

> ⚠️ **Terminology note:** This document covers two distinct intelligence layer components: (1) **HCAM** — the patent-pending deterministic decomposition / bridge calculation methodology, and (2) **Counterfactuals / Forecasting** — the forecast and scenario modeling layer. These are separate components that work together. See `intelligence-layer-definition.md` for the full five-component intelligence layer definition.

---

## How These Two Components Work Together

HCAM and the forecasting layer are integrated intelligence layer components, not separate tools:

- **Forecasting** establishes the counterfactual baseline (what *should* have happened) using three core inputs: spend, trend, and seasonality
- **HCAM** provides deterministic decomposition when actual performance deviates from forecast
- The forecast creates the "expected" that makes HCAM's "actual vs expected" meaningful

## The Ad Coefficient

- Shows incremental sales from each additional ad dollar *net of cannibalization*
- Separates what ads actually drove vs what would have happened anyway (trend/seasonality)
- Enables intelligent capital allocation decisions (e.g., 3X stronger coefficient in Italy vs US = shift budget)
- Calculated at ASIN/Item Group level for granular insight
- See full article: `memory/documents/ad-coefficient-true-incrementality.md`

## Model Architecture

- Three core inputs: spend, trend, seasonality
- Uses 25 months of monthly data for sufficient degrees of freedom
- Employs sinosine seasonality calculation vs dummy months to preserve DF
- Achieves 80-90%+ model fits (91.9%+ R² demonstrated)
- Promotional events/press hits kept outside model to preserve signal quality — impact measured as forecast deviations

## HCAM Decomposition

- **Horizontal analysis**: Why did ACOS change? (CPC vs ConvR vs AOV)
- **Vertical analysis**: Where did it change? (Campaign/ASIN/Keyword + proportional impact)
- Deterministic, not statistical — prevents AI from making correlation leaps
- Puts AI "on rails" for structured explanation

## Investigation Workflows

Two pathways:
1. **Performance vs forecast anomalies** — actual deviates from predicted → trigger investigation
2. **Coefficient drift detection** — ad coefficient changes over time → signal market/competitive shift

### Real Example: German Market
- Consistent misses to forecast month over month
- Investigation revealed macro trend: entire market was softening
- Confirmed via press coverage and Amazon SQP data
- Brand wasn't losing share — market was shrinking
- This signal would be invisible in period-over-period reporting alone

### Amazon Off-Platform Spend Example
- Amazon pushed off-platform spend on Sponsored Product campaigns
- Model showed 2% miss to forecast
- After backing out inefficient off-platform spend: miss reduced to 0.1%
- Proved model can isolate external factors distorting performance

## DSP True Incrementality

- Amazon inflates DSP attribution metrics because they lack a counterfactual
- MixShift's forecasting model creates that missing counterfactual
- Can run model with and without DSP spend to see projection changes (holdout test approach)
- Enables true DSP incrementality measurement without relying on Amazon's inflated metrics

## Competitive Positioning

- **No one else combines deterministic decomposition with counterfactual forecasting** for ongoing business operations
- Google's CausalImpact is closest parallel but designed for discrete intervention analysis, not continuous attribution
- Position as "anti-attribution company" — contribution over credit
- Future AI interpreter becomes sustainable competitive moat (competitors build reporting, MixShift explains *why*)

## Canonical Strategy (Approved)

- Writing thought leadership articles to seed concepts in market
- Establishes expertise and leads to high-value consulting opportunities
- SEO benefits (traditional + AI search)
- Feeds rebuilt website content
- Longer term: productize in MixShift, AI acts as the interpreter

---

*Recommended action: Commit key insights to operator memory after approval*
