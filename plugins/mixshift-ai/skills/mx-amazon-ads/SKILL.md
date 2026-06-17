---
name: mx-amazon-ads
description: >
  Read and write the live Amazon Ads API for any advertiser the signed-in
  MixShift tenant is connected to, straight from Amazon, through the bundled
  harness CLI. The Ads analogue of mx-data-explore and mx-report-pull: a
  catalog-driven workhorse for the current state of an ad account (campaign,
  ad group, keyword, target, and product-ad lists with live bids and states;
  intraday budget usage; live bid, keyword, and budget recommendations; full
  account exports; advanced v3 reporting) and for audited changes to it
  (pause and enable, budget edits, campaign and keyword and target and
  negative creation, negative deletes, across Sponsored Products, Brands,
  and Display). Writes preview by default and never reach Amazon without the
  user confirming the exact change set. Read-first; write only on request.
  Routes through the same Bearer token as the warehouse. Does NOT require
  brand cold-start, only that the user has signed in (`mixshift auth login`).
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - live campaign state
  - current bids
  - current campaign state
  - budget usage
  - intraday budget
  - export my campaigns
  - export my ad account
  - pause campaign
  - enable campaign
  - set campaign budget
  - change campaign budget
  - create a campaign
  - create an ad group
  - delete negative keywords
  - undo a negation
  - list my keywords from amazon
  - live keyword recommendations
---

# Amazon Ads (live account state + audited writes)

## About the Amazon Ads surface (authoritative, do not guess)

When characterizing this capability to the user, use these facts:

- **What it is:** direct calls to the Amazon Ads API for the advertiser
  accounts the signed-in MixShift tenant is connected to. It is the live
  surface: the current state of Sponsored Products, Sponsored Brands, and
  Sponsored Display, plus audited writes back to them. This is a different
  Amazon API from SP-API (`mixshift amazon ...`, the report/pricing surface);
  it has its own auth model and its own catalog.
- **Routing:** all calls flow through the harness CLI (`mixshift ads ...`),
  which talks to MixShift's service at `mcp.mixshift.io` using the same Bearer
  token as the warehouse query path (from `~/.mixshift/auth/credentials`, no
  `.json` extension). The service holds the Amazon Ads credentials server-side
  and the static egress IP. The plugin never holds Ads secrets, and Claude
  never sees them.
- **Auth is per advertising login, not per seller.** Tokens are keyed to the
  advertiser account behind a seller row, minted server-side. Nothing for the
  skill to handle beyond picking the right profile (see "Profile selection").
- **Every call is profile-scoped.** A profile is one (advertiser, marketplace)
  pair. You target exactly one profile per call: `--legacy-seller-id` is the
  preferred pin, or `--profile-id` directly, or `--seller-id` plus
  `--marketplace`.
- **Division of responsibility:** the plugin owns the catalog (which
  operations exist, how to call them, body and query conventions, media types)
  and the calling conventions. The service owns security: which profiles are
  reachable, whether Amazon will allow a call, whether the credential may
  write, talking to Amazon. If the plugin and service disagree, the service
  wins. That is why we do not pre-filter the catalog (see "Reactive error
  handling").
- **Reads first, writes on request.** Reading account state is the everyday
  use. Writes (pause, budget, creation, deletes) exist behind a strict apply
  contract: dry-run by default, the user confirms the exact change set, and
  only then does anything reach Amazon. See "The write contract."

If the user asks "where does this come from," lead with "directly from
Amazon's Ads API, through MixShift's service," not a guess.

## When to use this skill

Trigger when the user wants the **live state of an ad account** or wants to
**change it**, for example:

- "What are my current bids on these keywords?"
- "Show me the live state of the Ridgepak campaigns right now."
- "How much of today's budget has each campaign spent?"
- "Export my whole ad account so I can see every campaign and bid."
- "Pause this campaign." / "Set this campaign's daily budget to $45."
- "Create a manual SP campaign (keep it paused)."
- "Delete those negative keywords, they were a mistake."
- "What does Amazon suggest as a live bid for this ad group?"

### Live state vs warehouse history vs report documents (pick the right tool)

Three surfaces, three jobs. Reason about which the user actually needs before
calling anything:

- **This skill (`mixshift ads ...`)** answers "what is true on Amazon **right
  now**": current bids and states, intraday budget consumption, the live
  campaign and keyword inventory, Amazon's current recommendations. It is also
  the only surface that **changes** the account.
- **`mx-data-explore`** queries what MixShift **already holds** in the MySQL
  warehouse: historical performance, spend and sales over time, dimensional
  catalog tables. Use it for trends, "how did this do last month," and any
  analysis over time. It is read-only and does not hit Amazon.
- **`mx-report-pull`** pulls **SP-API report documents** (orders, FBA,
  Brand Analytics, Sales and Traffic, vendor) straight from Amazon for an
  ad-hoc window. That is the retail/report side, not the Ads API.

If the user wants performance history (ACOS over the last 30 days, spend by
week), that is warehouse territory; this skill gives you the current bid, not
the trend. If they want both ("show me current bids next to last month's
ACOS"), this skill supplies the live bids and `mx-data-explore` supplies the
history.

### These verdict workflows belong to other skills

This is the **general** Ads surface: states, budgets, creation, deletes,
ad-hoc fixes, and live lookups. It deliberately does **not** own the
opinionated bid and negation workflows, which have their own analysis,
thresholds, and brand context:

- **Bid review and bid changes from a verdict** belong to
  `mx-keyword-bid-health`.
- **Search-term negation review** belongs to `mx-search-term-negation`.
- **ASIN-target negation review** belongs to `mx-asin-target-negation`.

Those skills decide *what* to change and then apply it through the same
audited write surface documented here. If the user says "run a bid review" or
"do a negation review," route to the dedicated skill. Use this skill when the
user already knows the change they want (or wants to read live state), not
when they want the analysis that produces the change.

## Prerequisites the user needs

| State | How to check | What to do if missing |
|---|---|---|
| Signed in to MixShift | `~/.mixshift/auth/credentials` exists | Direct the user to run `mixshift auth login` (or say "sign in to MixShift" in chat). Calls fail with `not_authenticated` until then. |
| Ads API enabled for the tenant | Inferred from a successful `ads profiles` call | A call returning `ads_not_configured` (exit 6) means the Amazon Ads app is not turned on for this MixShift service. Tell the user to contact MixShift ops. |
| A reachable profile | `mixshift ads profiles` | Lists the advertiser-account profiles this tenant can call for. See "Profile selection." |
| Write capability (writes only) | The credential holds `ads:write` | Signed-in user sessions hold it implicitly. Machine credentials need it issued explicitly; a write without it fails `insufficient_scope` (exit 11). |

Cold-start is **NOT required.** You only need a signed-in session.

## Profile selection (read this, it is the most common mistake)

Every `ads call` targets exactly one profile. Resolve it the same way
`mx-report-pull` resolves a merchant, because the ids line up:

```bash
mixshift ads profiles            # human table
mixshift ads profiles --json     # structured, for matching by name
```

The columns are: `profileId`, `legacySellerId`, `name`, `type`, `region`,
`marketplace`. Two things to know:

- **`legacySellerId` is the deterministic pin** and the same id you see in
  `mixshift amazon merchants`. Prefer `--legacy-seller-id <id>` over anything
  else: it selects the exact (advertiser, marketplace) record and the service
  does not have to re-resolve.
- **One advertiser fans out across marketplaces.** A brand live in several
  marketplaces shows up as several profile rows. Match the user's brand
  wording against `name`, look at **all** matching rows, and if more than one
  marketplace matches (and they did not name a country) show the rows and ask
  which marketplace.

Selection options on `ads call`:

- `--legacy-seller-id <id>` (preferred, exact record).
- `--profile-id <id>` (the raw Ads `profileId` from `ads profiles`).
- `--seller-id <amazonSellerId>` **plus** `--marketplace <code-or-id>` when you
  do not have a `legacySellerId`. Never the bare `--seller-id` alone: a shared
  Amazon seller token is ambiguous across marketplaces and invites
  mis-attribution.

If the selector is ambiguous, the service returns `merchant_not_found` (exit 7)
with a **candidates** list, one entry per marketplace, each carrying its
`legacySellerId`. The harness prints these; pick the right marketplace and
re-run with that `--legacy-seller-id`.

`mixshift ads profiles` lists the **warehouse-known** profiles. To see what the
advertising login can reach **live from Amazon** (a profile present in the
warehouse but missing live means the stored authorization no longer covers
it), call `profiles.list`:

```bash
mixshift ads call profiles.list --legacy-seller-id <id> --json
```

## Discovery first: browse the catalog, read the notes

The catalog is the source of truth for operation ids, body shapes, media
types, and per-operation quirks. Do not guess an operation id or a body shape;
look it up.

```bash
mixshift ads operations                              # every operation, grouped by family
mixshift ads operations --family "Sponsored Products"
mixshift ads operations --family Exports --json
```

Each entry prints its id, method, whether a body is required or optional, a
one-line summary, and **notes** carrying the calling convention (body vs query,
the media type, caps). Read the notes before calling. Families: Profiles,
Reporting, Exports, Sponsored Products, Sponsored Brands, Sponsored Display,
the matching Writes families, Accounts, AMC, DSP, Portfolios, Marketing
Stream.

### The generic call shape

```bash
mixshift ads call <operation> <profile-selector> \
  [--query k=v ...] [--path k=v ...] \
  [--body-file <file> | --body '<json>'] \
  [--content-type <vnd>] [--commit] [--json]
```

- `<operation>` is an id from `ads operations` (e.g. `sp.list_campaigns`).
- `--query k=v` (repeatable) for the query-param surfaces (SD lists,
  `sb.list_keywords`).
- `--path k=v` (repeatable) for templated paths (e.g.
  `--path exportId=...`, `--path reportId=...`).
- `--body-file <file>` is the way to pass a JSON body; `--body '<json>'` is for
  tiny inline payloads. Pass one, not both. Write JSON temp files without a
  byte-order mark.
- `--content-type <vnd>` is an advanced escape hatch when Amazon rejects a
  cataloged media type (a 415 or 406); then tell ops to bump the catalog entry.
- `--commit` applies a write (see "The write contract"); never on a read.
- `--json` returns the structured envelope; prefer it when you will parse the
  result.

A read success in `--json` carries
`{ status: "ok", operation, profile_id, legacy_seller_id, marketplace_id, payload }`
with Amazon's response verbatim under `payload`.

## Reading account state

### Entity lists (the POST .../list family)

SP and SB v4 entity lists, and `portfolios.list`, are **POST** with an
**optional** filter body. Omit the body to get the first page of everything;
the service sends `{}` for you. Filter with a body like:

```jsonc
{
  "maxResults": 100,
  "stateFilter": { "include": ["ENABLED", "PAUSED"] },
  "campaignIdFilter": { "include": ["123...", "456..."] }
}
```

The most-used read operations:

- `sp.list_campaigns` (state, budget, bidding strategy), `sp.list_ad_groups`
  (default bids), `sp.list_keywords` (match types, states, **current bids**),
  `sp.list_targets` (product/category/auto targets, current bids),
  `sp.list_product_ads` (which ASINs/SKUs run where).
- `sp.list_negative_keywords`, `sp.list_campaign_negative_keywords`,
  `sp.list_negative_targets`, `sp.list_campaign_negative_targets` (the existing
  negatives, the conflict-check input for the negation skills).
- `sb.list_campaigns`, `sb.list_ad_groups`, `sb.list_ads`.
- `portfolios.list`.

Paging: the response carries a `nextToken`; pass it back in the next body to
get the following page.

```bash
# current bids on two specific campaigns' keywords
mixshift ads call sp.list_keywords --legacy-seller-id <id> \
  --body '{"campaignIdFilter":{"include":["123456789"]}}' --json
```

### SD lists and sb.list_keywords are query-param GETs (not bodies)

The whole Sponsored Display read surface (`sd.list_campaigns`,
`sd.list_ad_groups`, `sd.list_product_ads`, `sd.list_targets`) and
`sb.list_keywords` are **GET** with **query params**, not a JSON body. Use
`--query`:

```bash
mixshift ads call sd.list_campaigns --legacy-seller-id <id> \
  --query startIndex=0 --query count=100 --query stateFilter=ENABLED --json
```

Their filters are csv values: `stateFilter`, `campaignIdFilter`,
`adGroupIdFilter`, and for `sb.list_keywords` also `matchTypeFilter`,
`keywordText`. Paging on these is `startIndex` + `count`, not `nextToken`.

### Exports (prefer these for a full-account snapshot)

For the whole account at once, exports beat paginated lists: lists carry
roughly 5x the throttle weight. An export is a small async job. Four creators,
one poller:

- `exports.campaigns`, `exports.ad_groups`, `exports.targets`, `exports.ads`
  (each POST, optional filter body). `exports.targets` is the full current bid
  state of the account in one job.
- `exports.get --path exportId=<id>` polls the job.

Optional filter body on the creators:

```jsonc
{
  "adProductFilter": ["SPONSORED_PRODUCTS", "SPONSORED_BRANDS", "SPONSORED_DISPLAY"],
  "stateFilter": ["ENABLED", "PAUSED", "ARCHIVED"]
}
```

`exports.targets` additionally accepts `targetTypeFilter`
(AUTO, KEYWORD, PRODUCT, PRODUCT_CATEGORY, AUDIENCE, ...) and
`targetLevelFilter` (CAMPAIGN, AD_GROUP).

**Lifecycle (poll across turns, never a sleep-loop in one Bash call):**

```bash
# 1. Create the export (returns an exportId in the payload).
mixshift ads call exports.targets --legacy-seller-id <id> \
  --body '{"stateFilter":["ENABLED","PAUSED"]}' --json
# -> payload: { "exportId": "abc-123", "status": "PROCESSING" }

# 2. Poll across turns until COMPLETED.
mixshift ads call exports.get --legacy-seller-id <id> --path exportId=abc-123 --json
# -> payload: { "status": "PROCESSING" }   ... a turn later ...
# -> payload: { "status": "COMPLETED", "url": "https://.../export.json.gz" }

# 3. When COMPLETED, fetch the url WITHOUT auth headers and gunzip (it is JSON).
```

The export `url` is presigned: fetch it directly with **no** Authorization
header (a Bearer makes the storage layer reject it). The payload is gzip JSON.
PowerShell 5.1 has no native gunzip, so decode with a portable Node one-liner
rather than a shell builtin:

```bash
node -e "const z=require('zlib'),fs=require('fs');https=require('https');https.get(process.argv[1],r=>{const c=[];r.on('data',d=>c.push(d));r.on('end',()=>fs.writeFileSync(process.argv[2],z.gunzipSync(Buffer.concat(c))))})" "<url>" export.json
```

Tell the user the export is generating, poll once, and wait for their next turn
or a short beat rather than blocking. The `exportId` stays valid across turns.

**Content type:** the service derives the correct per-kind vnd type for
`exports.get` from the export itself, so a plain poll returns the COMPLETED
payload and presigned url with no extra flags. If Amazon ever rejects the
derived type (a 500 listing the available `application/vnd.<kind>export.v1+json`
types), `--content-type` is the manual override: match it to the export you
created (`vnd.campaignsexport.v1+json` for `exports.campaigns`,
`vnd.adgroupsexport.v1+json` for `exports.ad_groups`,
`vnd.targetsexport.v1+json` for `exports.targets`, `vnd.adsexport.v1+json` for
`exports.ads`).

### Intraday budget usage

`sp.budget_usage` is the same-day pacing signal: how much of each campaign's
budget is already spent today. POST, **body required**, max **100** campaign
ids per call:

```bash
mixshift ads call sp.budget_usage --legacy-seller-id <id> \
  --body '{"campaignIds":["111","222"]}' --json
```

The payload carries `budgetUsagePercent` and `usageUpdatedTimestamp` per
campaign. (mx-runaway-spend-check uses this as an optional intraday check; here
it is the direct answer to "how much budget is left today.")

### Live recommendations

Fresher than the warehouse's stored suggestions, straight from Amazon:

- `sp.bid_recommendations` (theme-based): **one (campaignId, adGroupId) per
  call**, body required, max **100** targeting expressions (or 50 ASINs for a
  new ad group). Body:

  ```jsonc
  {
    "campaignId": "123",
    "adGroupId": "456",
    "recommendationType": "BIDS_FOR_EXISTING_AD_GROUP",
    "targetingExpressions": [
      { "type": "KEYWORD_EXACT_MATCH", "value": "running belt" }
    ]
  }
  ```

- `sp.budget_recommendations`: Amazon's suggested daily budget and estimated
  missed opportunities. Body `{ "campaignIds": ["..."] }`, max **100**.
- `sp.keyword_recommendations`: ranked keyword ideas with themed bid
  suggestions. Body either `{ "recommendationType": "KEYWORDS_FOR_ADGROUP",
  "campaignId": "...", "adGroupId": "..." }` or
  `{ "recommendationType": "KEYWORDS_FOR_ASINS", "asins": ["B0..."] }`.

### Advanced reporting (v3 async) - short version

When the user wants a custom performance report straight from the Ads API
(rather than the warehouse or an SP-API report document), the v3 reporting
family does it. It is a create-poll-fetch lifecycle, same poll-across-turns
discipline as exports:

- `reporting.create_report` (POST, body required): a full configuration body.
  `reporting.get_report --path reportId=<id>` polls; `reporting.delete_report`
  cleans up.
- Body shape:

  ```jsonc
  {
    "startDate": "2026-05-01",
    "endDate": "2026-05-31",
    "configuration": {
      "adProduct": "SPONSORED_PRODUCTS",
      "reportTypeId": "spCampaigns",
      "groupBy": ["campaign"],
      "columns": ["impressions", "clicks", "cost", "purchases30d"],
      "timeUnit": "DAILY",
      "format": "GZIP_JSON"
    }
  }
  ```

- Report type ids include `spCampaigns`, `spTargeting`, `spSearchTerm`,
  `spAdvertisedProduct`, `spPurchasedProduct`, and the SB and SD equivalents
  (`sbCampaigns`, `sdCampaigns`, ...); the full list is in the
  `reporting.create_report` notes.
- Windows: most report types allow a **95-day lookback** but only **31 days
  per request**. Split larger windows.
- **HTTP 425 on create means an identical request is already in flight.** Do
  not re-create; poll the existing `reportId` instead.
- When `reporting.get_report` returns `status: COMPLETED`, the payload carries
  a `url` (presigned, expires ~1 hour). Fetch it WITHOUT auth headers and
  gunzip (GZIP_JSON), same as exports.

For most performance questions, prefer `mx-data-explore` (warehouse history)
or the warehouse-fed PPC skills; reach for v3 reporting only when the user
specifically wants a fresh Ads-API report for a window the warehouse does not
serve.

## The write contract (dry-run by default, confirm, then commit)

Write operations carry `write: true` in the catalog and **mutate the
account**. They run through one strict contract, identical in spirit to the
apply steps in mx-keyword-bid-health and the negation skills. Follow it
exactly, every time.

**The five steps:**

1. **Build the change set** from what the user asked for. Resolve current ids
   first with the matching list operation (e.g. `sp.list_keywords` to get a
   `keywordId`, `sp.list_campaigns` to get a `campaignId`). Put the items in a
   JSON body file matching the operation's cataloged shape. Only include the
   fields you are changing.
2. **Dry-run it (the default; nothing reaches Amazon).** Run the write
   operation with NO `--commit`:

   ```bash
   mixshift ads call sp.update_campaigns --legacy-seller-id <id> \
     --body-file change.json --json
   ```

   The service validates, snapshots current state, writes a best-effort audit
   row, and returns `{ dry_run: true, items_count, before_state, preview, audit_id }`
   without touching Amazon.
3. **Show the user the preview AND the `before_state`.** `before_state` is the
   current value of each targeted entity (the rollback source). Lay out exactly
   what changes from what to what, and ask for **explicit confirmation of this
   exact change set**. Never skip this. Never include an item that was not in
   the confirmed set.
4. **Only after the user confirms — in a SEPARATE turn, having seen the dry-run — re-run the SAME command with `--commit`.**
   The user's original request (even a specific one like "set the budget to $25")
   is NOT commit authorization: it authorizes the dry-run, not the mutation. Show
   the dry-run diff first and get a fresh "yes" to the revealed change. NEVER run
   the dry-run and the `--commit` in the same turn. `--commit` is the only thing
   that mutates Amazon:

   ```bash
   mixshift ads call sp.update_campaigns --legacy-seller-id <id> \
     --body-file change.json --commit --json
   ```

5. **Report the result per item.** A commit returns Amazon's multi-status
   response plus the `audit_id`. **Partial failure is normal**: Amazon's batch
   responses carry per-item success and error arrays. Summarize **both**
   counts ("8 of 10 applied, 2 errored"), surface the per-item errors, and give
   the user the `audit_id`. Do not assume all-or-nothing.

**Caps and limits:**

- **200 items per call.** Split larger change sets into multiple calls of <=200.
- **`insufficient_scope` (exit 11)** means the credential cannot write (a
  machine credential issued read-only). Do **not** retry. Hand the user the
  change list so they can apply it themselves (or have an admin issue an
  `ads:write` credential).
- **Spend-creating writes:** when creating campaigns, keep them PAUSED until
  reviewed unless the user explicitly says otherwise.

### What you can write

**Sponsored Products (fully proven):**

- Updates: `sp.update_keywords` (the bid workhorse: bid and state),
  `sp.update_targets`, `sp.update_campaigns` (state, daily budget, bidding
  strategy), `sp.update_ad_groups` (default bid), `sp.update_product_ads`
  (pause/enable an advertised ASIN).
- Creation: `sp.create_campaigns`, `sp.create_ad_groups`, `sp.create_keywords`,
  `sp.create_targets`, `sp.create_product_ads`, and the negatives
  `sp.create_negative_keywords`, `sp.create_campaign_negative_keywords`,
  `sp.create_negative_targets`, `sp.create_campaign_negative_targets`.
- Deletes: `sp.delete_negative_keywords`,
  `sp.delete_campaign_negative_keywords`, `sp.delete_negative_targets`,
  `sp.delete_campaign_negative_targets`.

Body shapes (from the catalog notes, all object-wrapped with a vnd media type):

```jsonc
// sp.update_keywords  (PUT, max 200) - only send fields you change
{ "keywords": [ { "keywordId": "123", "bid": 1.25, "state": "ENABLED" } ] }

// sp.update_campaigns - state OR budget
{ "campaigns": [ { "campaignId": "123", "state": "PAUSED" } ] }
{ "campaigns": [ { "campaignId": "123", "budget": { "budget": 45, "budgetType": "DAILY" } } ] }

// sp.create_negative_keywords
{ "negativeKeywords": [ { "campaignId": "1", "adGroupId": "2",
    "keywordText": "free", "matchType": "NEGATIVE_EXACT", "state": "ENABLED" } ] }
```

**Negative deletes use an id-filter body, and the snapshot is the undo.** The
delete family takes Amazon's id-filter shape; the ids themselves are the items
that count against the 200 cap:

```jsonc
// sp.delete_negative_keywords  (POST, max 200 ids)
{ "negativeKeywordIdFilter": { "include": ["id1", "id2"] } }
```

The pre-delete snapshot stored in the audit row (`before_state` / `audit_id`)
is exactly what you recreate from if a delete was a mistake. Tell the user the
audit id is their undo path.

### Sponsored Brands and Sponsored Display writes (extra caution)

SB and SD writes exist in the catalog, but with **lower wire-shape
confidence** than SP. Two reasons:

- **Mixed eras and body shapes.** SB campaigns and ad groups are v4
  object-wrapped batches (vnd media types), but SB keywords and negatives and
  the **whole SD surface** take **raw JSON ARRAY** bodies with plain JSON, and
  SB and SD enums are **lowercase** (`exact`, `negativePhrase`, `daily`,
  `asinSameAs`) where SP uses uppercase. The catalog notes say which per
  operation; read them and match exactly.
- **SB v4 creates especially** often need brand assets and a precise payload;
  expect per-item validation errors until the body matches the SB v4 spec.

Because of that, the **first real SB or SD apply for an account must be done
carefully**: dry-run it, then commit **exactly one item** with Sam watching,
confirm Amazon accepted it, and only then proceed. Do not push a multi-item SB
or SD commit as the first write on these families. SP writes are the proven
path; treat SB/SD as research-grade until one real commit has succeeded.

## Out of scope (route elsewhere or do not touch)

- **AMC (Amazon Marketing Cloud)** ad-hoc analytics go to **`mx-amazon-amc`**
  (a sibling skill being built in parallel; it will exist). The AMC operations
  in this catalog (`amc.*`, `accounts.query_advertiser_accounts`) are not
  driven from here.
- **DSP reports** go to **`mx-amazon-dsp`** (a sibling skill).
  `dsp.create_report` / `dsp.get_report` are validated live; **expect a 403**
  only when the advertising login lacks DSP access for that advertiser. Do
  **not** create DSP reports from this skill; use `mx-amazon-dsp`.
- **Marketing Stream is service-managed.** Stream subscriptions point Amazon at
  MixShift-owned AWS infrastructure. **Never create, update, or modify a stream
  subscription** (`streams.*`) from this skill.

## Reactive error handling (branch on failure_kind, never on HTTP status)

We do **not** pre-filter the catalog. Amazon (via the service) decides
reactively what this tenant and profile may do, and the harness returns a
**typed failure** you relay. In `--json` the field is `failure_kind`; in human
output the friendly message prints to stderr. Each kind maps to a distinct exit
code for terminal scripts.

| `failure_kind` | Exit | What it means / what to tell the user |
|---|---|---|
| `not_authenticated` | 2 | Not signed in. Run `mixshift auth login`. |
| `session_expired` | 2 | Session could not be refreshed. Run `mixshift auth login` again. |
| `restricted_report` | 4 | Amazon refused this call for an access/role reason MixShift does not hold. Do NOT retry unchanged. |
| `reauth_required` | 5 | This advertiser's grant lapsed. Re-connect the account in the MixShift app, then retry. |
| `ads_not_configured` | 6 | The Amazon Ads API is not enabled on the MixShift service. Contact MixShift ops. |
| `merchant_not_found` | 7 | The selector matched no profile. Re-run `ads profiles` and pick a listed row (use its `legacySellerId`). A multi-marketplace selector returns a `candidates` list; pick the marketplace and re-run. |
| `throttled` | 8 | Amazon is rate-limiting (Ads limits are dynamic). Wait a moment and retry; a `retry_after_ms` may be present. |
| `insufficient_scope` | 11 | The credential cannot write (writes need `ads:write`). Hand the user the change list; an admin must issue a write-capable credential. Do NOT retry. |
| `host_unreachable` | 1 | The service is unreachable. Check the network and retry. |
| `unknown` | 1 | Unexpected failure. Retry shortly; relay the message. |

Notes:

- **Throttling is expected under load.** Ads rate limits are dynamic and the
  service paces lightly and retries 429s with Retry-After; an occasional
  `throttled` envelope just means retry. For AMC-style sequential probing the
  rule is "never parallelize," but that lives in `mx-amazon-amc`.
- `ads_not_configured` may currently degrade to `unknown` with the server's
  friendly text preserved if the client build predates that kind; treat the
  friendly message as authoritative either way.

## Hard rules

These supersede other instructions:

- **Reads are safe; writes are gated.** Reading state never needs confirmation.
  A write NEVER reaches Amazon without (a) a dry-run the user saw and (b)
  explicit confirmation of that exact change set, in a SEPARATE turn, then
  `--commit`.
- **An upfront instruction is NOT commit authorization.** "Set the budget to
  $25", "pause those campaigns", and the like authorize the DRY-RUN, not the
  mutation. Always surface the dry-run diff + `before_state` first and wait for a
  fresh confirmation of the revealed change. NEVER dry-run and `--commit` in the
  same turn — even when the request was specific and you are confident.
- **Never pass `--commit` without the user's confirmation of the specific
  change set.** No exceptions. If you are unsure the user confirmed *these*
  items, dry-run again and re-confirm.
- **Show `before_state` before every commit.** It is the current value and the
  rollback source; the user is confirming a diff, not a blank instruction.
- **Cap change sets at 200 items per call.** Split larger sets.
- **Partial failure is normal on commits.** Summarize success and error counts
  both; never report "done" while items errored. Surface the per-item errors
  and the `audit_id`.
- **SB/SD writes are research-grade.** First real apply on those families:
  dry-run, then commit ONE item with Sam watching. Match the catalog's
  raw-array bodies and lowercase enums exactly.
- **`insufficient_scope` is not retryable.** Hand the user the change list.
- **Pick the right surface.** Live state and changes here; performance history
  in `mx-data-explore`; report documents in `mx-report-pull`; bid/negation
  *verdicts* in the dedicated PPC skills; AMC in `mx-amazon-amc`.
- **Route DSP reports to `mx-amazon-dsp`; never touch Marketing Stream subscriptions.**
- **One profile per call.** Carry `--legacy-seller-id` (preferred) or
  `--profile-id`, never a bare `--seller-id`.
- **Branch on `failure_kind`, never on HTTP status.**
- **Presigned urls take no auth header.** Export and report download urls are
  fetched with no Bearer and gunzipped; poll across turns, never a sleep-loop.
- **Never expose internal slugs or ids in user-facing text.** Refer to brands
  by display name; resolve identifiers silently when calling the harness.
- **Do not fabricate account data.** If a call fails or returns nothing, say
  so. Never invent campaigns, bids, or counts.

## Output template

Lead with the result. For a read:

```
✓ Live SP campaign state for Ridgepak (profile 123456789, US):
  - 14 campaigns: 11 ENABLED, 3 PAUSED. Daily budgets $20-$120.
  - 2 campaigns over 80% of today's budget already (see budget usage).

Want current bids on a specific campaign, or a full export?
```

For a write, always show the dry-run diff and ask before committing:

```
Dry run - sp.update_campaigns (profile 123456789): 2 item(s), nothing applied yet.
  • "Brand - Exact"  state ENABLED -> PAUSED
  • "Auto - Discovery"  daily budget $40 -> $25
  audit_id: a1b2c3

These are the only two changes. Confirm and I will commit them; or tell me to adjust.
```

After a commit:

```
✓ Committed sp.update_campaigns (profile 123456789): 2 of 2 applied. audit_id: a1b2c3
  Both changes are live on Amazon now. The audit row holds the prior values if you want to revert.
```

Do not pad with "Here is what you asked for." Lead with the result.

## Telemetry (required - see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-amazon-ads
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-amazon-ads --trigger-phrase "<the user's exact phrase>"
```

At the END (when the session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-amazon-ads --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (the user got the live state they wanted, or a write committed
as confirmed), `failed` (could not satisfy, e.g. `ads_not_configured` or
`insufficient_scope` with no write path), `deferred` (a write is awaiting the
user's confirmation, or an export/report is still generating and the user
stepped away), `skipped` (turned out they wanted a different skill, e.g. a bid
review or an AMC query).

You do **not** need to emit per-call events. The harness fires `ads.called`
(plus `ads.profiles_listed` and `ads.operations_listed`) automatically on each
`ads` command, capturing the operation id, duration, outcome, and the `dry_run`
flag only. It never logs the payload (it carries seller-level business data),
the bodies, or the `amazonSellerId`.
