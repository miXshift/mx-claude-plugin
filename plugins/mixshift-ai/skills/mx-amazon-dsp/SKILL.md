---
name: mx-amazon-dsp
description: >
  Read and build an Amazon DSP (Demand-Side Platform) advertiser straight
  from Amazon. REPORTING: how DSP did last year, history older than 90 days,
  year-over-year or monthly history. ACCOUNT READS answer what is set up now:
  campaigns, line items, creatives, which creatives sit on which line items
  and whether they are live, approval or rejection reasons, eligible
  creatives, and which audiences a line item targets. Use it to audit a DSP
  account, explain why a creative is not delivering, or find an id. Also
  finds which DSP advertiser a login can reach, where most DSP work gets
  stuck. BUILDS: create campaigns (orders) and line items in bulk from a
  launch plan, always paused, add audiences and other targeting, and attach
  existing creatives. EDITS: campaign budget, flights and state; line item
  budget, dates, bids, pacing, and turning them on. Builds and edits are
  previewed and applied only on confirmation. Creating creatives is
  console-only. No brand setup needed, only sign-in.
metadata:
  version: "0.5.0"
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
  - dsp report last year
  - dsp historical data
  - dsp year over year
  - pull dsp data older than 90 days
  - dsp monthly report
  - dsp data before <date>
  - how far back can we pull dsp
  - create a dsp campaign
  - build dsp line items
  - launch a dsp campaign
  - bulk create dsp orders
  - build a dsp launch plan
  - add audiences to a dsp line item
  - attach creatives to dsp line items
  - what audiences is this line item targeting
---

# Amazon DSP: reporting, account reads, edits and builds

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.


## About the DSP reporting surface (authoritative, do not guess)

When characterizing this capability to the user, use these facts:

- **What it is:** Amazon DSP (Demand-Side Platform) is Amazon's programmatic
  display, video, and audio advertising platform. Its reporting API is a
  request-generate-download loop, separate from Sponsored Ads reporting: you
  POST a report request describing a `type`, `dimensions`, and `metrics` over a
  date range, Amazon generates it asynchronously, and you download the finished
  report from a presigned url. This skill drives that whole loop.
- **There are now TWO DSP reporting surfaces, and picking the wrong one is the
  main way this goes wrong.** The older one (`dsp.create_report`, at
  `/accounts/{accountId}/dsp/reports` with a `type` / `dimensions` / `metrics`
  body) only reaches back **90 days**. The unified one
  (`reporting_v1.create_report`, at `/adsApi/v1/create/reports` with a flat
  `fields` list) reaches back **years**. Neither is the Sponsored Ads v3
  surface (`configuration` / `reportTypeId` / `columns`). The three body shapes
  are not interchangeable. See "Which reporting surface" below, and never tell a
  user their older DSP data does not exist without checking the v1 surface.
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
- **Two different ids, and the advertiser has two parameter names.**
  `--legacy-seller-id` selects which advertising LOGIN's token the service uses
  (the seller row whose login holds the DSP seat). The DSP ADVERTISER is a
  separate id you discover first (see "Discovery" below), and it goes in
  `--path accountId=` on the REPORT operations but `--path advertiserId=` on the
  account reads. Same value, different name per surface, because Amazon names it
  differently. One login can reach many DSP advertisers.
- **Reports and reads change nothing.** Generating a report mutates nothing
  advertiser-facing, so reporting and the account reads need no `ads:write`
  scope. The one exception is the campaign and ad group edits in "Changing DSP
  campaigns and ad groups": they need `ads:write` and run only through the
  preview, confirm, commit contract there.

If the user asks "where does this data come from," lead with "Amazon DSP,
reported through MixShift's service," not a guess.

## When to use this skill

Trigger for either half of the surface.

**A DSP report** (how it performed):

- "Pull a DSP campaign report for Summit last week"
- "What did our DSP audience segments do this month?"
- "Get me DSP inventory performance by supply source"
- "Download a DSP report with impressions, clicks, and spend"

**A DSP account read** (how it is set up right now):

- "What creatives are running on DSP?"
- "Why is this DSP creative not delivering?"
- "Was that creative approved?"
- "Can this creative run on that line item?"
- "Audit our DSP account"
- "What is our DSP advertiser id?"
- "Which audiences is this line item targeting?"

**A DSP change or build** (edit what exists, or build new):

- "Raise the budget on these three line items" / "Turn the new campaign on"
- "Build this launch plan in DSP: two orders, six line items, these audiences"
- "Create the line items for the Q4 test, paused, so I can check them"
- "Attach these creatives to the new line items"

The core user story: *"I want to know what my DSP advertiser is doing, either as
performance I can analyze or as the live setup I can act on, and to make or
build the changes, without opening the DSP console."*

Decide which one the user is asking for before picking an operation. "How did
it do" is a report; "what is on it" or "why is it not delivering" is an account
read; "change it" or "build it" is a write (see "Changing DSP campaigns and ad
groups" and "Building DSP campaigns and line items").

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

**Only merchants ACTIVE for Ads are listed by default**, because Amazon will
not serve data for an inactive one. The response carries `activeCount`,
`inactiveCount` and, when any were withheld, a `note` saying so. Relay that
note: a brand missing from the list is usually inactive rather than absent.
Pass `--include-inactive` to see them, flagged `isActive: false`. Calling an
inactive merchant returns `merchant_inactive` (exit 13), which re-authorizing
cannot fix; activating it is the CUSTOMER's action in the MixShift platform.

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
| `dsp.create_report` | Submit an async DSP v3 report (type + dimensions + metrics). Returns a `reportId`. **Last 90 days only.** |
| `dsp.get_report` | Poll a v3 report (IN_PROGRESS, SUCCESS, FAILURE). SUCCESS carries the presigned `location` url. |
| `reporting_v1.create_report` | Submit a UNIFIED (v1) report. The only way to reach DSP data older than 90 days. |
| `reporting_v1.retrieve_report` | Poll a v1 report (PENDING, PROCESSING, COMPLETED, FAILED, DELETED). |
| `reporting_v1.delete_report` | Cancel a v1 report, and the way to free a slot when create is refusing new reports. |
| `dsp.list_campaigns` | Campaigns, with budgets, flights and state. |
| `dsp.list_ad_groups` | Line items, with `inventoryType`, bid, flights and state. |
| `dsp.list_ad_creatives` | The advertiser's creatives, including console-built ones. |
| `dsp.list_creative_associations` | Creative-to-line-item placements and whether each is ACTIVE or INACTIVE. |
| `dsp.list_association_moderations` | Per-placement approval status with rejection reasons. |
| `dsp.get_ad_creative_validation` | Which ad experiences a creative is valid for. |
| `dsp.list_eligible_creatives` | Which creatives may attach to given line items. |
| `dsp.update_campaigns` | **Write.** Edit up to 5 campaigns: state, budget caps, flights, name. See "Changing DSP campaigns and ad groups". |
| `dsp.update_ad_groups` | **Write.** Edit up to 20 ad groups: state, budget, dates, bid, pacing, name. See "Changing DSP campaigns and ad groups". |
| `dsp.create_campaigns` | **Write.** Create up to 5 campaigns (orders) per call, always paused. See "Building DSP campaigns and line items". |
| `dsp.create_ad_groups` | **Write.** Create up to 20 ad groups (line items) per call in existing campaigns, always paused. |
| `dsp.create_targets` | **Write.** Add audiences, locations, domains and other targeting to ad groups. |
| `dsp.delete_targets` | **Write.** Remove targets by id (up to 100), to change a default or swap an audience. |
| `dsp.create_ad_associations` | **Write.** Attach existing creatives to ad groups, up to 20 per call. |
| `dsp.query_campaigns` / `dsp.query_ad_groups` | Read campaigns and ad groups in the shape the creates write; check names before creating. |
| `dsp.query_targets` | Read the targeting on ad groups, including **which audiences each line item targets**. |

**The two DSP families are addressed differently, and mixing them up is the
usual first failure.** The report operations take the advertiser as
`--path accountId=<id>`. The account-read operations take it as
`--path advertiserId=<id>`. Same value, two parameter names, because Amazon
names it differently on each surface. The edit, build and query operations
(`dsp.update_*`, `dsp.create_*`, `dsp.delete_targets`, `dsp.query_*`) take it as
`--path advertiserId=<id>` too.

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
# advertiserName (NOT SellerID); read the id as a STRING (a long BIGINT that JS
# rounds, so always CAST AS CHAR); pick the one with recent spend.
mixshift data query --sql "SELECT CAST(advertiserId AS CHAR) AS advertiserId, advertiserName, entityId AS seat, MAX(DATE(DateTime)) AS last_day, ROUND(SUM(CASE WHEN DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN totalCost ELSE 0 END),0) AS spend_30d FROM dsp_campaigns_metric WHERE advertiserName LIKE '%<brand>%' GROUP BY advertiserId, advertiserName, entityId ORDER BY last_day DESC" --json
```

- **Amazon exposes no `isActive` flag on a DSP advertiser** — a brand can have an
  active advertiser AND an older/deprecated one on a different seat. Derive
  "active" from recent `spend_30d` / `last_day`; surface both and say which is
  current.
- Use the active row to identify WHICH advertiser the user means (by
  `advertiserName` and recent spend). Do NOT assume the warehouse `advertiserId`
  is interchangeable with the id Amazon's accounts API returns: reconcile it
  against a `list_manager_accounts` row before passing it to any call below.
  This matters more than it sounds. The account reads return **HTTP 200 with an
  empty array** for an id that is valid but not the one you wanted, so an
  unreconciled id produces "you have no creatives" rather than an error.

## Reading the DSP account (campaigns, creatives, placements)

These answer "what is set up right now", as opposed to the reports, which
answer "how did it perform". They are addressed DIFFERENTLY from the report
operations, so read this before using them.

**The advertiser id goes in `--path advertiserId=<id>`.** It is not put in the
URL; the service sends it as a header. It is REQUIRED on all seven. Omitting it fails
before the request is sent, with an error naming the operation, the parameter
and the header, so read that message rather than guessing at auth or access.

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

**Two of the seven need more than the advertiser id, and both fail hard rather
than degrading, so the pattern above does not generalize to them:**

`dsp.get_ad_creative_validation` is a GET for ONE creative and also takes
`--path adCreativeId=<id>`. It takes NO body; sending one is refused outright.

```bash
mixshift ads call dsp.get_ad_creative_validation --legacy-seller-id <id> \
  --path advertiserId=<dspAdvertiserId> --path adCreativeId=<adCreativeId> --json
```

`dsp.list_eligible_creatives` REQUIRES a body naming the ad groups. Without
`adGroupIdFilter` (or `adGroupDrafts`) it returns 400, so a generic
`{"maxResults":100}` body fails on exactly the operation you were told to trust
over guessing. Get the ad group ids from `dsp.list_ad_groups` first.

```bash
mixshift ads call dsp.list_eligible_creatives --legacy-seller-id <id> \
  --path advertiserId=<dspAdvertiserId> \
  --body '{"adGroupIdFilter":{"include":["<adGroupId>"]},"maxResults":100}' --json
```

### Four things that produce a confidently wrong answer

**1. "Live or paused" is a property of the PLACEMENT, not the creative.** A
creative object has no state field at all. Whether something is running is on
its association to a line item, and one creative can be attached to many line
items. So "how many creatives are live" and "how many creatives exist" are
different questions with different answers. Use `dsp.list_creative_associations`
for anything about what is running.

**2. Three different type systems, and they do not share values.** A line item's
`inventoryType` says ONLINE_VIDEO. The creatives serving it are typed VIDEO, at
`adCreativeFormatProperties.adCreativeFormatType` (mind the path: there is no
top-level `adCreativeFormatType`, so reading `creative.adCreativeFormatType`
returns `undefined` on every row and reads as "nothing has a type"). And
ONLINE_VIDEO appears on the creative side only as an *ad experience*, from
`dsp.get_ad_creative_validation`. Comparing a line item's type to a creative's
type gives the wrong answer, and it looks right. **Never tell a user an
advertiser has no online-video creatives because none are typed ONLINE_VIDEO.**
When the question is "can this creative go here", ask Amazon with
`dsp.list_eligible_creatives` instead of reasoning about types.

**3. On the five plain list operations, always pass `maxResults`, and always
page.** With no body those return ONE row, not a first page. Use 100, which is
the ceiling. Then page with `nextToken` until it is absent, because the
truncation signal differs per operation: campaigns and ad groups have no total
field at all, `dsp.list_ad_creatives` reports only the size of the page you are
holding, and the association, moderation and eligibility operations report the
true total.

This rule does NOT extend to the other two. `dsp.list_eligible_creatives` needs
its ad-group filter as well (above), and `dsp.get_ad_creative_validation` takes
no body at all and its `totalResults` reads **0 even when validations came
back** — count `validations.length` instead, or you will report a perfectly good
creative as valid for nothing. When that operation returns errors, quote the
`errorCode`; its `errorMessage` is sometimes degenerate and names no field, so
relaying it verbatim hands the user a non-diagnosis.

Read the operation's own notes rather than assuming. Note the two discovery
operations are in the `Accounts` family, so `--family DSP` will not show them:
run `mixshift ads operations` unfiltered, or `--family Accounts`, to read those.

**4. An empty result is not an empty advertiser.** These return 200 with an
empty array when the advertiser id is valid but is not the one the user meant,
and an account can hold many. Re-check the id before reporting that something
does not exist.

### When a DSP read fails

- **`reauth_required` (a 401 underneath) is usually about the merchant you
  picked, not the advertiser id.** Work through it in this order: try another
  merchant on the account first, since the token is per login; if every merchant
  fails, THEN have the user re-authorize, because a lapsed grant looks exactly
  the same. Only after both of those fail should you raise the third
  possibility, that this account has DSP advertisers but no DSP API access,
  which re-authorizing cannot fix and which MixShift ops has to confirm. Do not
  lead with that one: telling a user re-authorizing is pointless when their
  grant has simply expired closes the door on the fix.
- **A failure on `dsp.get_ad_creative_validation` is often advertiser-wide, not
  creative-specific.** It reaches you as `failure_kind: upstream_unavailable`
  (plugin versions before 0.8.13 reported it as `unknown`; accept either). The tell is the SECOND creative failing the same way:
  stop there and report that validation is unavailable for that advertiser. Do
  NOT walk the advertiser's whole creative set. Each attempt is retried upstream
  before it returns, so a sweep costs minutes of wall clock and tells you nothing
  new.

### What is NOT available

Creating a DSP creative, and pausing or removing a creative's placement on a
line item, are **not** in the catalog. There is no workaround through this
surface: say plainly that MixShift can show the account and tell them exactly
what to change, and that the change itself is made in the Amazon DSP console for
now. Amazon also has **no delete for DSP campaigns or line items**: a wrong one
is left paused (and can be renamed). Edits and builds are available: see
"Changing DSP campaigns and ad groups" and "Building DSP campaigns and line
items", which also covers attaching an existing creative to a line item.

## Changing DSP campaigns and ad groups

Two write operations change what already exists. They follow the **same
contract as Sponsored Ads writes** (see `mx-amazon-ads`, "The write contract"):
preview first, the user confirms the exact change set in a separate turn, then
commit. Nothing reaches Amazon on a preview. DSP changes can also be proposed
for later approval by a person: see `mx-amazon-ads`, "Proposals (approve later)".

| Operation | What it edits | Cap per call |
|---|---|---|
| `dsp.update_campaigns` | `state` (ACTIVE or INACTIVE), `budgetCaps[]` (at most 2: one DAILY and one MONTHLY, each `{amount, recurrenceTimePeriod}` with `amount` of at least 1), `flights`, `name`, `comments`, `optimization`, `frequencies`. There is no pacing field on a campaign. | **5 campaigns** |
| `dsp.update_ad_groups` | `state`, `budgetAmount` (leave it out when automated budget allocation is on), `budgetCaps[]`, `startDateTime` and `endDateTime` (RFC 3339), `bid.baseBid`, `bid.maxAverageCPM`, `pacing`, `name`, `comments`, `frequencies`, `creativeRotationType`. | **20 ad groups** |

Body shapes: `dsp.update_campaigns` takes `{"campaigns":[{"campaignId":"...", ...}]}`
and `dsp.update_ad_groups` takes `{"adGroups":[{"adGroupId":"...", ...}]}`. The
id is required on every item; include only the fields you are changing. Split a
larger change into calls within the cap.

**Addressing.** Pass the **numeric DSP advertiser id** in
`pathParams.advertiserId` (`--path advertiserId=<id>`), the same value and the
same parameter name the account reads use. `--legacy-seller-id` still selects
the advertising login. Discover and confirm the advertiser id with the user
first (see "Discovery"); never pick one for them.

**Flights are a FULL replacement.** On `dsp.update_campaigns`, `flights.flights[]`
replaces the campaign's whole flight list. Every flight you want to keep must
be sent **with its `flightId`**; a flight you leave out is **deleted**. Read the
campaign's current flights with `dsp.list_campaigns` first, copy them all, then
change only the one you mean to. A body with a single changed flight and no
others silently removes the rest. Say this out loud in the preview: list every
flight that will remain and every one that will go.

**Ad group pacing.** `pacing.deliveryProfile` is one of `EVEN`, `PACE_AHEAD`,
`ASAP` or `STRICT_EVEN`. `STRICT_EVEN` is **podcast only**. `pacing.catchUpBoostPercentage`
is allowed **only with `EVEN`** and must be 0, 200, 300 or 400. Do not send a
boost with any other profile.

**The contract, step by step** (identical in spirit to Sponsored Ads):

1. Read the current state with `dsp.list_campaigns` or `dsp.list_ad_groups`
   (filtered to the ids) and build the change body from it.
2. Preview (no `--commit`; nothing is sent to Amazon):

   ```bash
   mixshift ads call dsp.update_ad_groups --legacy-seller-id <id> \
     --path advertiserId=<dsp-advertiser-id> --body-file change.json --json
   ```

3. Show the user the preview and the `before_state`: each item, field by field,
   from what to what (and for flights, what stays and what goes). Ask for
   **explicit confirmation of this exact change set**. Never add an item that
   was not in the confirmed set.
4. Only after a "yes" in a **separate turn**, re-run the SAME command with
   `--commit`. The original request is not commit authorization.
5. Report the **per-item result**. Amazon answers HTTP 207 with a `success`
   list and an `error` list, each entry carrying its `index`. Partial failure
   is normal: summarize both counts ("4 of 5 applied, 1 refused"), surface each
   refused item's reason, and give the user the `audit_id`. A write is never
   retried automatically; if a commit ends with `request_outcome: "unknown"`,
   re-read the entities and compare before sending anything again.

**After a commit lands**, check which brand the advertiser belongs to (see "Which
brand a DSP advertiser belongs to"): one `show`, and one question if it is unassigned.

**Propose instead of preview** when the session is unattended, the credential
is propose-only, or a teammate should approve: add `--propose` (see
`mx-amazon-ads`, "Proposals (approve later)"). A person approves; you commit
only afterward. Money changes over 25% are flagged and need the approver's
`--acknowledge-guard`.

**Still console-only.** Creating a creative, and pausing or removing a
creative's placement on a line item, are **not** in the catalog. Say so
plainly: MixShift can show the account and tell them exactly what to change,
and that change is made in the Amazon DSP console. Do not improvise it through
another operation.

**Turning a new build on** is this section's job: once a build from "Building
DSP campaigns and line items" is checked, `dsp.update_campaigns` and
`dsp.update_ad_groups` with `state: "ACTIVE"` start delivery, through the same
preview and confirmation.

## Which brand a DSP advertiser belongs to

The user story: *"My agent just built or changed DSP campaigns. I am asked once
which brand that advertiser belongs to, so its changes show on the right brand's
change log from then on, and nothing is guessed."* MixShift files a DSP change on
a brand only when exactly one brand's context declares the advertiser. Until one
does, the changes stay **unassigned**: nothing is lost, they just are not on any
brand's change log.

After a DSP change or build commits, and whenever the user starts working on one
advertiser, run:

```bash
mixshift context dsp-advertiser show <advertiser_id> --json
```

It answers `unassigned`, `assigned` (one brand) or `conflict` (several brands),
all with exit 0. An error saying the service does not support the lookup yet
means: say nothing to the user, keep working, and do not try to assign.

- **`assigned`**: nothing to do.
- **`unassigned`**: ask the user **once per advertiser per session**. Name the
  advertiser (its name and id) and list the user's brands (`mixshift brand list`).
  You may offer the evidence from "Matching an advertiser to a brand" as a
  suggestion; it is never the answer. Then:
  - The user names a brand: run `mixshift context dsp-advertiser assign
    <advertiser_id> --brand <slug> --json` (a dry run; add `--account <seller id>`
    if the brand has several accounts and the user says which), show them the line
    it would change, and only after they confirm run it again with `--commit`.
    Report the read-back it prints: whether the service now resolves the advertiser
    to that brand.
  - "None of these", "not sure" or no answer: write nothing, keep working, and say
    the changes stay unassigned. Do not ask again this session.
- **`conflict`**: show the user both brands and ask which one keeps the advertiser.
  Never fix it by writing: `assign` refuses when another brand already declares it.

Never assign in bulk, never for an advertiser the user did not name, and never for
a brand the user did not name. **Scheduled or unattended runs (nobody to ask):**
never ask and never assign; list any unassigned advertisers in the run summary
instead.

## Building DSP campaigns and line items

The user story: *"I have a DSP launch plan (orders, line items, audiences,
creatives) and I want it built in the account in one pass, not clicked in one
line item at a time, and I want to check it before anything spends."*

Five write operations build new structure, on Amazon's Campaign Management API.
They follow the same write contract as edits (preview, the user confirms in a
separate turn, then `--commit`), and **nothing they create can spend**: Amazon
creates DSP campaigns and line items **paused only**, MixShift refuses any
other state before the call, and only a separate `dsp.update_*` change to
`ACTIVE` starts delivery.

| Operation | Creates | Cap per call |
|---|---|---|
| `dsp.create_campaigns` | Campaigns (orders): name, flights with budgets, goal KPI, bid strategy, budget allocation, frequency caps, budget caps, agency fee, PO number | **5** |
| `dsp.create_ad_groups` | Line items in existing campaigns: inventory type, dates, budget, bid, pacing, creative rotation, targeting settings (viewability, audience match type) | **20** |
| `dsp.create_targets` | Targeting on line items: audiences, locations, domains, devices, apps, day parts, content and inventory targets; `negative: true` excludes | 200 |
| `dsp.delete_targets` | Removes targets by id (a DSP target has no paused state); keeps a snapshot of each in the audit row | **100** |
| `dsp.create_ad_associations` | Attaches EXISTING creatives to line items (creative id as `adId`) | **20** |

**These use a different field model from the `dsp.list_*` and `dsp.update_*`
operations.** Build bodies from each operation's notes (`mixshift ads operations
--family DSP`), never from a `dsp.list_campaigns` row: here every item carries
`"adProduct": "AMAZON_DSP"`, state is `PAUSED` / `ENABLED`, budgets nest as
`budget.budgetValue.monetaryBudgetValue.monetaryBudget.value`, and dates are
RFC 3339 UTC. Read what you built back with `dsp.query_campaigns`,
`dsp.query_ad_groups` and `dsp.query_targets` (each needs
`"adProductFilter": {"include": ["AMAZON_DSP"]}`).

**Same ids on both APIs** (verified on live accounts, October 2026). These
operations take the same DSP advertiser id as the reads, and the campaigns,
line items and creatives they create show up in `dsp.list_campaigns`,
`dsp.list_ad_groups` and `dsp.list_creative_associations` under the same ids
(`PAUSED` here reads as `INACTIVE` there). If a call fails with an account or id
error, report Amazon's answer as it came, do not retry with another id, and
offer to send it to MixShift (`mx-feedback`).

### The build, step by step

1. **Confirm the advertiser** (see "Discovery") and echo the id back.
2. **Write the launch plan before any call**, as a table the user can check:
   every campaign (name, flight dates, budget, goal KPI) and under it every line
   item (name, inventory type, dates, budget, base bid, pacing), its audiences
   (by DSP audience id and name) and other targeting, and its creatives (by
   creative id). Ask, do not assume, the things that change cost:
   - **Audience match type** (`targetingSettings.defaultAudienceTargetingMatchType`):
     `EXACT` serves only the audiences named; `SIMILAR` lets Amazon expand to
     similar shoppers. On retargeting and loyalty lines the expansion can cost
     many times more per purchase, so ask which they want per line.
   - **Budget allocation** (`MANUAL` vs `AUTO`) and the goal KPI.
   - Where the audience ids come from: an AMC audience's DSP id is on the
     audience itself (`mx-amazon-amc`, or the AMC app); Amazon's own audiences
     are picked in the DSP console for now, so ask the user for those ids.
   Get the user's yes on the plan.
3. **Check for duplicates.** `dsp.query_campaigns` with a `nameFilter`
   (`EXACT_MATCH`) on the planned names. A build that already exists, or a
   half-finished earlier run, is continued, never created twice.
4. **Build in dependency order, one step at a time**, each step previewed and
   confirmed as one change set (all of its calls within the caps):
   1. campaigns, then read each new `campaignId` from `success[].campaign`;
   2. line items with those ids, then read each `adGroupId`;
   3. targeting on those line items. Amazon adds **default targets** to every
      new line item (devices, inventory, day parts, the advertiser domain list,
      video ad format; a new display line item carried more than 100, mostly
      inventory sources and day parts, so page with `nextToken`): read them with
      `dsp.query_targets` and summarize them by type. To change one, remove it
      with `dsp.delete_targets` and add the replacement;
   4. creatives: check each pairing with `dsp.list_eligible_creatives` first
      (a creative whose type does not fit the line item's inventory is refused),
      then attach with `dsp.create_ad_associations` (`adId` is the creative's
      `adCreativeId`). A new attachment starts with Amazon's moderation
      `PENDING`: check `dsp.list_association_moderations` before turning the
      line item on.
   Later steps differ from the confirmed plan only by the ids Amazon assigned.
   If the user wants to change anything else mid-build, preview it again.
5. **Read the 207 per item.** Each response can carry three lists, each entry
   with its `index`: `success` (created), `partialSuccess` (**created**, with
   some fields refused: the entity exists, so fix it with an update, never
   create it again) and `error` (not created, with Amazon's message). An empty
   list can come back as `[]` or not at all, depending on the operation. Report
   the counts and each refusal in plain words.
6. **An unknown outcome is not a failure.** A commit that ends with
   `request_outcome: "unknown"` (a 5xx or a lost answer) may have created the
   entities. Query by name or id before sending anything again; a blind retry
   makes duplicates, and Amazon cannot delete DSP campaigns or line items.
7. **Hand back a build sheet**: every campaign and line item with its new id,
   all **paused**, the targets and creatives attached, and what is left before
   it can spend: creatives still to build or approve in the console, the
   advertiser's payment profile in the console, and turning it on (offer to do
   that with `dsp.update_*` once they have checked it). Then check the advertiser's
   brand (see "Which brand a DSP advertiser belongs to").

Builds cannot be proposed for later approval yet; they need a signed-in person
to confirm. For many rows at once, Amazon's own bulk upload (DSP console, Bulk
operations) is the other route, and the user can mix the two.

## Which reporting surface: the 90-day rule

Decide this BEFORE building a request. It is decided by the date range alone.

| The user wants | Use | Why |
|---|---|---|
| Anything inside the last 90 days | `dsp.create_report` (v3) | Richer DSP-native report types (INVENTORY, AUDIENCE, GEOGRAPHY, TECHNOLOGY, REACH) that v1 does not reproduce one-for-one |
| Anything older than 90 days | `reporting_v1.create_report` | v3 physically cannot serve it |
| A range that straddles 90 days | `reporting_v1.create_report` | One report beats stitching two surfaces with different metric definitions |

**The v3 wall is hard and it is a rolling 90 days.** Measured 2026-09-13: a
start date 89 days back succeeds, 90 days back fails with
`HTTP 422 REQUEST_BODY_FIELD_REPORT_DATE_OLD`, and every older window fails the
same way. It is not a permissions problem and retrying will not help, so when
you see that error do not re-run it or tell the user to ask MixShift for
access. Switch surfaces.

**Retention on v1 is deep, but do not promise a number.** A 2021 window is
accepted and a 2019 window is refused with `400025 ... outside the supported
retention`, so the ceiling is somewhere around five to six years. What a given
advertiser actually HAS is a different question: their data starts when their
DSP activity started. Say "we can request it, and you will get everything back
to when your DSP campaigns began", not "you have six years of history".

## Pulling DSP history with Reporting v1

Same three-step shape as v3 (submit, poll, download) but a different body, a
different envelope, and its own traps.

### Addressing: pass the DSP advertiser id directly

The DSP advertiser id you found in Discovery goes straight into the body:

```jsonc
"accessRequestedAccounts": [ { "advertiserAccountId": "583538932061309199" } ]
```

That is the `dspAdvertiserId`, used as-is. The sibling `ENTITY...` id in the
same row is NOT interchangeable and returns 401.

You can also pass `{ "managerAccountId": "amzn1.ads1.ma1..." }`, the parent
account that holds access to the advertiser, which is useful when you want
several advertisers in one report. **Prefer the direct advertiser id when you
know which advertiser you want.** Manager-account-scoped reports cover every
advertiser under that account and are dramatically slower: in a 2026-09-13
session one of six finished while every single-advertiser report finished. If a
manager-account report sits in `PENDING` for half an hour without reaching
`PROCESSING`, narrow it rather than waiting longer.

Up to **5** accounts per report, and they must be distinct (duplicates are
refused). Note the published API spec claims 2000; the real limit is 5.

### The request

```bash
mixshift ads call reporting_v1.create_report --legacy-seller-id <id> \
  --body-file dsp-2025.json --json
```

```jsonc
{
  "accessRequestedAccounts": [ { "advertiserAccountId": "<dspAdvertiserId>" } ],
  "reports": [ {
    "format": "CSV",
    "periods": [ { "datePeriod": { "startDate": "2025-01-01", "endDate": "2025-12-31" } } ],
    "query": {
      "fields": [
        "year.value", "month.value",
        "campaign.id", "campaign.name", "budgetCurrency.value",
        "metric.impressions", "metric.clicks", "metric.totalCost",
        "metric.purchases", "metric.newToBrandPurchases",
        "metric.sales", "metric.roas"
      ]
    }
  } ]
}
```

`reports` holds exactly ONE report despite being an array.

### Four rules that decide whether the answer is right

**1. ALWAYS include `year.value` with `month.value`.** This is the one that
produces a plausible, wrong report instead of an error. `month.value` is a bare
`1`-`12` with no year attached, so any range crossing a year boundary merges the
same month from different years into one row and SUMS the metrics. Proven on a
2024-10 to 2025-12 window: without `year.value`, 12 months and 694 rows; with it,
15 (year, month) pairs and 768 rows, and the merged October row was exactly
2024-10 plus 2025-10 to the cent. Nothing warns you. The same applies to
`week.value`.

**2. `fields` needs a level-of-detail dimension.** A time dimension plus a
metric is refused: `400015: fields must contain at least one level-of-detail
dimension (e.g. campaign.id)`. Add `campaign.id`.

**3. Time is a dimension, not a `timeUnit`.** `date.value` = daily,
`week.value` = weekly, `month.value` = monthly. There is no `timeUnit` field and
no report `type` on this surface.

**4. Field pairing is enforced.** An attribute needs its primary key
(`campaign.name` requires `campaign.id`) and currency metrics need their currency
dimension (`metric.sales` requires `budgetCurrency.value`). Errors name the pair:
`400004` incompatible, `400006` missing requirement.

### Poll and download

```bash
mixshift ads call reporting_v1.retrieve_report --legacy-seller-id <id> \
  --body '{"reportIds":["<reportId>"]}' --json
```

`reportIds` also holds exactly one id. Status runs `PENDING` then `PROCESSING`
then `COMPLETED` or `FAILED`; `DELETED` also exists and is not in Amazon's
published list, so do not branch exhaustively on four values.

**Expect minutes, and poll ACROSS TURNS.** Measured generation times on one
advertiser ranged from 4m37s to 32m28s, and window size did not predict it. Tell
the user it is generating and check again on a later turn; never sleep-loop.

`COMPLETED` carries `completedReportParts`, an **array**. Iterate all of it,
because the `PARTITIONED_*` formats split deliberately. Fetch each `url` with a
plain GET and **no** `Authorization` header: the same url returns 200 without one
and 400 `InvalidArgument` with one. Urls expire (`urlExpirationDateTime`); re-poll
for fresh ones.

### When create refuses a new report

Only **two** v1 reports can be in flight at once. A third is refused, and
**waiting does not clear it** — the usual "back off and retry" is wrong here and
will loop forever. Either wait for one to reach a terminal status, or free a slot:

```bash
mixshift ads call reporting_v1.delete_report --legacy-seller-id <id> \
  --body '{"reportIds":["<reportId>"]}' --json
```

### Narrowing a report

`filter` takes `{ "on": { "field", "comparisonOperator": "EQUALS" | "IN", "not": false, "values": [...] } }`,
or `{ "and": { "filters": [...] } }` to combine. **`not` is required** and is the
easiest part to leave out.

Filterable fields are a RESTRICTED SUBSET of the fields you can request:
`advertiserAccount.id` is valid in `fields` and rejected in `filter` with
`400020`. `adProduct.value` IS filterable and takes `AMAZON_DSP`, which is how
you narrow a manager-account report to DSP only.

### Telling the user why the numbers moved

v1 redefined two things, so v1 figures will NOT match an older DSP export or a
v3 report. This is a definition change, not an error, and saying so up front
prevents a support thread:

- Base conversion metrics now include **halo** (not just the promoted product).
  `metric.purchases` equals the old DSP `totalPurchases`, not the old `purchases`.
  Halo is credited to every brand in the advertiser's tracked-product list, so
  when a PRODUCT report shows halo rows under a brand the advertiser does not
  own, a foreign ASIN is in the tracked list; find it by brand in that report
  and remove it in the DSP console (removal is not retroactive; past-period
  reports keep the halo). Tracked-product lists are built from the catalog
  (`mws_items` with `InCatalog = 1`), never from `seller_ASIN_list`.
- Conversions report on **traffic date** (the ad interaction) where DSP v3 used
  **conversion date**, so volume shifts earlier in flight.

For a like-for-like comparison with old figures use `metric.purchasesPromoted`,
`metric.salesPromoted` and `metric.roasPromoted`.

## Building a v3 report request (the last-90-days surface)

Everything from here to "Reactive error handling" is the **DSP v3** surface. If
the user's date range starts more than 90 days ago, none of it applies and you
want the Reporting v1 section above instead.

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
| `reauth_required` | 5 | The 401 case. Do NOT jump to "re-authorize": work the order in "When a DSP read fails" — another merchant first, then re-authorize, and only then the no-DSP-API-access possibility. |
| `merchant_inactive` | 13 | The merchant is **not active for Amazon Ads** in MixShift, so Amazon will not serve data for it. Nothing was sent to Amazon. **Terminal: never retry, and do not attempt the rest of a change set.** Tell the user to activate the merchant in the MixShift platform, then re-run. Do NOT tell them to re-authorize: the connection is working, this is an activation setting. |
| `profile_not_authorized` | 14 | Amazon denies this profile to the advertising login the merchant is connected through. The MixShift credential is fine, so re-authorizing changes nothing. **Terminal: never retry unchanged.** Ask the user to check that the advertising login has access to that advertiser in Amazon Ads, or to contact MixShift support so it can be re-mapped. |
| `throttled` | 8 | Amazon is rate-limiting. Wait a moment and retry. |
| `invalid_request` | 15 | MixShift refused the request before anything reached Amazon (an unknown operation, a parameter it does not take, a missing one). The message says what is wrong; `fix`, when present, says what to change. **Never resend it unchanged.** Fix it and call again. |

A DSP write adds `insufficient_scope` (exit 11: the credential cannot write; hand
the user the change list) and, when proposing, the proposal kinds (exits 16 to
20) documented in `mx-amazon-ads` "Proposals (approve later)".

Every failure in `--json` also carries `source` (who has to act: `request`, `account`,
`amazon_rejected`, `amazon_unavailable` or `mixshift`) and `retryable`. `retryable: false` means
the identical call fails the same way until something changes, so never resend it as is (the one
exception is `unknown`: one retry, then report it). See `mx-amazon-ads` "Reactive error handling".

**If a failure carries `request_outcome: "unknown"`** (the message says the call
may still have gone through), the report you were creating may already exist.
Do not resend `dsp.create_report` or `reporting_v1.create_report` blindly: a v1
resend makes a second report that holds one of the two slots. Follow the
unknown-outcome rule in `mx-amazon-ads` ("Reactive error handling").

Four DSP-specific cases that need their own handling:

- **`REQUEST_BODY_FIELD_REPORT_DATE_OLD` (HTTP 422) on `dsp.create_report`** is
  the 90-day wall, and it is the most likely error you will see on this skill.
  It is NOT an access or permissions problem and it will never succeed on retry.
  Rebuild the request against `reporting_v1.create_report` instead.
- **A `throttled` failure on `reporting_v1.create_report`** means two reports are
  already generating, not that you are calling too fast. Waiting does not clear
  it. Poll the reports you have, or free a slot with
  `reporting_v1.delete_report`.

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

- **Reports and reads are safe; edits and builds are gated.** Generating a DSP
  report or reading the account mutates nothing. A DSP write (`dsp.update_*`,
  `dsp.create_*`, `dsp.delete_targets`) NEVER reaches Amazon without a preview
  the user saw and explicit confirmation of that exact change set in a SEPARATE
  turn, then `--commit`. A flights list is a full replacement: omitting a flight
  deletes it. Creating creatives and changing a creative's placement are
  console-only: do not improvise them.
- **A build never starts spend.** Campaigns and line items are created
  `PAUSED`; turning them on is a separate, confirmed `dsp.update_*` change.
  Never retry a create whose outcome is unknown without querying first: Amazon
  cannot delete a duplicate DSP campaign or line item.
- **Pick the surface from the DATE RANGE, before anything else.** Older than 90
  days means `reporting_v1.*`. A `REQUEST_BODY_FIELD_REPORT_DATE_OLD` 422 from
  `dsp.create_report` is the v3 wall, not an access problem: switch surfaces
  rather than retrying or blaming permissions.
- **Never say a user's older DSP data does not exist** without having tried the
  v1 surface. It is reachable back several years.
- **On v1, always request `year.value` alongside `month.value`** (or
  `week.value`). Without it, a range crossing a year boundary silently merges
  months across years and sums the metrics. It does not error; it just returns a
  wrong number, and that is the single worst failure available on this surface.
- **Warn before comparing v1 numbers to old ones.** v1 base metrics include halo
  and report on traffic date, so figures legitimately differ from a v3 report or
  an older console export. Offer the `*Promoted` metrics for like-for-like.
- **Do not promise a number of years of DSP history.** Retention is deep, but the
  data begins when the advertiser's DSP activity began.
- **A v1 429 on create means two reports are already in flight, not that you are
  going too fast.** Backing off never clears it. Wait for one to finish or delete
  one with `reporting_v1.delete_report`.
- **Discover the DSP advertiser id first, starting at
  `accounts.list_manager_accounts`.** The advertiser id is NOT the `profileId`
  or `legacySellerId`. Read `linkedAccounts[]` rows of type
  `DSP_ADVERTISING_ACCOUNT`, de-duplicated. `accounts.query_advertiser_accounts`
  is the second source, and it only looks empty when one global filter or one
  page is skipped. The warehouse (`dsp_campaigns_metric`) is a CROSS-CHECK that
  shows who is spending, not the resolver.
- **Never pick the advertiser for the user.** There is no reliable brand →
  advertiser mapping; the sponsored and DSP records share no identifier. Present
  the candidates, have the user confirm, and echo the id back. Do NOT auto-select
  by spend or by name similarity.
- **Keep the two ids straight, and the two parameter names.**
  `--legacy-seller-id` selects the LOGIN. The advertiser id goes in
  `--path accountId=` for the report operations and `--path advertiserId=` for
  the account reads. Same value, different parameter name per family; using the
  wrong one silently omits the advertiser and the call fails as if unauthorized.
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
