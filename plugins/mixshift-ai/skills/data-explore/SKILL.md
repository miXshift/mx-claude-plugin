---
name: data-explore
description: >
  Ad-hoc query, sample, and CSV export against MixShift's MySQL warehouse
  (legacy schema: dashamazon). Covers Amazon Sponsored Ads (SP/SB/SD), DSP,
  Seller Central + Vendor Central operational revenue and orders,
  inventory, and dimensional catalog tables — not just PPC. Read-only,
  routes through the bundled harness CLI. Use when the user wants to see
  what's in their data, sample a table, export to CSV for use in other
  tools, or run a custom SQL query. Does NOT require brand cold-start —
  only that the user has signed in (`mixshift auth login`) and optionally
  knows a SellerID or brand slug.
metadata:
  version: "0.1.1"
  author: "MixShift"
trigger_phrases:
  - explore my data
  - show me my data
  - what tables can I query
  - what tables are available
  - export data
  - export to CSV
  - sample data
  - run a query
  - query my warehouse
  - query mixshift
  - what brands do I have
---

# Data Explore

## About the MixShift warehouse (authoritative — don't guess)

When characterizing the data source to the user (e.g. in a multi-source
disambiguation), use these facts:

- **Technology:** MySQL (NOT BigQuery, Snowflake, Postgres, or any cloud
  warehouse — Claude has guessed BigQuery before; that's wrong)
- **Schema:** `dashamazon` is the canonical legacy database name; some
  tenants have tenant-specific schemas (typically matching their MySQL
  username)
- **Access:** Read-only credentials. Destructive writes are impossible at
  the DB level — no need to defensively SQL-parse.
- **Scope:** Amazon advertising + retail. Specifically:
    - Sponsored Ads (Sponsored Products, Sponsored Brands, Sponsored Display)
    - Amazon DSP (display campaigns, separate from sponsored)
    - Seller Central operational revenue (sales, orders, units, sessions,
      page views, buy box, returns, settlements)
    - Vendor Central operational revenue (ordered/shipped revenue, units,
      COGS, page views via glance views)
    - Inventory (FBA + vendor)
    - Catalog metadata (mws_items with Brand / ItemGroup / Tags / TargetACOS,
      vendor_items with CustomBrand)
- **Routing:** All queries flow through the harness CLI (`mixshift data ...`),
  which sends them to MixShift's auth service at `mcp.mixshift.io/api/query`
  using a Bearer token from `~/.mixshift/auth/credentials` (no `.json` extension).
  The auth service holds the warehouse credentials server-side and the single
  static egress IP. The plugin itself never holds raw MySQL credentials.

If the user asks "what kind of database is this" or you need to pick
between multiple data sources, lead with "MixShift's MySQL warehouse"
rather than guessing technology.

You help the user query, sample, and export MixShift warehouse data. This is a **low-friction, read-only** skill — partners can use it without doing a full brand cold-start, as long as they've signed in (`mixshift auth login`).

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
| Auth set up | `~/.mixshift/auth/credentials` exists | Direct user to run `mixshift auth login` (recommended, token-based) or `mixshift auth setup` (legacy raw-MySQL path) |
| Service reachable | Inferred from successful query | Token-based path: no per-user IP whitelist needed; the auth service holds the single static egress IP. Legacy mysql path only: if queries hang/timeout, run `mixshift auth setup --request-whitelist`. |
| Brand registry populated | `~/.mixshift/clients/index.yaml` exists | Auto-populated after either sign-in flow completes; if missing, run `mixshift brand discover` |
| Knows a SellerID or brand slug | They tell you, or look up via the registry | Run `mixshift brand list` to surface the active brands |

Cold-start is **NOT required.** Most data-explore workflows only need a SellerID, which is in the brand registry.

### Brand registry (`~/.mixshift/clients/index.yaml`)

After either sign-in flow completes (`mixshift auth login` or the legacy `mixshift auth setup`), the harness auto-runs discovery and persists every brand the user has warehouse access to into `~/.mixshift/clients/index.yaml`. **Use this file as the canonical source for brand → SellerID lookups** — don't re-run `mixshift brand discover` unless:

- The user explicitly asks to refresh ("refresh my brands", "check for new accounts"), OR
- The registry is missing (`mixshift brand list` outputs the "no brand registry yet" warning), OR
- The user mentions a brand by name and `brand list` doesn't surface it (could be dormant or stale).

To read the registry, surface it to the user, run:

```bash
mixshift brand list           # active brands only (default)
mixshift brand list --all     # include dormant
mixshift brand list --only-inactive   # just dormants ("what do I need to activate?")
mixshift brand list --refresh   # force a fresh discovery query
```

The registry has a 24h TTL — `brand list` refreshes silently on read if stale.

**Dormant handling:** brands with no active ads + no active retail (SP-API) access are hidden by default. If the user asks "where is brand X?" and X isn't in the active list, check `mixshift brand list --all` for the dormant status, then explain (e.g. "X shows both ads and SP-API access disabled — ping MixShift ops or visit https://dash.mydashapplications.com/account-manager to reactivate").

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

### Pattern 0 — Warm-start when the user is wandering
```
User: "What can I do?" / "Where should I start?" / "Load some data up
       for me" / "I don't know where to start"
You:  Don't bounce them back to "what would you like to query?" — that's
      the failure mode that wastes their first turn. Instead, proactively
      pull a TWO-PART warm-start:
        1. Portfolio scoreboard — 30-day spend / ad-sales / ACOS by brand
           (joins campaignmetric to seller). Identifies the biggest brand.
        2. Spotlight on the top brand from step 1 — campaign-type and
           item-group breakdown so they can see where the money goes.
      Then suggest 3-5 concrete next directions (high-ACOS deep dive,
      daily trend, CSV export, ops-revenue context, etc.).

      Before pulling, fire the warm-start telemetry event:

        mixshift telemetry emit warm_start.served \
          --skill data-explore \
          --trigger-phrase "<the user's exact wording>" \
          --payload-json '{"snippets":["scoreboard","top_brand_drill"]}'

      This captures the moment Claude needed to scaffold the user
      because they didn't know what to ask. High-signal for measuring
      onboarding friction during beta.
```

### Pattern 1 — User doesn't know what's available
```
User: "What data can I look at?"
You:  Run `mixshift data list-tables`. Surface the result. Suggest
      they pick one of the common tables (campaignmetric for ad
      performance, business_reports_dpst_date for SC sales, etc.).
      If the user hasn't yet seen their brands, also nudge them with
      "say 'show my brands' to see which accounts are active."
```

### Pattern 1b — User asks about their brands
```
User: "What brands do I have?" / "What accounts do I have access to?" /
      "Which brands can I work with?" / similar
You:  Run `mixshift brand list` (default: active only, with a footer
      noting how many dormants are hidden). Surface the output.

      Variants:
        "show all my brands"     → `mixshift brand list --all`
        "what's dormant"         → `mixshift brand list --only-inactive`
        "refresh my brands"      → `mixshift brand list --refresh`
        "who do I need to activate?" → `mixshift brand list --only-inactive`
```

**Hard rules for brand questions (these supersede default helpfulness instincts):**

- **MUST use `mixshift brand list`.** Do NOT read `~/.mixshift/clients/index.yaml` directly with `cat` / `head` / `ls`. Do NOT run inline `python3 -c "import yaml…"` scripts against the registry. Do NOT re-query the warehouse with `mixshift brand discover` for this question — the registry is the source of truth and `brand list` is the only sanctioned access path. (The harness owns refresh behavior, error rendering, dormant filtering, footer counts — bypassing it loses all of that.)
- **MUST NOT say "slug" or "canonical slug" in user-facing text.** Slugs are internal command-invocation identifiers (used when YOU call `mixshift brand add <slug>` or `mixshift data query --seller-id <N>`). Users think in display names ("Hydrapak", "Skratch Labs"). When you reference a brand in chat, use the display name. If you need to call a follow-up command, resolve the slug silently from the registry and pass it to the harness — don't expose it.
- **MUST NOT label brands as "duplicates" or "legacy migrations" without evidence.** A brand showing up under multiple display names across marketplaces (Hydrapak / Hydrapak - CA / Hydrapak - DE Sporting Goods - (Pan-EU) / etc.) is the warehouse's intentional separation by marketplace and account type, not a data hygiene issue. The right framing is "multi-marketplace variants of one parent brand", not "duplicates" or "you need to figure out which is canonical."

### Pattern 1b extension — adding observation paragraphs

After surfacing the `mixshift brand list` output, you MAY add a brief observation paragraph if it adds genuine signal. Guidelines:

- Use display names, never slugs.
- Group multi-marketplace variants visually: *"Hydrapak shows up across 6 marketplace entries (US, CA, DE, FR, IT, plus the LLC parent) — same parent brand, separate ad accounts per marketplace."*
- Surface zero-activity edge cases: *"Polar Bottle and Polar Bottle® look like a legacy SC/VC split — the SC variant shows no ad spend last 30d, the VC variant carries the activity."*
- Don't editorialize about "data hygiene" or "canonical entries" — the warehouse is what it is.
- Keep it to 2-4 sentences. The list itself is the substance.

### Pattern 1c — Key brands (focused subset for agency / multi-brand users)

The user can curate a "key brands" subset — the brands they actually focus on day-to-day. This is distinct from the full registry. Portfolio-level skills (e.g. portfolio-quick-scan) default to running across key brands when set, falling back to all active brands when not.

State lives in `~/.mixshift/profile.yaml::brands.key`. Manage via the harness:

```
mixshift brand key add <name-or-slug>      add one (or multiple, space-separated)
mixshift brand key remove <name-or-slug>   remove
mixshift brand key list                    show current key brands
mixshift brand key clear                   empty the list
mixshift brand list --key                  same as `key list`
```

The harness accepts fuzzy input — display names, acronyms, prefixes, case-insensitive. "Skratch" → `skratch-labs`, "AOP" → `american-outdoor-products`, "Home IQ" → `home-iq-usa`. Ambiguous inputs return a non-zero exit code with candidate slugs in the output; pass that back to the user for disambiguation.

**Chat triggers and routings:**

| User phrase | Route to |
|---|---|
| "mark hydrapak as key" / "add hydrapak to my key brands" / "pin hydrapak" | `mixshift brand key add hydrapak` |
| "I manage Skratch, Hydro Cell, AOP, and Home IQ" / "set my key brands to X, Y, Z" | Parse the comma/and-separated list, then loop: one `mixshift brand key add "<each>"` per item. Use the user's exact phrasing — don't normalize before sending; let the harness resolver handle it. |
| "remove kiwa from key brands" / "unpin kiwa" / "drop kiwa from focus" | `mixshift brand key remove kiwa` |
| "show my key brands" / "what are my key brands" / "which brands am I focused on" / "list my key brands" | `mixshift brand key list` |
| "clear my key brands" / "reset my focus list" / "start over on key brands" | `mixshift brand key clear` (confirm before running if list has 3+ entries — irreversible, easy mistake to make) |

**Multi-brand parse pattern** (the natural "I manage Skratch, Hydro Cell, AOP, and Home IQ" flow):

1. Parse the list from the user's phrase. Common separators: comma, "and", "&", line breaks, "+". Strip filler words ("brands", "accounts").
2. For each item, call `mixshift brand key add "<item>"` in sequence. Don't pre-resolve client-side — pass the literal user phrasing to the harness so the resolver gets a chance.
3. Collect the results. Three possible per-item outcomes: added (✓), already_key (no-op, fine), ambiguous (need disambiguation), not_found (registry doesn't have it).
4. Render a summary:
   > *"Got it — your key brands are now Skratch Labs, Hydro Cell, American Outdoor Products, and Home IQ USA. Portfolio skills will default to these."*
5. For ambiguous or not_found items, ask a clarifying question in the SAME response — don't make the user wait a turn. Example:
   > *"Got 3 of 4. 'Hydro' matched both Hydrapak and Hydro Cell — which did you mean?"*

**Behavior when user has many active brands and no key set:**

If the user runs `mixshift brand list` and the footer says "No key brands set" with active count >5, proactively offer: *"You've got 23 active brands. Day-to-day, do you focus on a smaller set? Tell me which ones (e.g. 'I manage Skratch, Hydro Cell, AOP, and Home IQ') and I'll mark them as key — portfolio skills will then default to those."*

Don't pester. Single offer per session. If the user declines or doesn't reply, move on.

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
- **`describe` before joining unfamiliar tables.** Before composing a JOIN against a dimensional table (`seller`, `campaign`, `mws_items`, `vendor_items`, etc.) you haven't queried this session, run `mixshift data describe <table>` OR `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '<table>'` first. Column names in MixShift's warehouse use mixed casing (`MarketPlaceName`, `SellerID`, `CampaignType`, `MerchantType`, `CampaignID`, `AdGroupID`, `DateTime`) and primary keys are NOT always what intuition suggests — e.g. `seller.ID` is the PK that other tables join on as `<other>.SellerID`, NOT `seller.SellerID` which doesn't exist. Past sessions have wasted queries guessing column names like `s.marketplace` (actual: `s.MarketPlaceName`) and `s.SellerID` (actual: `s.ID`). Don't guess — describe first.
- **All `INFORMATION_SCHEMA` queries MUST filter by `TABLE_SCHEMA = DATABASE()`.** Without that filter you get rows for every table on the MySQL server (often 6000+ rows of `ID` columns from system tables) — useless and slow. Always include `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '<table>'`.
- **Always pass `--seller-id` for time-series tables** (campaignmetric, keywordmetric, keywordtargetingmetric, targetexpressionsmetric, productadmetric, asinmetric, business_reports_dpst_date, business_reports_dpst_sku, vendor_sales_manufacturing_asin, vendor_sales_sourcing_asin, mws_orders_metric, mws_inventory_history, mws_inventory_health, etc.). Without it the harness rejects the query because the table is huge.
- **Don't dump 100-column tables inline.** Always offer a CSV export or column selection.
- **Don't fake data.** If a query fails, surface the failure. Don't generate plausible-looking rows.
- **Don't assume timezone.** All dates in CSVs are UTC `YYYY-MM-DD`. Warehouse date columns are interpreted in MySQL's session timezone.

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill data-explore
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill data-explore --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill (i.e. when the user's data-exploration session winds down or they pivot to another skill), run:

```bash
mixshift telemetry emit skill.completed --skill data-explore --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (user got what they wanted), `failed` (the skill couldn't satisfy the request — e.g. all queries hit `access_denied_table`), `deferred` (user said "let me think and come back"), `skipped` (turned out the user wanted a different skill).

If the user hits `access_denied_table` and asks to request access, ALSO fire the dedicated event (in addition to running `mixshift feedback`):

```bash
mixshift telemetry emit table_access.requested --skill data-explore --payload-json '{"table_name": "<table>", "seller_ids": "<comma-separated>"}'
```

`table_access.requested` is in the Discord fan-out allowlist — ops sees the request in real time.

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
