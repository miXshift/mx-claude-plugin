---
title: "Bridge Model + Forecast Integration — Concept Brief"
brain: domain
owner: mixshift
status: active
created: 2026-02-21
updated: 2026-07-27
tags: [domain, methodology]
---

# Bridge Model + Forecast Integration — Concept Brief

**Status:** Active / In Development  
**Origin:** an internal strategy session, 2026-02-20  
**Last updated:** 2026-02-20 (revised with full context from screenshots + extended discussion)

---

## Problem Reframe (canonical framing, validated)

**Goal:** Embed the canonical analytical ability to interpret across data sources and data types — deterministic (bridge), probabilistic (forecast + CIs + coefficients), and contextual (event stakes, changelog, user comments) — into the platform in a way that serves users at varying levels of data literacy.

**Problem:** Users can't make the analytical leaps themselves. The platform has to do the interpretation for them — not as a one-time onboarding explanation, but persistently and contextually at each layer of the drill-down.

**Complications:** Not all data is equal. When forecasting models return poor model fit or non-significant coefficients, the outputs are not garbage — but they require different interpretation than a high-fit model. The platform must convey this distinction without requiring users to understand the underlying statistics.

**Opportunity:** Even with poor model fit, forecasts generally return within CIs. Breaching CIs is itself a signal worth surfacing. Coefficients and model fit changing over time are signals for what's going right or wrong with the business, independent of absolute fit level. The beat/miss/on-target signal is useful for all users regardless of model quality.

**Edge Cases:** In periods where the modeled ad coefficient is corrupted by operational confounders (spend throttling, stockouts), the deterministic bridge delta can be used to infer a more realistic implied coefficient. This requires user-supplied operational context (event stakes) to validate the ceteris paribus assumption. Not automated — but workable when the event tagging workflow is in place.

**Bonus Problem 1:** Users need to understand the different analytical use cases for the forecast: market saturation signal (diminishing coefficient over time), media/press value estimation (organic trend spike during PR), OOS cost estimation (revenue at risk), and the general counterfactual concept as a performance evaluation baseline. These are Phase 2+ analytical lenses, not Phase 1 features.

**Bonus Problem 2:** Users need to understand that the bridge (deterministic) and the Probabilistic Counterfactual operate in different paradigms — but they are not separate products. They are sequential analytical layers in the same drill-down. The distinction is carried by visual treatment and AI synthesis language, not by product separation.

---

## Architecture: The Drill-Down Chain

The integration pattern is sequential, not parallel. Each layer answers a progressively more specific question.

**Layer 1 — Sales Mix chart, forecast toggle (Report Center)**
Actuals overlaid with forecast band and CIs. Users see whether they beat, missed, or came in on target. No model understanding required — the band and the actual line tell the story. This is the entry point for all users, including operators who will never look at a coefficient.

**Layer 2 — Item group sub-forecasts**
Drill down from the account-level beat/miss to localize where the variance came from. Which item groups overperformed? Which underperformed? This is where a $30K account-level miss becomes attributable to a specific product or segment.

**Layer 3 — Bridge decomposition**
From the item group, drill into the deterministic decomposition to understand the causal drivers. Did the miss come from volume, price, mix, or ad contribution? This is where the probabilistic signal (forecast miss) gets explained by deterministic math (bridge attribution).

The AI synthesis layer operates at all three levels, generating contextual plain-language interpretation at each step — informed by model outputs, event stakes, and changelog.

---

## The Model Performance Summary UI Pattern

existing model output (see screenshot, 2026-02-20) demonstrates the right pattern for displaying model quality to all users:

- Color-coded indicators (green/red dots) for each coefficient's significance
- Plain-language descriptions: "virtually no chance random" as a p-value translation; "not significant" for uncertain coefficients
- CI ranges expressed as ±values in dollars/percentages
- Summary labels: "Highly Significant," "Excellent fit," "not significant"

This pattern should be replicated in the platform's forecast view for every account. The AI "Explain" layer generates a narrative version of this summary, contextualizing each indicator for the specific account's situation. This is explicitly separate from business performance interpretation — it's a model sanity check and teaching moment. However, the model quality assessment should be linkable to how far a user should trust the coefficient-based recommendations (e.g., budget targets).

Key example from the screenshot: $6.11 ad coefficient, tight CI, highly significant → high-confidence budget planning input. Underlying growth coefficient not significant → treat trend projections with caution and rely on actuals to recalibrate.

---

## The Event Stakes Mechanism (Solves the Ceteris Paribus Problem)

The implied coefficient approach — using bridge delta and spend deviation to infer a corrected ad coefficient — requires knowing whether a deviation period was "clean." Previously identified as an unsolved elicitation problem.

**Solution:** Event stakes and user comments (on roadmap) as operational context inputs tagged by users on the timeline. A user who logs "pulled spend intentionally to test organic lift" during a low-coefficient period gives the AI the context it needs to:
1. Validate the deviation period as a clean experiment
2. Generate the implied coefficient from the bridge delta
3. Surface the tension between modeled and implied coefficient in plain language
4. Qualify the budget recommendation accordingly

This shifts the problem from pure inference to contextual interpretation. The platform doesn't need to detect what happened — the user tells it, as a normal part of their workflow. The changelog provides the longitudinal record. Event stakes provide the period-specific operational tags.

---

## The AI "Explain" Layer — Taxonomy

There are two distinct explain types in the platform, with different analytical starting points:

**Specific skill-based explains (deterministic-first):** Narrow, metric-focused diagnostics triggered by a user question or a flagged anomaly. Example: "Explain why my ACOS went up." These start from the bridge math — deterministic attribution — and work backward to explain a specific metric movement. They are precise, auditable, and scoped to a single question.

**Comprehensive AI Performance Summary (probabilistic-first):** The broader model explanation that reads the model performance summary — fit, coefficients, significance, CI ranges — and synthesizes them into a plain-language assessment of what the user can and cannot rely on. This is the teaching moment and sanity check. It starts from the model and works forward into confidence levels and planning guidance.

The Performance Summary is the same workflow regardless of model quality — but the output is confidence-modulated based on what the model returns. High-fit, significant coefficients produce language like "this coefficient is reliable, use it for budget planning." Low-fit, non-significant coefficients produce "this coefficient is uncertain — use directional guidance only and watch for changes as new data accumulates." This approach avoids the need for hard thresholds between "good" and "poor" fit, handles moderate-quality models naturally, and keeps the UX consistent across all accounts.

The two explain types can appear in proximity in the UI but should be clearly distinguished — they have different analytical starting points and answer different questions. Specific explains answer "what happened to this metric?" Performance Summary answers "how much should I trust what this model is telling me?"

The AI Performance Summary can be linked to business performance context where model quality affects the reliability of a recommendation — but the two are authored and triggered separately.

---

## The Implied Coefficient — Revised Framing

The mechanism: when a user-tagged clean deviation period exists (intentional spend change, no other anomalies logged), and the bridge delta significantly exceeds what the modeled coefficient would predict, the platform computes and surfaces an implied coefficient.

```
Implied Coefficient = (Actual Revenue − Forecast Revenue) / (Actual Spend − Expected Spend)
```

This is not presented as a corrected model output. It's presented as a signal: "Based on what happened when you changed spend in [month], your actual ad impact may be closer to $X per dollar than the model's estimate of $Y. This is not confirmed by the model, but it's worth factoring into your planning." The user/analyst still holds the interpretive judgment. The platform provides the math and the framing.

**Gating condition for surfacing:** Modeled coefficient low or not significant + user-tagged clean deviation period with significant spend change + bridge miss substantially larger than model would predict. Not surfaced automatically without the event tag — the tag is the validation mechanism.

---

## Paradigm Separation — Revised

The bridge and the Probabilistic Counterfactual are not separate views. They are sequential layers in the same analytical workflow. The distinction is maintained through:

- **Visual treatment:** CI shading on forecast overlays makes the probabilistic nature visible without explanation. Deterministic bridge outputs have no ranges — point estimates with drill-through to source math.
- **AI synthesis language:** Forecast/coefficient synthesis uses conditional language ("expected," "estimated," "projected"). Bridge synthesis uses declarative past tense ("revenue was," "ad spend drove," "mix accounted for"). Users absorb the distinction through repeated exposure to consistent language, not through one-time education.
- **Display ordering:** Beat/miss signal (probabilistic) surfaces first at the account level. Causal explanation (deterministic) is reached by drilling in. The sequence itself encodes the paradigm relationship.

---

## Skill Feedback & Personalization Architecture (Skills Roadmap)

**Three-layer isolation model for production skills:**

**Layer 1 — Master Skill (global, immutable in production)**
Authored by domain experts (domain experts). Versioned, write-protected. Updated only through the deliberate review cycle — parallel testing, failure identification, judgment-based iteration. No user action touches it. This is the ground truth.

**Layer 2 — Brand Context (per-account, admin-editable, isolated)**
Structured override context injected between the master skill and account data at query time. Brands tell the platform things about themselves: audience demographics, product positioning, operational patterns, management preferences. This context shapes how the skill interprets and prioritizes signals for that specific brand — it does not change what the skill knows. Brand context never flows upward. Isolated by account. Cannot pollute the master skill or other brands.

**Layer 3 — Aggregated Feedback Queue (user-facing, human-gated)**
Users provide structured feedback on skill outputs — not thumbs up/down (too coarse), but: "missed X," "direction right but threshold wrong," "doesn't apply to our brand because [reason]." Third category routes to brand context (Layer 2), not the master skill queue. Feedback aggregates across all accounts. the operator reviews periodically and decides if master skill iteration is warranted. No auto-apply. Human gate is the firewall.

**Key isolation rules:**
- Brand context is additive to master skill outputs — never overwrites them
- Feedback queue informs iterations — never auto-applies them
- These two rules prevent pollution at both the account level and the global level

**Connection to self-evolving agentic reasoning (arXiv 2601.12538):**
This three-layer architecture implements the self-evolving layer from the paper — in-context skill improvement through feedback, memory, and adaptation — with deliberate human gating until feedback signal quality and volume can support partial automation.

**parallel testing process = gold-standard labeling.** His judgment is the ground truth calibration for what the skill should have caught. Account managers with sufficient expertise are the eventual reviewer pool, but the canonical calibration comes first.

---

## Open Questions (Still Burn Down Further)

1. **Multi-period implied coefficients:** If multiple clean deviation periods exist with different implied coefficients, how do you aggregate? Weighted by reliability score? Most recent? Range display?
2. **Coefficient sign changes:** A positive-to-negative flip in the ad coefficient over time is a potential saturation or data quality signal. What's the detection threshold and the plain-language framing?
3. **Rate of model fit change:** Accelerating R² decline as a stress signal independent of absolute fit level — how is this surfaced and at what cadence?
4. **Analytical lenses for Bonus Problem 1:** Market saturation, media value, OOS cost, counterfactual baseline — each requires its own framing and AI synthesis template. Timing and sequencing relative to Phase 1 TBD.
5. **Threshold calibration for implied coefficient surfacing:** What divergence magnitude between implied and modeled coefficient warrants the signal? Rough calibration from the session: 10x ($0.33 → $3.00) is clearly worth surfacing. What's the minimum?
6. **Item group sub-forecast granularity:** What level of granularity is achievable and meaningful for sub-forecasts? Does model quality degrade significantly at item group level vs. account level?

---

## Phase Sequencing

**Phase 1:** Forecast + CIs overlaid on Sales Mix chart in Report Center (toggle). Beat/miss/on-target signal. Model Performance Summary with AI "Explain" for model quality. No implied coefficient surfacing yet.

**Phase 2:** Item group sub-forecasts for drill-down localization. Event stakes as operational context inputs. Implied coefficient surfacing when event tags provide clean deviation period validation. Changelog integration.

**Phase 3:** Analytical lenses for specific use cases (saturation, media value, OOS cost, counterfactual concept). Full bridge-as-model-interrogation workflow.

---

*Last updated: 2026-02-20 | the operator | MixShift | Source: extended strategy session including model and Report Center screenshots*
