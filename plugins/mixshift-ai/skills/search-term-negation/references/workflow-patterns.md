# Search Term Negation — Workflow Patterns

## Data Preparation SQL Patterns

### Pull Search Term Performance Data

[SQL-LIBRARY: STN-01]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:start_date` from runtime
- `:end_date` from runtime

### ASIN Targeting Cleanup Pattern

[SQL-LIBRARY: STN-02]

Parameters: none — operates on caller-prepared scratch table `search_term_data`.

### Historical Performance Analysis

[SQL-LIBRARY: STN-03]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:search_term` from candidate term under review
- `:end_date` from runtime

### Theme Analysis Pattern

[SQL-LIBRARY: STN-04]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:theme_pattern` LIKE expression assembled by caller (e.g., `%leather%`)

---

## Irrelevance Detection Patterns

### Common Category Mismatches
- **Wrong product type**: Necklaces when selling bracelets, electronics when selling jewelry
- **Wrong material**: Gold for rope products, leather for metal products
- **Wrong gender**: Women's for men's products, kids for adult products
- **Wrong formality**: Formal for casual brands, casual for luxury brands
- **Electronics**: Charger, USB, battery for non-electronic products
- **Home goods**: Candle, diffuser, pillow for jewelry/accessories
- **Wrong size scale**: XL, size 12 for non-clothing items
- **Character/IP**: Disney, Marvel, Batman without licensing

### Brand Name Confusion Patterns
- **Competitor brands**: Direct competitor names in search terms
- **Generic brand terms**: Brand name + product for unrelated brands
- **Misspellings**: Competitor brand misspellings that don't convert
- **Category brand leaders**: Nike for non-athletic products

### Lifestyle Mismatch Patterns
- **Age demographic**: Teen, elderly for wrong age groups
- **Activity mismatch**: Swimming for non-waterproof products
- **Occasion mismatch**: Wedding for tactical gear, hiking for formal wear
- **Cultural/religious**: Religious terms for secular brands (or vice versa)
- **Geographic**: Location-specific terms for national brands

---

## Decision Framework Templates

### Performance vs Relevance Matrix
```
High Performance + High Relevance = Keep, potentially increase bids
High Performance + Low Relevance = Investigate (may be finding unexpected market)
Low Performance + High Relevance = Bid optimization opportunity
Low Performance + Low Relevance = Prime negation candidate
```

### Negation Type Decision Tree
```
Is this a specific wrong product/brand? → Exact Negative
Is this a category mismatch? → Phrase Negative  
Is this affecting multiple campaigns? → Campaign Level Negative
Is this product-line specific? → Ad Group Level Negative
Is this a typo with unclear intent? → Exact Negative (specific term only)
```

### Historical Context Considerations
```
Recent stockout? → Analyze pre-stockout performance before negating
Seasonal product? → Check same period last year before negating
New campaign? → Need more data, defer negation decisions
Recent bid changes? → Consider bid optimization before negation
```

---

## Implementation Tracking Templates

### Negation Documentation Format
```
Negative Keyword: [term]
Type: [exact/phrase]
Level: [campaign/ad group]  
Rationale: [category mismatch/competitor/wrong product type]
Historical Impact: $[amount] waste, [conversion rate]%
Campaigns Affected: [list]
Implementation Date: [date]
```

### Pre/Post Analysis Template
```
Metric | Pre-Implementation | Post-Implementation | Change
Total Impressions | [number] | [number] | [%]
Irrelevant Impressions | [number] | [number] | [%] 
Cost on Irrelevant Terms | $[amount] | $[amount] | [%]
Overall ACOS | [%] | [%] | [%]
```

---

## Quality Control Checklists

### Pre-Implementation Review
- [ ] Verified against complete brand portfolio
- [ ] Checked for partnership/licensing implications  
- [ ] Confirmed category assumptions with actual products
- [ ] Considered seasonal/temporal factors
- [ ] Reviewed historical performance trends
- [ ] Validated negation type (exact vs phrase) appropriateness

### Post-Implementation Monitoring  
- [ ] Traffic volume impact within expected range
- [ ] No unexpected drops in relevant term performance
- [ ] ACOS improvement on remaining traffic
- [ ] No over-restriction of valid long-tail terms
- [ ] Impression share maintained on target terms

---

## Advanced Patterns

### Competitor Analysis Integration
- Monitor competitor brand name performance before negating
- Consider conquest vs defense strategy implications
- Analyze competitor product launches affecting search behavior

### Seasonal Adjustment Patterns
- Different negation thresholds during peak vs off-peak periods
- Holiday-specific term management (Valentine's, Christmas, etc.)
- Back-to-school, summer, winter seasonal considerations

### International Market Considerations
- Language-specific irrelevance patterns
- Cultural context for lifestyle/demographic terms
- Local brand recognition vs global brand confusion

### Automation Readiness Patterns
- Systematic rules that can be automated vs judgment calls
- Threshold-based negation for scale (spend + zero conversions + time period)
- Whitelist protection for brand partnerships and special categories
