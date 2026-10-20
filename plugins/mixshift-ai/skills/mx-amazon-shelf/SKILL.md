---
name: mx-amazon-shelf
description: >
  See the Amazon shelf the way a shopper at a given zip sees it, on demand:
  who holds the Buy Box for an ASIN and with what delivery promise, every
  offer on a listing with each seller's price, where ASINs rank for a keyword
  (organic and sponsored, desktop and mobile) with badges, coupons and stock
  warnings, the product page as it renders today, and who a third-party
  seller is. Public shelf observations through MixShift's service, never your
  Amazon credentials; each answer counts one against your organization's
  monthly shelf allowance. Runs a guided demo on your own ASIN and keyword
  (demo Amazon shelf) and a catalog with a plain what-is-this per call. Uses
  the MixShift plugin sign-in. Does not require brand setup. Beta.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - shelf data
  - what does the shelf look like
  - who has the buy box
  - buy box by zip
  - buy box winner
  - featured offer by location
  - delivery promise by zip
  - every seller on this asin
  - other sellers on my listing
  - who is this seller
  - where do we rank for
  - keyword rank at a zip
  - organic rank
  - sponsored rank
  - search results page for
  - what does the product page show
  - demo amazon shelf
  - amazon shelf demo
  - show me a demo of amazon shelf
  - walk me through amazon shelf
  - tour amazon shelf
  - what can you do with shelf data
  - request more shelf requests
  - more shelf requests
  - shelf allowance
  - track these keywords
  - track my keyword rank
  - keyword rank tracking
  - rank history
---

# Amazon Shelf (what the shopper sees: Buy Box, offers, keyword rank, product page)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.

## About shelf data (authoritative, do not guess)

When characterizing this capability to the user, use these facts:

- **What it is:** a public observation of what a shopper at a given location
  sees on Amazon right now: the Buy Box for an ASIN, the whole offer list,
  the search results page for a keyword, the product page, a seller's
  storefront. It is the shopper's view, not the account's data.
- **Where it comes from:** a licensed third-party shelf-data provider,
  through MixShift's service at `mcp.mixshift.io`, on MixShift's own key. If
  the user asks "where does this come from," say: *public shelf observations
  from a licensed third-party shelf-data provider, through MixShift's service,
  joined to your authorized account data only when a workflow does the join.*
  Do not name the provider; nothing in the answers does either.
- **Not your credentials, not your data:** no call uses the account's Amazon
  credentials, and nothing of the account's is sent. An ASIN, a keyword or a
  seller id is the only input.
- **By location:** every answer is taken as a shopper at one zip (or the
  default location when no zip is given). The Buy Box, the delivery promise
  and the ranked page can differ by zip. The zips are a fixed list per country
  (`mixshift shelf zips`); a zip off the list is refused for free.
- **Dated:** every data answer carries `observed_at`, when the shelf looked
  like this. MixShift may answer from a recent observation; `--fresh` asks for
  the shelf as of now at the same cost. Use `--fresh` when the question needs
  timeliness (right after a price change, "is it back"); a read-out does not.
- **Metered:** every data answer counts one against the organization's
  monthly shelf allowance, whether or not MixShift had to observe the shelf
  for it. `mixshift shelf usage` shows allowance, used, remaining and the
  reset date; `shelf zips` and `shelf usage` are free. Unused requests do not
  roll over.
- **Read-only:** nothing here changes anything, anywhere.
- **Beta:** every enrolled organization has shelf data on from 2026-10-20, on
  the discovery allowance (`shelf_not_enabled` means MixShift switched it off
  for this organization; `shelf_not_enrolled` means the account has no
  organization yet). The product-page call is itself beta (fields can be
  missing; its answer says `beta: true`).

If this conversation also has MixShift connector tools named `shelf_get_buybox`,
`shelf_get_offers`, `shelf_search`, `shelf_get_product`, `shelf_get_seller`,
`shelf_list_zips` and `shelf_get_usage`, they are the same seven calls. Use one
path, not both; prefer the CLI below.

### How this differs from the account's own data

| Question | Surface |
|---|---|
| "Did *my account* lose the featured offer, and what share of views does that segment carry?" | `mx-amazon-retail` / `mx-amazon-report` (SP-API pricing: the account's own featured-offer and competitive-summary data) |
| "Who has the Buy Box *at this zip*, with what promise, and who else is on the listing?" | **this skill** (the shopper's view) |
| "Where do we rank for a keyword, with badges and sponsored positions, as a shopper sees it?" | **this skill** |
| "How did our ads perform on that keyword?" | `mx-amazon-ads` / `mx-data-explore` |

The two sides join by ASIN and by date: an SP-API loss says *that* it
happened and how much it matters; the shelf says *why* (price, promise,
badge, stock) and *where*.

## When to use this skill

Trigger when the user asks what the **shelf** looks like, for example:

- "Who has the Buy Box for B0055QS6AK in Dallas?" / "Do we win the Buy Box in
  New York and LA?"
- "List every seller on this ASIN and their prices." / "Is anyone undercutting
  us?"
- "Where do we rank for 'backpacking meals' in Chicago, desktop and mobile?"
- "What does the product page for B07BDBDT21 show right now?"
- "Who is seller A1EXAMPLESELLER?"
- "Demo Amazon shelf." / "Walk me through shelf data." Run the Demo section.
- "What can you do with shelf data?" Run `mixshift shelf catalog` and answer
  from it, then offer the demo: *say "demo Amazon shelf" and I'll walk you
  through it on your own ASIN and keyword.*

Route elsewhere:

- The account's **own** featured-offer status, fees, inventory, orders:
  `mx-amazon-retail`.
- Ads performance and changes: `mx-amazon-ads`; warehouse data: `mx-data-explore`.
- Sales estimates: not here. "Bought in past month" is Amazon's own label on
  the page, shown as `monthly_sales`; it is not an estimate.

## Prerequisites the user needs

| State | How to check | What to do if missing |
|---|---|---|
| Signed in to MixShift | `~/.mixshift/auth/credentials` exists | Run `mixshift auth login` (or say "sign in to MixShift" in chat). Calls fail with `not_authenticated` until then. |
| Shelf data on for the organization | `mixshift shelf usage --json` succeeds | `shelf_not_enabled` (exit 6): MixShift switched shelf data off for this organization; tell the user to ask MixShift. `shelf_not_enrolled`: the account has no organization set up yet; same ask. |
| Allowance left this month | `shelf usage` shows `remaining` > 0 | `shelf_allowance_exhausted` (exit 10) carries the reset date and `request_more`; see "Requesting more" below. |

Brand setup is **not required.** A signed-in session is enough.

## Step 1: the catalog (discovery first)

```bash
mixshift shelf catalog          # chat markdown: what each call answers, takes, returns, costs
mixshift shelf catalog --json
```

Seven calls. Read the entry before calling; it carries the inputs, the fields
worth reading first, and a question it answers:

| Call | What it answers | Cost |
|---|---|---|
| `shelf buybox <asin>` | the Buy Box at a zip: price, seller, ships-from, Prime, stock, delivery promise as text and days | counts 1 |
| `shelf offers <asin>` | every offer at a zip: each seller's price, FBA or not, condition, promise days; the seller ids | counts 1 |
| `shelf search <query>` | the results page for a keyword at a zip: rank and absolute rank, sponsored or organic, price, rating, reviews, bought in past month, badges, coupon, stock text, banners | counts 1 per page |
| `shelf product <asin>` | the product page: title, bullets, details, images, best-seller ranks, rating, badge, Buy Box block, customers say (beta) | counts 1 |
| `shelf seller <seller-id>` | who a third-party seller is: storefront name, rating, business details | counts 1 |
| `shelf zips` | the shopper locations per country | free |
| `shelf usage` | this month's allowance, used, remaining, reset date | free |

## Step 2: the call shape

```bash
mixshift shelf buybox B0055QS6AK --zip 75201 --json
mixshift shelf offers B0055QS6AK --zip 10001 --json
mixshift shelf search "backpacking meals" --zip 10001 --view desktop --page 1 --json
mixshift shelf product B07BDBDT21 --json
mixshift shelf seller A1EXAMPLESELLER --json
mixshift shelf zips --country us --json
mixshift shelf usage --json
```

- `--zip` is a shopper location from `shelf zips` (omit for the default
  location; `seller` takes none). `--country` is `us` by default.
- `--fresh` observes the shelf now instead of serving a recent observation
  (same cost). `--origin demo` marks demo calls (attribution only).
- `--json` returns the full envelope and is what to parse. Without it, the
  command prints a readable table.

A success envelope is
`{ status: "ok", kind, retailer, country, zip, subject, observed_at, source: "shelf", data }`
(`beta: true` on product). `observed_at` is when the shelf looked like this:
quote it with every number you report ("as of 23:01 UTC today").

## Tracking keywords over time ("track these keywords for me")

Every answer is dated and MixShift keeps every observation it takes, so the same
keyword at the same zip asked again next week is a dated series the user can
compare. A MixShift-run tracked keyword list (daily observations, the history
on a page, feeding the daily health check and the monthly report) is being
built on this data. When the user asks to track keywords, or asks for rank
history MixShift does not hold yet, offer to send the request. With their yes,
run:

```bash
mixshift feedback "Track keyword rank for this organization: keywords <list>; locations <zips or metros>; cadence <daily|weekly>; devices <desktop, mobile or both>. <one line on what they will use it for, if they said>" --category feature_request --skill mx-amazon-shelf --command "shelf search"
```

Tell the user MixShift sets the tracking up and gets back to them, that the daily
observations count against the allowance like any other answer, and that the
price of keeping history, if any, is decided before it is charged. Emailing
MixShift the same list is the other route. Until then, the user can repeat the
search themselves (or schedule it with the scheduled-task skill) and keep the
dated answers.

## Requesting more ("request more shelf requests")

Every data answer counts one against the organization's monthly allowance
(`mixshift shelf usage` shows allowance, used, remaining and the reset date).
When a call answers `shelf_allowance_exhausted`, or the user asks for more
before that, offer to send the request to MixShift. If they say yes, run:

```bash
mixshift feedback "Request more shelf requests for this organization: used <used> of <allowance> for <period>, resets <resets_at>. <one line on what they are using it for, if they said>" --category feature_request --skill mx-amazon-shelf --command "shelf <the call that hit the wall>"
```

Take `used`, `allowance`, `period` and `resets_at` from the failure (or from
`shelf usage`). Tell the user MixShift raises the allowance from the
organization's settings and that it applies to the current month; the free
reads (`shelf zips`, `shelf usage`) keep working meanwhile. One request per
organization per month is enough; do not send it again on every refused call.

## Starter jobs

### "Who has the Buy Box for this ASIN, and where?"

One call per zip. Pick the zips that matter: the big metros (10001 New York,
60601 Chicago, 75201 Dallas, 90001 Los Angeles, 02108 Boston, 30303 Atlanta,
80202 Denver, 98101 Seattle) or the zip the account's SP-API segment names.
Lead with who won where and at what price, then the delivery-promise gap:
`promise_days_fastest` for the winner versus the account's own offer (from
`shelf offers`). A same-price loss is usually a promise loss.

### "Is anyone undercutting us? Who are they?"

`shelf offers <asin> --zip <zip>`: sort `offers[]` by `price_num`, flag
anything below the account's price, note `fba` and `conditions`. Then
`shelf seller <seller_id>` on the ones the user does not recognize: business
name and address are the unauthorized-reseller tell.

### "Where do we rank for a keyword?"

`shelf search "<keyword>" --zip <zip>` (desktop), then `--view mobile`.
Report the account's ASINs by `absolute_rank` with `is_sponsored`, the badge,
the coupon and the stock text; the top of the page (who is sponsored, which
banners); and `related_keywords` as harvest candidates. Deeper pages:
`--page 2` (each page is one answer; 5 pages at most).

### "What does the product page show today?"

`shelf product <asin>`: title, bullets, details, images, best-seller ranks,
rating and review count, "bought in past month", the badge, the Buy Box block,
"customers say". Beta: say so when a field is missing rather than inferring it.

## Demo ("demo Amazon shelf")

A guided walkthrough of this skill on the user's own ASIN and keyword,
following the demo contract in `shared/skill-runtime-contract.md` ("Demos"):
real data, read only, one screen per step, each step ending with the sentence
that runs it again. Nothing on the account changes; the demo spends about
eight shelf answers of the organization's allowance (step 1 says how many are
left). Run it when the user asks for a demo, tour or walkthrough of shelf data,
or says yes to the demo you offered.

**Open.** Run the opener and show its output verbatim, then go straight to
step 1:

```bash
mixshift demo mx-amazon-shelf
```

The user can say "skip" (next step), "stop" (go to the close), or ask anything
mid-step: answer it, then carry on. If they start real work instead, that is
the demo succeeding; leave it and help them. Pass `--origin demo` on every
data call in the demo.

### Step 1: What shelf data is, and your allowance

`mixshift shelf usage --json` and `mixshift shelf zips --json`. In three
sentences: shelf data is what a shopper at a location sees on Amazon (Buy Box,
offers, search page, product page), it is public and uses none of the
account's credentials, and every answer is dated and counts one against the
monthly allowance. Say how many are left this month and that this demo uses
about eight. Say how many shopper locations the country has and name the
three metros step 2 will use (10001 New York, 60601 Chicago, 90001 Los
Angeles, or any three the user prefers).

- `shelf_not_enabled` or `shelf_not_enrolled` (exit 6): shelf data is off for
  this organization, or the account has no organization yet. Say so, and that
  MixShift turns it on. Then describe steps 2 to 6 in one sentence each from
  the catalog (`mixshift shelf catalog`), with no numbers, and close.
- `shelf_allowance_exhausted` (exit 10): say when it resets, offer to request
  more ("Requesting more"), describe the steps in words from the catalog and
  close.

Then ask for one ASIN and one keyword the user cares about, unless the
request already named them (an ASIN is a 10-character code such as
B0055QS6AK). Keep both for the rest of the demo.

Next time, just say: *"how many shelf requests do we have left?"*

### Step 2: The Buy Box for one ASIN across three metros

Three calls: `mixshift shelf buybox <asin> --zip 10001 --origin demo --json`,
then `--zip 60601`, then `--zip 90001`. One table, one row per metro: who
has the Buy Box, price, Prime, in stock, fastest delivery and its days. Point
out the first thing that differs by metro (a different winner, a different
promise) or say that all three agree. Quote `observed_at`. If the ASIN has no
Buy Box at a metro, show that row as "no featured offer" and move on.

What is this: the Buy Box is the offer behind Add to Cart, and it can change
with the shopper's location because delivery promises differ by zip.

Next time, just say: *"who has the Buy Box for <asin> in New York, Chicago and LA?"*

### Step 3: Every offer on that ASIN

`mixshift shelf offers <asin> --zip 10001 --origin demo --json`. The featured
offer at the top, then the offer list sorted by price: seller, price, FBA or
merchant-shipped, condition, fastest delivery in days. Say how many sellers
are on the listing and name the lowest price and the fastest promise. Keep
the seller ids: step 6 looks one up.

What is this: one listing, many sellers; this is the "other sellers" list the
shopper can open, with each seller's price and promise.

Next time, just say: *"list every seller on <asin> and their prices"*.

### Step 4: Keyword rank at one zip, desktop and mobile

Two calls: `mixshift shelf search "<keyword>" --zip 10001 --origin demo --json`,
then the same with `--view mobile`. For desktop: the top ten positions
with sponsored or organic, price, rating, reviews, bought in past month and
badge; the sponsored-brand banners at the top; and where the user's own ASINs
land (by `absolute_rank`), or that none are on page 1. For mobile: the 15
positions, and the difference from desktop (mobile shows fewer positions and
no review counts). Mention `related_keywords` in one line.

What is this: the search results page as the shopper sees it, position by
position; "where do we rank" is this, by location and by device.

Emit `shelf.insight` with `rank_found`, `rank_not_found` or `sponsored_only` for the desktop page (one event).

Next time, just say: *"where do we rank for <keyword> in New York, desktop and mobile?"*

### Step 5: The product page as the shopper sees it

`mixshift shelf product <asin> --zip 10001 --origin demo --json`. Title,
rating and review count, "bought in past month", best-seller ranks by
category, the number of images, the first two bullet points, the Buy Box block,
and one line of "customers say". Say the call is beta: a field can be missing
on some listings, and this answer says `beta: true`.

What is this: the listing itself, parsed, so you can check what the page
shows today or compare a competitor's page with yours.

Next time, just say: *"what does the product page for <asin> show right now?"*

### Step 6: Who that seller is

Take one seller id from step 3 that is not the user's own (if every offer is
the user's or Amazon's, take the featured offer's seller id, or skip this
step and say why). `mixshift shelf seller <seller_id> --origin demo --json`:
storefront name, rating and count, and the business details Amazon shows
(business name and address, where listed). Say what that tells the user: a
storefront with a business name and address that is not theirs is the
unauthorized-reseller tell.

What is this: the "who is this reseller" step after the offer list.

Next time, just say: *"who is seller <seller_id>?"*

### Close

Recap the "next time" sentences from the steps the user saw. Add two or three
more they can try:

- "who has the Buy Box for <asin> at the zips Amazon reports for my featured-offer segments?";
- "where do we rank for <keyword> in Dallas, page 2?";
- "run that Buy Box check again now" (that is `--fresh`: the shelf as of now, same cost).

Say how many shelf answers the demo used and how many are left
(`mixshift shelf usage --json`). Ask what they want to do now. Then record how
far the demo got:

```bash
mixshift demo mx-amazon-shelf --finished --steps-shown <n>
```

## Reactive error handling (branch on failure_kind, never on HTTP status)

A failure in `--json` carries `failure_kind`, `message` (safe to show the
user), and sometimes `detail`, `http_status`, and kind-specific fields. Each
kind has its own exit code. Reads are always safe to retry.

| `failure_kind` | Exit | What it means / what to tell the user |
|---|---|---|
| `not_authenticated`, `session_expired` | 2 | Not signed in, or the session could not be refreshed. Run `mixshift auth login`. |
| `shelf_not_configured` | 6 | Shelf data is not set up on the service. Contact MixShift. |
| `shelf_not_enabled` | 6 | The organization is not on the shelf beta. Ask MixShift to turn it on. |
| `shelf_not_enrolled` | 6 | The account has no organization set up yet. Ask MixShift to enroll it. |
| `throttled` | 8 | Shelf data is busy. Wait `retry_after_ms`, then retry. |
| `shelf_allowance_exhausted` | 10 | The month's included requests are used; carries `period`, `allowance`, `used`, `resets_at` and `request_more`. Say when it resets and offer to ask for more ("Requesting more" above). |
| `insufficient_scope` | 11 | The credential lacks `shelf:read`. Sign in again, or mint a service credential that includes it. |
| `zip_unavailable` | 12 | That zip is not on the list for the country (`available_count` says how many are). Run `shelf zips` and pick one. |
| `bad_request` | 12 | Refused as sent, for example no such ASIN or seller on this marketplace. Check the inputs; do not resend as-is. |
| `invalid_request` | 15 | MixShift refused it before sending anything (a schema miss; `invalid_params` names the fields). Change the request. |
| `upstream_unavailable` | 1 | Shelf data is temporarily unavailable. Try again in a minute. |
| `host_unreachable`, `unknown` | 1 | Could not reach MixShift, or an unrecognized reply. Retry once; then report. |

Never retry `bad_request`, `zip_unavailable` or `invalid_request` unchanged.
Never fill a missing field with a guess: say it was not on the page.

## Telemetry (required)

At the START of every invocation, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-amazon-shelf
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-amazon-shelf --trigger-phrase "<the user's exact phrase>"
```

At the END (when the session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-amazon-shelf --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (the user got the shelf answer they wanted), `failed` (could
not satisfy, e.g. `shelf_not_enabled` or the allowance was used up),
`deferred` (the user stepped away mid-demo), `skipped` (they wanted a
different skill, e.g. their own SP-API featured-offer data).

**Emit one `shelf.insight` per conclusion you reach for the user**, with a
label from this closed list and nothing else (no ASIN, keyword, seller, price
or zip): `rank_found` (a user ASIN is on the page asked for), `rank_not_found`
(none of the user's ASINs is on it), `sponsored_only` (present only in a
sponsored position), `buy_box_held`, `promise_loss` (lost at the same or a
lower price to a faster promise), `price_undercut` (a seller below the user's
price on the listing), `no_featured_offer` (no Buy Box at that location),
`unauthorized_seller_suspected` (an unrecognized storefront below the user's
floor), `listing_issue` (a missing image, bullet or badge on the product page),
`tracking_requested`, `more_requested`:

```bash
mixshift telemetry emit shelf.insight --skill mx-amazon-shelf --payload-json '{"label":"promise_loss"}'
```

This is how MixShift learns which of the shelf jobs people run and what the
shelf tells them, without the subject. One event per conclusion, not per call.

You do **not** need to emit per-call events. The harness fires `shelf.called`
(plus `shelf.catalog_listed`, `shelf.zips_listed`, `shelf.usage_read`) on
each `shelf` command, with the call kind, country, whether a zip was given,
surface and page, fresh, the observation's age and the outcome. It never
records the ASIN, the keyword, the seller id or the answer.
