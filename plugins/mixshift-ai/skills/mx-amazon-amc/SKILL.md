---
name: mx-amazon-amc
description: >
  Run ad-hoc Amazon Marketing Cloud (AMC) SQL analytics for a merchant, on
  demand, straight from Amazon through MixShift's service. AMC is a clean-room:
  you submit a SQL workflow against a tenant's AMC instance and Amazon returns
  aggregated results as downloadable CSVs. This skill owns the full AMC loop:
  discover the AMC instances an advertising login can reach, inspect the
  available data sources (tables), help author dialect-correct AMC SQL, submit
  a workflow execution, poll it to completion across turns, and fetch the
  results. Also the surface for the paid Amazon Retail Purchases dataset
  (`amazon_retail_purchases`), which covers every Amazon store purchase whether
  or not an ad was involved and across a far longer history than the
  ad-attributed tables: use this skill for customer lifetime value, revenue and
  repeat rate by ASIN, acquisition cohorts, and repeat-purchase analysis.
  Also builds AMC audiences: rule-based audiences written as SQL over the
  instance's audience tables and activated on a DSP advertiser or a
  sponsored-ads account, with list, status, fix-and-resubmit and delete for
  failed ones. Reporting is read-only; audience creation is a write, dry-run
  first and `--commit` only after the user confirms. Routes through the
  bundled harness CLI. Does not require brand setup, only that the user has
  signed in (`mixshift auth login`).
metadata:
  version: "0.3.0"
  author: "MixShift"
trigger_phrases:
  - run an amc query
  - amazon marketing cloud query
  - amc analytics
  - amc workflow
  - amc clean room
  - query amazon marketing cloud
  - list my amc instances
  - what amc instances do I have
  - amc data sources
  - submit an amc workflow
  - amc sql
  - pull retail purchases
  - amazon retail purchases
  - retail purchases data set
  - customer lifetime value
  - ltv by asin
  - purchase cohorts
  - repeat purchase analysis
  - create an amc audience
  - build an audience from amc
  - amc audience
  - lapsed buyers audience
  - dsp audience from amc
  - list my amc audiences
  - why did my amc audience fail
  - resubmit an amc audience
  - delete a failed amc audience
---

# Amazon Marketing Cloud (AMC) Ad-hoc Analytics and Audiences

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.


## About the AMC surface (authoritative, do not guess)

When characterizing this capability to the user, use these facts:

- **What it is:** Amazon Marketing Cloud is Amazon's privacy-safe clean room.
  You submit an ad-hoc SQL workflow against a tenant's AMC instance and Amazon
  returns aggregated results as CSV download urls. This skill drives that whole
  loop: discovery, schema, query authoring, execution, polling, and fetching.
- **Routing:** all calls flow through the harness CLI (`mixshift ads ...`),
  which talks to MixShift's service at `mcp.mixshift.io` using the same Bearer
  token as the other MixShift surfaces (from `~/.mixshift/auth/credentials`, no
  `.json` extension). The service holds the Amazon Advertising credentials
  server-side and the single static egress IP. The plugin never holds Ads
  secrets, and Claude never sees them.
- **Auth model (different from SP-API):** AMC rides the Amazon Ads API, whose
  tokens are PER ADVERTISING LOGIN, not per seller. The service reads the
  tenant's stored advertising refresh token (keyed by the seller row's
  `idUserAccount`) and mints access tokens in memory. Nothing for the plugin to
  handle. You select the merchant the same way as every Ads surface (see
  "Merchant selection" below).
- **The AMC header model is its own thing.** Unlike the Sponsored Ads
  operations, AMC calls are NOT profile-scoped. Instead the service derives two
  headers for you: the AMC ENTITY id (an advertiser id, passed as
  `--path entityId=...`) and a marketplace id (defaults to the resolved seller
  row's marketplace, overridable with `--path marketplaceId=...`). You never set
  these as raw HTTP headers; you pass them as `--path` values and the service
  places them.
- **Reporting is read-only; audiences are the one write.** Submitting and
  running an AMC workflow mutates nothing advertiser-facing, so reporting needs
  no `ads:write` scope. An AMC audience is different: creating one activates a
  real audience on the destination advertiser account, so the five audience
  operations need `ads:write`, preview by default, and apply only with
  `--commit` after the user has confirmed the preview. See "Audiences" below.

If the user asks "where does this data come from," lead with "Amazon Marketing
Cloud, queried through MixShift's service," not a guess.

## When to use this skill

Trigger when the user wants to **run an ad-hoc AMC SQL query**, for example:

- "Run an AMC query for path-to-conversion last month"
- "What AMC instances do I have for Ridgepak?"
- "List the AMC data sources I can query"
- "Submit this AMC SQL and get me the results"
- "Build me an AMC new-to-brand overlap query"

And when the user wants an **AMC audience** built or managed, for example:

- "Build an audience of everyone who bought in the last 365 days and push it to DSP"
- "Create a lapsed-buyer audience: bought 180 to 365 days ago, nothing since"
- "Why did my AMC audience fail?" / "Fix it and resubmit"
- "List the audiences on this instance"

The core user stories: *"I want to run a privacy-safe SQL analysis against my
AMC clean room, on demand, and get the aggregated results back as a file I can
analyze or build on,"* and *"I want to describe an audience in plain terms and
have it built and activated on my DSP or sponsored-ads account, without
learning the clean room's rules by trial and error."*

**Do NOT use this skill** for:

- Warehouse history or Sponsored Ads metrics MixShift already holds, that is
  `mx-data-explore`.
- SP-API report documents (orders, Brand Analytics, Sales and Traffic), that is
  `mx-amazon-report`.
- Live Sponsored Ads account state, lists, exports, or writes, that is
  `mx-amazon-ads`.
- Live SP-API retail lookups (catalog, fees, inventory), that is
  `mx-amazon-retail`.

AMC is a distinct surface: aggregated, clean-room SQL, not row-level warehouse
data and not a packaged report.

## Prerequisites the user needs

| State | How to check | What to do if missing |
|---|---|---|
| Signed in to MixShift | `~/.mixshift/auth/credentials` exists | Direct the user to run `mixshift auth login` (or say "sign in to MixShift" in chat). Calls fail with `not_authenticated` until then. |
| Ads API enabled for the tenant | Inferred from a successful `ads profiles` call | If a call returns `ads_not_configured`, the Amazon Ads credentials are not set on the service for this MixShift account. Tell the user to contact MixShift ops. |
| An advertising login with AMC access | `mixshift ads call amc.list_accounts ...` returns rows | No AMC accounts means this login cannot reach an AMC instance. See the discovery chain below; an empty result is normal for tenants without AMC. |

Brand setup is **not required.** You only need a signed-in session.

## Merchant selection (resolve the row first)

AMC calls take the same merchant selectors as every Ads surface. Resolve the
row through `mixshift ads profiles` (or `--json` to match by `name`); the
columns are `profileId`, `legacySellerId`, `name`, `type`, `region`,
`marketplace`. Carry identity end to end:

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

AMC-specific nuance: **an AMC account's marketplace can differ from the seller
row's.** The service defaults the marketplace header to the resolved row's
marketplace; when the AMC account lives elsewhere, pass
`--path marketplaceId=<id>` to override it on the execution, poll, schema, and
download calls (see "Lifecycle" below).

## Available harness commands

All commands accept `--json` for structured output and `--data-dir` to
override the data directory. AMC is one family inside the general Ads call
surface; there is no dedicated `amc` subcommand. Browse the catalog first:

```
mixshift ads profiles
mixshift ads operations --family AMC
mixshift ads call <operation> [--legacy-seller-id <id> | --seller-id <id> --marketplace <m> | --profile-id <id>]
                              [--path <k=v> ...] [--query <k=v> ...]
                              [--body-file <file> | --body <json>]
```

`ads operations --family AMC` prints each AMC operation id with its notes (body
vs path conventions); read the notes before calling. The eight reporting
operations, used in the order below, then the five audience operations:

| Operation | Purpose |
|---|---|
| `amc.list_accounts` | Entity accounts (ENTITY ids + names + marketplaceIds) this login can reach. No params, no entity header. |
| `amc.list_instances` | Instances visible to one `(entityId, marketplaceId)` pair. |
| `amc.get_instance` | One instance, including `optionalDatasets`: which PAID datasets are active on it. |
| `amc.list_data_sources` | Every data source (table) in an instance, with columns. Pages, and the response is large. |
| `amc.get_data_source` | Full column schema for ONE named table. Prefer it when you know the table. |
| `amc.create_workflow_execution` | Submit an ad-hoc AMC SQL workflow execution. |
| `amc.get_workflow_execution` | Poll an execution (PENDING, RUNNING, SUCCEEDED, FAILED, CANCELLED, REJECTED). |
| `amc.get_download_urls` | Presigned CSV download urls for a SUCCEEDED execution. |
| `amc.create_audience` | **Write.** Create a rule-based audience from SQL and activate it on one destination account. Dry run by default. |
| `amc.list_audiences` | Every audience on an instance with status, destination, window and refresh. |
| `amc.get_audience` | One audience by execution id: status and Amazon's failure reason. |
| `amc.update_audience` | **Write.** Fix and resubmit a FAILED audience in place (same id). |
| `amc.delete_audience` | **Write.** Delete a FAILED audience. Immediate and irreversible. |

`--path` values for AMC are either sent as HTTP headers (entityId,
marketplaceId, and for the audience operations instanceId too) or filled into
templated paths (instanceId on reporting, workflowExecutionId,
audienceExecutionId); the service decides per operation. You always pass them
as `--path k=v`.

## Discovery chain (run IN ORDER)

You cannot submit a query without an `instanceId` and the `entityId` that
reaches it. Walk this chain in order; do not skip ahead.

### 1. List AMC accounts (entity ids + marketplaces)

```bash
mixshift ads call amc.list_accounts --legacy-seller-id <id> --json
```

No parameters, no entity header. Each row carries an `accountId` (use it as the
`entityId`) and a `marketplaceId`. BUT this returns only the entities the LOGIN
directly administers — for an agency/manager login that is MixShift's own manager
+ SANDBOX entities, usually NOT the merchant's own advertiser entity. Treat it as
a STARTING point, never the whole list: you MUST also run step 3 (the merchant's
own entity, where a managed brand's real production instance lives). An empty
result here is normal and NOT a stopping point.

### 2. List instances per (entityId, marketplaceId) pair, SEQUENTIALLY

For each account row, probe its instances. The `entityId` and `marketplaceId`
ride as HEADERS via `--path`:

```bash
mixshift ads call amc.list_instances --legacy-seller-id <id> \
  --path entityId=<accountId> \
  --path marketplaceId=<marketplaceId> --json
```

Rules for this step (all load-bearing):

- **Probe pairs SEQUENTIALLY, one call at a time.** Parallel probing trips
  429 throttling. Never fan these out concurrently.
- **The response shape varies.** It may come back as `{ "instances": [...] }`
  or as a single `{ "instance": {...} }`. Handle both: normalize to a list.
- **401 / 403 / 404 while probing is NORMAL.** It means no access for that
  pair, not a failure. Skip that pair and move on; do not surface it as an
  error to the user.
- **Dedupe by `instanceId`** across all entities — the same instance can surface
  under more than one entity.
- **Distinguish `instanceType`.** `STANDARD` is a real production clean room with
  the merchant's actual data; `SANDBOX` holds Amazon's synthetic test data (fine
  for validating SQL, NOT for real insights). If only sandboxes turn up under the
  step-1 manager accounts, that is EXPECTED — the production instance is under the
  merchant's OWN entity (step 3). NEVER conclude "no production AMC instance"
  until you have probed the merchant's own entities from step 3.

Each instance carries an `instanceId`, which you need for every execution,
poll, schema, and download call. If more than one STANDARD instance turns up,
show the list (instanceName + instanceType + customerCanonicalName) and let the
user pick.

### 3. ALWAYS resolve the merchant's OWN entityIds via query advertiser accounts

Run this on EVERY discovery, not only when step 1 is empty. `amc.list_accounts`
returns the login's manager/sandbox entities, but a managed brand's real
(STANDARD) instance lives under the brand's OWN advertiser entity, which only
appears here. The `alternateId` whose `profileId` matches the login you resolved
is the merchant's own entity — probe it (step 2) first. Discover via:

```bash
# global accounts (default body)
mixshift ads call accounts.query_advertiser_accounts --legacy-seller-id <id> --json

# non-global accounts (pass the filter body)
mixshift ads call accounts.query_advertiser_accounts --legacy-seller-id <id> \
  --body '{"isGlobalAccountFilter":{"include":[false]}}' --json
```

Rules for this step (query advertiser accounts):

- **This operation uses a different client-id header** than the AMC operations;
  the service sets it. You do nothing special beyond calling it.
- **Query BOTH global and non-global** for full coverage. The default body
  (`{}`) returns global accounts only; pass
  `{"isGlobalAccountFilter":{"include":[false]}}` for non-global.
- **Pagination via `nextToken` in the body.** Empty pages with a valid
  `nextToken` are NORMAL; keep iterating until `nextToken` is absent. Do not
  stop on the first empty page.
- The `alternateIds` carry Sponsored Ads `entityId`s. Feed each one back into
  `amc.list_instances` (step 2, sequentially) to surface its instances.

### 4. Check paid datasets before promising them

Some AMC tables are free with every instance and some require a paid
subscription the advertiser has to hold. A query against an unsubscribed table
fails at compile time with a message that does **not** mention the subscription,
so it reads as a broken query and sends you off fixing SQL that was never wrong.
Do this before schema discovery, not after.

```bash
mixshift ads call amc.get_instance --legacy-seller-id <id>   --path instanceId=<instanceId>   --path entityId=<entityId>   --path marketplaceId=<the marketplace that found this instance> --json
```

`instance.optionalDatasets` is an array of `{ label, activationTime }`. A `label`
of `PURCHASE_RETAIL_PROGRAM` means `amazon_retail_purchases` is queryable here.

`activationTime` is when the advertiser **subscribed**, and it is not where the
data starts. Amazon backfills roughly five years behind it, so an instance
activated last year can hold history from years before that. Never bound a window
with it: measure the real floor with `SELECT MIN(purchase_date_utc)` over a
window deliberately opened years earlier, then set every later window from that
result. Nothing in the API reports the floor, so this query is the only route to
it. `references/amazon-retail-purchases.md` has the full procedure and what goes
wrong without it.

`amc.list_instances` carries the same array for every instance it lists, so
either call answers this; prefer `amc.get_instance` once you hold an instance
id, since the list pages at 100.

A missing label is a reliable no. A present label is necessary but not proven
sufficient, since the entry carries no expiry and a lapsed subscription may
still list. If a query is rejected at compile time with the label present,
suspect the subscription before rewriting the SQL. The schema call in step 5
gives a second signal for free: a paid table reports `isPremium: true`.

### 5. Find the schema before writing SQL

Never author SQL from guessed table or column names. Which call you make
depends on whether you already know the table.

**When you know the table** (the common case), ask for just that one. It is a
single small response instead of every table with all of its columns:

```bash
mixshift ads call amc.get_data_source --legacy-seller-id <id>   --path instanceId=<instanceId>   --path entityId=<entityId>   --path marketplaceId=<same marketplace>   --path dataSourceName=amazon_retail_purchases --json
```

**When you are exploring**, list everything, and page until the response carries
no `nextToken`. `limit` caps at 100, so do not assume one call covered it (a
subscribed instance checked 2026-09-09 held 46 tables, comfortably one page, but
that is not a guarantee). Every row carries that table's full column list, so
the response is large even at 46 tables:

```bash
mixshift ads call amc.list_data_sources --legacy-seller-id <id>   --path instanceId=<instanceId>   --path entityId=<entityId>   --path marketplaceId=<same marketplace> --json
```

**Pass the same `marketplaceId` that found the instance.** Without it the header
falls back to the seller row's marketplace, and an instance under a different
one returns 404.

A 404, or a table absent from the list, is **inconclusive**: it can be a
mistyped name, the wrong marketplace, the wrong entity, or a table this instance
cannot see. It is not proof that a subscription is off. Only step 4 answers
that.

Both calls return, per column, its `name`, `columnType` (DIMENSION or METRIC),
`dataType`, `description`, and — the one that matters most — its
**`sensitivity`**: `NONE`, `LOW`, `MEDIUM` or `VERY_HIGH`. That is the
aggregation threshold deciding whether a column may appear in your output, so
read it from the response rather than assuming. The next section explains what
each value means. The response also carries `isPremium`, which says whether the
table is a paid dataset.

**For `amazon_retail_purchases` specifically** - the long-window dataset behind
lifetime value, repeat purchase and cohort analysis - read
`references/amazon-retail-purchases.md` before writing the query. It carries the
full column list with the output floors the API does not return, six traps that
silently produce wrong answers, the execution-window default that otherwise
turns a five-year question into one day, and three query recipes (one verified
live, two not).
## AMC SQL dialect rules (these bite, follow them)

AMC SQL is not standard SQL. These rules come straight from the operation
catalog notes; ignoring them produces a FAILED execution. Apply all of them
when authoring or reviewing a query:

- **Declare every CUSTOM_PARAMETER in `workflow.inputParameters`.** Any
  parameter the SQL references must be declared in the `inputParameters` array
  of the request body. Array-typed parameters additionally need
  `elementDataType` and `elementNullable`.
- **NTILE is unsupported.** Build quartiles (or any n-tile bucket) manually with
  `ROW_NUMBER()` plus `CEIL`: number the rows, then divide into buckets with
  `CEIL(row_number * n / total)`.
- **`COUNT(*) OVER ()` is rejected.** Use `COUNT(<col>) OVER ()` with a concrete
  column instead of the star.
- **No computed expressions inside `COLLECT`.** Pre-compute the value in a CTE,
  then `COLLECT` the already-computed column. Do not put arithmetic or function
  calls directly inside `COLLECT(...)`.

### The clean-room output rule (a rejection that is not a SQL error)

This one is not about the SQL at all, and it is the most common reason a query
that reads perfectly well comes back rejected or empty.

- **Shopper-level identifiers may never reach the final `SELECT`, the final
  `GROUP BY`, or the final `ORDER BY`.** All three clauses count. `user_id`,
  `purchase_id`, `event_id`, and the session id columns can be grouped, joined,
  and counted **inside** common table expressions, but what you return has to be
  an aggregate: `COUNT`, `COUNT(DISTINCT ...)`, `APPROX_COUNT_DISTINCT`, sums,
  averages. Every worked example below follows that shape.
- **A returnable column can still carry a floor.** Each column's `sensitivity`
  says which: `NONE` has no floor, `LOW` needs two distinct shoppers per row,
  `MEDIUM` needs a hundred, and `VERY_HIGH` can never be returned. Fine grouping
  on a `MEDIUM` column therefore drops most rows. `amc.get_data_source` returns
  `sensitivity` per column, so read it rather than guessing.
- **An empty result may be redaction, not an absence of data.** Before telling a
  user a segment had no sales, coarsen the grouping or widen the window and
  re-run. Better, set `distinctUserCountColumn`,
  `filteredMetricsDiscriminatorColumn` and `filteredReasonColumn` on the
  execution body: they report what was filtered and why, instead of leaving you
  to guess.
- **A `REJECTED` status is this rule firing**, not a transient error. Do not
  retry the same query unchanged.
- **Validate cheaply.** Submitting with `dryRun` set compiles the query and
  comes back in seconds rather than minutes. Use it on anything freshly
  authored, before the real submit.

### Worked example (exercises the dialect rules)

This query buckets users into manual quartiles by impression count, which
exercises both the NTILE workaround (ROW_NUMBER + CEIL) and the
`COUNT(col) OVER ()` rule, and declares its one CUSTOM_PARAMETER. Save the body
to a file and pass it with `--body-file`.

`amc-quartiles.json`:

```json
{
  "workflow": {
    "sqlQuery": "WITH per_user AS (SELECT user_id, SUM(impressions) AS imps FROM dsp_impressions WHERE campaign_id = :campaign_id GROUP BY user_id), ranked AS (SELECT user_id, imps, ROW_NUMBER() OVER (ORDER BY imps DESC) AS rn, COUNT(user_id) OVER () AS total_users FROM per_user) SELECT CEIL(rn * 4.0 / total_users) AS quartile, COUNT(user_id) AS users, SUM(imps) AS impressions FROM ranked GROUP BY CEIL(rn * 4.0 / total_users) ORDER BY quartile",
    "inputParameters": [
      { "name": "campaign_id", "dataType": "STRING" }
    ]
  },
  "timeWindowType": "MOST_RECENT_WEEK",
  "parameterValues": { "campaign_id": "1234567890" }
}
```

Notes on the example:

- `NTILE(4)` would be the natural way to quartile, but it is unsupported, so the
  query ranks with `ROW_NUMBER()` and divides by `COUNT(user_id) OVER ()`
  (concrete column, not `COUNT(*)`).
- `campaign_id` is referenced in the SQL as `:campaign_id`, so it is declared in
  `workflow.inputParameters` and supplied in `parameterValues`.
- If any parameter were an array, its declaration would also carry
  `elementDataType` and `elementNullable`.
- Table and column names here (`dsp_impressions`, `user_id`, `impressions`) are
  illustrative. Confirm the real ones with `amc.get_data_source` first.
- `user_id` is grouped on inside the CTEs and never returned, per the clean-room
  output rule above.

## Lifecycle: submit, poll across turns, fetch immediately

### 1. Submit the workflow execution

```bash
mixshift ads call amc.create_workflow_execution --legacy-seller-id <id> \
  --path instanceId=<instanceId> \
  --path entityId=<entityId> \
  --body-file amc-quartiles.json --json
```

Body shape (from the catalog):

- `workflow.sqlQuery` (required) and optional `workflow.inputParameters` (see
  the dialect rules: declare every CUSTOM_PARAMETER here).
- `timeWindowType`, one of `EXPLICIT`, `MOST_RECENT_DAY`, `MOST_RECENT_WEEK`.
- For `EXPLICIT`, supply `timeWindowStart`, `timeWindowEnd`, and optionally
  `timeWindowTimeZone`.
- `parameterValues` supplies the runtime values for the declared parameters.

Pass `--path marketplaceId=<id>` here as well when the AMC account's
marketplace differs from the seller row's (see "Merchant selection"). The
service places it as the marketplace header for this call.

A successful submit returns a `workflowExecutionId`. Hold onto it.

### 2. Poll the execution ACROSS TURNS (no sleep-loops)

```bash
mixshift ads call amc.get_workflow_execution --legacy-seller-id <id> \
  --path instanceId=<instanceId> \
  --path entityId=<entityId> \
  --path workflowExecutionId=<workflowExecutionId> --json
```

The status moves through `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`.

- **Poll across separate tool calls, never in a sleep-loop inside one Bash
  call.** AMC executions can take minutes, and chat Bash calls are capped around
  45 seconds. Call poll once, surface the status to the user, and check again on
  a later turn. The `workflowExecutionId` stays valid across turns.
- `SUCCEEDED` means results are ready: go fetch the download urls.
- `FAILED` means Amazon rejected or could not complete the query. Surface
  Amazon's error message and check the dialect rules first (NTILE,
  `COUNT(*) OVER ()`, COLLECT expressions, undeclared parameters are the usual
  culprits).

### 3. Get the download urls and FETCH THEM IMMEDIATELY

```bash
mixshift ads call amc.get_download_urls --legacy-seller-id <id> \
  --path instanceId=<instanceId> \
  --path entityId=<entityId> \
  --path workflowExecutionId=<workflowExecutionId> --json
```

This returns presigned CSV download urls for the SUCCEEDED execution. Two hard
constraints:

- **The urls expire in MINUTES.** Fetch them the moment you get them. Do not
  poll, summarize, or do anything else first. If they expire, re-run
  `amc.get_download_urls` for a fresh set (the execution itself stays valid).
- **Fetch WITHOUT auth headers.** The urls are presigned; sending a
  `Authorization` header will be rejected. Download them as plain GETs.

A portable fetch (Node, works where PowerShell lacks tooling):

```bash
node -e "const https=require('https'),fs=require('fs');const url=process.argv[1];https.get(url,r=>r.pipe(fs.createWriteStream('amc-result.csv')).on('finish',()=>console.log('saved amc-result.csv')))" "<presigned-url>"
```

Save the CSV under `~/.mixshift/reports/<merchant>/<date>-amc-<workflow>.csv`,
then summarize from the file. Report the path and row count, not the raw bytes.

## Audiences (the write side of AMC)

An AMC audience is a rule-based audience: SQL that returns `user_id`s, run by
Amazon over the instance's audience tables, and activated on ONE destination
account, a DSP advertiser or a sponsored-ads entity. Amazon then refreshes it
on a schedule and the advertiser targets or excludes it on line items. Every
rule in this section was learned from real rejections; none of them is in
Amazon's error text.

### The five settings, in the user's words

| The user says | The setting | Rule |
|---|---|---|
| "last 90 days", "the past year" | `timeWindowStart` / `timeWindowEnd`, `timeWindowRelative: 'TRUE'` | **The window IS the lookback.** Amazon applies it to every audience table before the SQL runs, so the query carries NO date filter. "Last 90 days" = start 90 days back, end today. |
| "between 90 and 180 days ago" | the same two fields | start = 180 days back, end = 90 days back. Still no date filter in the SQL. |
| "refresh daily / weekly" | `refreshRateDays` | 1, 7, 14 or 21. **Amazon allows at most 21 days**, so monthly and quarterly do not exist: offer weekly or every three weeks. 0 runs once and Amazon deactivates the audience after 30 days. |
| "push it to DSP" / "to sponsored ads" | `advertiserId` | The DESTINATION, not the AMC entity: a DSP advertiser id or a sponsored-ads `ENTITY...` id. One per audience; to reach both, create it twice. |
| a global DSP advertiser | `countryCode` | Amazon rejects the create with "Country code is required for Global Buying advertisers" until it is sent. Codes include `UK`, not `GB`. |

Plus `audienceName` (Amazon prefixes it with "AMC " in the destination
account) and an optional `audienceDescription`.

### Which table, and check it exists FIRST

The SQL reads the `_for_audiences` twin of a table, never the measurement
table (Amazon fails the run with "Invalid tables in the SQL query"). Which twin
decides what "purchasers" means, so settle it with the user before writing SQL:

| Intent | Table | Population | Availability |
|---|---|---|---|
| every purchaser of these ASINs | `amazon_retail_purchases_for_audiences` | every Amazon purchase, ad-attributed or not, years deep | **paid** (Amazon Retail Purchases); many instances lack it |
| purchasers, page views, add-to-cart, Subscribe & Save signups, wishlists | `conversions_for_audiences` | **ad-attributed events only**: shoppers who saw or clicked this advertiser's ad before the event | free on every instance |
| all conversions incl. non-attributed | `conversions_all_for_audiences` | every conversion | **paid**; most instances lack it |
| DSP-exposed shoppers | `dsp_impressions_for_audiences` | shoppers served a DSP impression | free once DSP delivers |

**Check availability before writing against a paid table.** Run
`amc.get_data_source` for the MEASUREMENT twin (`amazon_retail_purchases`,
`conversions_all`) on that instance: the full schema back means it is on; a
`bad_request` whose detail says the data source does not exist means the
dataset is not enabled there. The audience twin is listed by
`amc.list_data_sources` on every instance whether or not the dataset is
active, so a listing proves nothing. The service runs this same probe on every
create and refuses with the dataset name when it is missing. **Never swap the
free table in for an "all purchasers" intent without saying so**: it is a
different population (ad-attributed only), and the user should decide whether
that is acceptable or whether to enable the paid dataset.

### The SQL rules that only show up as failures

- `SELECT user_id` (or `SELECT DISTINCT user_id`) is the whole output. Nothing
  else may be returned.
- **No date arithmetic.** `INTERVAL`, `DATE_SUB`, `DATEDIFF` and every
  function that adds or subtracts days from a date fail validation with
  "interval data types are not enabled". Put the lookback in the window. When
  a query genuinely needs a cut inside the window (bought 180 to 365 days ago
  AND nothing in the last 180, as one audience), compare seconds back from the
  window end:
  `SECONDS_BETWEEN(event_dt_utc, BUILT_IN_PARAMETER('TIME_WINDOW_END')) > 180 * 86400`.
  Verified to succeed. The alternative is two audiences, a "between 180 and
  365 days ago" include and a "last 180 days" exclude, combined on the line item.
- **`tracked_asin` is only populated for purchases.** For `detailPageView`,
  `shoppingCart`, `snsSubscription` and every other non-purchase subtype the
  ASIN is in `tracked_item`. A page-view audience joined on `tracked_asin`
  runs clean and returns nobody. On `amazon_retail_purchases_for_audiences` the
  column is plain `asin` and every row is a purchase, so there is no subtype.
- `snsSubscription` ("New SnS Subscription") is a real `event_subtype` on the
  conversions table; Subscribe & Save audiences build from it.
- **No trailing semicolon.** Amazon wraps the statement; a terminator is a
  parse error. The service strips one for you, but do not rely on that in
  SQL you hand the user for other tools.
- A `VALUES` list is fine for an ASIN set:
  `WITH asins (asin) AS (VALUES ('B0...'), ('B0...')) SELECT DISTINCT c.user_id FROM conversions_for_audiences c JOIN asins a ON c.tracked_asin = a.asin WHERE c.event_subtype = 'order'`.
- The size floor is **2,000 user_ids**, and Amazon only tells you after the
  run (status FAILED with the reason). A narrow rule on a short window fails
  there; widen the window before touching the SQL.

### Worked example: lapsed buyers, weekly, to DSP

Body file `lapsed.json` (window 365 days back to today, relative, weekly):

```json
{
  "audienceName": "Lapsed buyers 180-365d",
  "audienceDescription": "Bought 180 to 365 days ago and nothing since. Win-back.",
  "advertiserId": "<dsp advertiser id>",
  "query": "WITH earlier AS (SELECT DISTINCT user_id FROM conversions_for_audiences WHERE event_subtype = 'order' AND SECONDS_BETWEEN(event_dt_utc, BUILT_IN_PARAMETER('TIME_WINDOW_END')) > 180 * 86400), recent AS (SELECT DISTINCT user_id FROM conversions_for_audiences WHERE event_subtype = 'order' AND SECONDS_BETWEEN(event_dt_utc, BUILT_IN_PARAMETER('TIME_WINDOW_END')) <= 180 * 86400) SELECT e.user_id FROM earlier e LEFT JOIN recent r ON e.user_id = r.user_id WHERE r.user_id IS NULL",
  "timeWindowStart": "<today minus 365 days>T00:00:00Z",
  "timeWindowEnd": "<today>T00:00:00Z",
  "timeWindowRelative": "TRUE",
  "refreshRateDays": 7,
  "countryCode": "US"
}
```

1. **Preview** (the default). The service normalises the body (trailing
   semicolon gone, booleans converted), runs the paid-table probe, and returns
   the exact body it would send without touching Amazon:

   ```bash
   mixshift ads call amc.create_audience --legacy-seller-id <id> \
     --path instanceId=<instanceId> --path entityId=<entityId> \
     --body-file lapsed.json --json
   ```

2. **Show the user the preview** in their terms: the name, where it lands, the
   window, the refresh, which table and therefore which population. Get an
   explicit yes.
3. **Commit** with the same command plus `--commit`. The response carries
   `audienceExecutionId` and `status: PENDING`.
4. **Poll** `amc.get_audience --path audienceExecutionId=<id>` once per turn.
   PENDING, then RUNNING, then SUCCEEDED or FAILED, usually within minutes; a
   full-year scan on a large catalog can take an hour. On FAILED, `statusReason`
   is Amazon's reason: read it before touching anything.
5. A SUCCEEDED audience takes a few hours to sync to the destination account,
   where it appears with "AMC " in front of its name.

### After a failure

- **Fix in place**: `amc.update_audience --path audienceExecutionId=<id>` with
  a body carrying only what changes (`query`, `timeWindowStart`, `timeWindowEnd`,
  `timeWindowRelative`). Same preview then `--commit`. The audience keeps its id
  and re-runs.
- **Remove it**: `amc.delete_audience --path audienceExecutionId=<id>` then
  `--commit`. Immediate and irreversible; confirm first.
- Both work on FAILED audiences ONLY. A SUCCEEDED or RUNNING audience is
  immutable: to change one, create a new audience from its definition and stop
  using the old one on the line items.
- **Never retry an ambiguous failure blind.** A create that timed out on the
  wire may have created the audience; an identical re-POST makes a SECOND one
  with a new id. List first.

### Listing and the source of record

`amc.list_audiences` returns the array under **`executionMetadata`** (not
"audiences"), one row per audience with its SQL, window, refresh, status,
`statusReason`, `lastRefreshedTime` and the DSP ids once activated. The
instance is the system of record: an audience created here exists whether or
not another MixShift surface has recorded it, and an audience created elsewhere
shows up here. When the user's MixShift AMC workspace page does not list an
audience you created, that is the page lagging the instance, not a failed
create; point them at the destination account's audience list.

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
| `merchant_inactive` | 13 | The merchant is **not active for Amazon Ads** in MixShift, so Amazon will not serve data for it. Nothing was sent to Amazon. **Terminal: never retry, and do not attempt the rest of a change set.** Tell the user to activate the merchant in the MixShift platform, then re-run. Do NOT tell them to re-authorize: the connection is working, this is an activation setting. |
| `profile_not_authorized` | 14 | Amazon denies this profile to the advertising login the merchant is connected through. The MixShift credential is fine, so re-authorizing changes nothing. **Terminal: never retry unchanged.** Ask the user to check that the advertising login has access to that advertiser in Amazon Ads, or to contact MixShift support so it can be re-mapped. |
| `throttled` | 8 | Amazon is rate-limiting. Wait a moment and retry. Probing instances SEQUENTIALLY prevents most of these. |
| `insufficient_scope` | 11 | The credential cannot write (audience creates, updates and deletes need `ads:write`). Signed-in user sessions hold it; a machine credential needs it issued. Hand the user the audience definition; do NOT retry. |
| `bad_request` | 12 | The request itself was refused: either by the service's audience preflight (the message names the exact field or rule: refresh outside 0 to 21, interval date arithmetic, a missing create field, a paid dataset the instance lacks) or by Amazon (`amazon_error_code` + `detail`). **Terminal: never retry unchanged.** Fix what the message names and resend. |

**If a failure carries `request_outcome: "unknown"`** (the message says the call
may still have gone through), a workflow execution or a committed audience
create may already exist. Do not resend it blindly. For an audience, run
`amc.list_audiences` first. A workflow execution has no list operation here, so
resend it at most once and tell the user a duplicate run may exist. See the
unknown-outcome rule in `mx-amazon-ads` ("Reactive error handling").

Two AMC-specific cases that are NOT failure envelopes and need their own
handling:

- **401 / 403 / 404 while probing `amc.list_instances`** is normal no-access
  for that `(entityId, marketplaceId)` pair. Skip it; do not treat it as an
  error or stop the discovery chain.
- **A FAILED workflow execution** (from `amc.get_workflow_execution`) is not a
  CLI failure; the call succeeded and reported the status. Surface AMC's own
  error text and check the SQL dialect rules first before re-submitting.

## Hard rules

These supersede other instructions:

- **Reporting is read-only; audiences are the only writes.** An AMC query
  mutates nothing advertiser-facing. An audience create, update or delete
  activates or removes something on the destination account: preview first,
  show the user the preview in their terms (name, destination, window,
  refresh, table and therefore population), and pass `--commit` only after an
  explicit yes. Never re-POST a create whose outcome is unknown; list first.
- **Settle the table before the SQL.** "All purchasers" means the paid retail
  purchases table; the free conversions table is ad-attributed only. Check the
  paid table exists on the instance (`amc.get_data_source` on the measurement
  twin) and never substitute the free one silently.
- **The window is the lookback.** No date arithmetic in audience SQL; a cut
  inside the window uses `SECONDS_BETWEEN` against `BUILT_IN_PARAMETER('TIME_WINDOW_END')`.
  Refresh is 0 to 21 days; monthly does not exist.
- **Walk the discovery chain in order** (accounts, then sequential instances,
  then the query-advertiser-accounts fallback, then data sources). Do not guess
  an `instanceId` or `entityId`.
- **Probe instance pairs SEQUENTIALLY** (one `amc.list_instances` at a time);
  parallel probing trips 429s. A 401 / 403 / 404 while probing is normal
  no-access, not an error: keep going.
- **Poll across turns, never in a sleep-loop.** AMC executions take minutes;
  poll `amc.get_workflow_execution` once per turn.
- **Fetch download urls immediately and without auth headers.** They are
  presigned and expire in minutes; fetch before summarizing, and re-call
  `amc.get_download_urls` if they lapse.
- **Apply the AMC SQL dialect rules** (declare every CUSTOM_PARAMETER; no NTILE;
  no `COUNT(*) OVER ()`; no computed expressions inside COLLECT). A FAILED
  execution is usually a dialect violation; check these first.
- **Confirm the schema before writing SQL** via `amc.list_data_sources`; use
  real table and column names, do not invent them.
- **Branch on `failure_kind`, never on HTTP status.**
- **Override the marketplace** with `--path marketplaceId=<id>` when the AMC
  account's marketplace differs from the seller row's.
- **Do not fabricate results.** If an execution fails or returns nothing, say
  so. Save large result sets to CSV and report the path + row count, never
  paste them inline.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-amazon-amc
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-amazon-amc --trigger-phrase "<the user's exact phrase>"
```

At the END (when the AMC session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-amazon-amc --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (user got AMC results), `failed` (could not satisfy, e.g. no AMC
access, or every execution came back FAILED), `deferred` (an execution is still
running and the user stepped away), `skipped` (turned out they wanted a
different skill).

The harness fires per-call telemetry automatically on each `ads call`,
capturing the operation id + duration + outcome (+ failure kind) only. It never
logs the query body, the result bytes, or the amazonSellerId.

## Output template

Lead with a one-line result, then the path or a brief sample:

```
✓ AMC query SUCCEEDED for Ridgepak (instance amc1a2b3c, MOST_RECENT_WEEK).
  → Saved 1,284 rows to ~/.mixshift/reports/<merchant>/2026-06-12-amc-quartiles.csv
  → Columns: quartile, users, impressions

Want me to summarize the quartile spread, or run another window?
```

While an execution is still running:

```
• Submitted AMC workflow for Ridgepak (execution wfx-9c41...).
  Amazon is running it (status: RUNNING). I'll check again in a moment;
  AMC executions can take a few minutes.
```

An audience, at the preview step and after the commit:

```
• Ready to create "Lapsed buyers 180-365d" on the Ridgepak DSP advertiser.
  Window: last 365 days, moving with each weekly refresh. Table: ad-attributed
  conversions (shoppers who saw a Ridgepak ad), since Retail Purchases is not
  enabled on this instance. Say yes and I'll create it.

✓ Created "Lapsed buyers 180-365d" (execution 83a0...). Amazon is building it
  (status: PENDING); it usually resolves within minutes and shows in the DSP
  audience list a few hours after it succeeds.
```

Do not pad with "Here is the data you requested." Lead with the result.
