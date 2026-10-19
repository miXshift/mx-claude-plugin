---
name: mx-walmart-ads
description: >
  Read and manage Walmart ads (Walmart Connect Sponsored Search, plus Display
  where the account has it) for the Walmart advertisers connected to the
  signed-in MixShift account, straight from Walmart, through the bundled
  harness CLI. The Walmart analogue of mx-amazon-ads: the advertisers you can
  use, campaigns and ad groups with status and budgets, ad items, keywords and
  bids, placement bid multipliers, keyword suggestions, and performance
  reports (spend, clicks, impressions) that MixShift creates, downloads and
  totals for you, for example the last 30 days by campaign. Changes to
  campaigns, ad groups, items, keywords, bids and multipliers preview first
  and never reach Walmart without the user confirming the exact change set.
  Read-first; write only on request. Also runs a guided demo of all this on
  the user's own account (demo Walmart ads). Uses the MixShift plugin sign-in,
  so no separate connector is needed. Does not require brand setup.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - walmart campaigns
  - my walmart ads
  - walmart connect
  - walmart advertisers
  - walmart sponsored search
  - how did my walmart campaigns perform
  - walmart ad performance
  - walmart ad spend
  - walmart keyword bids
  - pause a walmart campaign
  - demo walmart ads
  - walmart ads demo
  - show me a demo of walmart ads
  - walk me through walmart ads
  - tour walmart ads
  - what can you do with walmart
---

# Walmart Ads (Walmart Connect: live account state + previewed changes)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.

## About the Walmart ads surface (authoritative, do not guess)

When characterizing this capability to the user, use these facts:

- **What it is:** direct calls to Walmart Connect, Walmart's advertising API,
  for the Walmart advertisers connected to the signed-in MixShift account.
  Sponsored Search is the main surface (campaigns, ad groups, ad items,
  keywords, bids, placement multipliers, performance reports). Display is in
  the catalog for advertisers that run Display; treat it as available only
  when the advertiser list shows a `display` row and the calls succeed.
- **Routing:** every call goes through the harness CLI
  (`mixshift walmart ads ...`), which talks to MixShift's service at
  `mcp.mixshift.io` with the same sign-in as every other MixShift skill. The
  service holds MixShift's Walmart credential. The plugin never holds Walmart
  secrets, and Claude never sees them. No separate connector is needed.
- **Which advertisers:** MixShift connects each Walmart advertiser to a
  MixShift account. `mixshift walmart ads advertisers` lists the ones this
  sign-in can use. An advertiser that is not on that list cannot be called,
  whatever its id.
- **Not in the warehouse.** MixShift's warehouse (`mx-data-explore`) holds
  Amazon data. Walmart performance comes from Walmart's own reports, through
  this skill.
- **Reads first, writes on request.** Reading account state and pulling
  reports is the everyday use. Changes exist behind a strict preview, confirm,
  commit contract (see "The write contract").

If the user asks "where does this come from," lead with "directly from
Walmart Connect, Walmart's advertising API, through MixShift's service."

If this conversation also has MixShift connector tools named
`walmart_ads_advertisers`, `walmart_ads_operations` and `walmart_ads_call`,
they are the same three calls. Use one path, not both; prefer the CLI below.
When an error message names one of those tools, the CLI equivalent is the
matching `mixshift walmart ads` subcommand.

## When to use this skill

Trigger when the user asks about **Walmart** advertising, for example:

- "List my Walmart advertisers."
- "Show my Walmart campaigns and their status."
- "How did my Walmart campaigns perform over the last 30 days?"
- "What are my keyword bids in this Walmart campaign?"
- "Pause this Walmart campaign." / "Raise the bid on these keywords."
- "Demo Walmart ads." / "Walk me through Walmart ads." Run the Demo section.
- "What can you do with Walmart?" Answer in two lines (read campaigns and
  reports, preview and apply changes) and offer the demo: *say "demo Walmart
  ads" and I'll walk you through it on your own account.*

Route elsewhere:

- **Amazon ads** (Sponsored Products, Brands, Display on Amazon) go to
  `mx-amazon-ads`.
- **Walmart Marketplace** (orders, items, inventory, WFS) is not in this
  skill. Tell the user it is not available in the plugin yet.

## Prerequisites the user needs

| State | How to check | What to do if missing |
|---|---|---|
| Signed in to MixShift | `~/.mixshift/auth/credentials` exists | Run `mixshift auth login` (or say "sign in to MixShift" in chat). Calls fail with `not_authenticated` until then. |
| Walmart enabled for the MixShift account | `mixshift walmart ads advertisers` succeeds | `tenant_not_allowed` (exit 6) means no Walmart advertiser is connected to this MixShift account yet. Tell the user to contact MixShift to connect one. |
| The advertiser connected | It appears in `walmart ads advertisers` | An id that is not listed fails `advertiser_not_allowed` (exit 7). MixShift connects advertisers; the user cannot do it from chat. |
| Write capability (writes only) | The advertiser's `access` is `owner`, and the credential holds `ads:write` | `read` access can preview but not commit. Signed-in user sessions hold `ads:write`; a machine credential without it fails `insufficient_scope` (exit 11). |

Brand setup is **not required.** A signed-in session is enough.

## Step 1: pick the advertiser

```bash
mixshift walmart ads advertisers --json
```

Returns `{ status: "ok", count, advertisers: [...] }`. Each row:

| Field | Meaning |
|---|---|
| `label` | A short name for the advertiser. Use it when talking to the user. |
| `advertiserId` | Pass it as `--advertiser-id` on every call. |
| `api` | `sponsored_search` or `display`. Use `ss.*` operations with Sponsored Search rows and `display.*` operations with Display rows. |
| `environment` | `production` is the real account. `sandbox` is Walmart's test environment with dummy data: never present sandbox numbers as real performance. |
| `access` | `owner` may read, preview and commit. `read` may read and preview only. |

If there is exactly one advertiser, use it. If there are several, ask which
one by `label`. Every call names exactly one `--advertiser-id`.

## Step 2: discovery first, read the notes

```bash
mixshift walmart ads operations                     # every operation, grouped by family
mixshift walmart ads operations --family reports
mixshift walmart ads operations --json
```

Each operation lists its id, method, whether it is a write, the query
parameters it requires, its body shape, and **notes** with the calling
convention and Walmart's own field names. Read the notes before calling. Do
not guess an operation id, a body shape or a field name. Families:
`campaigns`, `ad_groups`, `ad_items`, `keywords`, `bid_multipliers`,
`reports`, `account` (Sponsored Search) and `display`.

## Step 3: the generic call shape

```bash
mixshift walmart ads call <operation> --advertiser-id <id> \
  [--query k=v ...] [--body-file <file> | --body '<json>'] [--commit] [--json]
```

- `<operation>` is an id from `walmart ads operations`, e.g. `ss.list_campaigns`.
- `--query k=v` (repeatable) for query parameters, e.g. `--query campaignId=2000001`.
- `--body-file <file>` passes a JSON body; `--body '<json>'` is for tiny
  payloads. Pass one, not both. Write JSON files without a byte-order mark.
- `--commit` applies a write (see "The write contract"); never on a read.
- `--json` returns the structured result; prefer it when you will parse it.

A read returns
`{ status: "ok", operation, environment, advertiserId, walmart_status, correlationId, payload }`
with Walmart's response verbatim under `payload` and Walmart's HTTP status in
`walmart_status`. `status` is always the CLI's own `ok` or `error`. Quote `correlationId` when
reporting a problem to MixShift: it identifies the call on Walmart's side.

A write returns the same envelope plus `auditId`, the id of this change's row
in MixShift's change log. Previews carry it too, and a committed change also
returns `beforeState` with the entities' values before the change (the
rollback source). Quote `auditId` when discussing a specific change with
MixShift.

MixShift checks every campaign, ad group and keyword id you name against the
advertiser before anything is sent. An id that belongs to a different
advertiser is refused (`advertiser_not_allowed`), so re-list rather than
reuse ids from another account.

## Starter jobs

### "List my Walmart advertisers"

Run `walmart ads advertisers --json` and answer with each advertiser's label,
whether it is Sponsored Search or Display, and whether MixShift can make
changes (`owner`) or only read (`read`). Do not show sandbox rows to a user as
their own accounts.

### "Show my Walmart campaigns and their status"

```bash
mixshift walmart ads call ss.list_campaigns --advertiser-id 1000001 --json
```

`payload` is an array of campaigns: `campaignId`, `name`, `campaignType`,
`targetingType`, `status`, `budgetType`, `dailyBudget`, `totalBudget`,
`startDate`, `endDate`. Lead with the count by status (for example 9 live,
5 paused), then list the campaigns the user cares about with type, targeting
and budget. Ad groups: `ss.list_ad_groups` (optional `--query campaignId=...`).

For a Display advertiser, `display.list_campaigns` is a POST and needs a body
even with no filter: pass `--body '{}'`.

### "How did my Walmart campaigns perform over the last 30 days?"

Three calls. Reports are built by Walmart in the background; MixShift
downloads the finished file and returns its rows, because an agent cannot open
Walmart's report links itself.

1. **Check how fresh the data is:**

   ```bash
   mixshift walmart ads call ss.latest_report_date --advertiser-id 1000001 --json
   ```

   Use the latest `adGroup` date as the end of the window, never a later
   day (Walmart rejects an end date past it, and its data usually trails by
   a day or two), and the start 29 days earlier.

2. **Request the report** with a body file, e.g. `report.json`:

   ```json
   {
     "reportType": "adGroup",
     "startDate": "<YYYY-MM-DD>",
     "endDate": "<YYYY-MM-DD>",
     "reportMetrics": ["date", "campaignId", "adGroupId", "numAdsShown", "numAdsClicks", "adSpend"]
   }
   ```

   ```bash
   mixshift walmart ads call ss.create_report --advertiser-id 1000001 --body-file report.json --json
   ```

   `payload.snapshotId` identifies the report. If `payload.code` is
   `failure`, `payload.details` carries Walmart's reason: fix the body and
   request again.

3. **Download it, totalled by campaign:**

   ```bash
   mixshift walmart ads call ss.download_report --advertiser-id 1000001 \
     --query snapshotId=<snapshotId> --query groupBy=campaignId --json
   ```

   `ready: false` means Walmart is still building the file: wait about a
   minute and call `ss.download_report` again. When `ready` is true the result
   carries `rows` (one per campaign, with each metric summed and a
   `sourceRows` count), `groupCount`, `rowCount` and `truncated`. Rows carry
   `campaignId` only: take campaign names from `ss.list_campaigns`.

Walmart's metric names: `numAdsShown` is impressions, `numAdsClicks` is
clicks, `adSpend` is spend. Walmart rejects the words "impressions" and
"clicks". Click-through rate and cost per click are yours to compute from
those columns. Sales and other attributed metrics have their own Walmart
names: take them from the `docs` link on `ss.create_report`, never guess one.

`groupBy` and `limit` are MixShift's own query parameters: `groupBy` takes one
to five column names (e.g. `groupBy=campaignId` or `groupBy=campaignId,date`)
and `limit` caps the rows returned (default 500, max 5000). Without `groupBy`
you get the raw report rows.

## Demo ("demo Walmart ads")

A guided walkthrough of this skill on the user's own account, following the
demo contract in `shared/skill-runtime-contract.md` ("Demos"): real data, read
first, one screen per step, each step ending with the sentence that runs it
again, and a change only ever shown as a preview. Run it when the user asks for
a demo, tour or walkthrough of Walmart ads, or says yes to the demo you offered.

**Open.** Run the opener and show its output verbatim, then go straight to
step 1:

```bash
mixshift demo mx-walmart-ads
```

The user can say "skip" (next step), "stop" (go to the close), or ask anything
mid-step: answer it, then carry on. If they start real work instead, that is
the demo succeeding; leave it and help them.

### Step 1: Your Walmart advertisers

`mixshift walmart ads advertisers --json`. Say how many advertisers are
connected and, for each, its label, whether it is the live account
(`production`) or Walmart's test environment (`sandbox`), and whether MixShift
can make changes there (`owner`) or only read (`read`).

- Pick one: a `production` Sponsored Search advertiser. If there are several,
  ask which. If there are only sandbox advertisers, use one and say that every
  number in this demo is Walmart's test data.
- A Display-only advertiser: run step 2 with `display.list_campaigns
  --body '{}'`, say the rest of the demo covers Sponsored Search, and close.
- `tenant_not_allowed` (exit 6): no Walmart advertiser is connected to this
  MixShift account yet. Say so, and that MixShift connects them (the user
  sends MixShift the advertiser ID from Walmart Ad Center). Then describe steps
  2 to 5 in one sentence each, with no numbers, and close.

Next time, just say: *"list my Walmart advertisers"*.

### Step 2: Campaigns and their status

`ss.list_campaigns`. Lead with the count by status (for example 9 live, 30
paused, 2 proposals), then the five largest by daily budget: name, status,
manual or auto, budget. Walmart returns statuses capitalized (`Live`,
`Paused`, `Proposal`, `Completed`); compare without case. Keep the list:
steps 3 and 4 need the names.

Next time, just say: *"show my Walmart campaigns and their status"*.

### Step 3: Last 30 days by campaign

The three calls from the starter job above: `ss.latest_report_date`,
`ss.create_report` (adGroup, the last 30 days ending on the latest date), then
`ss.download_report` with `groupBy=campaignId`. Show the five campaigns with
the most spend: spend, clicks, impressions, click-through rate and cost per
click, with names from step 2. If the file is still building after about two
minutes, say so, do step 4, and come back to it before step 5.

Next time, just say: *"how did my Walmart campaigns perform over the last 30 days?"*

### Step 4: Inside one campaign

Take the campaign with the most spend in step 3 (or the first live one if the
report had no rows). `ss.list_ad_groups --query campaignId=<id>`, then:

- a manual campaign: `ss.list_keywords --query campaignId=<id>`, the five
  highest bids with match type;
- an auto campaign (no keywords): `ss.list_ad_items --query campaignId=<id>`,
  the items with their bids.

Next time, just say: *"what are my keyword bids in <campaign>?"*

### Step 5: One change, shown as a preview

Propose one small, concrete change from what the user just saw, for example
that campaign's daily budget up 10% (`ss.update_campaigns`), or, for a
campaign with a total budget and no daily one, one keyword's bid down 5 cents
(`ss.update_keywords` with `--query campaignId=<id>`). Run it as a preview, with NO
`--commit` (the write contract, step 2). Show the current value and the new
one, and say nothing was sent to Walmart. Then say how applying works: with
`owner` access they say "apply it" and confirm; with `read` access the change
is made from the advertiser's own MixShift sign-in or in Ad Center.

- **The demo never commits on a production advertiser.** If the user says to
  apply it, the demo ends there and the write contract takes over: their yes
  to this exact preview is the confirmation, and only that change is sent.
- **A sandbox advertiser with `owner` access** (MixShift's own Walmart test
  advertisers) may walk the full build instead. Preview and confirm each write
  before its `--commit`, per the write contract:
  1. a manual campaign (paused unless the user says otherwise);
  2. an ad group in it;
  3. two items from `ss.search_items`, at a bid;
  4. three keywords from `ss.keyword_suggestions`, as exact match;
  5. raise the campaign's budget;
  6. set the Buy-Box placement multiplier.

  Say that Walmart's sandbox data is dummy data.

Next time, just say: *"raise the daily budget on <campaign> to $<amount>"*.

### Close

Recap the "next time" sentences from the steps the user saw. Add two or three
more they can try:

- "run the Walmart item health report";
- "keyword performance for the last 30 days";
- "export all my Walmart campaigns, ad groups, keywords and items".

Ask what they want to do now. Then record how far the demo got:

```bash
mixshift demo mx-walmart-ads --finished --steps-shown <n>
```

## The write contract (preview by default, confirm, then commit)

Operations with `write: true` change the account. They follow one strict
contract, every time:

1. **Build the change set.** Resolve current ids and values first with the
   matching list operation (`ss.list_campaigns`, `ss.list_ad_groups`,
   `ss.list_ad_items --query campaignId=...`,
   `ss.list_keywords --query campaignId=...`,
   `ss.list_placement_multipliers --query campaignId=...`). Write the items to
   a JSON body file in the operation's cataloged shape (most writes take an
   ARRAY), with only the fields you are changing. At most 100 items per call.
2. **Preview it (the default; nothing reaches Walmart).** Run the write with
   NO `--commit`:

   ```bash
   mixshift walmart ads call ss.update_campaigns --advertiser-id 1000001 \
     --body-file change.json --json
   ```

   The service checks the request and returns
   `{ dryRun: true, preview, message }` without sending anything. The preview
   carries no current values, so take them from the list call in step 1.
3. **Show the user each change from its current value to the new one** and ask
   for explicit confirmation of this exact change set. Never include an item
   that was not in the confirmed set.
4. **Only after the user confirms, in a SEPARATE turn, re-run the SAME command
   with `--commit`.** The user's original request ("pause that campaign")
   authorizes the preview, not the change. Never preview and commit in the
   same turn:

   ```bash
   mixshift walmart ads call ss.update_campaigns --advertiser-id 1000001 \
     --body-file change.json --commit --json
   ```

5. **Report the result per item.** Walmart answers with an array of
   `{ code: "success" | "failure", details, ... }`, one per item. Partial
   failure is normal: give both counts ("8 of 10 applied, 2 failed") and each
   failure's `details`. Keep the values you showed in step 3 in your reply:
   they are how the user reverts. The reply also carries `auditId`, the id of
   this change in MixShift's change log: include it when reporting the result.
   It is the handle for audit and rollback, and `beforeState` in the same
   reply holds the entities' values from before the change.

Rules for specific writes:

- **New campaigns start paused** (`"status": "paused"`) unless the user says
  otherwise: a live campaign spends money.
- **Keyword changes** (`ss.update_keywords`) also take
  `--query campaignId=<id>` naming the keywords' campaign; MixShift uses it to
  check the keywords and does not send it to Walmart.
- **An item cannot be deleted from a live campaign**: disable it
  (`ss.update_ad_items` with `"status": "disabled"`).
- **`read` access refuses `--commit`** with `advertiser_not_allowed`. The
  preview still works, so show it and tell the user the change has to be made
  from the advertiser's own MixShift sign-in or in Walmart's Ad Center.

## Reactive error handling (branch on failure_kind, never on HTTP status)

A failure in `--json` carries `failure_kind`, `message` (safe to show the
user), and sometimes `detail`, `http_status`, `advertiser_id`,
`required_scope` or `audit_id`. Each kind has its own exit code.

**Check `request_outcome` first.** `request_outcome: "unknown"` means the
answer was lost after the request went out, so a commit or a report request
may already have happened. Never resend blindly: re-list the entities a
commit targeted and compare before sending again. A report request resent
makes a second report: resend at most once. Reads are always safe to retry.
A write failure that carries `audit_id` names its record in MixShift's
change log: quote it when asking MixShift about the change.

| `failure_kind` | Exit | What it means / what to tell the user |
|---|---|---|
| `not_authenticated` | 2 | Not signed in. Run `mixshift auth login`. |
| `session_expired` | 2 | The session could not be refreshed. Run `mixshift auth login` again. |
| `tenant_not_allowed` | 6 | No Walmart advertiser is connected to this MixShift account. Contact MixShift to connect one. Stop. |
| `walmart_not_configured` | 6 | Walmart is not set up on MixShift's service. Contact MixShift. Stop. |
| `advertiser_not_allowed` | 7 | Read `message`: the advertiser is not connected to this account (re-run `walmart ads advertisers` and use a listed id), MixShift's access is read-only (no commits), the report covers every advertiser and is not available, or an id belongs to a different advertiser (re-list). |
| `not_found` | 7 | Walmart has no such record. Re-list the ids and try again. |
| `throttled` | 8 | Walmart is rate-limiting. Its limits are hourly; wait and retry. `ss.api_usage` shows calls made in the last hour. |
| `insufficient_scope` | 11 | This credential cannot make changes (needs `ads:write`). Hand the user the change list. Do not retry. |
| `bad_request` | 12 | MixShift or Walmart rejected the request as sent: a missing parameter, a wrong body shape, an unknown operation. Fix it from the notes and resend; never retry unchanged. If the catalog notes led you to it, suggest `mixshift feedback`. |
| `upstream_auth` | 14 | Walmart refused MixShift's access for this advertiser. Nothing the user can fix in chat: tell them to contact MixShift. Do not retry. |
| `upstream_unavailable` | 1 | Walmart's side failed. Retry a read later. A commit with `request_outcome: "unknown"` may or may not have applied: re-list the entity to check before resending; its `audit_id` names the change-log record. |
| `host_unreachable` | 1 | MixShift's service did not answer. Check `request_outcome`; otherwise retry shortly. |
| `unknown` | 1 | Unexpected. Check `request_outcome`; otherwise retry once and relay the message. |

An access or sign-in failure (`not_authenticated`, `session_expired`,
`tenant_not_allowed`, `upstream_auth`) stops the whole plan, not just the call
that hit it. Report it once with the remedy; do not walk the rest of a change
set into the same wall.

Display advertisers: some Display operations can answer with a permission
error that only Walmart can lift. Tell the user that part is not available
for their account yet; do not retry.

## Hard rules

- **Reads are safe; writes are gated.** A change NEVER reaches Walmart without
  a preview the user saw and their explicit confirmation of that exact change
  set, in a separate turn, then `--commit`.
- **An upfront instruction is not commit authorization.** "Pause those
  campaigns" authorizes the preview only.
- **One advertiser per call**, always by `--advertiser-id` from
  `walmart ads advertisers`.
- **Never present sandbox data as real performance.**
- **Never guess operation ids, field names or metric names.** Read the notes;
  follow the `docs` link when the notes do not name what you need.
- **Partial failure is normal on commits.** Report successes and failures both.
- **Branch on `failure_kind`, never on HTTP status.**
- **Do not fabricate account data.** If a call fails or returns nothing, say
  so. Never invent campaigns, bids, spend or counts.

## Output template

Lead with the result. For a read:

```
Walmart campaigns for Example Brand (Sponsored Search): 14 total, 9 live, 5 paused.
  - Brand - Auto: live, daily budget $50
  - Category - Manual: live, daily budget $120
  ...
Want the last 30 days of spend and clicks by campaign?
```

For a report:

```
Walmart Sponsored Search, Sep 13 to Oct 12, by campaign (8 campaigns with delivery):
  - Brand - Auto: $1,240 spend, 3,100 clicks, 410,000 impressions (CTR 0.76%, CPC $0.40)
  ...
```

For a write, always show the preview and ask before committing:

```
Preview - ss.update_campaigns (Example Brand): 2 changes, nothing sent to Walmart yet.
  - "Brand - Auto": live -> paused
  - "Category - Manual": daily budget $120 -> $90

These are the only two changes. Confirm and I will apply them, or tell me what to adjust.
```

After a commit:

```
Applied ss.update_campaigns (Example Brand): 2 of 2 succeeded.
  Previous values, in case you want to revert: "Brand - Auto" was live; "Category - Manual" was $120/day.
```

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-walmart-ads
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-walmart-ads --trigger-phrase "<the user's exact phrase>"
```

At the END (when the session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-walmart-ads --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (the user got the Walmart data they wanted, or a change
committed as confirmed), `failed` (could not satisfy, e.g.
`tenant_not_allowed`), `deferred` (a change is waiting for the user's
confirmation, or a report is still building and the user stepped away),
`skipped` (they wanted a different skill, e.g. Amazon ads).

You do **not** need to emit per-call events. The harness fires
`walmart.ads.called` (plus `walmart.ads.advertisers_listed` and
`walmart.ads.operations_listed`) on each `walmart ads` command, with the
operation id, advertiser id, environment and outcome. It never records the
payload, the request body, or report rows.
