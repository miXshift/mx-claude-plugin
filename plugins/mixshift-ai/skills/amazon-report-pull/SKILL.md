---
name: amazon-report-pull
description: >
  Pull Amazon SP-API reports on demand, directly from Amazon, for any
  merchant and window you need. This is the report analogue of data-explore:
  a catalog-driven workhorse for fetching data MixShift may not already hold
  in the warehouse, or a known report for a specific ad-hoc time frame, so the
  user can analyze it, build with it, combine it with existing data, or store
  it for later workflows. Covers Seller Central flat-file reports (orders,
  listings, FBA inventory, FBA fees, returns, settlement), Sales and Traffic,
  Brand Analytics (JSON), and Vendor Central reports (JSON). Read-only, routes
  through the bundled harness CLI. Does NOT require brand cold-start, only that
  the user has signed in (`mixshift auth login`).
metadata:
  version: "0.2.0"
  author: "MixShift"
trigger_phrases:
  - pull a report
  - pull an amazon report
  - get a report from amazon
  - fetch a report
  - request a report
  - sales and traffic report
  - brand analytics report
  - search terms report
  - vendor sales report
  - fba inventory report
  - all orders report
  - settlement report
  - what reports can I pull
  - what amazon reports are available
  - get data amazon doesn't have in the warehouse
  - pull fresh data from amazon
---

# Amazon Report Pull

## About the Amazon report surface (authoritative, do not guess)

When characterizing this capability to the user, use these facts:

- **What it is:** an on-demand pull of Amazon Selling Partner API (SP-API)
  reports, straight from Amazon, for the merchants the signed-in MixShift
  tenant is authorized for. It is a first-class, user-driven capability. Before
  pulling, you check whether the warehouse already holds the data and let the
  user choose (see "Warehouse-first" below), but you never refuse a requested
  pull.
- **Routing:** all calls flow through the harness CLI (`mixshift amazon ...`),
  which talks to MixShift's service at `mcp.mixshift.io` using the same Bearer
  token as the warehouse query path (from `~/.mixshift/auth/credentials`, no
  `.json` extension). The service holds the Amazon SP-API credentials
  server-side and the single static egress IP. The plugin never holds SP-API
  secrets, and Claude never sees them.
- **Division of responsibility:** the plugin owns the catalog (which reports
  exist, how to call and parse them) and the calling conventions. The service
  owns security: which merchants are authorized, which reports Amazon will
  allow, talking to Amazon. If the plugin and service disagree, the service
  wins. That is why we do not pre-filter the catalog on guesses about what is
  restricted (see "Reactive error handling" below).
- **Lifecycle:** every pull is keyed by a `run_id` (a service-minted UUID).
  Three steps: start (kick off the run), poll (is it done?), get (fetch the
  document). A report can take anywhere from a few seconds to several minutes
  to generate on Amazon's side.
- **Document formats:** flat-file reports come back as TSV (tab-separated,
  sometimes with a leading UTF-8 byte-order mark). Vendor and Brand Analytics
  reports come back as JSON. The catalog's `document format` field tells you
  which. The bytes are returned as-is and never transcoded.

If the user asks "where does this data come from," lead with "directly from
Amazon's SP-API, pulled through MixShift's service," not a guess.

## When to use this skill

Trigger when the user wants to **pull a report from Amazon**, for example:

- "Pull the Sales and Traffic report for Hydrapak last month"
- "Get me the Brand Analytics search terms report for last week"
- "I need the all-orders report for a specific date range"
- "Fetch FBA inventory for Skratch"
- "What Amazon reports can I pull?"
- "Get data Amazon has that isn't in the warehouse yet"
- "Pull the vendor sales report and save it so I can build on it"

The core user story this serves: *"I want to get data MixShift doesn't yet
have, or for a specific time frame, on demand, so I can analyze it, build with
it, combine it with existing data, or store it for later workflows."*

### Warehouse-first: check, reason, and ask (do this before pulling)

`data-explore` queries data MixShift **already holds** in the MySQL warehouse.
This skill pulls **fresh data from Amazon**. Most of the scheduled SP-API and
vendor feeds are already ingested into the warehouse on a recurring basis, so
for a lot of routine requests the data is **already there** and a fresh pull is
slower and redundant. Before you start a run, work through these four steps:

1. **Reason about coverage first.** Look at what the user actually wants (report
   type, grain, window, merchant) and form a hypothesis about whether the
   warehouse already holds it. The catalog's `warehouse coverage` tag (`have` /
   `partial` / `none`) is a **coarse hint**, not a verdict. It tells you a
   related table probably exists; it does NOT tell you the grain, window, or
   exact columns line up. Treat it as a starting prior, then reason.
2. **Check the warehouse.** When your hypothesis is "the warehouse probably has
   this," actually look: use `data-explore` to see whether a relevant table is
   present and how fresh / complete it is for the window the user asked for.
   Confirm rather than assume.
3. **Ask the user which they want.** When the warehouse plausibly covers the
   request, surface the choice plainly, for example: *"MixShift's warehouse
   already holds Sales and Traffic data through yesterday, so I can pull that
   from the warehouse in seconds. Or I can pull the raw report straight from
   Amazon if you want the exact source file, a grain the warehouse doesn't
   keep, or a window it hasn't loaded. Which would you like?"* Let them decide.
4. **Reason about whether a fresh pull is actually necessary.** Even after they
   answer, use judgment. If they want something the warehouse genuinely cannot
   give (a specific historical window not loaded, a finer grain, the raw file to
   archive or combine), a fresh pull is the right call. If the warehouse copy
   fully satisfies the need, say so and save them the wait.

This is an **explicit step and a courtesy, NOT a hard gate.** If the user wants
the Amazon report, pull it. Never refuse a requested pull because the warehouse
"probably has it" already. The goal is to inform the choice, not to block it.

#### The table <> report mapping is NOT 1:1 (reason, do not mechanically map)

The hard part of step 1 is that there is **no clean mapping** from a warehouse
table back to the SP-API report(s) that feed it. The warehouse is a transformed
layer, not a raw mirror, so you have to reason about coverage semantically
rather than looking it up:

- **Columns are renamed and derived.** Warehouse column names often differ from
  the report's raw field names, and many columns are computed (period
  roll-ups, normalized identifiers, blended or ratio metrics) and have no direct
  counterpart in any single report.
- **Grain can change.** A report might be ASIN-by-day while the warehouse table
  is rolled up to brand-by-week (or the reverse). "We have Sales and Traffic"
  can still mean the warehouse lacks the exact grain the user is asking for.
- **Sources are joined and merged.** One warehouse table is frequently built
  from **several** reports plus dimension tables, and some tables are populated
  from the **Ads API**, not SP-API reports at all. So a table existing does not
  cleanly imply "this one report is redundant."

Because of all this, **coverage is a judgment call, and that is exactly where
your reasoning is needed.** Do not mechanically equate a table name with a
report type. Reason about whether the *data the user wants* is present at the
*grain and window* they want, and when you are unsure, say you are unsure and
offer both paths (check the warehouse, or pull fresh) rather than guessing.

**Do NOT use this skill** when the user wants an opinionated analysis (daily
health check, bid recommendations, monthly performance report). Those are
separate skills with their own context prerequisites. This skill pulls raw
report data; it does not interpret it for you beyond surfacing it cleanly.

## Prerequisites the user needs

| State | How to check | What to do if missing |
|---|---|---|
| Signed in to MixShift | `~/.mixshift/auth/credentials` exists | Direct the user to run `mixshift auth login` (or say "sign in to MixShift" in chat). Reports fail with `not_authenticated` until then. |
| SP-API enabled for the tenant | Inferred from a successful `amazon merchants` call | If a call returns `spapi_not_configured`, on-demand report pulls are not turned on for this MixShift account yet. Tell the user to contact MixShift ops. |
| A target merchant | `mixshift amazon merchants` | Lists the seller/vendor accounts this tenant can pull for. See merchant selection below. |

Cold-start is **NOT required.** You only need a signed-in session. A specific
`amazonSellerId` (from `amazon merchants`) is needed only when the tenant has
more than one merchant; if there is exactly one, the service infers it and you
can omit `--seller-id` entirely.

## Merchant selection (read this, it is the most common mistake)

Report commands take a `--seller-id` that is the **Amazon seller/vendor ID**
(Amazon's merchant token, e.g. `A2EUQ1WTGCTBG2`), surfaced by
`mixshift amazon merchants`. This is **NOT** the numeric warehouse `SellerID`
you see in `data-explore` or `mixshift brand list`. They are different
identifiers for different systems.

`--seller-id` is **optional when the tenant has exactly one merchant** (the
service infers it). It is **required when the tenant has more than one**: omit
it and the run fails with `merchant_not_found`. When in doubt, resolve it
explicitly so the pull targets the merchant the user meant.

**Always resolve the merchant through `mixshift amazon merchants`:**

```bash
mixshift amazon merchants            # human table
mixshift amazon merchants --json     # structured, for matching by name
```

The output has these columns: `amazonSellerId`, `name`, `type`
(Seller/Vendor), `region`, `marketplace`, `authorized`.

To pull for a brand the user names:

1. Run `amazon merchants --json`.
2. Match the user's brand wording against the `name` field (case-insensitive,
   allow partial / fuzzy matches; ask to disambiguate if more than one hits).
3. Use that row's `amazonSellerId` for `report start --seller-id`.
4. If the matched row has `authorized: false`, warn the user before pulling:
   the SP-API grant for that merchant has lapsed and the pull will fail with
   `reauth_required` until it is re-connected in the MixShift app.

If no merchant matches, run `amazon merchants` and show the user the list
rather than guessing an ID.

## Available harness commands

All commands accept `--json` for structured output and `--data-dir` to
override the data directory.

```
mixshift amazon merchants
mixshift amazon list-reports [--applies-to seller|vendor] [--group <name>]
mixshift amazon describe-report <reportType>

mixshift amazon report start [--seller-id <amazonSellerId>] --type <reportType>
                             [--start <date>] [--end <date>]
                             [--marketplace <id>]
                             [--option <key=value> ...]
mixshift amazon report poll <runId>
mixshift amazon report get  <runId> [--out <path>]

mixshift amazon report run   ...same flags as start... [--out <path>]
                             [--interval-ms <n>] [--max-wait-ms <n>]
```

- `report start` returns a `run_id` immediately (it does NOT wait for the
  document).
- `report poll <runId>` returns `{ ready, status }`. **Gate on `ready`
  (boolean), never on the `status` string.**
- `report get <runId>` fetches the document once ready. It is safe to call
  before ready: it returns `ready: false` and exit code 10 (not an error),
  so you can use it as the poll itself. With `--out`, it writes the bytes to a
  file; without `--out`, it streams to stdout.
- `report run` does start + poll-until-ready + get in one blocking call. It is
  **TERMINAL-ONLY** (see the Cowork constraint below).

## The poll-across-calls pattern (CRITICAL for chat surfaces)

Chat hosts (Cowork, claude.ai) cap the Bash tool at roughly **45 seconds**. A
report can take minutes to generate on Amazon's side. A blocking wait will be
killed mid-flight and you will lose the run.

So in chat, **never block**. Run start, poll, and get as **separate tool
calls**, each of which returns in well under a second:

```bash
# 1. Start the run (returns immediately with a run_id)
mixshift amazon report start --seller-id A2EUQ1WTGCTBG2 \
  --type GET_SALES_AND_TRAFFIC_REPORT \
  --start 2026-05-01 --end 2026-05-31 \
  --option dateGranularity=DAY --json

# -> { "status": "ok", "run_id": "3f2c...", "report_status": "IN_QUEUE" }

# 2. Poll. Repeat this across separate turns until ready is true.
mixshift amazon report poll 3f2c... --json
# -> { "status": "ok", "ready": false, "report_status": "IN_PROGRESS" }
# ...a turn or two later...
# -> { "status": "ok", "ready": true,  "report_status": "DONE" }

# 3. Fetch once ready true, writing to a file.
mixshift amazon report get 3f2c... --out ~/.mixshift/reports/<merchant>/sat-may.json --json
# -> { "status": "ok", "ready": true, "out_path": "...", "bytes": 48213 }
```

Practical guidance for chat:

- After `start`, tell the user the run is going and that you will check on it.
  Then call `poll` once. If `ready` is false, surface the status ("Amazon is
  still generating it, status IN_PROGRESS") and either wait for the user's next
  turn or poll again after a short beat. Do not sit in a tight Bash loop.
- You can skip a separate `poll` and just call `report get` repeatedly: it
  returns `ready: false` (exit 10) until the document is available, then
  returns the bytes. Either approach works; `get` is one fewer command.
- The `run_id` stays valid across turns and even across separate CLI
  invocations, so a slow report is never lost: poll it again later.

**`report run` (the blocking convenience) is for a real terminal only.** It can
run for minutes, which blows past the chat Bash ceiling. Use it when you know
you are in a terminal session (not Cowork, not claude.ai). In chat, always use
start / poll / get separately.

## Workflow patterns

### Pattern 0 - User does not know what is available
```
User: "What Amazon reports can I pull?"
You:  Run `mixshift amazon list-reports`. It is grouped (Orders, FBA
      Inventory, Brand Analytics, Vendor, etc.). Surface the groups that fit
      what the user does (seller vs vendor). If they are a vendor, filter:
      `mixshift amazon list-reports --applies-to vendor`. Point them at
      `describe-report <type>` for the details on any one.
```

### Pattern 1 - Detail on one report type before pulling
```
User: "What's in the Sales and Traffic report?"
You:  Run `mixshift amazon describe-report GET_SALES_AND_TRAFFIC_REPORT`.
      It shows purpose, who it applies to, document format, the window rule
      (required / optional / forbidden), reportOptions knobs, parse hints,
      and warehouse coverage. Read the window rule before starting a run:
      some reports REQUIRE a --start/--end, some REJECT one.
```

### Pattern 2 - Straightforward pull (chat, poll-across-calls)
```
User: "Pull last month's Sales and Traffic for Hydrapak, daily grain"
You:  1. Resolve the merchant: `amazon merchants --json`, match "Hydrapak"
         by name, take its amazonSellerId.
      2. Check the window rule via describe-report if unsure. Sales and
         Traffic REQUIRES a window.
      3. Start:
         mixshift amazon report start --seller-id <amazonSellerId> \
           --type GET_SALES_AND_TRAFFIC_REPORT \
           --start 2026-05-01 --end 2026-05-31 \
           --option dateGranularity=DAY --json
      4. Poll across turns until ready (see the pattern above).
      5. Get with --out to save, then report the path + byte size.
```

### Pattern 3 - Report with reportOptions (Brand Analytics)
```
User: "Get the Brand Analytics search terms report for last week"
You:  1. Resolve merchant (must have Brand Registry; if Amazon rejects with
         restricted_report, relay that - it means this tenant/merchant lacks
         the Brand Analytics entitlement).
      2. describe-report GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT to confirm
         the reportPeriod option and window rule.
      3. Start with the option:
         mixshift amazon report start --seller-id <id> \
           --type GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT \
           --option reportPeriod=WEEK \
           --start 2026-05-25 --end 2026-05-31 --json
      4. Poll, then get. This one is JSON (--out a .json file).
```

### Pattern 4 - Vendor report
```
User: "Pull the vendor sales report"
You:  1. Resolve a merchant whose type is Vendor in `amazon merchants`.
      2. GET_VENDOR_SALES_REPORT requires three reportOptions; pass all three:
         --option reportPeriod=WEEK (or DAY/MONTH/QUARTER/YEAR)
         --option distributorView=MANUFACTURING (or SOURCING)
         --option sellingProgram=RETAIL (or BUSINESS/FRESH)
      3. amazon report start --seller-id <id> --type GET_VENDOR_SALES_REPORT
         --start <date> --end <date> + the three options above. JSON output.
      Note: vendor report types only apply to Vendor merchants. If the user's
      merchant is a Seller, say so rather than starting a doomed run.

      Vendor data lag: vendor feeds settle ~48-72h behind. Set the end of the
      window about three days back from today so you land on settled numbers; a
      too-recent end window returns thin or empty rows. If the user asks for
      "through yesterday," explain the lag and offer the settled window instead.
```

### Pattern 5 - Snapshot report (window FORBIDDEN)
```
User: "Get current FBA inventory"
You:  Some reports are point-in-time snapshots and Amazon REJECTS a window.
      describe-report will show window: forbidden. Start WITHOUT --start/--end:
      mixshift amazon report start --seller-id <id> --type GET_AFN_INVENTORY_DATA
```

### Pattern 6 - Pull to store / combine / build
```
User: "Pull X and save it so I can join it with my warehouse data later"
You:  Always use --out so the bytes land on disk. Default location is
      ~/.mixshift/reports/<merchant>/<date>-<reportType>.<tsv|json>. Report
      the exact path. The file is the deliverable; do not paste large
      documents inline (see Output formatting).
```

## Reactive error handling (branch on failure_kind, never on HTTP status)

We do **not** pre-filter the catalog. The catalog lists every report type with
no exclusions. Amazon (via the service) decides reactively what this tenant and
merchant may actually pull, and the harness returns a **typed failure** you
relay to the user. In `--json` the field is `failure_kind`; in human output the
friendly message is printed to stderr. Each kind also maps to a distinct exit
code for terminal scripts.

| `failure_kind` | Exit | What it means / what to tell the user |
|---|---|---|
| `not_authenticated` | 2 | Not signed in. Run `mixshift auth login`. |
| `session_expired` | 2 | Session could not be refreshed. Run `mixshift auth login` again. |
| `restricted_report` | 4 | Amazon needs a Restricted Data Token / PII role MixShift does not hold. Offer the default (non-PII) form of the report, or a different report. Do NOT retry the same request unchanged. |
| `reauth_required` | 5 | This merchant's SP-API grant lapsed. Re-connect the account in the MixShift app, then retry. |
| `spapi_not_configured` | 6 | SP-API pulls are not enabled for this MixShift account. Contact MixShift ops. |
| `merchant_not_found` | 7 | The `--seller-id` matched no merchant. Re-run `amazon merchants` and pick a listed `amazonSellerId`. |
| `throttled` | 8 | Amazon is rate-limiting. Wait a moment and retry (a `retry_after_ms` may be present). |
| `report_fatal` | 9 | Amazon returned FATAL / CANCELLED. Usually the report type does not apply to this merchant, or the window is invalid. Check `describe-report` and try a valid window. |
| `host_unreachable` | 1 | The service is unreachable. Check the network and retry. |
| `unknown` | 1 | Unexpected failure. Retry shortly; relay the message. |

A separate, non-error case: `report get` (and `report run`) use **exit code
10** for "not ready yet" / "timed out waiting." That is NOT a failure: the run
is still valid, keep polling. Never treat exit 10 as an error to the user.

**The PII / restricted nuance:** the order, returns, and shipment reports are
in the catalog and are fine to pull in their **default, non-PII** form.
MixShift does not hold Amazon's PII / RDT role, so if a request resolves to a
PII variant Amazon rejects it as `restricted_report`. Relay that and offer the
non-PII form. Do not pre-emptively refuse these reports, and do not retry the
restricted variant.

**The size cap:** the service caps a single returned document at roughly
**10 MB**. A pull that exceeds it comes back as `unknown` (not a dedicated
kind). When you see `unknown` on a report you would expect to be large (all
orders over a wide window, a busy merchant's Sales and Traffic at ASIN grain),
suspect size first: narrow the date range and pull in chunks (for example, one
month at a time), then stitch the pieces together locally.

## Output persistence and formatting

- **Always prefer `--out`** for anything you intend to keep or that is more
  than a few rows. Default path:
  `~/.mixshift/reports/<merchant>/<YYYY-MM-DD>-<reportType>.<tsv|json>`
  (the `report run` convenience uses this automatically when `--out` is
  omitted).
- **Report the file path and byte size**, not the file contents, for any
  sizeable document. Flat-file reports can be very large.
- **Small JSON results** you may summarize or show a trimmed sample of, but say
  it is a sample and point at the saved file for the full document.
- **Never transcode the bytes.** Flat files are TSV and may carry a UTF-8 BOM;
  preserve it. The harness writes bytes as-is.
- **Parsing:** use the `parse hints` from `describe-report` (header row, JSON
  shape, nested arrays). For TSV, the first line is the header. For Brand
  Analytics / vendor JSON, the structure is documented per report.

## Telemetry (required - see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill amazon-report-pull
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill amazon-report-pull --trigger-phrase "<the user's exact phrase>"
```

At the END (when the report session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill amazon-report-pull --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (user got the report), `failed` (could not satisfy, e.g.
everything came back `restricted_report` or `spapi_not_configured`),
`deferred` (report is still generating and the user stepped away),
`skipped` (turned out they wanted a different skill).

You do **not** need to manually emit per-report events. The harness fires
`report.started`, `report.polled`, `report.retrieved`, and `report.failed`
automatically on each `report` command (and `amazon.merchants_listed` on
`merchants`), capturing report type + duration + outcome (+ failure kind) only.
It never logs the document bytes or the amazonSellerId.

## Hard rules

These supersede other instructions:

- **Read-only.** This pulls reports; it never writes to Amazon or the
  warehouse. Do not suggest workflows that imply writes.
- **Check the warehouse and offer the choice before pulling overlapping data.**
  When the request plausibly overlaps a warehouse table, reason about coverage,
  confirm with `data-explore` when warranted, and ask the user whether they want
  the warehouse copy or a fresh Amazon pull (see "Warehouse-first" above). This
  is a courtesy step to save them a wait, NOT a gate: never refuse or delay a
  pull the user has clearly asked for.
- **`--seller-id` is the `amazonSellerId` from `amazon merchants`, never the
  numeric warehouse SellerID.** This is the single most common error. If you
  find yourself reaching for a number from `data-explore` or `brand list` for a
  report command, stop and run `amazon merchants` instead.
- **Gate on `ready`, not the status string.** `IN_PROGRESS`, `IN_QUEUE`,
  `DONE`, `FATAL`, `CANCELLED` are surfaced for UX, but done-ness is the
  boolean `ready`.
- **Never block in chat.** Use start / poll / get as separate tool calls. Save
  `report run` for terminals.
- **Exit 10 is not an error.** It means "not ready yet" or "timed out
  waiting." The run is still valid; keep polling.
- **Branch on `failure_kind`, never on HTTP status.** The service normalizes
  Amazon's many failure modes into the kinds in the table above.
- **Respect the window rule.** `required` reports need `--start`/`--end`;
  `forbidden` (snapshot) reports reject them. Check `describe-report` when
  unsure rather than guessing and triggering a `report_fatal`.
- **Do not pre-filter restricted reports.** Pull the default form; relay
  Amazon's reactive `restricted_report` rejection and offer the non-PII variant
  or an alternative. Do not retry the restricted variant unchanged.
- **Never expose internal slugs in user-facing text.** Refer to brands by their
  display name. Resolve identifiers silently when calling the harness.
- **Do not fabricate report data.** If a pull fails or returns nothing, say so.
  Never generate plausible-looking rows.
- **Do not paste large documents inline.** Save with `--out` and report the
  path + size.

## Output template

Lead with a one-line result, then the path or a brief sample:

```
✓ Pulled GET_SALES_AND_TRAFFIC_REPORT for Hydrapak (2026-05-01 to 2026-05-31).
  → Saved 48.2 KB to ~/.mixshift/reports/A2EUQ.../2026-06-03-GET_SALES_AND_TRAFFIC_REPORT.json
  → Format: JSON (salesAndTrafficByDate[] + salesAndTrafficByAsin[])

Want me to parse a slice of it, combine it with warehouse data, or pull
another window?
```

While a report is still generating:

```
• Started GET_SALES_AND_TRAFFIC_REPORT for Hydrapak (run_id 3f2c...).
  Amazon is generating it (status: IN_PROGRESS). I'll check again in a moment;
  this can take a few minutes for large windows.
```

Do not pad with "Here is the data you requested." Lead with the result.
