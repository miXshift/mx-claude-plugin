---
name: mx-featured-offer-check
description: >
  Check, on demand, which of your ASINs hold the Amazon featured offer (the
  Buy Box) and which do not: Amazon's own answer per shopper segment with its
  share of views, then the shelf for every ASIN you lose, so each loss is
  explained (a faster delivery promise, a lower price, no featured offer at
  all, or your offer missing from the listing) and shown by location on one
  page. Reads only; runs in resumable phases through the bundled CLI. Also
  runs a guided demo on your own account (demo featured offer check). Uses
  the MixShift plugin sign-in; no brand setup. Beta.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - featured offer check
  - check my featured offer
  - who has my buy box
  - did we lose the buy box
  - buy box check
  - am i winning the buy box
  - why did we lose the featured offer
  - featured offer by segment
  - buy box across my asins
  - demo featured offer check
  - featured offer check demo
  - walk me through the featured offer check
---

# Featured Offer Check (who holds your Buy Box, where, and why)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.

## About this check (authoritative, do not guess)

- **Two sources, both dated.** Amazon's answer comes from your account's Product Pricing data (the Competitive Summary): for each ASIN, which seller is featured for each shopper segment (Prime, non-Prime, default), the segment's share of views, and a sample zip per segment. The shelf's answer is a public observation through MixShift's service (never your Amazon credentials): the Buy Box as a shopper at a zip sees it, with the delivery promise, and the full offer list. Amazon says *that* you lost and *how much* it matters; the shelf says *why* and *where*.
- **What "lost" means here.** Held: you hold at least 99% of the views. Partial or lost: another seller is featured for some or all segments. No featured offer: Amazon names no featured seller at all (the Buy Box is suppressed). Errors (an ASIN Amazon rejects) are listed, not guessed.
- **The diagnosis.** For each lost ASIN the shelf is read at the lost segments' sample zips (when they are observation points) and a few metros, plus the offer list once. The reason is one of: lost on delivery promise (same or higher price, faster promise), lost on price, no featured offer at those locations, our offer missing from the listing (out of stock or not buyable there), lost in segments that could not be observed, or unresolved.
- **Cost.** Amazon's answer is free to you. Each shelf call counts one against your organization's monthly shelf allowance: about five per lost ASIN (four Buy Box reads and the offer list). Held ASINs cost nothing unless asked. Say the estimate before spending; `mixshift shelf usage` shows what is left.
- **Reads only.** Nothing changes on Amazon or in your account. The output is a page and a markdown file in `~/.mixshift/output/featured-offer-check/<seller>-<date>/`.
- **Resumable.** A shell call in chat has a ceiling of about 45 s, so the check runs in phases: `start`, then `resume` until the answer says `next` is null. Nothing is lost between calls; the state is on disk.

If the user asks "where does this come from," say: *your account's featured-offer data from Amazon, and public shelf observations through MixShift's service.* Do not name the shelf-data provider; nothing in the output does either.

## When to use this skill

- "Check my featured offer." / "Who has my Buy Box?" / "Did we lose the Buy Box on anything?"
- "Why did we lose the featured offer on B0055QS6AK?" (one ASIN, same path)
- After a daily health check or a sales drop points at the Buy Box.
- "Demo featured offer check." Run the Demo section.

Route elsewhere: a single Buy Box read at one zip, keyword rank, offers or a seller lookup with no account answer is `mx-amazon-shelf`. The win-back price (what to price at to regain the offer) is the FOEP batch in `mx-amazon-report`'s pricing surface; this check does not fetch it.

## Prerequisites

| State | How to check | If missing |
|---|---|---|
| Signed in | `~/.mixshift/auth/credentials` exists | `mixshift auth login`. |
| A seller merchant on this sign-in | `mixshift amazon merchants --json` lists it | The merchant must be connected to the MixShift account; vendors have no Buy Box and are skipped. |
| Shelf data on for the organization | `mixshift shelf usage --json` succeeds | `shelf_not_enabled`: ask MixShift. The Amazon half still runs; say the shelf half is unavailable. |

## Step 1: the merchant and the ASINs

```bash
mixshift amazon merchants --json
```

Pick the seller row (`merchantType` Seller) and keep its `legacySellerId`. If several, ask which by name. Then the ASINs: the user's list, or the account's active ASINs from the warehouse (SKUs with sales in the last 30 days, the same list the pricing surfaces key on):

```bash
mixshift data query --sql "SELECT DISTINCT ChildAsin AS asin FROM business_reports_dpst_sku WHERE SellerID = <legacySellerId> AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND ChildAsin IS NOT NULL ORDER BY asin" --out asins.csv --json
```

Write the ASINs one per line to a file for `--asins-file`. Up to 100 per check; more than 20 runs Amazon's part asynchronously (a minute or two). Before starting, say the cost: lost ASINs are unknown until Amazon answers, so say "up to about 5 shelf requests per lost ASIN" and what `mixshift shelf usage` shows.

## Step 2: run it in phases

```bash
mixshift shelf featured-offer-check start --legacy-seller-id 574 --asins-file asins.csv --json
mixshift shelf featured-offer-check resume --json      # repeat until "next" is null
mixshift shelf featured-offer-check status --json
```

Options: `--asins B0...,B0...` instead of a file; `--zips 10001,60601` to choose the metros observed besides the lost segments' sample zips (default New York, Chicago, Dallas, Los Angeles); `--include-held` to observe held ASINs too (costs allowance); `--budget <n>` shelf calls per invocation (default 12); `--out <dir>` to name the directory.

Each call answers `{ status, out_dir, progress: { phase, asins, summarized, flagged, shelf_calls_total, shelf_calls_done, shelf_answers_spent }, next, blocked, report }`. Keep calling `resume` while `next` is `"resume"`; show the progress line between calls ("12 of 25 shelf reads done"). When `phase` is `summary_pending`, Amazon's part is still running; `resume` polls it. When `blocked` is set, stop and say why: `shelf_allowance_exhausted` carries `requestMore` (offer "request more shelf requests", the `mx-amazon-shelf` flow; the run resumes after more is granted); `shelf_not_enabled` means the shelf half is off for the organization.

## Step 3: read the page and say what to do

When `next` is null, read `report.md` (tables for you) and point the user at `report.html` (the page). Lead with the counts: checked, held, flagged, and the flagged ones by reason. Then one line per flagged ASIN from its `detail`, and the action the reason implies:

| Reason | What it usually means | What to do |
|---|---|---|
| lost on delivery promise | same or higher price, faster promise to that zip | FBA placement or inventory in that region; not a price cut |
| lost on price | a seller is cheaper there; the offer list says who and by how much | price decision, or the reseller conversation (look the seller up with `mx-amazon-shelf`) |
| no featured offer | the Buy Box is suppressed for everyone at those locations | a lower price off Amazon or a listing issue; the case is with Amazon |
| our offer missing | we are not in the offer list at that zip | stock or buyability; check inventory and the listing |
| lost in unobserved segments | we win every observed zip; the losing segments' sample zips are not observation points | watch the ASIN; add zips with `--zips` if the user knows the region |
| unresolved | Amazon says lost; the shelf had no answer | retry later; Amazon's row is still the finding |

Quote both dates when you state a fact (Amazon's answer time and the shelf observation time). Never fill a missing value with a guess. If the user wants a second look at one ASIN right now, `mx-amazon-shelf` with "right now" observes fresh at the same cost.

## Demo ("demo featured offer check")

A guided walkthrough on the user's own account, per the demo contract in `shared/skill-runtime-contract.md` ("Demos"): real data, read only, each step ending with the sentence that runs it again. The demo spends about five shelf requests (one lost ASIN) and says so in step 1.

**Open.** Run the opener and show its output verbatim, then go straight to step 1:

```bash
mixshift demo mx-featured-offer-check
```

"skip" moves on, "stop" ends, questions are answered before moving on. If the user starts real work, that is the demo succeeding.

### Step 1: Your merchant and a few ASINs

`mixshift amazon merchants --json`: name the seller account (ask which if several) and ask for three to five ASINs the user cares about, or take the top five by sales from the warehouse query in Step 1 above. Say the cost: Amazon's part is free; the shelf part is about five requests per lost ASIN, and `mixshift shelf usage --json` says what is left. If no seller merchant is connected, or `shelf usage` answers `shelf_not_enabled`, say so, describe steps 2 to 4 in one sentence each, and close.

Next time, just say: *"check my featured offer on <asins>"*.

### Step 2: Amazon's answer, by shopper segment

`mixshift shelf featured-offer-check start --legacy-seller-id <id> --asins <list> --budget 0 --json` (budget 0: Amazon's part only, no shelf spend yet). From `progress`, say how many are held and how many flagged; from the state file (`<out_dir>/state.json`, `summaries`), show one table: ASIN, status, our share of views, the top competitor's share. Explain the segments in one sentence: Amazon features a seller per shopper segment (Prime, non-Prime, default), weighted by views, each with a sample zip.

What is this: your account's own featured-offer data, the same source the win-back price comes from, read per segment instead of collapsed to one number.

Next time, just say: *"who has my Buy Box on <asins>, by segment?"*

### Step 3: The shelf for the ASIN you lose

`mixshift shelf featured-offer-check resume --json`, repeating while `next` is `"resume"`, showing the progress line. When it finishes, open `report.md` and, for one flagged ASIN, show the shelf table: zip, why that zip (a lost segment's sample zip or a metro), the winner, price, fastest promise in days, observed time; then the offer line (ours, lowest other, how many below us). Say the reason in one sentence from `detail`. If nothing was flagged, say so and show the held table instead.

What is this: the shelf as a shopper at each location sees it, dated, next to Amazon's dated answer; the two together say why.

Next time, just say: *"why did we lose the featured offer on <asin>?"*

### Step 4: The page, and what to do next

Point at `report.html`, read the counts off the top, and say the action each reason implies (the table in Step 3 above). Offer the two follow-ups: a fresh look at one ASIN right now with `mx-amazon-shelf`, and the reseller lookup for a seller they do not recognize.

Next time, just say: *"check my featured offer"*.

### Close

Recap the "next time" sentences from the steps the user saw. Add two or three more they can try: "check the featured offer on my top 20 ASINs", "who has the Buy Box for <asin> in Seattle right now?", "track these keywords for me". Say how many shelf requests the demo used. Then:

```bash
mixshift demo mx-featured-offer-check --finished --steps-shown <n>
```

## Reactive error handling (branch on failure_kind, never on HTTP status)

The Amazon half fails like the pricing surface (`not_authenticated` 2, `merchant_not_found` 7, `throttled` 8, `bad_request` 12, `too_many_items` means split the list). The shelf half pauses the run with `blocked`: `shelf_allowance_exhausted` (exit 10; offer to request more, resume later), `shelf_not_enabled` / `shelf_not_enrolled` (exit 6; the shelf half is off for this organization, Amazon's table still stands), `upstream_unavailable` on one call is recorded as a failed read and the run continues. A `FATAL` summary run is reported with Amazon's `errorDetail`; do not resend the same list unchanged.

## Telemetry (required)

At the START of every invocation, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-featured-offer-check
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-featured-offer-check --trigger-phrase "<the user's exact phrase>"
```

At the END (when the session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-featured-offer-check --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (the page was produced), `failed` (Amazon's part failed, or the shelf half was off and the user wanted it), `deferred` (paused at the allowance wall or mid-demo), `skipped` (they wanted a different skill). The harness fires `shelf.featured_offer_check` per phase with counts only (ASINs, flagged, shelf calls, reasons), never an ASIN, a seller or a price; the shelf calls it makes fire `shelf.called` as usual.
