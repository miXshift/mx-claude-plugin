# Narrative Template

This is a starter `narrative.md`. Real per-brand narratives live at `~/.mixshift/clients/<brand-slug>/narrative.md` on the user's machine.

The narrative captures **prose context** — interpretation rules, brand positioning, management history, and per-skill guidance that doesn't belong in `context.yaml`. Skills read this file for color and judgment cues, never for numbers.

Canonical headings (the renderer looks for these — keep the H2s as written):

---

## Brand Identity

A few sentences on what the brand sells, who buys it, where it sits in the category. Include positioning anchors that help skills interpret search-term intent. For example: *"<Brand Name> sells hydration accessories. Buyers are outdoor / endurance athletes. Search terms involving 'water bottle', 'flask', 'reservoir' are core relevant; 'gym bag', 'shaker', 'protein' are adjacent-not-core."*

This section helps `mx-search-term-negation` and `mx-phrase-negative-discovery` calibrate what counts as relevant traffic.

---

## Current Quarter Context

Operational state right now. Goals, posture, structural events in flight, known disruptions. Example:

- Q2 2026 targets: $300K total sales, 10% TACOS goal, 20% ACOS target.
- Posture: efficiency-leaning; aggressive scaling deferred until July inventory replenishment.
- Active structural events: Q2 price test on top-3 ASINs (2026-05-10 → 2026-05-24).
- Known disruptions: <list any inventory issues, ad account changes, recent restructures>.

This section feeds the Bottom Line of `mx-daily-health-check`, `mx-monthly-report`, and any skill that interprets anomalies.

---

## Historical Notes

Anything in the data that requires historical context to interpret. SKU launches, brand migrations, ownership changes, agency transitions, viral / press events. Example:

- 2025 Q4: Featured on national podcast (2025-11-12). T-30 baseline still reflects elevated traffic; skills should treat 2026-Q1 vs Q4 comparisons as not apples-to-apples.
- 2026 Q1: Brand migrated from Vendor Central to Seller Central. Reports prior to 2026-02-01 use VC schema (`vendor_sales_manufacturing_asin`); 2026-02-01+ use SC schema (`business_reports_dpst_date`). Mixing the two produces phantom revenue drops.

Skills cross-reference this section to avoid spurious causal explanations.

---

## Per-skill guidance (optional)

If a specific skill needs brand-specific interpretation cues, document them under this heading. Example:

- **mx-monthly-report**: Lead the narrative with TACOS this quarter; ACOS is a derived metric for this brand and shouldn't be the headline.
- **mx-search-term-negation**: Aggressive on competitor brand terms (we lose money on them); conservative on generic category terms.
- **mx-portfolio-quick-scan**: Account is small enough that single-day spikes are noise; require 2+ day patterns before flagging YELLOW.
