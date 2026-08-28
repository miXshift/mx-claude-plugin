---
name: mx-amazon-dsp
description: >
  Read an Amazon DSP (Demand-Side Platform) advertiser straight from Amazon
  through MixShift's service. Two surfaces, addressed differently. REPORTING is
  async: request a report by type (campaign, inventory, audience, and so on)
  with dimensions and metrics, poll it, download the JSON. CAMPAIGN AND CREATIVE
  READS answer what is actually set up right now: which campaigns and line items
  exist, which creatives the advertiser has, which creatives are attached to
  which line items and whether they are live or paused, whether a placement was
  approved or rejected and why, and which creatives Amazon considers eligible
  for a given line item. Use it to audit a DSP account, explain why a creative
  is not delivering, or find the id of a creative or line item. Also owns
  discovering which DSP advertiser a login can reach, which is the step most
  DSP work gets stuck on. Read-only throughout: nothing here changes an
  advertiser, and no write scope is needed. Creating and attaching DSP
  creatives is NOT available yet; say so plainly rather than improvising.
  Routes through the bundled harness CLI. Does not require brand setup, only
  that the user has signed in (`mixshift auth login`).
metadata:
  version: "0.2.0"
  author: "MixShift"
trigger_phrases:
  - pull a dsp report
  - amazon dsp report
  - dsp campaign report
  - dsp reporting
  - dsp performance
  - get dsp data
  - dsp audience report
  - dsp inventory report
  - run a dsp report
  - dsp advertiser report
  - dsp creatives
  - dsp line items
  - dsp ad groups
  - what creatives are running on dsp
  - why is my dsp creative not delivering
  - dsp creative approval
  - is this creative eligible for dsp
  - audit dsp account
  - find my dsp advertiser id
---

# Amazon DSP: reporting and account reads

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


## About the DSP reporting surface (authoritative, do not guess)

When characterizing this capability to the user, use these facts:

- **What it is:** Amazon DSP (Demand-Side Platform) is Amazon's programmatic
  display, video, and audio advertising platform. Its reporting API is a
  request-generate-download loop, separate from Sponsored Ads reporting: you
  POST a report request describing a `type`, `dimensions`, and `metrics` over a
  date range, Amazon generates it asynchronously, and you download the finished
  report from a presigned url. This skill drives that whole loop.
- **It is its OWN endpoint, not the unified reporting surface.** DSP reports
  live at `/accounts/{accountId}/dsp/reports` with a `type` / `dimensions` /
  `metrics` body. They are NOT part of the Sponsored Ads v3 reporting surface
  (`configuration` / `reportTypeId` / `columns`) and NOT part of the unified
  `/adsApi/v1` reporting surface. Do not mix the two body shapes.
- **Routing:** all calls flow through the harness CLI (`mixshift ads ...`),
  which talks to MixShift's service at `mcp.mixshift.io` using the same Bearer
  token as the other MixShift surfaces (from `~/.mixshift/auth/credentials`, no
  `.json` extension). The service holds the Amazon Advertising credentials
  server-side and the single static egress IP. The plugin never holds Ads
  secrets, and Claude never sees them.
- **Auth model (different from SP-API):** DSP rides the Amazon Ads API, whose
  tokens are PER ADVERTISING LOGIN, not per seller. The service reads the
  tenant's stored advertising refresh token (keyed by the seller row's
  `idUserAccount`) and mints access tokens in memory. Nothing for the plugin to
  handle.
- **Two different ids, do not confuse them.** `--legacy-seller-id` selects which
  advertising LOGIN's token the service uses (the seller row whose login holds
  the DSP seat). `--path accountId=<dspAdvertiserId>` is the DSP ADVERTISER you
  are reporting on, a separate id you discover first (see "Discovery" below).
  One login can reach many DSP advertisers.
- **Reads only.** Generating a report mutates nothing advertiser-facing, so the
  surface needs no `ads:write` scope. This skill never sends a write and never
  uses `--commit`.

If the user asks "where does this data come from," lead with "Amazon DSP,
reported through MixShift's service," not a guess.

## When to use this skill

Trigger when the user wants a **DSP report**, for example:

- "Pull a DSP campaign report for Summit last week"
- "What did our DSP audience segments do this month?"
- "Get me DSP inventory performance by supply source"
- "Download a DSP report with impressions, clicks, and spend"

The core user story: *"I want Amazon DSP performance for one of my DSP
advertisers, on demand, as a file I can analyze or build on."*

**Do NOT use this skill** for:

- Sponsored Products / Brands / Display state, lists, or reporting, that is
  `mx-amazon-ads` (live state) or the warehouse via `mx-data-explore`.
- SP-API report documents (orders, Brand Analytics, Sales and Traffic), that is
  `mx-amazon-report`.
- AMC clean-room SQL analytics, that is `mx-amazon-amc`.
- Live SP-API retail lookups (catalog, fees, inventory), that is
  `mx-amazon-retail`.

DSP is a distinct advertising product with its own advertisers, report types,
and metric vocabulary, separate from Sponsored Ads.

## Prerequisites the user needs

| State | How to check | What to do if missing |
|---|---|---|
| Signed in to MixShift | `~/.mixshift/auth/credentials` exists | Direct the user to run `mixshift auth login` (or say "sign in to MixShift" in chat). Calls fail with `not_authenticated` until then. |
| Ads API enabled for the tenant | Inferred from a successful `ads profiles` call | If a call returns `ads_not_configured`, the Amazon Ads credentials are not set on the service for this MixShift account. Tell the user to contact MixShift ops. |
| An advertising login with DSP access | `accounts.list_manager_accounts` returns `linkedAccounts` rows with `accountType: DSP_ADVERTISING_ACCOUNT` | Empty here is NOT proof of "no DSP" on its own; work through Discovery below before saying so. Do NOT judge this by counting agency-type profiles: most agency profiles are Amazon Attribution, not DSP, and an account with none at all can still hold DSP advertisers. |
| That login is authorized for the DSP **API** | A DSP read returns 200 rather than `reauth_required` | Owning DSP advertisers and being able to call the DSP API are different things. Some accounts have advertisers linked and still cannot call, on every login. See "When a DSP read fails" below before telling anyone to re-authorize. |

Brand setup is **not required.** You only need a signed-in session.

## Merchant selection (resolve the login first)

DSP calls take the same merchant selectors as every Ads surface, and the
selector picks which advertising LOGIN's token to use. Resolve the row through
`mixshift ads profiles` (or `--json` to match by `name`); the columns are
`profileId`, `legacySellerId`, `name`, `type`, `region`, `marketplace`. Carry
identity end to end:

- **Prefer `--legacy-seller-id <id>`** (the exact per-marketplace seller record
  id, the same ids as `amazon merchants`). It uniquely pins the row.
- Otherwise pass `--seller-id <id>` together with `--marketplace <code-or-id>`;
  never the seller token alone. `--profile-id <id>` also works.

Ambiguity returns `merchant_not_found` (exit 7) with a candidates list, one
entry per marketplace; pick the one the user meant and re-run with its
`--legacy-seller-id`.

Region alignment: a DSP advertiser carries a region (NA, EU, FE). The login you
select routes to its own region, so use a login that reaches the advertiser's
region. If a report request 403s, a region or access mismatch between the login
and the DSP advertiser is the usual cause.

## Available harness commands

All commands accept `--json` for structured output and `--data-dir` to override
the data directory. DSP is one family inside the general Ads call surface; there
is no dedicated `dsp` subcommand. Browse the catalog first:

```
mixshift ads profiles
mixshift ads operations --family DSP
mixshift ads call <operation> [--legacy-seller-id <id> | --seller-id <id> --marketplace <m> | --profile-id <id>]
                              [--path <k=v> ...] [--body-file <file> | --body <json>]
```

`ads operations --family DSP` prints each DSP operation id with its notes; read
the notes before calling. The operations, used in the order below:

| Operation | Purpose |
|---|---|
| `accounts.list_manager_accounts` | **Start discovery here.** `linkedAccounts[]` rows of type `DSP_ADVERTISING_ACCOUNT` carry `dspAdvertiserId`. No parameters. |
| `accounts.query_advertiser_accounts` | Second discovery source (`alternateIds[].dspAdvertiserId`). Query both global filters and page both. |
| `dsp.create_report` | Submit an async DSP report request (type + dimensions + metrics). Returns a `reportId`. |
| `dsp.get_report` | Poll a report (IN_PROGRESS, SUCCESS, FAILURE). SUCCESS carries the presigned `location` url. |
| `dsp.list_campaigns` | Campaigns, with budgets, flights and state. |
| `dsp.list_ad_groups` | Line items, with `inventoryType`, bid, flights and state. |
| `dsp.list_ad_creatives` | The advertiser's creatives, including console-built ones. |
| `dsp.list_creative_associations` | Creative-to-line-item placements and whether each is ACTIVE or INACTIVE. |
| `dsp.list_association_moderations` | Per-placement approval status with rejection reasons. |
| `dsp.get_ad_creative_validation` | Which ad experiences a creative is valid for. |
| `dsp.list_eligible_creatives` | Which creatives may attach to given line items. |

**The two DSP families are addressed differently, and mixing them up is the
usual first failure.** The report operations take the advertiser as
`--path accountId=<id>`. The account-read operations take it as
`--path advertiserId=<id>`. Same value, two parameter names, because Amazon
names it differently on each surface.

## Discovery: find the DSP advertiser id

Every DSP call needs a DSP advertiser id. It is NOT the `profileId` and NOT the
`legacySellerId`; it is a numeric `dspAdvertiserId` in its own namespace. Note
its width VARIES (13 and 18 digits both occur), so never validate it by length.
It is also NOT the `ENTITY...` id that sits beside it, which Amazon rejects.

**Start here. `accounts.list_manager_accounts` is the authoritative source and
takes no parameters:**

```bash
mixshift ads call accounts.list_manager_accounts --legacy-seller-id <id> --json
```

Read `managerAccounts[].linkedAccounts[]` and keep the rows where
`accountType` is `DSP_ADVERTISING_ACCOUNT`. Each carries `dspAdvertiserId`,
`accountName` and `marketplaceId`.

Three things about that list that will bite otherwise:

- **De-duplicate by `dspAdvertiserId`.** One advertiser is commonly linked under
  more than one manager account, so the raw row count overstates how many
  advertisers exist.
- **The manager account holding DSP is often not named after the brand or the
  account.** Do not filter the list by name before looking at it.
- **The DSP row's `profileId` is empty, and seller rows carry no
  `dspAdvertiserId`.** There is no shared key between the two, by design. See
  "Matching an advertiser to a brand" below.

**Second source, worth querying when the first looks incomplete:**

```bash
# global accounts (default body)
mixshift ads call accounts.query_advertiser_accounts --legacy-seller-id <id> --json

# non-global accounts (pass the filter body)
mixshift ads call accounts.query_advertiser_accounts --legacy-seller-id <id> \
  --body '{"isGlobalAccountFilter":{"include":[false]}}' --json
```

- **Query BOTH global and non-global, and page BOTH.** The default body (`{}`)
  returns global accounts only. Skipping either half is the most common reason
  this endpoint appears to show no DSP when the advertiser is right there.
- **Pagination via `nextToken` in the body.** Empty pages with a valid
  `nextToken` are NORMAL; keep iterating until `nextToken` is absent.
- The DSP advertisers are the `alternateIds` entries carrying a
  `dspAdvertiserId` and a `region`.

If the user already knows the DSP advertiser id, skip discovery and use it.

### Matching an advertiser to a brand

**There is no reliable automatic mapping, and you should not invent one.** A
brand appears as two unrelated records, one sponsored-ads and one DSP, with
different ids and no common key. The only thing connecting them is a display
name, and the two surfaces frequently name the same brand differently.

So: **present the candidate advertisers and have the user confirm which one they
mean**, then echo the id back. A confident wrong guess here reads every number
off the wrong advertiser, and nothing downstream will look wrong.

### Warehouse cross-check (fallback, and a gap-closer)

The warehouse is still worth querying, for two reasons: it shows which
advertiser is actually SPENDING, and it catches an advertiser the API calls
missed (for example when the login you resolved reaches a different manager
account than the one running DSP).

```bash
# dsp_campaigns_metric is keyed by SEAT, not the brand's seller row — match on
# advertiserName (NOT SellerID); read the id as a STRING (an 18-19 digit BIGINT
# that JS rounds, so always CAST AS CHAR); pick the one with recent spend.
mixshift data query --sql "SELECT CAST(advertiserId AS CHAR) AS advertiserId, advertiserName, entityId AS seat, MAX(DATE(DateTime)) AS last_day, ROUND(SUM(CASE WHEN DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN totalCost ELSE 0 END),0) AS spend_30d FROM dsp_campaigns_metric WHERE advertiserName LIKE '%<brand>%' GROUP BY advertiserId, advertiserName, entityId ORDER BY last_day DESC" --json
```

- **Amazon exposes no `isActive` flag on a DSP advertiser** — a brand can have an
  active advertiser AND an older/deprecated one on a different seat. Derive
  "active" from recent `spend_30d` / `last_day`; surface both and say which is
  current.
- Use the active row's `advertiserId` (the CAST-AS-CHAR string) as the
  advertiser id for any call below.

## Reading the DSP account (campaigns, creatives, placements)

These answer "what is set up right now", as opposed to the reports, which
answer "how did it perform". They are addressed DIFFERENTLY from the report
operations, so read this before using them.

**The advertiser id goes in `--path advertiserId=<id>`.** It is not put in the
URL; the service sends it as a header. It is REQUIRED on all seven, and omitting
it fails with an error that does not name the cause.

The merchant selector is still required, and it is not decoration: it chooses
which login's authorization the call is made with, and which regional host the
request goes to. Pick a merchant in the same region as the advertiser.

| Operation | Answers |
|---|---|
| `dsp.list_campaigns` | Which campaigns exist, with budgets, flights, state |
| `dsp.list_ad_groups` | Which line items exist, with `inventoryType` (ONLINE_VIDEO, STREAMING_TV, DISPLAY), bid, flights, state |
| `dsp.list_ad_creatives` | Which creatives the advertiser has, including ones built in the DSP console |
| `dsp.list_creative_associations` | Which creatives are attached to which line items, and whether each placement is ACTIVE or INACTIVE |
| `dsp.list_association_moderations` | Whether a placement was approved or rejected, with reasons |
| `dsp.get_ad_creative_validation` | Which ad experiences one creative is valid for (this is where ONLINE_VIDEO lives on the creative side) |
| `dsp.list_eligible_creatives` | Which creatives Amazon will let you attach to given line items |

```bash
mixshift ads call dsp.list_ad_groups --legacy-seller-id <id> \
  --path advertiserId=<dspAdvertiserId> --body '{"maxResults":100}' --json
```

### Four things that produce a confidently wrong answer

**1. "Live or paused" is a property of the PLACEMENT, not the creative.** A
creative object has no state field at all. Whether something is running is on
its association to a line item, and one creative can be attached to many line
items. So "how many creatives are live" and "how many creatives exist" are
different questions with different answers. Use `dsp.list_creative_associations`
for anything about what is running.

**2. Three different type systems, and they do not share values.** A line item's
`inventoryType` says ONLINE_VIDEO. The creatives serving it are typed VIDEO. And
ONLINE_VIDEO appears on the creative side only as an *ad experience*, from
`dsp.get_ad_creative_validation`. Comparing a line item's type to a creative's
type gives the wrong answer, and it looks right. **Never tell a user an
advertiser has no online-video creatives because none are typed ONLINE_VIDEO.**
When the question is "can this creative go here", ask Amazon with
`dsp.list_eligible_creatives` instead of reasoning about types.

**3. Always pass `maxResults`, and always page.** With no body these endpoints
return ONE row, not a first page. Use 100. Then page with `nextToken` until it
is absent, because the truncation signal differs per operation: campaigns and ad
groups have no total field at all, `dsp.list_ad_creatives` reports only the size
of the page you are holding, and the association, moderation and eligibility
operations report the true total. Read the operation's own notes
(`mixshift ads operations --family DSP`) rather than assuming.

**4. An empty result is not an empty advertiser.** These return 200 with an
empty array when the advertiser id is valid but is not the one the user meant,
and an account can hold many. Re-check the id before reporting that something
does not exist.

### When a DSP read fails

- **`reauth_required` (a 401 underneath) is usually about the merchant you
  picked, not the advertiser id.** Try another merchant on the account before
  telling anyone to re-authorize. And some accounts genuinely cannot call the
  DSP API even though they own DSP advertisers, on every login: re-authorizing
  will not fix that, and saying so early saves the user a pointless trip.
- **`upstream_unavailable` on `dsp.get_ad_creative_validation` is often
  advertiser-wide, not creative-specific.** Stop after the first one and report
  that validation is unavailable for that advertiser. Do NOT walk the
  advertiser's whole creative set: each attempt is retried upstream, so a sweep
  costs minutes and tells you nothing new.

### What is NOT available

Creating a DSP creative, attaching one to a line item, and pausing or removing a
placement are **not** in the catalog. There is no workaround through this
surface. If the user wants to place a creative, say plainly that MixShift can
show them the account and tell them exactly what to change, and that the change
itself is made in the Amazon DSP console for now. Do not improvise a write.

## Building a report request

The request body describes one report:

```jsonc
{
  "startDate": "2026-06-01",      // YYYY-MM-DD, inclusive
  "endDate": "2026-06-07",        // YYYY-MM-DD, inclusive, not in the future
  "type": "CAMPAIGN",             // the report family (see table)
  "dimensions": ["ORDER"],         // breakdown columns, type-specific
  "metrics": ["impressions", "clickThroughs", "totalCost"]  // measures, type-specific
}
```

### Report types and their dimensions

DSP groups reports into families by `type`. Each type defines its own valid
dimensions and metrics. The documented families:

| `type` | What it covers | Typical dimensions |
|---|---|---|
| `CAMPAIGN` | Order / line-item / creative performance | `ORDER`, `LINE_ITEM`, `CREATIVE` |
| `INVENTORY` | Where ads served | supply source / site / deal dimensions |
| `AUDIENCE` | Performance per audience segment | audience segment dimensions |
| `PRODUCT` | Advertised / purchased product performance | product / ASIN dimensions |
| `GEOGRAPHY` | Where ads resonated | region / city / postal-code dimensions |
| `TECHNOLOGY` | Device / OS / environment | device / os / environment dimensions |
| `REACH` | Reach and frequency | frequency-bucket dimensions |

`CAMPAIGN` with `["ORDER", "LINE_ITEM", "CREATIVE"]` is the validated,
known-good starting shape. For the other families, the exact dimension and
metric strings are defined by Amazon and are type-specific; confirm them against
Amazon's DSP metrics and dimensions reference rather than guessing. A wrong
dimension/metric for the chosen type comes back as an Amazon error (surface it,
adjust, resubmit).

### Metrics: pick a small set, do not dump everything

The DSP metric vocabulary is very large (hundreds of metrics: impression and
click measures, 14-day attribution families like `purchases14d` / `sales14d` /
`ROAS14d` / `newToBrandPurchases14d`, detail-page-view and add-to-cart families,
video quartiles, fees, and more). Do NOT enumerate them all into a request.
Start from a small, intentional set tied to the user's question, for example:

- Delivery: `impressions`, `clickThroughs`, `CTR`, `eCPM`, `totalCost`
- Outcomes (14-day): `purchases14d`, `sales14d`, `ROAS14d`, `dpv14d`, `atc14d`
- New-to-brand: `newToBrandPurchases14d`, `newToBrandProductSales14d`,
  `percentOfPurchasesNewToBrand14d`

Confirm metric names valid for the chosen `type` against Amazon's reference if
you go beyond a known-good set.

## Lifecycle: submit, poll across turns, fetch immediately

### 1. Submit the report request

Write the body to a file and submit it. The `accountId` path param is the DSP
advertiser id from discovery.

```bash
mixshift ads call dsp.create_report --legacy-seller-id <id> \
  --path accountId=<dspAdvertiserId> \
  --body-file dsp-campaign.json --json
```

A successful submit returns a payload like
`{ "reportId": "...", "type": "CAMPAIGN", "format": "JSON", "status": "IN_PROGRESS", "location": "" }`.
Hold onto the `reportId`. `location` is empty until the report finishes.

### 2. Poll the report ACROSS TURNS (no sleep-loops)

```bash
mixshift ads call dsp.get_report --legacy-seller-id <id> \
  --path accountId=<dspAdvertiserId> \
  --path reportId=<reportId> --json
```

The status moves through `IN_PROGRESS`, then `SUCCESS` or `FAILURE`.

- **Poll across separate tool calls, never in a sleep-loop inside one Bash
  call.** DSP reports can take from seconds to minutes. Call poll once, surface
  the status to the user, and check again on a later turn. The `reportId` stays
  valid across turns.
- `SUCCESS` means the report is ready: the payload carries a presigned
  `location` url. Go fetch it.
- `FAILURE` means Amazon could not generate the report. Surface the
  `statusDetails` message; the usual causes are a dimension or metric that is
  not valid for the chosen `type`, or a date range outside DSP retention.

### 3. Fetch the report from the location url, WITHOUT auth headers

The `location` url is a presigned S3 url. Two hard constraints:

- **Fetch WITHOUT auth headers.** Sending an `Authorization` header will be
  rejected. Download it as a plain GET.
- **It expires (roughly an hour).** Fetch promptly. If it lapses, re-run
  `dsp.get_report` for a fresh `location`.

The downloaded content is JSON (an array of row objects). A portable fetch
(Node, works where PowerShell lacks tooling):

```bash
node -e "const https=require('https'),fs=require('fs');const url=process.argv[1];https.get(url,r=>r.pipe(fs.createWriteStream('dsp-report.json')).on('finish',()=>console.log('saved dsp-report.json')))" "<location-url>"
```

Save the report under `~/.mixshift/reports/<merchant>/<date>-dsp-<type>.json`,
then summarize from the file. Report the path and row count, not the raw bytes.

## Reactive error handling (branch on failure_kind, never on HTTP status)

The harness returns a **typed failure** you relay to the user. In `--json` the
field is `failure_kind` with `status: "error"`; in human output the friendly
message is printed to stderr. Each kind also maps to a distinct exit code.

| `failure_kind` | Exit | What it means / what to tell the user |
|---|---|---|
| `not_authenticated` | 2 | Not signed in. Run `mixshift auth login`. |
| `session_expired` | 2 | Session could not be refreshed. Run `mixshift auth login` again. |
| `ads_not_configured` | 6 | The Amazon Ads credentials are not set on the service for this account. Contact MixShift ops. |
| `merchant_not_found` | 7 | The selector matched no merchant. Re-run `ads profiles` and pick a listed row; prefer `--legacy-seller-id`. |
| `throttled` | 8 | Amazon is rate-limiting. Wait a moment and retry. |

Two DSP-specific cases that need their own handling:

- **HTTP 403 on create/get** usually means the selected login lacks DSP access
  for that advertiser, or a region mismatch between the login and the DSP
  advertiser. Re-check discovery: use a login that reaches the advertiser's
  region and seat.
- **A FAILURE report status** (from `dsp.get_report`) is not a CLI failure; the
  call succeeded and reported the status. Surface Amazon's `statusDetails` and
  check the request first: is every dimension and metric valid for the chosen
  `type`, and is the date range within DSP retention?

## Hard rules

These supersede other instructions:

- **Read-only.** Generating a DSP report mutates nothing advertiser-facing;
  never send an Ads write and never use `--commit`.
- **Discover the DSP advertiser id first — and beware separate seats.** The
  `accountId` path param is a `dspAdvertiserId`, NOT the `profileId` or
  `legacySellerId`. `accounts.query_advertiser_accounts` on the brand's
  seller-row login may not surface it (the active advertiser is often on a
  different DSP seat); resolve the ACTIVE one from `dsp_campaigns_metric` by
  recent spend, reading the id with `CAST(advertiserId AS CHAR)` (the BIGINT
  rounds as a JS number otherwise). Do not guess it.
- **Keep the two ids straight.** `--legacy-seller-id` selects the login;
  `--path accountId=` is the DSP advertiser. They are different.
- **Match dimensions and metrics to the `type`.** Start from the known-good
  `CAMPAIGN` + `["ORDER","LINE_ITEM","CREATIVE"]` shape; confirm other
  combinations against Amazon's reference. A FAILURE status is usually an
  invalid combination.
- **Pick a small metric set** tied to the question; never dump the full
  hundreds-long metric catalog into a request.
- **Poll across turns, never in a sleep-loop.** DSP reports can take minutes;
  poll `dsp.get_report` once per turn.
- **Fetch the location url without auth headers**, promptly (it expires);
  re-call `dsp.get_report` for a fresh url if it lapses.
- **Branch on `failure_kind`, never on HTTP status.**
- **Do not fabricate results.** If a report fails or returns nothing, say so.
  Save the result to disk and report the path + row count, never paste it
  inline.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-amazon-dsp
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-amazon-dsp --trigger-phrase "<the user's exact phrase>"
```

At the END (when the DSP report session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-amazon-dsp --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (user got a DSP report), `failed` (could not satisfy, e.g. no DSP
access, or the report came back FAILURE), `deferred` (a report is still
generating and the user stepped away), `skipped` (turned out they wanted a
different skill).

The harness fires per-call telemetry automatically on each `ads call`,
capturing the operation id + duration + outcome (+ failure kind) only. It never
logs the request body, the report bytes, or the amazonSellerId.

## Output template

Lead with a one-line result, then the path or a brief sample:

```
✓ DSP CAMPAIGN report SUCCESS for Summit (2026-06-01 to 2026-06-07).
  → Saved 8 rows to ~/.mixshift/reports/<merchant>/2026-06-07-dsp-campaign.json
  → Dimensions: ORDER  |  Metrics: impressions, clickThroughs, totalCost

Want me to break it down by line item, or pull a different metric set?
```

While a report is still generating:

```
• Submitted DSP CAMPAIGN report for Summit (reportId 0acf637a...).
  Amazon is generating it (status: IN_PROGRESS). I'll check again in a moment;
  DSP reports can take a few minutes.
```

Do not pad with "Here is the data you requested." Lead with the result.
