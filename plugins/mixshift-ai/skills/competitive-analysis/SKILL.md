---
name: competitive-analysis
version: 1.0.0
description: >
  Structured competitive analysis framework for market positioning. Produces SWOT analysis,
  feature comparison matrices, pricing tiers, and market positioning maps. Research-driven
  assessment of direct competitors and adjacent market players.
  Triggers on: 'competitor analysis', 'competitive landscape', 'market comparison', 'SWOT',
               'who competes with us', 'competitive threat analysis'.
author: Claude
last_updated: 2026-04-08
dependencies:
  - web browser (for competitor research and pricing pages)
  - web search capability
sample_input: "Run competitive analysis for Amazon PPC management tools"
sample_output: |
  ## SWOT: MixShift vs Helium 10
  Strengths, Weaknesses, Opportunities, Threats
  
  | Feature | MixShift | Helium 10 | Pacvue |
standalone: true
---

# Competitive Analysis

Structured competitive analysis for market positioning. Produces SWOT, feature matrices, pricing analysis, and positioning maps. Saves analysis to shared domain directory.

---

## What This Skill Does

Structured competitive analysis for market positioning. Produces SWOT, feature matrices, pricing tiers, and market positioning maps. Research-driven.

---

## Market Context

MixShift is an Amazon-based tech company building tools for Amazon sellers/brands. Primary product: HCAM (Headline/Campaign Ads Manager). Market: Amazon advertising management, seller analytics, agency tools.

Direct competitors: Helium 10, Perpetua, Pacvue, Teikametrics, Jungle Scout.

---

## Step 1: Research

Use web search to gather:
- Competitor website pricing pages
- Feature documentation
- Product announcements
- Pricing tier structure
- Free trial / freemium model

Capture current pricing, feature set, target customer tier (SMB/enterprise).

---

## Step 2: SWOT Template

Produce a structured SWOT for MixShift vs. each major competitor:

```markdown
## SWOT: MixShift vs [Competitor] — [YYYY-MM-DD]

### Strengths (MixShift advantages)
- List of MixShift strengths relative to this competitor

### Weaknesses (MixShift gaps)
- List of MixShift product or go-to-market gaps

### Opportunities (market gaps to fill)
- List of market opportunities MixShift can capture

### Threats (competitor advantages that hurt us)
- List of competitor strengths that pose risk to MixShift
```

---

## Step 3: Feature Comparison Matrix

Create a feature matrix comparing MixShift to 3-5 key competitors:

```markdown
| Feature | MixShift | Helium 10 | Pacvue | Teikametrics |
|---------|----------|-----------|--------|--------------|
| Headline Ads Mgmt | ✅ Core | ⚠️ Basic | ✅ | ❌ |
| Auto-bidding | 🔜 Q2 | ✅ | ✅ | ✅ |
| Multi-brand support | ✅ | ❌ | ✅ | ⚠️ Limited |
| Agency dashboard | 🔜 | ❌ | ✅ | ❌ |
| Price (mo) | TBD | $99-$399 | Custom | $250+ |
```

Legend: ✅ Yes | ⚠️ Partial | ❌ No | 🔜 Roadmap

---

## Step 4: Pricing Analysis

For each competitor capture: tier names, prices, what's included, free trial availability.

```markdown
## Pricing: [Competitor] — [YYYY-MM-DD]
- Starter: $[price]/mo — [features]
- Pro: $[price]/mo — [features]
- Enterprise: Custom
- Free trial: Yes/No
```

Note: pricing changes fast — always date-stamp.

---

## Step 5: Market Positioning Map

Create a 2x2 positioning map to visualize competitive landscape:

```
                    HIGH PRICE
                        |
      Pacvue ●          |     ● Enterprise X
                        |
FULL-FEATURED ──────────┼────── LIGHTWEIGHT
                        |
      MixShift ●        |  ● Budget Tool Y
                        |
                    LOW PRICE
```

Adjust axes per analysis need (price/features, SMB/Enterprise, self-serve/managed).

---

## Step 6: Save Output

Structure (user-machine local, shared across all brands the user works on):
```
~/.mixshift/competitors/
├── landscape-overview.md   ← Master map
├── helium-10.md
├── pacvue.md
├── teikametrics.md
├── perpetua.md
└── _template.md
```

This skill is not brand-scoped — competitive intel is portfolio-wide and shared across every brand the user manages. Create the directory if it does not exist.

After saving: update the knowledge index.
Refresh every 90 days (staleness rule).

---

## Step 7: Deliver Results

- **Inline summary:** 3-5 bullet top threat + top opportunity
- **Deep research note:** Full report available at path
- **Full report:** Save to shared directory

---

## Research Notes

- Internal only — never share raw competitive docs externally
- Flag immediately if a competitor ships something on roadmap
- Data sources: G2, Capterra, Product Hunt, LinkedIn (hiring signals), Crunchbase (funding)
- Update frequency: 90 days recommended
- Archive prior versions in ~/.mixshift/competitors/archive/

---

## Self-Review Checklist

- [ ] At least 3-5 competitors analyzed
- [ ] SWOT covers Strengths, Weaknesses, Opportunities, Threats
- [ ] Feature matrix includes pricing tier comparison
- [ ] Positioning map clearly shows differentiation points
- [ ] All pricing date-stamped (current as of research date)
- [ ] No em dashes in output
- [ ] Competitive threats and opportunities clearly named
- [ ] All findings are from public sources (websites, docs, announcements)

