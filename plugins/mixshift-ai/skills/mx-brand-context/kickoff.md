# Brand Setup - Kickoff Script

This is the AM-facing intake script. Read it, or the relevant excerpt, at the start of Phase 0 before DB queries or context fetches. The goal is alignment: the AM understands what you will ask up front, what you will figure out autonomously, and what you will come back to them about.

`SKILL.md` is the model's procedure manual. This file is the human-facing companion. Keep AM prose here, not in `SKILL.md`.

---

## Step 1 - Opening

> Hi, I'm setting up brand context for **{brand}**. Before I touch any data, I want to align on three things: (1) what you can tell me up front so I don't misread the numbers, (2) what I'll figure out on my own from MixShift data and public sources, and (3) what I'll come back to you about after I've looked. This usually takes about 10 minutes of your time, split across two short check-ins.

---

## Step 2 - Tell me about the brand

Ask in order. "I don't know" is a valid answer. Note it and move on.

**Identifiers & accounts**
- What's the brand's website?
- What's the Amazon storefront URL, if one exists?
- Any official social handles, community links, app store pages, or review surfaces I should treat as authoritative?
- Account type: Seller Central or Vendor Central?
- SellerID(s): how many, and which is primary?
- Any wind-down accounts or legacy SKU lines being sunset?

**History & anomalies**
- Any management transitions: agency changes, team turnover, or strategy shifts?
- Structural breaks in the data: SKU transitions, product migrations, channel changes, or account moves?
- One-time press or media events that inflated a month? Examples: Today Show, Shark Tank, podcast, viral TikTok.
- Stockouts that deflated specific months?

**Buyer-intent boundaries**
- Which product nouns attract the wrong buyer? Example: "bottle" for a cleaning-tablet brand.
- Which adjacent styles, materials, or competitor names still convert for you?
- Which competitor brands act as product-class shorthand in your category?
- For multi-item-group accounts: which lanes have broad tolerance vs. tight tolerance?

**Runtime-only report artifacts**
- Is there a forecast model, budget planner, or sales forecast that exists outside the DB?
- Is there an HCAM, H-Bridge, MoM bridge, or dimension bridge export that should be supplied when Monthly Report runs?
- If yes, should I request those artifacts at report run time rather than marking brand context incomplete?

**Brand-manager wow check**
- What would a brand manager expect MixShift to remember if we had really studied the brand?
- Any founder story, acquisition, launch, category shift, product-line sunset, viral moment, press event, customer segment, or competitor nuance that should appear in the first paragraph?

**Why this matters:** Without these answers, Phase 1 data gets misread. A unit decline may be a deliberate delisting. A revenue miss may be an intentional brand transition. A high-spend month may be a media event, not seasonality. Phase 0 is the interpretive filter.

---

## Step 3 - What I'll figure out on my own

Tell the AM you do not need them for this part. Also set expectations on
timing before you start: the background data fetch (web/social scrub plus
the historical baseline queries) commonly takes several minutes, and the
baseline prefetch is one blocking command you cannot narrate mid-run. Say
so up front, for example "The next step pulls up to 24 months of history
and takes a few minutes; I'll report back as soon as it finishes." Give
updates between steps where the work is split across separate lookups (the
web/social scrub is), and confirm completion as soon as the prefetch
returns. An unannounced multi-minute silence reads as broken even when the
fetch is working normally.

**Web & social scrub**

Required surfaces: official website, Amazon storefront if one exists, official social/community surfaces, app/review-marketplace pages when relevant, press/history surfaces, customer-language surfaces, and competitor surfaces. If a surface is dynamic or not captured directly, preserve it as `needs_capture` rather than claiming exact counts or storefront modules.

Quality bar for the first paragraph:
- It should make the brand manager feel MixShift studied the company, not merely the ad account.
- It should connect public brand truth to PPC interpretation.
- It should include only source-backed facts or internal context facts.
- Dynamic or uncaptured surfaces must be labeled `needs_capture`, not presented as verified facts.

Search sequence:
- Official website: positioning, product architecture, founder/company story, milestone facts.
- Amazon storefront: known surface; dynamic modules, ratings, and review counts require direct capture.
- Reddit/forums: customer language, complaints, comparisons. Zero presence is a valid baseline.
- YouTube: owned positioning, demonstrations, and third-party inclusions.
- Instagram / TikTok / Facebook / LinkedIn: official handles, creator mentions, UGC, social proof. Counts require capture.
- Amazon review surface: top 2-3 ASINs, customer language, failure modes.
- App stores / G2 / Trustpilot / press / gift guides: SaaS, app, review-marketplace, or press proof when relevant.
- Competitive context: brands customers compare against and competitors that act as product-class shorthand.

Buyer-language checklist:
- Pull compact phrase clusters from public review/forum/support surfaces when accessible.
- Pull top converting CS-31 search terms by brand lane / product job.
- Separate official product language from customer pain language and support/failure-mode language.
- Preserve blocked review/forum surfaces as `needs_capture`, but do not leave Brand Voice partial if CS-31 plus official/support language is enough to establish buyer vocabulary.

Findings populate `brand-intelligence.yaml` first: source map, hero narrative, proof points, `customer_language_corpus`, PPC implications, and open research gaps. Durable prose feeds `narrative.md ## Brand Identity` or `## Brand Positioning` plus `## Customer Language Samples`; typed terms and guardrails feed `context.yaml::brand_terms` / `negation`.

**MixShift data I already have**

Most of the brand's shape and calibration is already computed in the Brand Brain (built when the brand was set up). I read it rather than re-deriving it:

- **Brand taxonomy**: sub-brands, item groups, and the top ASINs by revenue.
- **Campaign-structure shape**: the distinct objectives, item groups, and brands in use, plus how completely campaigns are tagged with an objective.
- **Attribution settlement calibration**: how much ACOS improves between fresh and settled reads, including the per-campaign-type daily settlement curve.
- **Stockout windows**: detected out-of-stock periods that may have deflated specific months.
- **Brand-term typo clusters**: coined misspellings and variants customers actually type.

**MixShift data I pull fresh as historical baselines**

Horizon rule: monthly revenue and ACOS baselines should use 24 months when available so seasonality, YoY context, and anomaly separation are visible.

- **24-month monthly revenue baseline when available**: seasonal shape, trend direction, anomaly months, YoY context.
- **24-month monthly ACOS baseline when available**: by month and by campaign type.
- **VC sub-brand and item-group detail**: revenue concentration, ASP, and per-pair target ACOS where the brain's flat lists are not enough.
- **Budget utilization**: which campaigns are capped vs. running wide open.
- **Keyword spend concentration**: top-N keyword share of spend.
- **Objective config**: campaign-level intent classification from naming.

After Phase 1 reads complete, surface a one-line summary to the AM:

> "I now have {N} months of revenue, ACOS by month and objective, attribution calibration, {S} sub-brands across {G} item groups, and {M} manual-target ASINs across {K} lanes. Ready for the second check-in."

---

## Step 4 - Then I'll come back to you

After Phase 1, proactively surface the AM-required decisions. This is a required handoff, not an optional follow-up. Do not wait for the AM to ask for questions, and do not treat a draft Brand Context render as complete until these decisions are answered or explicitly marked unknown/not applicable.

Ask the smallest numbered set that will let you finalize context. For each question, include the data-derived hypothesis if one exists, then ask the AM to confirm, correct, or mark unknown. Do not ask for items the automated data review can answer by itself.

Runtime-only artifacts are separate from missing context. Forecast models, HCAM/H-Bridge, vertical bridges, and report screenshots should be flagged as required at downstream skill run time unless the AM says they do not exist.

**Required**
- **Primary metric**: ACOS or TACOS? TACOS for SC; ACOS default for VC.
- **ACOS target %**: blended account level; per-sub-brand if they differ materially.
- **For SC: TACOS target**: monthly and quarterly if quarterly pacing is enabled.
- **Quarterly or annual revenue target**: if one exists. When `report_quarterly_pacing: true`, remind the AM that this target should be refreshed at each quarter rollover. The Tier 1 freshness preflight catches stale `context.yaml::last_updated`, but if the AM bumps `last_updated` without also updating `quarterly_revenue_target` (or `monthly_revenue_target` at month rollover), daily and weekly skills will pace against a stale anchor and produce verdicts that look on-target when they're actually pacing against last quarter's number.
- **Forecast / bridge runtime status**: confirm whether forecast, HCAM, H-Bridge, vertical bridge, or screenshots should be requested at downstream skill run time.
- **Spend posture**: scale / efficiency / defend / clear_bleed.
- **Active promotions or upcoming launches**: 30-60 day horizon.
- **Objective config**: which campaign types intentionally run above efficiency? Examples: brand defense, SB/SD awareness, acquisition.

**Important context**
- Historical anomalies to exclude from baselines.
- Inventory situations.
- Brand maturity: emerging / scaling / defending.
- Competitive context if conquesting is active.
- Re-entry conditions if currently in pullback posture.
- Any first-paragraph brand facts that public research missed or got wrong.

---

**Target-refresh discipline (Alpha cohort guidance)**

The Tier 1 freshness preflight measures `context.yaml::last_updated` at the file level,
not per-field. Two cases the AM should watch for:

- **Quarter rollover.** When a new quarter begins and `report_quarterly_pacing: true`,
  refresh `goals.quarterly_revenue_target` first, then bump `last_updated`. Skipping the
  target refresh means `pacing_gap_pct` is computed against the prior-quarter anchor.
- **Month rollover.** Same hazard with `goals.monthly_revenue_target` when daily skills
  pace against monthly targets. Refresh first, then bump `last_updated`.

A future per-field timestamp (`goals.targets_last_updated`) is on the roadmap; for now
this is AM discipline. Skills will flag a stale `last_updated` via the Tier 1 preflight,
but they cannot detect a field-level miss when the file-level timestamp was bumped.

---

## Step 5 - Wrap-up

Once Phase 2 answers are in, emit `context.yaml + narrative.md + brand-intelligence.yaml + corpora/`, run the renderer, and share the link to `brand-context.html` for AM review. If Phase 2 is not answered yet, share only a draft link plus the numbered questions and wait. Anything the AM disagrees with becomes a source-file edit followed by a re-render. Never manually edit the HTML.

Open gaps surface as Missing Context Buckets on the rendered page. Runtime-only artifacts surface separately as Runtime Inputs Required. Exact follow-up prompts and raw gaps stay in `review.json` / structured detail so the main review surface stays readable.
