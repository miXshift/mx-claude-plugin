---
name: mx-amazon-dsp
description: >
  Pull Amazon DSP (Demand-Side Platform) reports for a merchant, on demand,
  straight from Amazon through MixShift's service. DSP reporting is its own
  async surface: you request a report by type (campaign, inventory, audience,
  and so on) with a set of dimensions and metrics, Amazon generates it, and you
  download the result as JSON. This skill owns the full DSP report loop:
  discover the DSP advertiser id an advertising login can reach, build a report
  request, submit it, poll it to completion across turns, and fetch the result.
  Read-only: generating a report changes nothing advertiser-facing and needs no
  write scope. Routes through the bundled harness CLI. Does NOT require brand
  cold-start, only that the user has signed in (`mixshift auth login`).
metadata:
  version: "0.1.0"
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
---

# Amazon DSP Report Pull

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

- "Pull a DSP campaign report for Skratch last week"
- "What did our DSP audience segments do this month?"
- "Get me DSP inventory performance by supply source"
- "Download a DSP report with impressions, clicks, and spend"

The core user story: *"I want Amazon DSP performance for one of my DSP
advertisers, on demand, as a file I can analyze or build on."*

**Do NOT use this skill** for:

- Sponsored Products / Brands / Display state, lists, or reporting, that is
  `mx-amazon-ads` (live state) or the warehouse via `mx-data-explore`.
- SP-API report documents (orders, Brand Analytics, Sales and Traffic), that is
  `mx-report-pull`.
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
| An advertising login with DSP access | `accounts.query_advertiser_accounts` returns rows whose `alternateIds` carry a `dspAdvertiserId` | No DSP advertiser ids means this login cannot reach a DSP seat. An empty result is normal for tenants without DSP. |

Cold-start is **NOT required.** You only need a signed-in session.

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
| `accounts.query_advertiser_accounts` | Discover the DSP advertiser ids a login can reach (`alternateIds[].dspAdvertiserId`). |
| `dsp.create_report` | Submit an async DSP report request (type + dimensions + metrics). Returns a `reportId`. |
| `dsp.get_report` | Poll a report (IN_PROGRESS, SUCCESS, FAILURE). SUCCESS carries the presigned `location` url. |

## Discovery: find the DSP advertiser id

You cannot request a report without a DSP advertiser id for the `accountId` path
param. It is NOT the `profileId` and NOT the `legacySellerId`; it is the
`dspAdvertiserId` carried in `accounts.query_advertiser_accounts`.

```bash
# global accounts (default body)
mixshift ads call accounts.query_advertiser_accounts --legacy-seller-id <id> --json

# non-global accounts (pass the filter body)
mixshift ads call accounts.query_advertiser_accounts --legacy-seller-id <id> \
  --body '{"isGlobalAccountFilter":{"include":[false]}}' --json
```

Rules for discovery:

- **Query BOTH global and non-global** for full coverage. The default body
  (`{}`) returns global accounts only; pass
  `{"isGlobalAccountFilter":{"include":[false]}}` for non-global.
- **Pagination via `nextToken` in the body.** Empty pages with a valid
  `nextToken` are NORMAL; keep iterating until `nextToken` is absent.
- Each account row carries an `alternateIds` array. The entries with a
  `dspAdvertiserId` (plus a `region`) are the DSP advertisers. Match the one the
  user means by `accountName` / `displayName`, and use its `dspAdvertiserId` as
  the `--path accountId=` value.

If the user already knows the DSP advertiser id, you can skip discovery and pass
it directly.

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
- **Discover the DSP advertiser id first.** The `accountId` path param is the
  `dspAdvertiserId` from `accounts.query_advertiser_accounts`, NOT the
  `profileId` or `legacySellerId`. Do not guess it.
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

## Telemetry (required - see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

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
✓ DSP CAMPAIGN report SUCCESS for Skratch (2026-06-01 to 2026-06-07).
  → Saved 8 rows to ~/.mixshift/reports/<merchant>/2026-06-07-dsp-campaign.json
  → Dimensions: ORDER  |  Metrics: impressions, clickThroughs, totalCost

Want me to break it down by line item, or pull a different metric set?
```

While a report is still generating:

```
• Submitted DSP CAMPAIGN report for Skratch (reportId 0acf637a...).
  Amazon is generating it (status: IN_PROGRESS). I'll check again in a moment;
  DSP reports can take a few minutes.
```

Do not pad with "Here is the data you requested." Lead with the result.
