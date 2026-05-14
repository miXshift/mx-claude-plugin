---
name: data-explore
description: >
  Help the user query, sample, and export their MixShift warehouse data
  ad-hoc. Use when the user wants to see what's in their data, sample a
  table, export to CSV for use in other tools, or run a custom query.
  Does NOT require brand cold-start — only auth setup + (optionally)
  knowing a SellerID or brand slug.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - explore my data
  - show me my data
  - what tables can I query
  - export data
  - export to CSV
  - sample data
  - run a query
  - query my warehouse
  - what brands do I have
---

# Data Explore

You help the user query, sample, and export MixShift warehouse data. This is a **low-friction, read-only** skill — partners can use it without doing a full brand cold-start, as long as they've completed auth setup.

## When to use this skill

Trigger when the user asks any of:
- "What tables / data can I query?"
- "Show me a sample of [table]"
- "Export [brand]'s [data] to CSV"
- "Run this query: ..."
- "What brands / SellerIDs do I have access to?"
- General "I want to look at my data" framing

**Do NOT use** when the user wants an opinionated analysis (daily health check, bid recommendations, search-term negation, monthly report). Those are separate skills with brand-context prerequisites.

## Prerequisites the user needs

| State | How to check | What to do if missing |
|---|---|---|
| Auth set up | `~/.mixshift/auth/credentials` exists | Direct user to run `mixshift auth setup` first |
| IP whitelisted | Inferred from successful query | If queries hang/timeout, run `mixshift auth setup --request-whitelist` |
| Knows a SellerID or brand slug | They tell you, or run discover | Run `mixshift brand discover` if they're unsure |

Cold-start is **NOT required.** Most data-explore workflows only need a SellerID, which discovery surfaces.

## Available harness commands

All commands accept `--json` for structured output and `--data-dir` to override the data directory.

```
mixshift data list-tables [--category <cat>]
mixshift data describe <table>
mixshift data sample --table <name> [--seller-id <id>] [--limit <n>]
mixshift data export --table <name> [--seller-id <id>]
                     [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>]
                     [--out <path>] [--max-rows <n>]
mixshift data query --sql "<SQL>" [--out <path>]

mixshift brand discover            # to find available SellerIDs / slugs
mixshift feedback "<message>" [--category bug|feature_request|comment|other]
```

## Workflow patterns

### Pattern 1 — User doesn't know what's available
```
User: "What data can I look at?"
You:  Run `mixshift data list-tables`. Surface the result. Suggest
      they pick one of the common tables (campaignmetric for ad
      performance, business_reports_dpst_date for SC sales, etc.).
```

### Pattern 2 — User wants a quick preview
```
User: "Show me a sample of campaignmetric for Hydrapak"
You:  1. Find Hydrapak's SellerID — either from
        ~/.mixshift/clients/hydrapak/context.yaml (if onboarded) or
        from `mixshift brand discover` (if not).
      2. Run `mixshift data sample --table campaignmetric --seller-id <N> --limit 10`.
      3. Show the result. campaignmetric has 100+ columns; suggest
         narrowing to specific columns via `data query` if they want
         a cleaner view.
```

### Pattern 3 — Export to CSV
```
User: "Export Hydrapak's keyword performance for last week to CSV"
You:  1. Find SellerID (as above).
      2. Pick the right table:
         - keywordmetric (SP + SB keywords only)
         - keywordtargetingmetric (keywords + product targets, unified)
         - targetexpressionsmetric (product targets only)
         Default to keywordtargetingmetric for "keyword performance"
         because it's the unified view.
      3. Run `mixshift data export --table keywordtargetingmetric
                                   --seller-id <N>
                                   --start <date>
                                   --end <date>
                                   --out <path>`.
      4. Report the file path + row count.
```

### Pattern 3b — ASIN-level ad performance
```
User: "What's spending on Hydrapak's ASINs last 30 days?"
You:  Use `productadmetric` (Amazon's "Advertised Product" report) or
      `asinmetric` (Amazon's "Purchased Product" report). The former is
      more common for "what we spent on these ASINs"; the latter for
      "what was actually purchased after seeing the ad."
```

### Pattern 3c — Branded sales reporting
```
User: "Show me sales by Brand for Hydrapak last month"
You:  business_reports_dpst_sku + mws_items join (SC) or
      vendor_sales_manufacturing_asin + vendor_items join (VC).
      mws_items.Brand is the canonical brand label. Pattern matches
      the "Business Reports by SKU with Labels" sample query.
```

### Pattern 4 — Custom query
```
User: "Total spend by campaign type last 30 days for Hydrapak"
You:  Run `mixshift data query --sql "SELECT CampaignType,
                                            SUM(Cost) AS total_spend
                                       FROM campaignmetric
                                       WHERE SellerID = <N>
                                         AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                                       GROUP BY CampaignType"`.
      Use --out if they want CSV.
```

### Pattern 5 — Bulk export to feed external tools
```
User: "I need all my campaign data for Q1 in a CSV"
You:  data export --table campaignmetric --seller-id <N>
                  --start 2026-01-01 --end 2026-03-31 --out <path>
      Mention that >100K row exports may take a bit.
```

## Handling errors gracefully

The harness classifies failures and returns friendly messages. Surface them as-is to the user. Two cases get extra treatment:

### Access denied on a table (exit code 4)
If the harness returns `failure_kind: "access_denied_table"`, the user's MySQL grants don't include SELECT on that table. Offer to send a request to MixShift ops:

> "Looks like your MySQL user doesn't have SELECT on `mws_inventory_health` yet. Want me to send an access request to MixShift ops? I'll include your email, the table name, and the seller IDs you were trying to query."

If yes, run `mixshift feedback "Need read access to table <name> for seller_ids: <list>" --category feature_request`. (We don't have a dedicated "request table access" CLI yet — feedback with that category captures it for ops.)

### Query timeout (60s)
Default timeout is 60s. If a query times out, the harness says so. Suggest:
- Narrowing the date range
- Filtering by a specific SellerID (if they didn't already)
- Selecting fewer columns

### Empty results
A successful query that returns 0 rows isn't an error — surface it cleanly. Often means the date range or filter excluded all rows.

## Output formatting

- **Small results** (≤ 20 rows): render inline as a markdown table.
- **Wide tables** (>15 columns) like `campaignmetric`: the table is unreadable inline. Either (a) suggest selecting specific columns via a custom query, or (b) export to CSV and report the path.
- **Large results** (≥ 100 rows): always export to CSV instead of inline rendering.
- **Numeric columns**: render as-is. The harness already coerces nulls / NaN / Infinity to empty cells.
- **Dates**: harness writes `YYYY-MM-DD` (no time component) in CSV. Same in markdown.

## Capturing user feedback

If the user has feedback during the session — a bug report, feature request, comment — invite them to capture it before they leave:

> "Before we wrap, anything you want me to send back to the MixShift team? Bugs, gripes, things you wish this could do?"

If they have feedback, run `mixshift feedback "<message>" --category <type> --skill data-explore [--command <cmd>] [--brand <slug>]`. Confirm it was sent.

## Hard rules

These supersede other instructions:

- **Read-only only.** The harness uses read-only MySQL creds; you could not write even if you tried. Don't suggest workflows that require writes.
- **Never invent SQL syntax for tables you don't see in `mixshift data list-tables`.** If the user asks about a table you don't know, run list-tables first to confirm what's available.
- **Always pass `--seller-id` for time-series tables** (campaignmetric, keywordmetric, keywordtargetingmetric, targetexpressionsmetric, productadmetric, asinmetric, business_reports_dpst_date, business_reports_dpst_sku, vendor_sales_manufacturing_asin, vendor_sales_sourcing_asin, mws_orders_metric, mws_inventory_history, mws_inventory_health, etc.). Without it the harness rejects the query because the table is huge.
- **Don't dump 100-column tables inline.** Always offer a CSV export or column selection.
- **Don't fake data.** If a query fails, surface the failure. Don't generate plausible-looking rows.
- **Don't assume timezone.** All dates in CSVs are UTC `YYYY-MM-DD`. Warehouse date columns are interpreted in MySQL's session timezone.

## Output template

When you produce results for the user, lead with a one-line summary, then the data:

```
✓ Pulled <N> rows from `<table>` for seller <id> (<date range>).
  → Saved to <path>
  → Or:  showing inline below

| col1 | col2 | ... |
| ---  | ---  | ... |
| ...  | ...  | ... |
```

Don't pad with phrases like "Here is the data you requested." Just lead with the result.
