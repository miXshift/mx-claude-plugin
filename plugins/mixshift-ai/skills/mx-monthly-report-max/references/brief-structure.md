# Brief structure and voice

Two documents. The **client brief** is written so the client can read it directly. The **internal
companion** holds everything that would damage the relationship if shared: talking points, the
numbers to keep off the call, owner-attributed asks, and MixShift's own misses.

The reader of either has fifteen minutes and a call to run. Every section either changes what
happens on that call or comes out. This file spells out what each section is for, so you can tell
when a section has nothing to contribute and should be dropped rather than padded.

## Client brief, in order

Masthead, scope bar, bottom line, headline metrics, what actually moved, segment reads, featured
offer status, things to check, method and caveats.

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

## Scope bar

Before the first number, always. It carries:

- Account, SellerID, marketplace, and whether this is Seller Central or Vendor Central
- The three windows with exact dates
- Why the windows end where they do, when the data load date drove it
- Any correction being applied and to which figures, such as a dark-day normalization

A client with both a 1P and a 3P account will otherwise assume the wrong one, and a brief that
does not date its windows cannot be checked later.

## Bottom line

One paragraph, three moves: the conclusion, the mechanism, the counterweight. A second short
paragraph only if there is a genuinely separate second finding.

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

Only where the account genuinely splits: sub-brands, marketplaces, product lines. A table with
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

Amazon reports offer count only at account level, so the segment counts are ours. Say so in the
method notes and say they will not tie to the account row.

This is where the settled-window check gets cited, because efficiency deterioration is almost
always concentrated in one segment rather than spread evenly. Naming the segment and the settled
figure is what makes the claim defensible.

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

Write the spoken lines the way people talk. "Ten items that were sellable last month went
out of stock this month, and those ten are most of the gap" is sayable. "Availability-driven
revenue attrition totalled $53,271" is not.

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

## Our next lever

**Internal companion only.** The specific action the analysis implies, scoped tightly enough to
execute: which rows, which exclusions, and what makes now the right time. One or two paragraphs.
This is the difference between a brief that describes a month and one that starts the next.

## Method and caveats

Last, and worth writing properly, because it is what someone reads when they want to check a
figure three months from now.

- Source tables by name
- Account, SellerID, marketplace, and what is deliberately excluded
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

**Label every delta MoM or YoY.** Every single one. A brief read out of order otherwise
mislabels itself.

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

Title each artifact as a name, two to four words, specific to the account and occasion, and give
the two documents distinct titles and favicons so they cannot be confused in the gallery. The
internal document's title always carries "(Internal)". "Acme Goods August Performance Review"
and "Acme Goods August Call Notes (Internal)" work. "Monthly Performance Report Summary" does
not, because it could sit on any page in the gallery.

When handing over the URLs, say plainly which one is shareable. That one sentence is what stops
the internal companion reaching a client.
