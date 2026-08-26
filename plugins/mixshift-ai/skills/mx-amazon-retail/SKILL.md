---
name: mx-amazon-retail
description: >
  Live Amazon SP-API retail lookups, straight from Amazon, for any merchant
  you are authorized for. This is the retail-operations analogue of
  mx-amazon-report: instead of asking Amazon to generate a report document, these
  are single fast request/response operations that answer point-in-time
  questions about your catalog, inventory, orders, finances, listings, and
  fulfillment. The headline use is the title/brand/sales-rank source for ASINs
  that are missing from the warehouse's mws_items (catalog.search_items). Covers
  Catalog Items, Product Fees, FBA Inventory, Sales metrics, Sellers, Finances,
  Orders, Product Pricing offer depth, Listings Items, Data Kiosk (GraphQL),
  Vendor Orders (1P), and Amazon Warehousing & Distribution (AWD). Read-only,
  routes through the bundled harness CLI.
  Does not require brand setup, only that the user has signed in
  (`mixshift auth login`).
metadata:
  version: "0.2.0"
  author: "MixShift"
trigger_phrases:
  - look up an asin
  - catalog lookup
  - get the title for these asins
  - title for an asin
  - brand and sales rank for an asin
  - asins missing from the warehouse
  - live fba inventory
  - how much stock do we have right now
  - estimate amazon fees
  - referral and fba fee estimate
  - order metrics
  - sales metrics for a window
  - search orders
  - look up an order
  - live listing state
  - listing issues
  - is this listing buyable
  - which marketplaces does this seller cover
  - financial transactions
  - settlement groups
  - data kiosk query
  - sales and traffic by graphql
  - seller economics
  - vendor purchase orders
  - call an sp-api operation
  - what sp-api operations can I call
  - awd inventory
  - amazon warehousing and distribution
  - awd stock levels
  - inbound shipments to awd
---

# Amazon Retail Lookups (live SP-API)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


## About this surface (authoritative, do not guess)

When characterizing this capability to the user, use these facts:

- **What it is:** a live, on-demand call to one Amazon Selling Partner API
  (SP-API) read operation, straight from Amazon, for the merchants the
  signed-in MixShift tenant is authorized for. Each operation is a single fast
  request and response: you ask a question (titles for these ASINs, stock for
  these SKUs, metrics for this window) and get Amazon's answer back inline. It
  is a first-class, user-driven capability.
- **The catalog:** 27 cataloged operations across 13 families. Discover them
  with `mixshift amazon operations` and read each operation's `notes` before
  calling: the notes carry the required params, the casing gotchas (several v0
  operations use PascalCase query params), the caps, and the body shapes. Treat
  the `notes` field as the integration contract.
- **Routing:** all calls flow through the harness CLI (`mixshift amazon ...`),
  which talks to MixShift's service at `mcp.mixshift.io` using the same Bearer
  token as the warehouse query path (from `~/.mixshift/auth/credentials`, no
  `.json` extension). The service holds the Amazon SP-API credentials
  server-side and the single static egress IP. The plugin never holds SP-API
  secrets, and Claude never sees them.
- **Division of responsibility:** the plugin owns the catalog (which operations
  exist, how to call and parse them) and the calling conventions. The service
  owns security: which merchants are authorized, which operations Amazon will
  allow, talking to Amazon, marketplaceId injection, pacing, retries, and token
  mint. If the plugin and service disagree, the service wins. That is why we do
  not pre-filter the catalog on guesses about what is restricted (see "Reactive
  error handling" below): Amazon decides reactively and the harness returns a
  typed failure you relay.
- **Read-only:** this catalog holds read operations only. There are no write
  operations here (no listing writes, no feeds, nothing RDT or PII bound).
  There is nothing to commit and no `--commit` flag on this surface. If a user
  wants to change something on Amazon (update a listing, change a bid), that is
  a different surface and is not what this skill does.

If the user asks "where does this data come from," lead with "directly from
Amazon's SP-API, pulled live through MixShift's service," not a guess.

### How this differs from the report and pricing surfaces

The same `mixshift amazon ...` CLI exposes three sibling surfaces. Route to the
right one:

| Surface | Command | Use it for |
|---|---|---|
| **Retail operations (this skill)** | `amazon operations` / `amazon call` | A live point-in-time answer from one read operation: titles, stock, metrics, listing state, order search, finances, Data Kiosk. |
| Report pulls (mx-amazon-report) | `amazon report start/poll/get` | A generated flat-file or JSON report document for a window (orders, FBA fees, settlement, Sales and Traffic, Brand Analytics, vendor). |
| Pricing batches (mx-amazon-report) | `amazon pricing ...` | Featured-offer and competitive-summary batch answers keyed by SKU or ASIN, with async run handles. |

The retail-operations surface and the warehouse also overlap, so reason about
which fits before calling (see "When to use this skill").

## When to use this skill

Trigger when the user wants a **live answer about their Amazon catalog,
inventory, orders, finances, or listings**, pulled straight from Amazon right
now. The clearest and most common case:

### The headline use: titles for ASINs missing from the warehouse

The warehouse table `mws_items` only holds the merchant's **listed** SKUs. When
you have an ASIN that is not in `mws_items` (an unlisted catalog ASIN, a
competitor ASIN, an ASIN surfaced by a Brand Analytics report that has no
matching listing row), the warehouse cannot give you its title, brand, or sales
rank. `catalog.search_items` is the source for exactly that:

```bash
# Titles, brands, and sales ranks for a batch of ASINs (up to 20 per call).
mixshift amazon call catalog.search_items --legacy-seller-id 692 \
  --query identifiers=B0CV4JLCVZ,B0ABC12345,B0DEF67890 \
  --query identifiersType=ASIN \
  --query includedData=summaries,salesRanks \
  --json
```

This is the canonical "I have ASINs the warehouse does not know about, get me
their titles" workflow. Lead with it when a user is staring at bare ASINs.

Other live questions this surface answers:

- "What is the title and brand for these ASINs?" (catalog.search_items)
- "What does our FBA stock look like right now?" (fba_inventory)
- "What would referral plus FBA fees be on these ASINs at this price?" (fees)
- "How many units and how much in sales did we do last week, by day?" (sales)
- "Which marketplaces does this seller's token actually cover?" (sellers)
- "Pull our itemized financial transactions since this date." (finances)
- "Search orders updated since yesterday." (orders, non-PII)
- "What is the live state of this listing: price, buyability, issues?" (listings)
- "Run a Data Kiosk sales-and-traffic or seller-economics query." (data_kiosk)
- "Show the purchase orders Amazon placed with this vendor." (vendor_orders, 1P)

### Warehouse-first: check, reason, and ask (courtesy, not a gate)

`mx-data-explore` queries data MixShift **already holds** in the MySQL
warehouse. This skill pulls **live data from Amazon**. Several of these
operations overlap warehouse tables that are refreshed on a recurring basis
(FBA inventory snapshots, order and sales aggregates, listing state), so for
routine requests the data may **already be in the warehouse** and a warehouse
read is faster.

Before calling a live operation that plausibly overlaps the warehouse, work
through the same courtesy steps mx-amazon-report uses:

1. **Reason about coverage.** Does the warehouse plausibly hold what the user
   wants, at the grain and freshness they need? The warehouse is a transformed
   layer, not a raw mirror: columns are renamed and derived, grain can differ,
   and one table is often built from several sources. Coverage is a judgment
   call, not a lookup.
2. **Check when warranted.** If your hypothesis is "the warehouse probably has
   this," use `mx-data-explore` to confirm a relevant table is present and
   fresh for the window asked. Confirm rather than assume.
3. **Ask the user which they want.** When the warehouse plausibly covers the
   request, surface the choice plainly, then let them decide.
4. **Use judgment on necessity.** Live is the right call when the user needs
   *now* (current buyability, current stock, this exact moment), a grain or
   identifier set the warehouse does not keep, or an ASIN the warehouse does
   not hold at all (the headline `mws_items` gap, where there is nothing to
   check). In those cases go straight to Amazon.

This is an **explicit step and a courtesy, NOT a hard gate.** If the user wants
the live answer, call it. Never refuse a requested call because the warehouse
"probably has it." The headline catalog lookup almost never has a warehouse
answer (that is the whole point), so it usually skips this dance entirely.

**Do NOT use this skill** when the user wants an opinionated analysis (daily
health check, bid recommendations, monthly performance report) or a generated
report document for a window (that is mx-amazon-report). This skill returns raw
live operation results; it does not interpret them for you beyond surfacing
them cleanly.

## Prerequisites the user needs

| State | How to check | What to do if missing |
|---|---|---|
| Signed in to MixShift | `~/.mixshift/auth/credentials` exists | Direct the user to run `mixshift auth login` (or say "sign in to MixShift" in chat). Calls fail with `not_authenticated` until then. |
| SP-API enabled for the tenant | Inferred from a successful `amazon merchants` call | If a call returns `spapi_not_configured`, live SP-API operations are not turned on for this MixShift account yet. Tell the user to contact MixShift ops. |
| A target merchant | `mixshift amazon merchants` | Lists the seller/vendor accounts this tenant can call for. See merchant selection below. |

Brand setup is **not required.** You only need a signed-in session. A specific
merchant identity (from `amazon merchants`) is needed only when the tenant has
more than one merchant or seller row; if there is exactly one, the service
infers it and you can omit the merchant selectors entirely.

## Merchant selection (read this, it is the most common mistake)

Every `amazon call` takes optional merchant selectors that resolve which Amazon
seller/vendor and marketplace the operation runs against. The selector value is
the **Amazon seller/vendor ID** (Amazon's merchant token, e.g.
`A2EUQ1WTGCTBG2`), surfaced by `mixshift amazon merchants`. This is **NOT** the
numeric warehouse `SellerID` you see in `mx-data-explore` or
`mixshift brand list`. They are different identifiers for different systems.

The selectors are **optional when the tenant has exactly one merchant** (the
service infers it). They are **required when the tenant has more than one**:
omit them and the call fails with `merchant_not_found`. When in doubt, resolve
the merchant explicitly so the call targets the seller and marketplace the user
meant.

**Always resolve the merchant through `mixshift amazon merchants`:**

```bash
mixshift amazon merchants            # human table
mixshift amazon merchants --json     # structured, for matching by name
```

The columns are: `amazonSellerId`, `legacySellerId`, `name`, `type`
(Seller/Vendor), `region`, `marketplace`, `authorized`, and `cron`. Three
things to know, including a fact that is **new on this surface**:

- **The list now shows EVERY marketplace row of an authorized seller**, not
  just the rows activated for MixShift's scheduled pulls. SP-API tokens are
  region-scoped, so a seller authorized in a region exposes one row per
  marketplace it participates in (US, CA, MX, BR, and so on), and every one of
  those rows is callable on demand. Expect more rows per seller than you might
  from the scheduled-pull view.
- **`cronActive` (the `cron` column) is a display and filter signal ONLY, NOT
  an auth signal.** It tells you whether the row is activated for MixShift's
  recurring scheduled pulls. A row with `cron: no` is still fully callable here.
  Do not treat `cronActive` as "can I call this": it cannot gate a live call.
  If you ever need just the scheduled-pull rows, filter on `cronActive === true`
  client-side, but for ad-hoc live calls ignore it.
- **`authorized` is the reauth flag.** `authorized: no` means the merchant's
  Amazon access grant has lapsed and a call may fail with `reauth_required`.
  Treat it as the warn-before-you-call signal. It is unchanged from the report
  surface.

To call for a brand the user names:

1. Run `amazon merchants --json`.
2. Match the user's brand wording against the `name` field (case-insensitive,
   allow partial / fuzzy matches).
3. Look at **all** rows that match. If the same `amazonSellerId` appears on more
   than one row, that is the multi-marketplace fan-out. Pick the row for the
   marketplace the user wants; if it is not obvious (and they did not name a
   country), show the matching rows and ask which marketplace.
4. From the chosen row, carry identity into the call. The cleanest pin is the
   single deterministic key: pass `--legacy-seller-id <legacySellerId>` (always
   present, and the service treats it as the authoritative record id).
   `--legacy-seller-id` alone uniquely identifies the row. If for some reason
   you are working from a row without a `legacySellerId`, fall back to
   `--seller-id <amazonSellerId>` **plus** `--marketplace <code-or-id>`
   together; never the seller token by itself.
5. If the chosen row reports `authorized: no`, warn the user before calling: the
   SP-API grant for that merchant may have lapsed and the call can fail with
   `reauth_required` until it is re-connected in the MixShift app.

If you pass only a shared `--seller-id` and it is ambiguous, the service returns
`merchant_not_found` with a **candidates** list (one entry per marketplace, each
with its `legacySellerId`). The harness prints these as ready-to-run hints; pick
the right marketplace and re-run with that `--legacy-seller-id`.

**Hard rule: never downgrade a specific row to the bare shared key.** Once you
have identified the marketplace row the user meant, send its
`--legacy-seller-id` (or, lacking that, `--seller-id` together with
`--marketplace`). The seller token by itself is ambiguous and invites
mis-attribution.

The service injects the resolved `marketplaceId` into whichever query param the
operation expects, so you usually do not pass it yourself; `--marketplace`
(country code like `US`/`UK` or a raw marketplaceId) is only needed to
disambiguate a multi-marketplace seller when you are not using
`--legacy-seller-id`.

If no merchant matches, run `amazon merchants` and show the user the list rather
than guessing an ID.

## Available harness commands

All commands accept `--json` for structured output and `--data-dir` to override
the data directory.

```
mixshift amazon merchants

mixshift amazon operations [--family <name>]

mixshift amazon call <operation>
    [--seller-id <amazonSellerId>]
    [--legacy-seller-id <id>]
    [--marketplace <code-or-id>]
    [--query <key=value> ...]      # repeatable; csv values pass through
    [--path  <key=value> ...]      # repeatable; templated-path placeholders
    [--body-file <file> | --body <json>]   # body-required operations only
```

- `amazon operations` lists the catalog grouped by family. `--family` filters
  to one family (match the family name exactly, e.g. `--family "Data Kiosk"`,
  `--family "Catalog Items"`). **Read the `notes` line for an operation before
  you call it** - it is the per-operation contract.
- `amazon call <operation>` executes one operation by its catalog `id` (e.g.
  `catalog.search_items`). Pass query params with repeatable `--query k=v`
  (array values are comma-separated and pass straight through to Amazon's csv
  form); pass path placeholders with repeatable `--path k=v` (e.g.
  `--path asin=B0CV4JLCVZ`); pass a JSON request body with `--body-file <file>`
  (preferred) or `--body <json>` (small inline payloads), and only for
  operations the catalog marks `body required`.
- `--query` values that the catalog notes spell in **PascalCase** must be
  passed in PascalCase. The CLI passes param names through verbatim; it does not
  normalize casing. Copy the exact casing from the operation notes.
- On success in `--json`, the envelope is
  `{ status: "ok", operation, amazon_seller_id, legacy_seller_id, marketplace_id, payload }`
  where `payload` is **Amazon's response body, verbatim**. In human output the
  payload is pretty-printed to stdout and a one-line confirmation to stderr.

## The 27 operations: a family tour

Run `amazon operations` for the live catalog; this is the map plus the
per-family gotchas that bite. Every operation is read-only.

### Catalog Items (2022-04-01) - titles, brands, ranks

- `catalog.search_items` - look up items by identifier or keyword.
- `catalog.get_item` - fetch one item by ASIN (`--path asin=`).

Gotchas:

- **The title source for ASINs missing from `mws_items`** (the headline use
  above). When the warehouse lacks a title for an ASIN, this is where it comes
  from.
- **`identifiers` is capped at 20 per call** (comma-separated), with
  `identifiersType` one of `ASIN, SKU, UPC, EAN, GTIN, ISBN`. For more than 20,
  page through batches of 20.
- **`identifiersType=SKU` also needs `--query sellerId=<...>`** (the seller's
  own SKUs). ASIN/UPC/EAN/GTIN/ISBN lookups do not.
- Use `--query keywords=<text>` instead of identifiers for a search; paginate
  with `pageToken`, `pageSize` max 20.
- `includedData` is a csv: `summaries, attributes, classifications, dimensions,
  identifiers, images, productTypes, relationships, salesRanks, vendorDetails`.
  Default is `summaries`. Add `salesRanks` when the user wants rank.
- Prefer `catalog.search_items` with `identifiers` over looping
  `catalog.get_item` for bulk lookups (20 per call beats one-at-a-time).

### Product Fees (v0) - referral + FBA fee estimates

- `fees.get_my_fees_estimates` - estimate fees for up to 20 ASINs or SKUs at a
  price point.

Gotchas:

- **Body is a JSON ARRAY (max 20)** of fee-estimate requests, passed via
  `--body-file`. **PascalCase fields**, and `MarketplaceId` lives **inside each
  entry**, not as a query param. Each entry shape:
  `{ FeesEstimateRequest: { MarketplaceId, IsAmazonFulfilled, PriceToEstimateFees: { ListingPrice: { CurrencyCode: "USD", Amount } } }, IdType: "ASIN" | "SellerSKU", IdValue }`.
- The `Identifier` you put on each `FeesEstimateRequest` is any unique string
  you choose; it round-trips in the response so you can match estimates back to
  inputs.
- **Pacing: this operation paces ~2.4s between calls** server-side. Sync, but
  advise the user when estimating hundreds of items in a loop.

### FBA Inventory (v1) - live stock snapshot

- `fba_inventory.get_inventory_summaries` - live fulfillable / inbound /
  reserved / unfulfillable levels per SKU.

Gotchas:

- **This is a snapshot of NOW, not history.** For inventory history use the FBA
  inventory reports via mx-amazon-report. Do not use this to reconstruct a past
  level.
- Pass `--query details=true` for the full per-SKU breakdown (without it you
  get only the top-line counts).
- Optional `--query sellerSkus=<csv,max 50>` or `--query startDateTime=<iso>` to
  scope; paginate with `nextToken`.

### Sales (v1) - units, orders, sales aggregates

- `sales.get_order_metrics` - aggregated order metrics over an interval.

Gotchas:

- **`interval` is required and is two ISO 8601 datetimes joined by `--`** (a
  double hyphen), e.g.
  `--query interval=2026-05-01T00:00:00Z--2026-06-01T00:00:00Z`. The `--`
  joiner is Amazon's contract; do not use a single hyphen or a comma.
- **`granularity` is required**: `Hour, Day, Week, Month, Year, or Total`.
- **For `Day` or coarser, pass `--query granularityTimeZone=<tz>`** (e.g.
  `America/Denver`), or day boundaries land in UTC and the buckets will look
  shifted.
- Optional: `buyerType` (B2B/B2C/All), `fulfillmentNetwork` (MFN/AFN),
  `firstDayOfWeek`, `asin`, `sku`.

### Sellers (v1) - which marketplaces a token covers

- `sellers.get_marketplace_participations` - every marketplace this seller
  participates in, live from Amazon.

Gotchas:

- **No parameters.** Useful to verify which marketplaces a region token actually
  covers before pulling marketplace-scoped data, and to sanity-check the
  `amazon merchants` fan-out against Amazon's own view.

### Finances - itemized transactions and settlement groups

- `finances.list_transactions` (2024-06-19) - itemized financial transactions
  (the **modern** replacement for v0 financial events).
- `finances.list_financial_event_groups` (v0) - settlement groups (the envelope
  rows that settlement reports detail).

Gotchas:

- **`finances.list_transactions` is the modern surface**: `--query postedAfter=`
  is required (ISO 8601); optional `postedBefore`, `marketplaceId`,
  `transactionStatus` (DEFERRED, RELEASED), `nextToken`. No marketplace is
  injected, so **omit `marketplaceId` to get every marketplace in the region**.
- **`finances.list_financial_event_groups` is v0 and uses PascalCase query
  params**: `FinancialEventGroupStartedAfter`, `FinancialEventGroupStartedBefore`,
  `MaxResultsPerPage` (max 100), `NextToken`. The v0 event-LIST operations are
  deprecated, but this group listing survives and pairs with
  `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` pulls.

### Orders - search and fetch orders (non-PII)

- `orders.search_orders` (2026-01-01) - **preferred**; order search with
  `includedData`.
- `orders.get_order` (2026-01-01) - fetch one order by id (`--path orderId=`).
- `orders.get_orders_v0` (v0, **deprecated**) - legacy list; wire-compat only.
- `orders.get_order_items_v0` (v0, **deprecated**) - legacy line items.

Gotchas:

- **Prefer the 2026-01-01 operations.** `orders.get_orders_v0` and
  `orders.get_order_items_v0` are **deprecated by Amazon, removal 2027-03-27**.
  Reach for v0 only for wire-compatibility with existing tooling, never for new
  work.
- **2026-01-01 `orders.search_orders`** needs at least one time filter:
  `createdAfter`, `createdBefore`, or `lastUpdatedAfter` (ISO 8601). Optional:
  `orderStatuses` (csv), `amazonOrderIds` (csv), `maxResultsPerPage`,
  `nextToken`, `includedData`.
- **Non-PII only.** The MixShift app does not hold Amazon's buyer-PII / RDT
  roles, so the default response is the non-PII order data. PII elements of
  `includedData` will be rejected by Amazon as `restricted_report`. Do not ask
  for buyer PII; relay the rejection and offer the non-PII shape if it happens.
- The v0 operations use **PascalCase** query params (`CreatedAfter` or
  `LastUpdatedAfter` required; `CreatedBefore`, `OrderStatuses`,
  `FulfillmentChannels`, `MaxResultsPerPage`, `NextToken`), also non-PII by
  default.

### Product Pricing (v0) - offer depth

- `pricing.get_competitive_pricing` - competitive pricing for up to 20 ASINs or
  SKUs (GET).
- `pricing.get_item_offers_batch` - full offer depth for up to 20 ASINs (POST
  batch).
- `pricing.get_listing_offers_batch` - offer depth for up to 20 of YOUR SKUs,
  including your own offer placement (POST batch).

Gotchas:

- **Pacing: the offer batches restore slowly, ~12s between batch calls**
  server-side. Sync, but for many batches advise the user it will take a while.
- **Max 20 per call** on all three.
- **`pricing.get_competitive_pricing` uses PascalCase query params**:
  `ItemType` (`Asin` | `Sku`) required, plus `Asins` or `Skus` (csv, max 20);
  optional `CustomerType` (Consumer | Business).
- The batch operations take a `--body-file` of
  `{ requests: [ { uri: "/products/pricing/v0/items/{ASIN}/offers", method: "GET", MarketplaceId, ItemCondition: "New", CustomerType? } ] }`
  (max 20 requests; for the listing batch the uri is
  `/products/pricing/v0/listings/{SKU}/offers` and SKUs must be URL-encoded
  inside the uri string). **Each response item carries its own status code** -
  read per-item statuses, do not assume the whole batch succeeded.
- **This complements, it does not replace, mx-amazon-report's pricing batches.**
  The 2022-05-01 featured-offer and competitive-summary batches in
  mx-amazon-report remain the richer surface for offer-winner analysis; these v0
  operations are the raw offer-depth view. If the user wants offer-winner
  answers, route to mx-amazon-report's pricing commands instead.

### Listings Items (2021-08-01) - live listing state

- `listings.get_listings_item` - one listing's live state (`--path sku=`).
- `listings.search_listings_items` - search this seller's listings.

Gotchas:

- **`{sellerId}` auto-fills** from the resolved merchant, so you pass only
  `--path sku=<SKU>` on `get`, and nothing extra on `search`. You do not supply
  the seller id in the path.
- `includedData` csv options: `summaries, attributes, issues, offers,
  fulfillmentAvailability, procurement`. Add `issues` to see listing problems,
  `offers` for live price and buyability.
- `search` optional filters: `identifiers` + `identifiersType`,
  `withStatus` / `withoutStatus` (BUYABLE, DISCOVERABLE), `withIssueSeverity`
  (ERROR, WARNING), `lastUpdatedAfter` / `lastUpdatedBefore`, `sortBy`,
  `sortOrder`, `pageSize` (max 20), `pageToken`.
- **Read-only here.** Listing writes stay in the MixShift platform; this surface
  reads listing state only.

### Data Kiosk (2023-11-15) - GraphQL datasets

- `data_kiosk.create_query` - submit a GraphQL query (POST, body required).
- `data_kiosk.get_query` - poll one query: status plus `dataDocumentId` once
  DONE (`--path queryId=`).
- `data_kiosk.list_queries` - list recent queries.
- `data_kiosk.cancel_query` - cancel an in-flight query (DELETE,
  `--path queryId=`).
- `data_kiosk.get_document` - resolve a document id to a download URL
  (`--path documentId=`).

This is a **three-step, poll-across-turns lifecycle** (see the dedicated
walkthrough below). Gotchas:

- **`create_query` body is `{ query: "<GraphQL document>" }`** via
  `--body-file`. Datasets as of mid-2026:
  `analytics_salesAndTraffic_2024_04_24`, `analytics_economics_2024_03_15`,
  `analytics_vendorAnalytics_2024_09_30`. Explore schemas at
  `sellercentral.amazon.com/datakiosk-schema-explorer`.
- **`get_query` statuses**: `IN_QUEUE, IN_PROGRESS, DONE, FATAL, CANCELLED`.
  Poll until `DONE`. **`DONE` with no `dataDocumentId` means the result set was
  empty** (a successful query that matched nothing) - that is not an error, tell
  the user the query returned no rows. `errorDocumentId` explains a `FATAL`.
- **`get_document` returns a `documentUrl` you must fetch directly WITHOUT an
  Authorization header** (it is a presigned S3 URL and S3 rejects Bearer
  tokens). It **expires in minutes**, so fetch it immediately after resolving
  it. **The content is JSONL** (one JSON object per line), not a single JSON
  document.

### Vendor Orders (v1) - 1P purchase orders

- `vendor_orders.get_purchase_orders` - POs Amazon placed with this vendor.
- `vendor_orders.get_purchase_order` - one PO with line detail
  (`--path purchaseOrderNumber=`).

Gotchas:

- **1P (Vendor) merchants ONLY. Seller (3P) merchants 4xx** on these
  operations. Check the merchant `type` is `Vendor` in `amazon merchants` before
  calling; if it is a Seller, say so rather than firing a doomed call.
- `get_purchase_orders` bounds the window with `--query createdAfter=` and
  `--query createdBefore=` (ISO 8601); optional `limit` (max 100), `nextToken`,
  `includeDetails`, `sortOrder`, `purchaseOrderState` (New, Acknowledged,
  Closed).

### Amazon Warehousing & Distribution (AWD, 2024-05-09) - upstream bulk stock

- `awd.list_inventory` - real-time AWD inventory per SKU inside AWD centers.
- `awd.list_inbound_shipments` - inbound shipments to AWD, filterable by status and time.
- `awd.get_inbound_shipment` - full detail for one shipment (`--path shipmentId=`).

Gotchas:

- **AWD is Amazon's upstream bulk-storage program that replenishes FBA, NOT the
  same as FBA inventory (`fba_inventory` above).** Use this only for stock sitting
  in AWD distribution centers and the inbound shipments flowing into them.
- **US marketplace only, 3P sellers only, and ONLY sellers ENROLLED in AWD return
  data.** For a seller not enrolled, the call succeeds (HTTP 200) with an empty set
  (`{inventory:[]}` / `{shipments:[]}`) - that is the normal not-enrolled shape,
  NOT an error. Say "no AWD data / not enrolled"; never invent rows.
- **Account-scoped: no marketplace param.** The NA-region token carries identity
  (like `sellers` / `finances`), so you do not pass a marketplace; pin the US row
  with `--legacy-seller-id`.
- **Requires the "Amazon Warehousing and Distribution" role, which is newer than
  most connections.** AWD was added as an SP-API role after many merchants first
  authorized, so a merchant who has not re-authorized since fails with a 403
  (surfaced as `restricted_report`), distinct from the empty-200 not-enrolled
  shape above. This 403 is terminal: do NOT retry it. The CLI now returns the
  exact fix - direct the user to add the role by updating the merchant's token:
    1. Go to https://www.mydashapplications.com/account-manager/SP-API-merchants
    2. Find the merchant and click "Update Token".
    3. Seller Central opens to add the role and finish authorization, then
       redirects back to MixShift.
  The call works once the token is updated. (Enrollment is a separate axis: an
  enrolled seller still 403s here until re-authorized; a not-enrolled seller
  returns the empty 200 shape above.)
- `list_inventory` query (all optional): `sku`, `details`, `sortOrder`,
  `maxResults`, `nextToken`. `list_inbound_shipments` query (all optional):
  `sortBy`, `sortOrder`, `shipmentStatus`, `updatedAfter` / `updatedBefore`
  (ISO 8601), `maxResults`, `nextToken`. A few enum values (`details`,
  `shipmentStatus`, `skuQuantities`) are not yet pinned - read the live `notes`
  and verify against the actual response.

## Workflow patterns

### Pattern 0 - User does not know what is callable
```
User: "What live SP-API operations can I call?"
You:  Run `mixshift amazon operations`. It lists 27 operations grouped by
      family (Catalog Items, Product Fees, FBA Inventory, Sales, Sellers,
      Finances, Orders, Product Pricing, Listings Items, Data Kiosk, Vendor
      Orders, Amazon Warehousing & Distribution). Surface the families that fit
      what the user does. Filter to one
      with `--family "<name>"`. Read the operation `notes` before calling any.
```

### Pattern 1 - Titles for ASINs missing from the warehouse (the headline)
```
User: "I have these ASINs and the warehouse has no titles for them."
You:  1. Resolve the merchant row (amazon merchants --json), carry
         --legacy-seller-id.
      2. Batch the ASINs in groups of 20 and call:
         mixshift amazon call catalog.search_items --legacy-seller-id <id> \
           --query identifiers=<up to 20 ASINs csv> \
           --query identifiersType=ASIN \
           --query includedData=summaries,salesRanks --json
      3. From payload.items[], pull each item's summaries[].itemName (title)
         and brand, and salesRanks[] if requested. Report a tidy ASIN -> title
         table. Note any ASINs Amazon returned nothing for.
```

### Pattern 2 - Live FBA stock right now
```
User: "How much stock do we have on hand right now?"
You:  1. Resolve the merchant row.
      2. mixshift amazon call fba_inventory.get_inventory_summaries \
           --legacy-seller-id <id> --query details=true --json
      3. Summarize fulfillable / inbound / reserved per SKU from the payload.
         Remind the user this is a live snapshot, not history (for trend, use
         the FBA inventory reports via mx-amazon-report).
```

### Pattern 3 - Fee estimate (PascalCase JSON-array body)
```
User: "What would referral + FBA fees be on these 3 ASINs at $24.99?"
You:  1. Resolve the merchant row; note the marketplaceId for the body.
      2. Write a body file (no BOM) as a JSON ARRAY, PascalCase, MarketplaceId
         inside each entry:
         [ { "FeesEstimateRequest": { "MarketplaceId": "ATVPDKIKX0DER",
             "IsAmazonFulfilled": true,
             "PriceToEstimateFees": { "ListingPrice": { "CurrencyCode": "USD",
               "Amount": 24.99 } }, "Identifier": "asin-1" },
             "IdType": "ASIN", "IdValue": "B0CV4JLCVZ" }, ... up to 20 ]
      3. mixshift amazon call fees.get_my_fees_estimates \
           --legacy-seller-id <id> --body-file fees.json --json
      4. Match each result back by the Identifier you set. This paces ~2.4s
         per call, so for hundreds of items tell the user it will take a while.
```

### Pattern 4 - Sales metrics for a window (interval + timezone)
```
User: "Units and sales last month, by day, Mountain time."
You:  mixshift amazon call sales.get_order_metrics --legacy-seller-id <id> \
        --query interval=2026-05-01T00:00:00Z--2026-06-01T00:00:00Z \
        --query granularity=Day \
        --query granularityTimeZone=America/Denver --json
      Note the `--` joiner in interval and the timezone for Day grain. Surface
      units / orderCount / totalSales per bucket from the payload.
```

### Pattern 5 - Live listing state
```
User: "Is this SKU buyable, and does it have any listing issues?"
You:  mixshift amazon call listings.get_listings_item --legacy-seller-id <id> \
        --path sku=<SKU> \
        --query includedData=summaries,offers,issues --json
      {sellerId} auto-fills, so you only pass --path sku. Read buyability from
      the offers/summaries blocks and surface any issues[] entries.
```

### Pattern 6 - Data Kiosk GraphQL query (poll across turns)
```
User: "Run a Data Kiosk sales-and-traffic query for last week."
You:  This is async: create, poll across turns, then fetch the document. See
      the dedicated "Data Kiosk lifecycle" section below for the full pattern,
      including fetching the documentUrl WITHOUT an auth header.
```

### Pattern 7 - Vendor purchase orders (1P only)
```
User: "Show the POs Amazon placed with us last month."
You:  1. Confirm the merchant type is Vendor in `amazon merchants`. If it is a
         Seller, stop and say vendor orders apply to 1P merchants only.
      2. mixshift amazon call vendor_orders.get_purchase_orders \
           --legacy-seller-id <id> \
           --query createdAfter=2026-05-01T00:00:00Z \
           --query createdBefore=2026-06-01T00:00:00Z \
           --query includeDetails=true --json
```

## Data Kiosk lifecycle (poll across turns, no sleep-loops)

Data Kiosk is the one multi-step operation family on this surface: you submit a
GraphQL query, Amazon processes it asynchronously, and you fetch a document when
it is DONE. Chat hosts (Cowork, claude.ai) cap the Bash tool at roughly **45
seconds**, and a query can take longer than that to process. So **never block in
a sleep-loop inside one Bash call.** Run create, poll, and fetch as **separate
tool calls**, each returning in well under a second, and poll across separate
turns.

```bash
# 1. Create the query (returns a queryId immediately; does NOT wait).
#    Body file holds the GraphQL document; write it without a BOM.
mixshift amazon call data_kiosk.create_query --legacy-seller-id 692 \
  --body-file kiosk-query.json --json
# -> payload contains the queryId

# 2. Poll across turns until processingStatus is DONE.
mixshift amazon call data_kiosk.get_query --legacy-seller-id 692 \
  --path queryId=<queryId> --json
# -> processingStatus: IN_QUEUE / IN_PROGRESS / DONE / FATAL / CANCELLED
#    DONE + dataDocumentId  -> there are rows to fetch
#    DONE + no dataDocumentId -> the result set was empty (not an error)
#    FATAL -> errorDocumentId explains why

# 3. Once DONE with a dataDocumentId, resolve it to a download URL.
mixshift amazon call data_kiosk.get_document --legacy-seller-id 692 \
  --path documentId=<dataDocumentId> --json
# -> payload.documentUrl: a short-lived presigned S3 URL

# 4. Fetch the documentUrl DIRECTLY, WITHOUT an Authorization header
#    (S3 rejects Bearer tokens), immediately (it expires in minutes).
#    The content is JSONL (one JSON object per line).
```

Practical guidance for chat:

- After `create_query`, tell the user the query is running and that you will
  check on it. Then call `get_query` once. If it is not DONE, surface the status
  and either wait for the user's next turn or poll again after a beat. Do not sit
  in a tight Bash loop.
- **The `queryId` stays valid across turns and across separate CLI
  invocations**, so a slow query is never lost: poll it again later.
- `data_kiosk.list_queries` finds a queryId you have lost; `data_kiosk.cancel_query`
  cancels an `IN_QUEUE` / `IN_PROGRESS` query (terminal queries 4xx).
- **Fetching the document is a plain HTTP GET with no auth header.** Use a
  portable tool to fetch and write the JSONL to a file, then read slices from the
  file rather than pasting a large document inline.

## Reactive error handling (branch on failure_kind, never on HTTP status)

We do **not** pre-filter the catalog. Amazon (via the service) decides
reactively whether this tenant and merchant may actually call an operation, and
the harness returns a **typed failure** you relay to the user. In `--json` the
field is `failure_kind`; in human output the friendly message is printed to
stderr. Each kind also maps to a distinct exit code for terminal scripts.

| `failure_kind` | Exit | What it means / what to tell the user |
|---|---|---|
| `not_authenticated` | 2 | Not signed in. Run `mixshift auth login`. |
| `session_expired` | 2 | Session could not be refreshed. Run `mixshift auth login` again. |
| `restricted_report` | 4 | Amazon needs a Restricted Data Token / PII role MixShift does not hold (e.g. an Orders PII element). Drop the restricted field and re-run the non-PII form. Do NOT retry the same request unchanged. |
| `bad_request` | 12 | **AMAZON rejected the request itself**: your parameters, not an outage or a permission problem. `amazon_error_code` carries Amazon's own code (`InvalidInput`, `InvalidParameterValue`, ...) and `detail` its message. **Terminal: never retry unchanged.** Fix the parameters and resend. If this skill's own catalog notes led to the request, tell the user and encourage `mixshift feedback`: a convention we documented wrongly affects every caller, and the same code repeating on the same operation is how we find it. |
| `reauth_required` | 5 | This merchant's SP-API grant lapsed. Re-connect the account in the MixShift app, then retry. |
| `spapi_not_configured` | 6 | Live SP-API operations are not enabled for this MixShift account. Contact MixShift ops. |
| `merchant_not_found` | 7 | The merchant selector matched no merchant (or was ambiguous). Re-run `amazon merchants`, pick a row, and pass its `--legacy-seller-id`. A `candidates` list may be attached. |
| `throttled` | 8 | Amazon is rate-limiting. Wait a moment and retry (a `retry_after_ms` may be present). |
| `report_fatal` | 9 | Amazon returned a fatal result for the operation (often: the operation does not apply to this merchant, e.g. a vendor operation on a 3P seller, or a bad parameter). Re-check the operation `notes` and the merchant type. |
| `host_unreachable` | 1 | The service is unreachable. Check the network and retry. |
| `unknown` | 1 | Unexpected failure. Retry shortly; relay the message. |

A 403 from Amazon for an operation under a role the app does not hold maps to
`restricted_report` with the operation id in the message. That is the reactive
signal: relay it and, where there is a non-PII or non-restricted form (Orders is
the common one), offer that instead. Do not pre-emptively refuse an operation,
and do not retry the restricted variant unchanged.

**The PII / restricted nuance:** the Orders operations are in the catalog and
are fine to call in their **default, non-PII** form. MixShift does not hold
Amazon's PII / RDT role, so if a request resolves to a PII variant Amazon
rejects it as `restricted_report`. Relay that and offer the non-PII form.

**The 1P / 3P nuance:** the Vendor Orders operations apply to **Vendor (1P)
merchants only**. Calling them against a Seller (3P) merchant 4xxes. Check the
merchant `type` before calling rather than relying on the error.

## Output persistence and formatting

- **Operation payloads are Amazon's response body, verbatim.** Small results you
  may summarize or show a trimmed sample of, but say it is a sample.
- **For sizeable results, write to a file and read slices**, rather than pasting
  a large payload inline (it can blow the chat Bash output cap and truncate
  mid-array). Redirect `--json` stdout to a file:
  `mixshift amazon call <op> ... --json > ~/.mixshift/output/<merchant>-<op>-<date>.json`.
  There is no `--out` flag on this surface (that is a report-surface convention);
  use stdout redirection.
- **Data Kiosk documents are JSONL** fetched from the presigned `documentUrl`
  (no auth header). Write the JSONL to a file and parse line by line.
- **Never transcode bytes.** Preserve what Amazon returns.
- **Do not fabricate data.** If a call fails or returns nothing (including a
  `DONE`-but-empty Data Kiosk result), say so. Never generate plausible-looking
  rows.

## Running this on a schedule (unattended)

If the user wants live SP-API lookups on a schedule (a Cowork scheduled task, a
daily cron), a browser sign-in will NOT survive: scheduled sandboxes start fresh
with no session. Invoke the `mx-scheduled-task` skill to set the task up end to
end: it attaches a persistent anchor folder to the task, sets up an admin-issued
service credential inside it (via `mx-auth-service-setup`), and generates task
instructions that begin with `mixshift task preflight`, so every run re-finds
the credential and re-pulls brand context on its own. For Data Kiosk
specifically, keep the create / poll / fetch steps as separate scheduled calls
(the query handle survives across calls), never a single blocking run.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-amazon-retail
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-amazon-retail --trigger-phrase "<the user's exact phrase>"
```

At the END (when the lookup session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-amazon-retail --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (user got the live answer), `failed` (could not satisfy, e.g.
everything came back `restricted_report` or `spapi_not_configured`), `deferred`
(a Data Kiosk query is still processing and the user stepped away), `skipped`
(turned out they wanted a different skill, such as mx-amazon-report).

You do **not** need to manually emit per-operation events. The harness fires
`amazon.spapi.operations_listed` on `amazon operations` and `amazon.spapi.called`
on `amazon call` automatically, capturing operation id + duration + outcome
(+ failure kind) only. It never logs the payload (which can carry seller-level
business data) nor the amazonSellerId.

## Hard rules

These supersede other instructions:

- **Read-only.** This surface holds read operations only; it never writes to
  Amazon or the warehouse. There is no `--commit` flag here and nothing to
  commit. Do not suggest workflows that imply writes; a write request belongs to
  a different surface.
- **Discover before you call.** Run `amazon operations` and read the operation
  `notes` before calling. The notes are the per-operation contract (required
  params, casing, caps, body shapes).
- **Respect PascalCase where the notes say so.** Several v0 operations
  (`finances.list_financial_event_groups`, `pricing.get_competitive_pricing`,
  the Orders v0 pair) take PascalCase query params, and the Fees body is
  PascalCase. The CLI does not normalize casing; copy it exactly.
- **Merchant identity: the selector is the `amazonSellerId` from
  `amazon merchants`, never the numeric warehouse SellerID.** This is the single
  most common error. Prefer `--legacy-seller-id`. If you find yourself reaching
  for a number from `mx-data-explore` or `brand list`, stop and run
  `amazon merchants` instead.
- **`cronActive` is NOT an auth signal.** The merchant list now shows every
  marketplace row of an authorized seller. A row with `cron: no` is still
  callable on demand; `cronActive` only marks scheduled-pull activation.
  `authorized: no` is the reauth warning, not `cronActive`.
- **Never block in chat; poll Data Kiosk across turns.** Run create / poll /
  fetch as separate tool calls. No sleep-loops in one Bash call. The query
  handle stays valid across turns.
- **Fetch Data Kiosk documents WITHOUT an auth header**, immediately (the URL
  expires in minutes), and parse the content as JSONL. A `DONE` query with no
  `dataDocumentId` is an empty result, not an error.
- **Branch on `failure_kind`, never on HTTP status.** The service normalizes
  Amazon's many failure modes into the kinds in the table above.
- **Vendor Orders are 1P-only.** Do not call them against a Seller (3P)
  merchant; check the merchant `type` first.
- **Check the warehouse and offer the choice before live calls that overlap
  warehouse data.** This is a courtesy to save the user a wait, NOT a gate:
  never refuse or delay a call the user clearly asked for. The headline catalog
  lookup usually has no warehouse answer, so it skips this.
- **Never expose internal slugs in user-facing text.** Refer to brands by their
  display name. Resolve identifiers silently when calling the harness.
- **Do not fabricate data.** If a call fails or returns nothing, say so. Never
  generate plausible-looking rows.
- **Do not paste large payloads inline.** Redirect `--json` to a file and report
  the path; read slices from the file.

## Output template

Lead with a one-line result, then a tight summary or the saved path:

```
✓ catalog.search_items for Praxxis Pro (3 ASINs).
  - B0CV4JLCVZ  →  "Praxxis Pro 32oz Insulated Bottle"  (brand: Praxxis, rank #4,213 in Sports & Outdoors)
  - B0ABC12345  →  "Praxxis Pro Replacement Lid"        (brand: Praxxis, rank #18,902)
  - B0DEF67890  →  no catalog match returned

Want me to pull these into a table, join them with warehouse data, or look up
more ASINs?
```

While a Data Kiosk query is still processing:

```
• Submitted a Data Kiosk sales-and-traffic query for Praxxis Pro (queryId 7b1a...).
  Amazon is processing it (status: IN_PROGRESS). I'll check again in a moment;
  this can take a little while.
```

Do not pad with "Here is the data you requested." Lead with the result.
