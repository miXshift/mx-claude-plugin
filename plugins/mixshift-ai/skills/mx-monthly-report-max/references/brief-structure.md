# Brief structure and voice

Two documents, two readers, neither of them MixShift. The **internal companion**'s
reader is an Amazon/ecommerce manager running the account for their client: fluent in
Amazon operations, unaware of MixShift machinery, and trying to connect the actions they
took to the results on the page so they can show their client the value. Machinery
vocabulary is banned from both documents (table names, HCAM/envelope/battery, versions,
internal file names); sources speak the reader's language (Intelligence run, Amazon data,
Live check, Brand notes, Call history, Your answer at review, Derived), and query-level
provenance lives in the run record. The **client brief** is that manager presenting to
the client's executive team: every sentence must survive being read aloud in that meeting, and it
carries findings, never apparatus (no tooling nouns, no process narration, no scope or
method section; the one-plain-sentence exception for a method that genuinely needs client
words, like Buy Box weighting). The **internal companion** holds the entire audit trail
plus everything that would damage the relationship if shared: the technical scope block,
talking points, the numbers to keep off the call, owner-attributed asks, method and
caveats, the claims register, and MixShift's own misses.

The reader of either has fifteen minutes and a call to run. Every section either changes what
happens on that call or comes out. This file spells out what each section is for, so you can tell
when a section has nothing to contribute and should be dropped rather than padded.

## Client brief, in order

Masthead, bottom line, headline metrics, what actually moved, segment reads, featured
offer status, things to check, one-line footer. No scope bar and no method section: both
live in the internal companion.

Note that **things to check sits after the analysis, not before it**. Placed high it reads as a
to-do list handed to the client. Placed after the evidence it reads as the conclusions the
evidence supports, which is both more persuasive and more accurate to how the list was derived.

## Masthead

The `h1` states the month's **conclusion**, not its topic. This is the single highest-leverage
line in the document, because it is the frame the operator carries into the call.

- Good: "August is an availability story, not a demand story"
- Good: "Efficiency held while volume doubled"
- Bad: "August performance summary" (topic, not conclusion)
- Bad: "August was a challenging month" (vague, and squishy)

Under it, a one-line standfirst saying what the brief contains. Beside it, a stamp block. For the
client brief: prepared date, the window, the account, the prior review date. For the internal
companion: call date and time, attendees, the client doc it pairs with, prior monthly. Attendees
belong on the internal one because that is where the owner-attributed asks live.

## Exceptions first (internal companion; renders only when one exists)

The internal doc opens with the exceptions block ONLY in a month that has one: a
correction to an earlier read, a correction applied to this run's figures (dark-day
normalization, and which figures it touches), a basis or windowing change from the prior
run, or a non-established account mode reframing the read. In an ordinary month the block
is absent, so its presence IS the signal; a standing scope box that renders every month
trains the reader to skip it, which is fatal in the one month it matters.

Every user story the old standing scope block claimed is served elsewhere: account
identity and window are in both masthead stamps; the weighting, thresholds, bases,
SellerID and mode live in i06 where the figure-checking reader goes; what the engine
contributed is the layer receipt; on-call defensibility is i01's framing traps and i02's
keep-off numbers.

## The layer receipt (internal companion)

Right after the banner (below the exceptions block when one renders): one compact block,
one row per layer, showing what each part of the system contributed to THIS run. This is the manager's value surface; the client doc
deliberately hides the machinery, so without this block the three-layer system is
invisible to the person paying for it.

- **The intelligence run**: what it independently found, verified, or attributed, stated
  as contributions ("confirmed the conversion mechanism", "supplied the seasonal
  comparison", "attributed the Buy Box move to rate, not mix"). Things a hand read would
  have missed or could not prove.
- **Brand context**: which standing facts shaped the read (the target that framed the
  beat, tuned thresholds, lifecycle declarations that kept a planned decline from
  flagging, the voice profile). If context is empty, say so and say what filling it buys:
  on a young account this row is the setup pitch.
- **Call history + prior reviews**: which staked events and carried commitments explained
  movements or received verdicts this run, in action-to-result form where the reader's own
  work shows up in the numbers.
- **Written back**: what the run proposes to remember (event-stake candidates, lifecycle
  entries, watches), so the loop's other half is visible too.

Keep each row to one or two sentences of named contributions. The review packet carries
the counted one-line version at the end of "What this report says."

## Bottom line

One paragraph, three moves: the conclusion, the mechanism, the counterweight. Open with the
conclusion as one full bold clause, verb included: a bare label like "Bottom line." is a
verbless fragment and the lint flags it. A second short paragraph only if there is a
genuinely separate second finding.

The counterweight is the part people skip and it is what makes the brief trustworthy. If sales
fell but the catalog is wider than ever and new items offset half the loss, that belongs in the
bottom line, not buried in section six.

## Things to check

The triage list. It sits after the analysis so it reads as conclusions rather than assignments.
Each row carries:

- A **state chip**: Blocking, Open, Pending, Carried, Context. Pick honestly. Blocking means the
  month cannot recover without it. Open means it is live and costing money now. Pending means it
  is waiting on something already in motion. Carried means outstanding but not urgent. Context
  means a question whose answer would change the read.
- The item in bold, then the evidence in one or two sentences, with figures.
- One sentence on **why it matters now**, which is what turns a check into a decision.

**No owner names in the client brief.** This matters more than it looks. "Confirm inbound timing
on the ten stocked out items" invites the person who knows to answer. "Jordan to confirm inbound"
puts a named person on the spot in front of their colleagues, and the meeting turns defensive
instead of productive. The client's team knows who owns what. Owner attribution belongs in the
internal companion, where it is a management tool rather than a public scoreboard.

The same restraint applies to prior action items that did not land. In the client brief they
appear as a neutral open check with the evidence. In the internal companion they appear with an
owner and a verdict.

Order by what would move next month most. Five to seven rows is right; more than that and it
stops being triage.

## Headline metrics

A tile strip of six or so figures for the glance, then the full table.

Tiles carry the level and the labelled delta, colour-coded by direction with the semantic colours
(not the accent). Pick the six that would matter to this client: usually retail sales, sessions,
ACOS, TACOS, one catalog or availability measure, and one quality measure like Buy Box. When the
account's data does not serve a metric (VC has no sessions or Buy Box; a young account has no
MoM), drop the tile rather than substituting a lookalike. That rule holds for whole sections
too: a section renders when its gating data exists, and is omitted rather than faked when it
does not.

The table gives current, prior month, MoM, prior year, YoY for every metric. Where a figure has
been normalized, show raw and normalized as separate rows rather than picking one, so the
correction is visible instead of asserted. Use `n/a` where a comparison does not exist; do not
reach for a dash.

Follow the table with a short prose note on trajectory: what the daily series is doing, the exit
rate against the opening rate, and the run-rate close. Say plainly that the run-rate close is
arithmetic. A month-to-date total and a month closing at 45% above its opening rate tell opposite
stories and the client deserves both.

## Charts

Charts are baked-static inline SVG, composed at write time from battery data the way the
tables are: coordinates computed in the generator, literal markup emitted, no chart
library, no runtime fetch. They summarize what the tables already carry; a chart never
introduces a new figure (the one exception, a bridge residual, must foot to the printed
gross split and gets a method-notes line). At most three per document, each data-gated:

- **Monthly trend** (in Headline metrics): ordered sales by month, 8+ closed months
  required, in-progress months excluded. One hue (`var(--accent)`): current month at full
  opacity, the same month last year at 0.62, the rest at 0.38, so the YoY comparison is
  the thing the eye does first. Label only those two bars plus the season peak; per-bar
  `<title>` tooltips carry the rest. Bars round at the value end only, square at the
  baseline.
- **Mechanism bridge** (in What actually moved, after the gross-split lede): prior month
  to current month via the mechanisms. Anchors are level ticks with their values; deltas
  are floating bars in `var(--good)`/`var(--crit)` with dotted connectors; every bar is
  direct-labeled. The mechanism split must match the claims register's attribution row,
  and the caption names the basis (item-level vs account).
- **Daily line** (optional, wherever the story is intra-month shape, e.g. a stockout
  recovery): the battery daily series, 2px accent line, crosshair + tooltip.

SVG text wears the `.chartfig` text classes (ink tokens, never series colors); gridlines
are `var(--rule-soft)`; viewBox width 940 so charts scale with the page. Dark mode comes
free because every fill and stroke is a CSS token.

## What actually moved

Open with the gross split: gross declines, gross gains, and the net. The net is the account
delta everyone already knows. The two gross figures are the story, because they show whether the
account is churning or stalling.

Then the mechanisms as severity cards, one per mechanism, each with a left border in its severity
colour and a chip for the dollar impact. Three or four cards. Each card says what the mechanism is
and what it cost or contributed. In the client brief the chips carry impact and kind, not an owner
name. Include the good news as a card with a positive severity: a brief that only carries bad news
gets discounted, and the offsetting gains are usually invisible in the topline.

Then the mover table. Declines and gains, with units alongside dollars, and the availability
column where that is the mechanism. Cap it at about ten rows a side.

## Segment reads

Only where the account genuinely splits: sub-brands, marketplaces, product lines. Honor
`reporting.group_merges` from brand context: a replaced line and its successor compare as
ONE group (the operator declares the merge once; every later report inherits it), and a
merged pair never reports its halves as independent trends. A table with
both segments side by side, then a short prose read per segment.

Four rows earn their place in every segment table beyond the obvious sales and efficiency lines,
because together they separate "we cannot sell it" from "nobody wants it":

- **Buy Box, page-view weighted.** Not a simple average. The weighted figure is what shoppers
  actually met, and the two can disagree on direction: on one reference month the account's
  simple average read down about half a point while the weighted figure was up a full point,
  and the affected brand's weighted Buy Box had *improved* month over month even with a
  multi-week outage inside the window.
- **In-stock items per day** and **listed items per day**, side by side. When listings rise while
  in-stock falls, the catalog got broader and thinner at once. Report both or the next question
  undoes you.
- **Share of page views landing on an in-stock item.** Usually the most legible availability
  number in the document, because it is stated from the shopper's side.

Amazon reports offer count only at account level, so the segment counts are ours. Say so
in the internal method notes (i06) and say they will not tie to the account row; the
client caption states plainly what the counts mean, not where they came from.

This is where the settled-window check does its work, because efficiency deterioration is
almost always concentrated in one segment rather than spread evenly. Run the check before
writing the claim; the client copy asserts the verified result, and the internal method
notes cite the settled figure that makes it defensible.

Where a segment read implies an action on our side, say what the lever is in the client brief
without turning it into a confession: "bids have room to come down on the rows serving
out-of-stock neighbours, and that is our next lever" is right. The accounting of what we said we
would do last month and did not belongs in the internal companion.

## Featured offer status

Client-facing, and one of the most useful sections in the document, because it is where the
month's fixable money sits. Structure it as: what broke and recovered, then what is still open.

For a resolved item give the break date, the recovery date, the daily sales rate before, during
and after, and the live offer state today. The page view collapse belongs here too: it is what
explains why a featured offer loss costs more than its own conversion.

For the still-open set, lead with the **last 7 days** column and say explicitly that this is
current state rather than a month average. A table mixing resolved and open items is fine and
useful, as long as each row carries a status chip so nobody misreads a fixed item as broken.

Where the diagnosis distinguishes suppression from a competitor, say which, because the two have
completely different fixes and the client's team will act on whichever you name.

## Custom sections (per brand)

Standing per-brand sections live as spec files in `clients/<brand>/report-sections/*.md`
and render data-gated like every standard section. Spec format: frontmatter (`id`,
`title`, `documents: client|internal|both`, `position: after <standard section id>`,
`gating`, `added`), then plain-language composition notes: which data serves it, which
figures matter, this brand's data gotchas, and why the client cares (the manager's own
words, so the section keeps earning its place). Keep each spec under a screen; it is
instructions to a future run, not documentation. Creation, persistence and removal all
run through the review gate (see SKILL.md "Custom sections"); a section nobody asked to
keep is a one-off, not a standing spec.

## What to tell the client

**Internal companion only.** Numbered in speaking order, which is usually:
mechanism, counterweight, specifics, the hard item, the positive, the trajectory. Each point gets
a short bold instruction and, where the wording matters, a suggested spoken line set off as a
quote.

Include any **framing trap**: a true statement that invites a question you cannot answer well.
"The catalog is wider than ever" is one, if availability fell in the same month.

If the analysis changed while you were doing the work, put the correction at the very top of this
document, before the talking points. the operator needs to know what *not* to press on, and a
correction buried in section three gets read after the call.

Write the spoken lines the way people talk, and in the CLIENT register: a say-line is
what the manager says out loud to the client, so it takes the same read-aloud test as the
client brief (no basis talk, no machinery). "Ten items that were sellable last month went
out of stock this month, and those ten are most of the gap" is sayable.
"Availability-driven revenue attrition totalled $53,271" is not, and neither is "that
survives the settled-window check".

Numbering here encodes real sequence, so it earns the numerals. Do not number sections that are
not sequences.

## Numbers not to quote

**Internal companion only.** Everything from the pressure-test pass, as severity cards. Typically
two kinds:

- **Broken inputs.** A forecast that does not reconcile to actuals on the same basis, a workbook
  with several unlabelled scenarios, a metric whose feed has gaps. Say what is wrong, show the
  reconciliation that proves it, and route it to an internal fix rather than onto the call.
- **Weak bases.** A year-over-year figure flattered by an anomalous prior-year month. Give the
  surrounding months as evidence. Use the number, do not lean on it.

Then a short list titled along the lines of "where I would not assert a cause": each swing that
the data shows but cannot explain, with what would settle it. Being explicit here is what lets
every other causal claim in the brief be taken at face value.

## Open commitments

**Internal companion only.** The action items from the prior call as a table: item, owner, and
what the data says. Three verdicts, chipped: landed, not landed, not checkable. Include
MixShift's own items, and check the daily series before writing "not landed" about any of them.

## The review packet is plain language; i05 is the audit trail

Two renderings of the same register, two audiences. The PACKET (chat, pre-publish) is for
the operator deciding in thirty seconds per item: plain words, why-it-matters, questions
clearly asked as questions. i05 (below) is for the operator three months later checking
what was claimed and on what evidence: provenance chips, falsifiers, technical phrasing
welcome. Writing the packet at i05's register is the failure mode: the reviewer cannot
tell statements from questions and stops reading.

## Claims register (i05, internal only)

The internal companion's audit centerpiece: one row per assertion the brief makes beyond
its checked figures. Columns: the claim (one sentence), source (a chip, in reader
language: Intelligence run, Amazon data, Live check, Brand notes, Call history, Your
answer at review, or Derived; the machine taxonomy stays in claims.json), confidence
(asserted / consistent with / question), and the falsifier (what evidence would change
it). This is
the review surface: the packet the operator approves is built from this table, and the
published copy is the audit trail of what was approved. Keep it honest and short; a
register padded with restated figures buries the four rows that carry judgment.

## Our next lever

**Internal companion only.** The specific action the analysis implies, scoped tightly enough to
execute: which rows, which exclusions, and what makes now the right time. One or two paragraphs.
This is the difference between a brief that describes a month and one that starts the next.

## Method and caveats (i06, internal only)

The internal companion's closing section, after the claims register, and worth writing
properly, because it is what someone reads when they want to check a figure three months
from now. None of it appears in the client document.

- Sources in the reader's language: which Amazon reports (business, advertising,
  inventory), the intelligence run, live checks with dates. Query-level provenance
  (exact tables, run ids, versions) lives in the run record; say so here once
- Account, SellerID, marketplace, account mode, and what is deliberately excluded
- The threshold values applied, quoted so a later reader can re-derive every flag
- Attribution rule applied, per campaign type
- Any unsettled-attribution caveat and which claim was verified on a settled window instead
- Any normalization: what was scaled, by what factor, which figures it touched, which it did not
- Definitions that count something in a non-obvious way, especially the out-of-stock definition
- The SKU reconciliation result as a figure
- How the split was derived and how much was unmapped
- That the run-rate close is arithmetic

## Voice

These are the house rules. If your organization ships its own writing-style skill, it wins where they conflict. The rules that break most often:

**No em dashes or en dashes.** Not `-`, not `&mdash;`, not `&ndash;`. Ranges as "Aug 1 to Aug 25"
and "$39K to $49K". A period for two joined clauses, commas or parentheses for an aside, a colon
before an explanation. Scan the finished file for U+2014, U+2013, U+2015, U+2012 and the two
entities before publishing.

**Sign every change.** "-8.1 pts", not "8.1 pts". Both in prose and in tables.

**Label every delta.** Every single one; a brief read out of order otherwise mislabels
itself. In tables, tiles and chips the labels are MoM and YoY. In client PROSE the label
is words: "up 5.3% on July", "down 16.5% vs last August"; a list of sibling deltas may
share one label. The internal companion may use MoM/YoY anywhere.

**Lead with the answer.** Conclusion first, evidence second, in every paragraph and in the
document as a whole.

**Say ACOS or Total ACOS.** "Blended ACOS" is banned.

**Name the lever.** Lower spend is a bid pullback or a budget decision. Say which. It is never
just a number that went down.

**Cut squishy words.** "Significant", "meaningfully", "strong signal", "clean result",
"dominant". Each one is standing in for a figure. Write the figure.

**Own the recommendation.** "Our read is", "I'd raise this first". Not "it could be argued that".

**Caveats get their own sentence**, positioned next to the claim they qualify, not stacked at the
end where nobody reads them. Repeat a critical definitional caveat at every table it affects;
once at the top is not enough for a document that gets skimmed.

**No invented causality.** Do not write "X drove Y" unless the mechanism is in the data. State
the metric, state the direction, and put the why in Things to check as a question.

## Design

Build from `assets/brief-template.html`. Keep the token block, the two-theme structure, the
IBM Plex pairing (Serif for display, Sans for body, Mono for figures and labels) and the
component classes. Replace the content.

The design is deliberately instrument-panel rather than editorial, because this page is scanned
and operated, not read. What that means in practice:

- Figures are monospaced with `tabular-nums` so columns line up
- Semantic colour carries direction and severity, and is kept separate from the accent
- Severity is encoded in form as well as number: a left border, a chip, a state label
- Wide tables scroll inside their own container so the page body never scrolls sideways
- All three theme states are handled: bare `:root` for light, `prefers-color-scheme: dark`
  guarded with `:not([data-theme="light"])`, and `[data-theme="dark"]` for the explicit toggle

The published pages are the two per-brand HUBS, and their titles are STABLE across every
republish: "Acme Goods Performance Reviews" and "Acme Goods Call Notes (Internal)". Keep the
favicon stable too; clients find a bookmarked tab by its icon. The month and its conclusion
live inside each period's fragment (its masthead h1), not in the hub title. Generic titles
("Monthly Performance Report Summary") still fail: the hub must read as this brand's page in
a gallery of many.

When handing over the URLs, say plainly which one is shareable. That one sentence is what stops
the internal companion reaching a client.
