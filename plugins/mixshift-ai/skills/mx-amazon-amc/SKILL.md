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
  results. Read-only: running a query mutates nothing advertiser-facing and
  needs no write scope. Routes through the bundled harness CLI. Does NOT
  require brand cold-start, only that the user has signed in
  (`mixshift auth login`).
metadata:
  version: "0.1.0"
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
---

# Amazon Marketing Cloud (AMC) Ad-hoc Analytics

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
- **Reads only.** Submitting and running an AMC workflow mutates nothing
  advertiser-facing, so the surface needs no `ads:write` scope. This skill never
  sends a write and never uses `--commit`.

If the user asks "where does this data come from," lead with "Amazon Marketing
Cloud, queried through MixShift's service," not a guess.

## When to use this skill

Trigger when the user wants to **run an ad-hoc AMC SQL query**, for example:

- "Run an AMC query for path-to-conversion last month"
- "What AMC instances do I have for Ridgepak?"
- "List the AMC data sources I can query"
- "Submit this AMC SQL and get me the results"
- "Build me an AMC new-to-brand overlap query"

The core user story: *"I want to run a privacy-safe SQL analysis against my
AMC clean room, on demand, and get the aggregated results back as a file I can
analyze or build on."*

**Do NOT use this skill** for:

- Warehouse history or Sponsored Ads metrics MixShift already holds, that is
  `mx-data-explore`.
- SP-API report documents (orders, Brand Analytics, Sales and Traffic), that is
  `mx-report-pull`.
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

Cold-start is **NOT required.** You only need a signed-in session.

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
vs path conventions); read the notes before calling. The six AMC operations,
used in the order below:

| Operation | Purpose |
|---|---|
| `amc.list_accounts` | Entity accounts (ENTITY ids + names + marketplaceIds) this login can reach. No params, no entity header. |
| `amc.list_instances` | Instances visible to one `(entityId, marketplaceId)` pair. |
| `amc.list_data_sources` | Data sources (tables) in an instance. Schema discovery for query building. |
| `amc.create_workflow_execution` | Submit an ad-hoc AMC SQL workflow execution. |
| `amc.get_workflow_execution` | Poll an execution (PENDING, RUNNING, SUCCEEDED, FAILED). |
| `amc.get_download_urls` | Presigned CSV download urls for a SUCCEEDED execution. |

`--path` values for AMC are either sent as HTTP headers (entityId,
marketplaceId) or filled into templated paths (instanceId,
workflowExecutionId); the service decides per operation. You always pass them
as `--path k=v`.

## Discovery chain (run IN ORDER)

You cannot submit a query without an `instanceId` and the `entityId` that
reaches it. Walk this chain in order; do not skip ahead.

### 1. List AMC accounts (entity ids + marketplaces)

```bash
mixshift ads call amc.list_accounts --legacy-seller-id <id> --json
```

No parameters, no entity header. This is THE starting point. Each row carries
an `accountId` (use it as the `entityId`) and a `marketplaceId`. An empty
result is normal for a tenant with no AMC access; say so rather than retrying.

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

Each instance carries an `instanceId`, which you need for every execution,
poll, schema, and download call.

### 3. Fallback: query advertiser accounts for self-service entityIds

If `amc.list_accounts` returns nothing usable but the tenant runs self-service
Sponsored Ads, those Sponsored Ads `entityId`s can also surface AMC instances.
Discover them via:

```bash
# global accounts (default body)
mixshift ads call accounts.query_advertiser_accounts --legacy-seller-id <id> --json

# non-global accounts (pass the filter body)
mixshift ads call accounts.query_advertiser_accounts --legacy-seller-id <id> \
  --body '{"isGlobalAccountFilter":{"include":[false]}}' --json
```

Rules for this fallback:

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

### 4. List data sources for schema discovery

Once you have an `instanceId` and its `entityId`, inspect the tables before
writing SQL:

```bash
mixshift ads call amc.list_data_sources --legacy-seller-id <id> \
  --path instanceId=<instanceId> \
  --path entityId=<entityId> --json
```

This is the schema-discovery call for query building: it lists the data sources
(tables) available in that instance. Read it before authoring SQL so column and
table names are real, not guessed.

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
  illustrative. Confirm the real ones with `amc.list_data_sources` first.

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
| `throttled` | 8 | Amazon is rate-limiting. Wait a moment and retry. Probing instances SEQUENTIALLY prevents most of these. |

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

- **Read-only.** An AMC query mutates nothing advertiser-facing; never send an
  Ads write and never use `--commit`.
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

## Telemetry (required - see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

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

Do not pad with "Here is the data you requested." Lead with the result.
