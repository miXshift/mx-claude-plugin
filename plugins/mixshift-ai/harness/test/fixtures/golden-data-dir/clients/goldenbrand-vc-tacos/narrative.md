# Northgrove Coffee Roasters — Brand Narrative (synthetic fixture)

> Synthetic QA fixture for the MixShift plugin harness. Northgrove Coffee
> Roasters is an invented Vendor Central (1P) coffee brand. No real brand
> or account.

## Brand Identity

Northgrove Coffee Roasters is a specialty 1P coffee brand sold through Vendor
Central in the US. The range spans single-origin whole bean, espresso blends
(whole and ground), and a cold-brew line (concentrate plus ready-to-drink).
Positioning is "small-batch roastery at grocery scale" — traceable origins and
fresh roast dates, distributed through Amazon's 1P retail channel.

Because the account is Vendor Central, operational revenue comes from the
vendor manufacturing-view (OrderedRevenue, ShippedUnits) rather than Seller
Central business reports. The brand is managed to a TACOS target: total-sales
efficiency drives decisions, not ad-only ACOS, because the 1P relationship makes
total ordered revenue the meaningful denominator.

## Customer Language Samples

How shoppers describe Northgrove products in reviews and Q&A:

- "Roast date was two weeks out — actually fresh, not sitting in a warehouse."
- "The cold brew concentrate makes a smooth cup, not bitter."
- "Single origin Ethiopian is fruity without being sour."
- "Espresso blend pulls a thick crema in my machine."
- "Bag reseals well, beans stay fresh to the bottom."

Recurring positive themes: freshness/roast date, smoothness, crema, resealable
packaging. Recurring complaints: grind too coarse for some espresso machines,
cold-brew concentrate ratio confusion, price versus grocery-shelf competitors.

## Current Quarter Context

Q2-Q3 2026 is a cold-brew season. A recurring summer cold-brew media burst runs
weekly June through August; TACOS climbs during burst weeks as upper-funnel
Sponsored Brands spend ramps, and that is planned rather than runaway. A May
price test on the flagship espresso blend distorted efficiency for the affected
ASIN for two weeks; ad-attributed sales credit is reliable for that window, but
margin-based TACOS contribution is not.

Posture is scale with a low 0.35 bid-cut multiplier: the 1P brand is leaning
into growth, so bid cuts are applied gently.

## Historical Notes

- Brand entered Amazon 1P in 2022 with single-origin whole bean; espresso and
  cold-brew lines were added across 2023-2024.
- Settlement capture rate sits around 55-60% at T-1 and settles by T-14;
  fresh-day ACOS improves roughly 3-4 points once attribution lands. Stability
  is medium (more variance than the SC fixture).
- Competitor set (Ridgeline Roasters, Emberhouse Coffee, Sumaco) occasionally
  collides with Northgrove brand-misspelling terms; competitor_brands is set so
  negation skills do not false-positive.
- VC catalog turns slower than 3P, so the ASIN-negation lifetime-orders
  threshold is set higher (40) than a typical SC account.
