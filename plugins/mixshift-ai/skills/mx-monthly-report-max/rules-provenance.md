# Rules provenance — the incidents behind every monthly-report rule

**What this is:** the case law. Every rule in the skill was written after a defect shipped or
nearly shipped; those incident narratives used to live inline in SKILL.md (~500 of its 1,088
lines) where they crowded out the instructions. They move here VERBATIM IN SUBSTANCE — dates,
figures, and what caught each one preserved — so the v2 skill stays readable at the point of
use while zero institutional memory is lost.

**How to use it:** when a rule feels arbitrary, look up its entry here. When a new defect
ships, add its entry here and route its rule to its enforcement home (contract validator,
renderer, engine, brand context, or SKILL.md — see the append protocol below). Cold reviewers
of a report get this file; it tells them where this skill has failed before, which is where to
look first.

## How this file grows once the skill is live (the append protocol)

A new defect routes by SCOPE, not by where it was found:

1. **Brand-specific** (a fact about one client's catalog, calendar, or history) → the brand's
   context/facts layer via the existing discoveries flow (skill emits, human promotes).
   Customer-side, immediate, no skill release. It does NOT get an entry here.
2. **Universal** (a new claim-error pattern, a methodology insight) → comes back upstream via
   `mx-feedback` / `mx-share-skill` (plugin skills are overwritten on update, so customer-side
   edits cannot persist by design). Upstream it becomes, in one change: an entry in THIS file,
   a routed enforcement (validator rule, renderer behavior, or SKILL.md), and — if
   contract-class — a **negative fixture** (a render that must fail, forever) in the harness
   report-contract fixtures. Ships to every consumer in the next release.
3. **Engine-class** (true of every brand every month, e.g. Rule 18) → a finding-suppression
   rule or published caveat in the Ops Bridge engine; the entry here records the incident and
   flips from ENGINE-pending to adopted.

**Not a hardcoding violation:** this file holds history, never rules — extraction is what LETS
each rule live in its proper home (engine / catalog / contract / brand context / style) per
MixShift's Q4 ruling, and it is hand-over deliverable #4 verbatim ("judgment and voice as
reference docs, cleanly separated from mechanics").

**Scrub policy (this repo is public):** brands are anonymized (Brand A/B, Line-N, SKU-X/Y),
figures are rounded to magnitudes, and marketplaces are genericized (US, EU-1, EU-2). The
incident lessons are preserved in full; exact client financials never appear here. Any
appended entry follows the same policy.

---

**Enforcement column:** where the rule lives in v2 (per the routing manifest). ENGINE-pending
means the rule stays verbatim in SKILL.md until the engine adopts it.

---

## The July 2026 autopsy (the nine that drove the v2 architecture)

Nine claim errors shipped in one client-facing tab of the Brand A (US), July 2026 report and were
caught by a cold reviewer, not by the build. They are permanently encoded as **negative
fixtures** — renders that must fail — in the harness at
`harness/src/lib/report-contract/fixtures/negative/E1–E9`, each with its incident note. Four
were population errors, two field-semantics, one recompute+unit, one basis, one causality.
The deepest lesson: **the rules that would have caught four of them were already written in
the v1 skill on the day they shipped.** A rule in prose is checked by the same attention that
wrote the sentence; v2 moves enforcement into data and validators wherever possible.

---

## Anti-fabrication rules

### Rule 7 — "bid pullback," not "budget decision"
Recurring reader inference: lower spend read as a deliberate budget decision when it is the
mechanical consequence of lower bids. *Enforcement: ENGINE-pending (statement wording).*

### Rule 14 — superlatives need a backing query
Brand A (EU-2), April 2026 shipped Order CVR called "highest in trailing twelve months" without a TTM
query — the actual figure ranked mid-pack. **Recurrence in July 2026 (error #1):** "July
lowest of any month in 2026" passed a hand-written assertion that validated against `PLAN`,
which held Jan–Jul only; August was lower. A guard checking an incomplete population converts
"unverified" into "verified" and is worse than no guard. *Enforcement: CONTRACT POP-1/POP-2 —
population must be complete AND the claim re-evaluates against the members.*

### Rule 15 — labels from context.yaml, never SKU titles
Brand A (EU-2), April 2026 shipped alternate-standard labels throughout ("ALT-1450+") inferred from Italian SKU
titles while the YAML declared house-standard labels ("Line-28"). SKU titles are diagnostic input for
mapping rules, never display strings. *Enforcement: STYLE + the mapping step.*

### Rule 16 — visual accents follow data sign, not prose tone
Brand A (EU-2), April 2026 shipped a green YTD forecast card on a −€5K variance — the prose was
optimistic, the data negative. *Enforcement: RENDERER (accent from value sign).*

### Rule 17 — sign adjective-shaped change figures
The table cases were mechanically checked; the ones that slipped were prose figures that
describe movement without looking like deltas: "10% off" (→ −10% on price), "44.7% of its
sessions", "sold fewer units". *Enforcement: RENDERER + prose-lint.*

### Rule 18 — the blended-benchmark non-finding (the flagship judgment rule)
Brand A, July 2026 drafted "converting at 7.3% and 7.8% against the account's 27.0%" as evidence
two premium tiers were underperforming. Those are the two most expensive lines in the catalog;
conversion correlates with price point, so the top of the ladder sits below the blended
account rate **by construction, every month** — the claim had no content. The real finding
was inside the line: a −10% price cut produced *fewer* units and lower conversion.
**Extension, same build:** `traffic_share_exceeds_revenue_share` is "revenue per session
below account average," and revenue/session = conversion × ASP, so a cheap item trips it
every month. Brand A (US) July published *"Line-20 entry-size draws traffic it does not convert"* off
that signal; the item converts at **28.8% against the account's 27.0%** — the entire gap was
a ~$33 price against a ~$52 account ASP. Not merely unsupported: **backwards**, and the
opposite of the supported action. Decompose the ratio before reporting it; a drill signal is
a place to look, never a finding. *Enforcement: ENGINE-pending (finding-suppression rule) —
verbatim in SKILL.md until adopted.*

### Rule 19 — absolute contributions, not growth rates
Brand A, July 2026 nearly shipped "Sponsored Brands accounts for almost the entire YoY spend
increase" on the strength of +397.6% growth; SB was ~+$41K of a ~+$92K increase (44%) while
SP was ~+$57K (62%). *Enforcement: ENGINE-pending (statement style) + CONTRACT share checks.*

### Rule 20 — test the mechanism before publishing it
Brand A, July 2026: "conversion fell because June had event discounting" was tested against May
(the last event-free month) — and failed: conversion was −2.7 pts against May too. The failed
test became the strongest finding in the advertising section. State what you tested and what
it showed, including when the intuitive answer loses. *Enforcement: SKILL (Pass 0).*

### Rule 21 — forecast terminology lock
Brand A, July 2026 shipped a draft mixing "the model", "the forecast model", "the forecast" and
"plan" in one document. "Plan" reads as a merchandising/budget plan. Three terms, three
meanings, no synonyms. *Enforcement: STYLE banned-terms consumed by validators.*

### Rule 22 — build shared content once, inject twice
Brand A, July 2026: the executive summary's copy of a table was silently missing a row the full
report had; the US report shipped a two-paragraph executive Bottom Line beside a
three-paragraph full version with different framing, same run. *Enforcement: RENDERER
(shared-block injection + parity assert — implemented as a validator on rendered output).*

### Rule 22a — sweep every fix across sibling reports
The single most-repeated defect of the July 2026 build: EU-1's Bottom Line was restructured
after a "what are you comparing?" critique and shipped fully labelled; the US report kept the
unlabelled version for three more rounds — the exact defect, already raised and fixed next
door. The reader had to find it a second time. *Enforcement: SKILL (review workflow) +
prose-lint run on every report in the session.*

### Rule 24 — internal report names are a rewrite, not a citation
Brand A, July 2026 drafted "Amazon's purchased-product reporting shows…"; it shipped as
"shoppers click the small-size item's ads and buy the large size instead," with the dollars attached.
*Enforcement: STYLE banned-terms.*

### Rule 25 — re-derive brief claims; the check pays both directions
Brand A (EU-1), July 2026: the brief said Line-S "converts at roughly twice the account rate" —
true, but banned-by-Rule-18 shaped. Re-deriving surfaced Line-13 at ~€41 vs Line-S at ~€40
converting 30% vs 50% — a like-for-like comparison at the same price point, which
is the version that carries the argument (an UPGRADE). The same session produced two
confidently-reported HIGH-severity "product defects" that were both wrong — the agent had
probed with guessed field names and treated `undefined` as a finding; both retracted only
because a second run re-tested them (a CATCH). *Enforcement: CONTRACT (source_path makes
re-derivation the default) + SKILL (the upgrade judgment).*

### Rule 26 — quantifiers require enumeration
Brand A (EU-1), July 2026 drafted "every line that fell did so on traffic" from an aggregate in which
traffic dominated; enumerating the eight lines showed **six** did, while Line-10 and the accessory line
fell on conversion *despite gaining traffic*. The aggregate was right; the quantifier was
wrong — and "six of the eight, with the exceptions named" is also more interesting.
**Recurrences in July US (errors #5, #8, #9):** "only two of thirteen fell" (three did);
"high-potency tiers did not participate" (Line-24 grew +10.8%); "almost all of it is traffic"
(traffic was 128% of the net). *Enforcement: CONTRACT POP-2.*

### Rule 27 — write sentences; the linter's genesis
Prose construction was critiqued in **every** review round of the Brand A, July 2026 build — the
one failure never written down as a rule. Signature: "**Line-24 — the largest single decline,
and a discovery problem rather than a pricing one.**" Entity, dash, noun phrase, no subject
doing anything; it shipped four-of-four paragraphs in the US report and four-of-four in EU-1 — a
filled template, not composed writing. Two structural causes: composing prose inside an HTML
template invites template-shaped prose (hence: write narrative strings in the data file, then
render), and later reports in a session inherit the earlier one's sentence shapes wholesale.
*Enforcement: `helpers/prose-lint.py` (label-dash fragments, verbless leads, repeated
openings, dash density, 60-word sentences) — unchanged in v2.*

### Rule 28 — a report contains several "return per ad dollar"; name which one
Brand A (EU-1), July 2026 told the reader **~€5 of revenue per euro of advertising** in the
forecast section and **~€1.80 per euro** in the advertising section. Both correct — different
measures (the model's incremental total-revenue coefficient vs attributed ROAS) — and nothing
on the page said so, so the only available reading was that one was wrong. *Enforcement:
CONTRACT BASIS-1 (one basis per label per document).*

### Rule 29 — bullets stand alone
Brand A (EU-1), July 2026 shipped *"Re-examine the Line-S pullback"* — which assumes the reader
knows there was a pullback, what Line-S is, and why it was a mistake. The rewrite named the
thing, sized the move (spend −46% MoM, traffic −40%, vs Line-26 spend +125% buying
traffic converting −53% worse), gave the comparison that makes it a problem (50% vs 30%
at the same price), and stated the action in the lead. *Enforcement: SKILL (writing craft).*

### Rule 30 — match H-Bridge display precision
Brand A, July 2026 shipped CTR at three decimals in both US and EU-1 while H-Bridge displays two; the
operator with both screens open goes hunting for a discrepancy that doesn't exist. The fix
had to land twice because the `snap()` formatter was duplicated between the US builder and
the shared helper (a Rule 22 surface). *Enforcement: CATALOG precision metadata + RENDERER.*

### Rule 31 — every callout sentence earns its place; mirror shared mechanisms
Brand A (US), July 2026: the Line-20 entry-size paragraph spent half its length defending the item
against a charge nobody made (all true, none of it the point — "what decision does this
sentence change?"). And the Line-24 and Line-20 stories were the same causal shape (spend cut
→ fed item lost passed-on sales → X% of the receiving item's decline) written in different
orders with different figure selections, forcing the reader to reverse-engineer their
sameness; written in the same order, adjacent, the magnitude comparison (70% vs 17%) becomes
the finding. *Enforcement: SKILL (writing craft).*

---

## Required analytical checks

### C1 — cross-item discovery ("the entry point check")
Brand A, July 2026: advertising on the Line-24 small size was cut −55%; sales of its large-size
sibling originating from those ads fell ~−$9.5K against a ~−$30K decline in that item overall —
the small size was 70% of the fall in what the large-size sibling earned from other items'
advertising, and the pair was **~32% of the entire month-over-month account decline**,
invisible at item-group grain. Carry the confound: if the comparison period held an event the source promoted into,
part of the fall is the event not repeating — tracking, never cause.

### C1a — run C1 on every item in a spend recommendation
Brand A (US), July 2026 ran the cross-item check on the Line-24 pair only, then recommended
incremental budget for a *different* line without checking its halo: $0.38 of other-item
sales per ad dollar, against $1.34 for the item whose spend had just been halved. The measure
that settles budget questions: **(same-SKU ad sales + halo-out) ÷ ad spend** vs account
ROAS — July: Line-24 small size ~$4.60, Line-20 entry size ~$2.60, Line-10 large size ~$2.60, account ~$2.15.

### The adsGrain override defect (probe, don't assume)
Brand A (US), July 2026: a freshly-created ads run with `groupingMode: "asin"` came back
`adsGrain: "campaign"` with `ads.spend_by_asin → skipped / no_data_in_source` — while the
**ops** run for the same seller and periods computed that same analysis successfully. One
domain folds ASIN ad data, the other says there is none, from identical inputs: a defect to
report, never a limitation to accept. Fallback (declared): same-SKU ≈ ad orders × ASP,
verified against account units/order (1.03 in July, held). *All C-checks: envelope-carried
inputs, SKILL-owned interpretation.*

---

## Traps that cost published numbers

### The revenue bridge is published — read it, never rebuild it
**Shipped wrong in BOTH the US and EU-1 July 2026 reports.** The account bridge was assembled
by summing per-line bridges instead of reading `horizontalInsights[scope='total',
variantKey='primary']`. The per-line sums reconcile to the same total — which is exactly why
it survived every check — but allocate the mix effect into traffic and conversion. EU-1's
price leg printed with the **wrong sign** (~−€1.2K published vs ~+€2.0K real): the client
opened H-Bridge, saw the positive ASP leg, and caught it. The US version inverted the YoY
ranking (price published ~−$41K vs real ~−$107K; conversion ~−$112K vs ~−$52K) — the report
called price "immaterial" when it was the larger drag. Sign coherence was the second miss:
EU-1 published a conversion leg that fell while contributing ~+€1.8K, and nobody caught it
because the legs summed. *Enforcement: CONTRACT TRACE-2/3 (recomputing a published figure requires a
written justification that cannot honestly be written) + footing/leg assertions in the
extractor.*

### Re-pull on the day you publish (three measurements and counting)
Amazon revises recent months. Aug 5→6: EU-1 July moved ~−€190 and US July moved ~−$730 —
enough to shift the EU-1 forecast miss 19%. Aug 8→11: US July restated **~−$9.8K** on a
seven-figure month (units also restated down, June and sessions untouched) — the Brand A
slow-settlement/returns pattern at the largest magnitude measured. Grain is never the cause:
same-minute runs at different grains return identical totals. *Enforcement: SKILL workflow →
proposed service capability (re-pull/diff co-design with MixShift).*

### `exSurgePctChange` is not day-count normalised
It divides a full-length period by the *residual* of a shortened one (31 days vs 26).
Confirmed on two accounts and four period pairs; strongly positive every time the
day-normalised truth was negative (US MoM +13.3% reported vs −5.0% actual; EU-1 +14.0% vs
−4.4%). Compute `(period − event) / (days − event_days)` and show the working.
*Enforcement: ENGINE-pending (fix or caveat at source) — verbatim in SKILL until then.*

### A decomposition leg can oppose the blended metric of the same name
Brand A (EU-1), July 2026 rendered a rising ASP (+2.0%) beside a negative price contribution
(~−€1.2K) — because per-line prices netted down while mix shifted toward expensive lines
(Line-24 at ~€121 grew, Line-S at ~€40 fell). Both numbers right; label the lever as per-line and
explain the mix, or the reader distrusts the whole table. *Enforcement: ENGINE-pending.*

### Statement-level figures can disagree with sidecar totals
H-Bridge's `lost_sales` statement was observed quoting one entity's value as the period total
(30% low): the statement builder drops entities with unresolved OOS days while
`metrics.lost_sales.total*Value` keeps them. Reconcile statement figures against metric
totals before publishing. *Enforcement: ENGINE-pending (reconciliation invariant).*

### Deploying from inside a git repo attaches its commit metadata
Vercel blocks the deployment if the commit author email is not on a GitHub account, with an
error that appears to be about something else entirely. Deploy report folders from a copy
outside any git working tree. Cost most of a session to diagnose. *Enforcement: SKILL
(delivery ops note).*

### The Sponsored Display basis fix (2026-08-06) and the two ad-sales totals
SD was previously read from the click-only column, understating every Display account (Brand A
US July ~$434K → ~$445K, ACOS 46.4% → 45.4%; the EU markets ~+3.5% / ~+5.7%; Brand B, a
Vendor Central account, ~+2.1%). Post-fix, `ad_sales`/`ad_orders` reconcile to the console
**to the cent**; the SKU split stays click-basis with Display view-through as its own named
lane; the identity **same + other + view-through === total** holds per row at every grain
(never derive other-SKU as total − same). Separately, the Ads Bridge total and the ops-side
`ad_driven_sales` are BOTH correct on different bases: July US walked ~$445K authoritative →
~$345K identified → ~$100K unattributable (SB + view-through, unsplittable). Quote ad-driven as a floor and name the basis. *Enforcement: CATALOG basis
metadata + the extractor's identity check (already live in `extract_figures --check`).*

---

## Workflow-step incidents

### Step 0.9's origin (superseded by architecture, history kept)
An agent with full context, full DB access, an explicit instruction to use H-Bridge, and a memory
note naming the route **bypassed H-Bridge for nearly all analysis and reported that it had used
it.** Consequences reached clients: a lost-sales figure published with no coverage caveat
while the coverage block sat in the same payload; an item-group ACOS table overstated by up
to 44 pts (SD posts zero in the 7-day column); a causal ad-spend claim that measured at ~1
point of a 13.3-point move. Two of the three were caught by a human reviewer, not by any gate. The
sub-agent answer was later superseded: MixShift's ruling is that tool-withholding is not
portable enforcement — "design a document that can't contain an unsourced figure" — which is
what the report-contract now does. The deterministic read step (envelope → extractor)
replaces the sub-agent entirely.

### Step 2b's origin — attribution data-completeness
Brand A (EU-2), April 2026: the DB's 14-day attribution columns were under-populated for SD, so
canonical-window SQL returned suspiciously low ad_sales (DB SD ACOS 11.4% vs console 4.7%).
The deterministic signal: `ad_sales_14d < ad_sales_7d` is mathematically impossible with
complete data. *Kept in v2 for the residual-SQL set.*

### Step 2c's origin — item-group classification
Brand A (EU-2), April 2026 shipped two mapping bugs requiring a client corrections pass: `SKU-X`
(the small-format item) classified as Line-13 because its title contains "ALT-400+" (fixed by SKU
regex); `SKU-Y` under a standalone "ALT-1300" group while MixShift's own view absorbs it
into Line-26. *Kept in v2 until a MixShift item-group query exists.*
