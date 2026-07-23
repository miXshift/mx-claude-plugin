---
name: mx-data-explore
description: >
  Ad-hoc query, sample, and CSV export against MixShift's MySQL warehouse
  (legacy schema: dashamazon). Covers Amazon Sponsored Ads (SP/SB/SD), DSP,
  Seller Central + Vendor Central operational revenue and orders,
  inventory, and dimensional catalog tables — not just PPC. Read-only,
  routes through the bundled harness CLI. Use when the user wants to see
  what's in their data, sample a table, export to CSV for use in other
  tools, or run a custom SQL query. Does not require brand setup,
  only that the user has signed in (`mixshift auth login`) and optionally
  knows a SellerID or brand slug.
metadata:
  version: "0.1.4"
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

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), resolve the bundled CLI by scanning for it once and reuse the path: `MIXSHIFT_CLI="$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)"`, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


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

You help the user query, sample, and export MixShift warehouse data. This is a **low-friction, read-only** skill: partners can use it without doing a full brand setup, as long as they've signed in (`mixshift auth login`).

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
| Auth set up | `~/.mixshift/auth/credentials` exists | Direct user to run `mixshift auth login` (token-based; the only supported sign-in path). Unattended runs use a service credential (mx-auth-service-setup). |
| Service reachable | Inferred from successful query | No per-user IP whitelist is needed; the auth service holds the single static egress IP. If queries hang or time out, run `mixshift doctor` to diagnose. |
| Brand registry populated | `~/.mixshift/clients/index.yaml` exists | Auto-populated after sign-in completes; if missing, run `mixshift brand discover` |
| Knows a SellerID or brand slug | They tell you, or look up via the registry | Run `mixshift brand list` to surface the active brands |

Brand setup is **not required.** Most mx-data-explore workflows only need a SellerID, which is in the brand registry.

### Brand registry (`~/.mixshift/clients/index.yaml`)

After sign-in completes (`mixshift auth login`), the harness auto-runs discovery and persists every brand the user has warehouse access to into `~/.mixshift/clients/index.yaml`. **Use this file as the canonical source for brand → SellerID lookups** — don't re-run `mixshift brand discover` unless:

- The user explicitly asks to refresh ("refresh my brands", "check for new accounts"), OR
- The registry is missing (`mixshift brand list` outputs the "no brand registry yet" warning), OR
- The user mentions a brand by name and `brand list` doesn't surface it (could be dormant or stale).

To read the registry, surface it to the user, run:

```bash
mixshift brand list --format chat           # active brands only (default)
mixshift brand list --all --format chat     # include dormant
mixshift brand list --only-inactive --format chat   # just dormants ("what do I need to activate?")
mixshift brand list --refresh --format chat   # force a fresh discovery query
```

**Always pass `--format chat` when you will surface the table in chat**, and pass the output through verbatim as markdown, NOT inside a code block. The flag renders a markdown pipe table that survives the chat relay; the default space-aligned terminal table collapses into an unreadable blur outside a code block (Cowork especially). Do not paraphrase, condense, or restructure the table: copy it through as-is, the same pass-through rule mx-welcome uses for `mixshift welcome --format chat`. The same flag exists on `mixshift brand discover`.

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

mixshift brand discover [--format chat]   # to find available SellerIDs / slugs
                                          # (use --format chat when surfacing in chat)
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
          --skill mx-data-explore \
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
You:  Run `mixshift brand list --format chat` (default: active only, with
      a footer noting how many dormants are hidden). Surface the output
      verbatim as markdown, not in a code block.

      Variants:
        "show all my brands"     → `mixshift brand list --all --format chat`
        "what's dormant"         → `mixshift brand list --only-inactive --format chat`
        "refresh my brands"      → `mixshift brand list --refresh --format chat`
        "who do I need to activate?" → `mixshift brand list --only-inactive --format chat`
```

**Hard rules for brand questions (these supersede default helpfulness instincts):**

- **MUST use `mixshift brand list`.** Do NOT read `~/.mixshift/clients/index.yaml` directly with `cat` / `head` / `ls`. Do NOT run inline `python3 -c "import yaml…"` scripts against the registry. Do NOT re-query the warehouse with `mixshift brand discover` for this question — the registry is the source of truth and `brand list` is the only sanctioned access path. (The harness owns refresh behavior, error rendering, dormant filtering, footer counts — bypassing it loses all of that.)
- **MUST NOT say "slug" or "canonical slug" in user-facing text.** Slugs are internal command-invocation identifiers (used when YOU call `mixshift brand add <slug>` or `mixshift data query --seller-id <N>`). Users think in display names ("Ridgepak", "Summit Labs"). When you reference a brand in chat, use the display name. If you need to call a follow-up command, resolve the slug silently from the registry and pass it to the harness — don't expose it.
- **MUST NOT label brands as "duplicates" or "legacy migrations" without evidence.** A brand showing up under multiple display names across marketplaces (Ridgepak / Ridgepak - CA / Ridgepak - DE Sporting Goods - (Pan-EU) / etc.) is the warehouse's intentional separation by marketplace and account type, not a data hygiene issue. The right framing is "multi-marketplace variants of one parent brand", not "duplicates" or "you need to figure out which is canonical."

### Pattern 1b extension — adding observation paragraphs

After surfacing the `mixshift brand list` output, you MAY add a brief observation paragraph if it adds genuine signal. Guidelines:

- Use display names, never slugs.
- Group multi-marketplace variants visually: *"Ridgepak shows up across 6 marketplace entries (US, CA, DE, FR, IT, plus the LLC parent) — same parent brand, separate ad accounts per marketplace."*
- Surface zero-activity edge cases: *"Glacier Bottle and Glacier Bottle® look like a legacy SC/VC split — the SC variant shows no ad spend last 30d, the VC variant carries the activity."*
- Don't editorialize about "data hygiene" or "canonical entries" — the warehouse is what it is.
- Keep it to 2-4 sentences. The list itself is the substance.

### Pattern 1c — Key brands (focused subset for agency / multi-brand users)

The user can curate a "key brands" subset — the brands they actually focus on day-to-day. This is distinct from the full registry. Portfolio-level skills (e.g. mx-portfolio-quick-scan) default to running across key brands when set, falling back to all active brands when not.

State lives in `~/.mixshift/profile.yaml::brands.key`. Manage via the harness:

```
mixshift brand key add <name-or-slug>      add one (or multiple, space-separated)
mixshift brand key remove <name-or-slug>   remove
mixshift brand key list                    show current key brands
mixshift brand key clear                   empty the list
mixshift brand list --key                  same as `key list`
```

The harness accepts fuzzy input — display names, acronyms, prefixes, case-insensitive. "Summit" → `summit-labs`, "AOP" → `aspen-outdoor-provisions`, "Hearth IQ" → `hearth-iq-usa`. Ambiguous inputs return a non-zero exit code with candidate slugs in the output; pass that back to the user for disambiguation.

**Chat triggers and routings:**

| User phrase | Route to |
|---|---|
| "mark ridgepak as key" / "add ridgepak to my key brands" / "pin ridgepak" | `mixshift brand key add ridgepak` |
| "I manage Summit, Ridgeline Cell, AOP, and Hearth IQ" / "set my key brands to X, Y, Z" | Parse the comma/and-separated list, then loop: one `mixshift brand key add "<each>"` per item. Use the user's exact phrasing — don't normalize before sending; let the harness resolver handle it. |
| "remove kiwa from key brands" / "unpin kiwa" / "drop kiwa from focus" | `mixshift brand key remove kiwa` |
| "show my key brands" / "what are my key brands" / "which brands am I focused on" / "list my key brands" | `mixshift brand key list` |
| "clear my key brands" / "reset my focus list" / "start over on key brands" | `mixshift brand key clear` (confirm before running if list has 3+ entries — irreversible, easy mistake to make) |

**Multi-brand parse pattern** (the natural "I manage Summit, Ridgeline Cell, AOP, and Hearth IQ" flow):

1. Parse the list from the user's phrase. Common separators: comma, "and", "&", line breaks, "+". Strip filler words ("brands", "accounts").
2. For each item, call `mixshift brand key add "<item>"` in sequence. Don't pre-resolve client-side — pass the literal user phrasing to the harness so the resolver gets a chance.
3. Collect the results. Three possible per-item outcomes: added (✓), already_key (no-op, fine), ambiguous (need disambiguation), not_found (registry doesn't have it).
4. Render a summary:
   > *"Got it — your key brands are now Summit Labs, Ridgeline Cell, Aspen Outdoor Provisions, and Hearth IQ USA. Portfolio skills will default to these."*
5. For ambiguous or not_found items, ask a clarifying question in the SAME response — don't make the user wait a turn. Example:
   > *"Got 3 of 4. 'Ridge' matched both Ridgepak and Ridgeline Cell — which did you mean?"*

**After a successful key add: brain pre-fill runs in the background.**

The `key add` output includes a line like "Brain pre-fill running in the background for: <slug>". This is the Brand Brain: the plugin pulls the brand's platform facts (ACoS target, identity, data freshness) so analytical skills have a head start before full brand setup. It usually finishes in a few seconds. Confirm the result for the user:

1. Run `mixshift brand brain status <slug> --json`.
2. If `status_file.status` is `complete`, add one line to your summary, for example:
   > *"Brain pre-fill finished for Forager's Pantry: pulled your ACoS target (25%) from MixShift. Analytical skills can use it right away; full brand setup still unlocks the deeper set (say 'set up <brand>')."*
   If `brain.acos_target_pct` is null, say the target is not set in the MixShift platform and they can add one later via `mixshift brand config <slug>`.
3. If still `fetching`, wait about 5 seconds and poll again, up to roughly 90 seconds total. If it has not finished by then, say it is still running in the background and they can check anytime with `mixshift brand brain status <slug>`.
4. If `failed`, surface the error plus the retry command `mixshift brand brain refresh <slug>`. Keying succeeded regardless; never treat a brain failure as a key-add failure.
5. If the `key add` output instead shows "Brain pre-fill not started" with a reason, relay the manual command it suggests and move on.

**Behavior when user has many active brands and no key set:**

If the user runs `mixshift brand list` and the footer says "No key brands set" with active count >5, proactively offer: *"You've got 23 active brands. Day-to-day, do you focus on a smaller set? Tell me which ones (e.g. 'I manage Summit, Ridgeline Cell, AOP, and Hearth IQ') and I'll mark them as key — portfolio skills will then default to those."*

Don't pester. Single offer per session. If the user declines or doesn't reply, move on.

### Pattern 2 — User wants a quick preview
```
User: "Show me a sample of campaignmetric for Ridgepak"
You:  1. Find Ridgepak's SellerID — either from
        ~/.mixshift/clients/ridgepak/context.yaml (if onboarded) or
        from `mixshift brand discover` (if not).
      2. Run `mixshift data sample --table campaignmetric --seller-id <N> --limit 10`.
      3. Show the result. campaignmetric has 100+ columns; suggest
         narrowing to specific columns via `data query` if they want
         a cleaner view.
```

### Pattern 3 — Export to CSV
```
User: "Export Ridgepak's keyword performance for last week to CSV"
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
User: "What's spending on Ridgepak's ASINs last 30 days?"
You:  Use `productadmetric` (Amazon's "Advertised Product" report) or
      `asinmetric` (Amazon's "Purchased Product" report). The former is
      more common for "what we spent on these ASINs"; the latter for
      "what was actually purchased after seeing the ad."
```

### Pattern 3c — Branded sales reporting
```
User: "Show me sales by Brand for Ridgepak last month"
You:  business_reports_dpst_sku + mws_items join (SC) or
      vendor_sales_manufacturing_asin + vendor_items join (VC).
      mws_items.Brand is the canonical brand label. Pattern matches
      the "Business Reports by SKU with Labels" sample query.
```

**Join hygiene: `mws_items` holds one row per SKU, not per ASIN.** A single
ASIN commonly has many SKU rows (different conditions, fulfillment channels,
or historical listings), so a naive `JOIN mws_items ON ASIN` can pick an
arbitrary, stale row for the title/Brand/ItemName columns. Worse, batch
refreshes stamp many rows with the same `dtUpdatedOn`, so even an equality
join on `MAX(dtUpdatedOn)` can return several rows per ASIN and inflate
SUMs. Pick exactly one row per ASIN: latest `dtUpdatedOn`, tie-broken on
`ID`, e.g.:

```sql
SELECT b.ChildAsin, SUM(b.Amount) AS revenue, mi.Brand, mi.ItemName
FROM business_reports_dpst_sku b
JOIN mws_items mi ON mi.ID = (
  SELECT m2.ID
  FROM mws_items m2
  WHERE m2.SellerID = <N> AND m2.ASIN = b.ChildAsin
  ORDER BY m2.dtUpdatedOn DESC, m2.ID DESC
  LIMIT 1
)
WHERE b.SellerID = <N>
GROUP BY b.ChildAsin, mi.Brand, mi.ItemName
```

If an ASIN has no `mws_items` row at all (common for Brand Analytics catalog
ASINs, which are not necessarily listed), that is expected, not a bug: see
mx-amazon-retail's Catalog Items lookup for a live title source in that case.

**Shortcut — resolving a handful of ASINs to titles.** When you already have a
list of ASINs (e.g. from a `productadmetric` pull) and just want their product
titles, you do not need to hand-write the latest-row join: run
`mixshift data asin-titles --seller-id <N> --asins B0ABC,B0XYZ` (add `--json`).
It applies the canonical latest-`dtUpdatedOn`/tie-on-`ID` rule for you and
returns `{titles, missing}` — `missing` is the ASINs with no listing row, which
you then resolve live via mx-amazon-retail `catalog.search_items`.

### Pattern 4 — Custom query
```
User: "Total spend by campaign type last 30 days for Ridgepak"
You:  Run `mixshift data query --sql "SELECT CampaignType,
                                            SUM(Cost) AS total_spend
                                       FROM campaignmetric
                                       WHERE SellerID = <N>
                                         AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                                       GROUP BY CampaignType"`.
      Use --out if they want CSV.
```

**Names, not IDs — the output convention.** Raw numeric IDs
(`CampaignID`, `AdGroupID`, `AmazonTargetID`, `KeywordID`, `PortfolioID`) are
unreadable on their own. Whenever your query selects a `*ID`, co-select its
`*Name` in the same query and present the human-readable name — every ads
metric table carries the name next to the id (`campaignmetric.CampaignName`,
`adgroupmetric.AdGroupName`, `keywordtargetingmetric.KeywordText`,
`targetexpressionsmetric.CampaignName/targetingText`, `portfolio.PortfolioName`,
etc.), so it is a free extra column, not a join. In
output, show `Name (id)` rather than the bare id — keep the id visible because a
downstream write step (a bid or budget edit) still needs it, but lead with the
name. For ASIN rows, show the product title: `Title (ASIN)` (resolve via the
`data asin-titles` shortcut above); if a title is unavailable, show
`ASIN (title unavailable)` — never drop the row or fail. Prefer the dimension
table's name (`campaign.CampaignName`) when a join to it already exists, since
names denormalized onto metric rows can be mildly stale; for brand display use
`seller.MerchantAlias` (SellerName is stale across rows).

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
- **Large results** (≥ 100 rows): always export to CSV instead of inline rendering. The harness pages through large result sets automatically and never rejects a query for being too big; pass `--out <path>` to stream the full set to a chosen file, or omit it and the harness spills a large result to a temporary CSV and reports the path. Either way, prefer surfacing the file path over dumping rows inline.
- **Numeric columns**: render as-is. The harness already coerces nulls / NaN / Infinity to empty cells.
- **Dates**: harness writes `YYYY-MM-DD` (no time component) in CSV. Same in markdown.

## Capturing user feedback

If the user has feedback during the session — a bug report, feature request, comment — invite them to capture it before they leave:

> "Before we wrap, anything you want me to send back to the MixShift team? Bugs, gripes, things you wish this could do?"

If they have feedback, run `mixshift feedback "<message>" --category <type> --skill mx-data-explore [--command <cmd>] [--brand <slug>]`. Confirm it was sent.

## Running this on a schedule (unattended)

If the user wants a query or export to run on a schedule (a Cowork scheduled
task, a daily cron), a browser sign-in will NOT survive: scheduled sandboxes
start fresh with no session. Invoke the `mx-scheduled-task` skill to set the
task up end to end: it attaches a persistent anchor folder to the task, sets
up an admin-issued service credential inside it (via `mx-auth-service-setup`),
and generates task instructions that begin with `mixshift task preflight`, so
every run re-finds the credential on its own. Read-only credentials cover
everything this skill does.

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
mixshift telemetry emit skill.invoked --skill mx-data-explore
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-data-explore --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill (i.e. when the user's data-exploration session winds down or they pivot to another skill), run:

```bash
mixshift telemetry emit skill.completed --skill mx-data-explore --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (user got what they wanted), `failed` (the skill couldn't satisfy the request — e.g. all queries hit `access_denied_table`), `deferred` (user said "let me think and come back"), `skipped` (turned out the user wanted a different skill).

If the user hits `access_denied_table` and asks to request access, ALSO fire the dedicated event (in addition to running `mixshift feedback`):

```bash
mixshift telemetry emit table_access.requested --skill mx-data-explore --payload-json '{"table_name": "<table>", "seller_ids": "<comma-separated>"}'
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
