---
name: mx-walmart-retail
description: >
  Read your Walmart Marketplace seller account for the Walmart sellers
  connected to the signed-in MixShift account, straight from Walmart, through
  the bundled harness CLI. Gives one view per SKU of what is selling, what you
  have, what is inbound, how many days of supply you have left and what to
  reorder (units sold over 2, 7, 30 and 60 days, available, reserved, inbound
  and on-hand stock in Walmart Fulfillment Services, days of supply, Walmart's
  suggested units), plus orders by date window, items, inventory, WFS
  inventory and inbound shipments. Use it for "what is selling on Walmart",
  "what do we have in stock", "what is inbound", "how long will it last",
  "what should we reorder", "show my Walmart orders", "list my Walmart items",
  and "connect my Walmart seller account". Read only: price, inventory and
  order changes are made in the MixShift app, never from Claude. Uses the
  MixShift plugin sign-in, so no separate connector is needed. Does not
  require brand setup.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - walmart marketplace
  - my walmart sellers
  - walmart seller account
  - walmart inventory
  - walmart wfs inventory
  - walmart days of supply
  - what should i reorder on walmart
  - what is selling on walmart
  - walmart sales by sku
  - walmart orders
  - walmart items
  - walmart inbound shipments
  - how long will my walmart stock last
  - walmart sku snapshot
  - what do we have on walmart
  - connect my walmart seller account
---

# Walmart Marketplace (per-SKU sales, stock, inbound, days of supply, reorder)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.

## About the Walmart Marketplace surface (authoritative, do not guess)

When characterizing this capability to the user, use these facts:

- **What it is:** direct reads of the Walmart Marketplace seller API for the
  Walmart sellers connected to the signed-in MixShift account: orders, items,
  inventory, Walmart Fulfillment Services (WFS) inventory, inbound shipments,
  and a per-SKU snapshot that puts sales, stock, inbound and days of supply on
  one line.
- **Read only.** This skill never changes anything at Walmart. Price,
  inventory and order changes (acknowledge, ship, cancel) are made in the
  MixShift app. If the user asks Claude to make one, say so plainly and point
  them there. The CLI refuses any operation marked as a change before sending
  anything.
- **Routing:** every call goes through the harness CLI
  (`mixshift walmart marketplace ...`), which talks to MixShift's service at
  `mcp.mixshift.io` with the same sign-in as every other MixShift skill. The
  plugin never holds Walmart secrets and Claude never sees them.
- **Which sellers:** a seller is connected to a MixShift account by the seller
  themselves (see "Connecting a seller"). `mixshift walmart marketplace
  sellers` lists the ones this sign-in can read. A seller that is not on that
  list cannot be called, whatever its id.
- **Not in the warehouse.** MixShift's warehouse (`mx-data-explore`) holds
  Amazon data. Walmart seller data comes live from Walmart through this skill.
- **Ads are a different skill.** Walmart advertising (campaigns, bids,
  reports) is `mx-walmart-ads`.

If the user asks "where does this come from," lead with "directly from your
Walmart seller account, through MixShift's service."

## When to use this skill

Trigger when the user asks about their **Walmart seller account** (not ads),
for example:

- "What is selling on Walmart?" / "What do we have in stock?" / "What is
  inbound?" / "How long will it last?" / "What should we reorder?"
- "Show my Walmart orders from last week."
- "List my Walmart items." / "What is the inventory on SKU ABC-1?"
- "Which Walmart sellers are connected?" / "Connect my Walmart seller account."

Route elsewhere:

- **Walmart ads** go to `mx-walmart-ads`.
- **Amazon** inventory, orders and shipments go to `mx-amazon-retail`
  (or `mx-amazon-inbound` flows).
- **Changing** a price, inventory count or order: the MixShift app.

## Prerequisites the user needs

| State | How to check | What to do if missing |
|---|---|---|
| Signed in to MixShift | `~/.mixshift/auth/credentials` exists | Run `mixshift auth login` (or say "sign in to MixShift" in chat). |
| Marketplace enabled for the MixShift account | `mixshift walmart marketplace sellers` succeeds | `tenant_not_allowed` (exit 6): not enabled for this account yet. Tell them to ask MixShift at support@mixshift.io. |
| A seller connected | It appears in `walmart marketplace sellers` | See "Connecting a seller". It cannot be done from chat. |

Brand setup is **not required.**

## Connecting a seller

The seller connects themselves; nobody waits on MixShift. In plain words
(these are steps on the web, not commands):

1. A **Seller Center admin** for the Walmart seller account opens
   https://mcp.mixshift.io/walmart/marketplace/connect.
2. They sign in with their MixShift account.
3. They approve MixShift on Walmart's own screen.

They can disconnect at any time from the same place or from Walmart Seller
Center. Nothing changes in the plugin: no update, no new sign-in. Never say a
seller is connected until `walmart marketplace sellers` lists it.

## Step 1: pick the seller

```bash
mixshift walmart marketplace sellers --json
```

Returns `{ status: "ok", count, sellers: [...] }`. Each row has `sellerId`,
`environment`, `label` and `scopes`. Use `label` when talking to the user and
pass `sellerId` as `--seller` on every call. `production` is the real account;
`sandbox` is Walmart's test environment with dummy data: never present sandbox
numbers as real. If a seller is connected in both environments, pass
`--environment production` (or `sandbox`). If there is one seller, use it; if
several, ask which by `label`.

## Step 2: the generic call shape

```bash
mixshift walmart marketplace operations                # the catalog, grouped by family
mixshift walmart marketplace operations --family <name>
mixshift walmart marketplace call <operation> --seller <id> \
  [--environment production|sandbox] [--query '<json>'] [--path '<json>'] [--json]
```

- Read the operation's **notes** before calling; do not guess an operation id,
  a parameter name or a field name.
- `--query` and `--path` take a JSON object, e.g. `--query '{"sku":"ABC-1"}'`.
- A read returns `{ status: "ok", operation, environment, sellerId,
  walmart_status, ... }` with Walmart's response under `payload` where the
  service sends one. `status` is always the CLI's own `ok` or `error`;
  Walmart's HTTP status is `walmart_status`.
- Operations the catalog marks as a write are refused with `write_refused`.
  There is no commit flag here by design.

## Starter jobs

### "What is selling, what do we have, what is inbound, how long will it last, what should we reorder?"

This is the headline job: the SKU snapshot, one line per SKU.

```bash
mixshift walmart marketplace call mp.sku_snapshot --seller 1234567890 --json
```

For one SKU, add `--query '{"sku":"ABC-1"}'`. **This call can take up to about
90 seconds** while MixShift gathers orders and WFS inventory: tell the user it
is working, and do not start a second copy while it runs. (The CLI waits up to
150 seconds.)

Per SKU the snapshot carries: units sold over 2, 7, 30 and 60 days, average
daily units, orders over 60 days, and, when the seller uses Walmart
Fulfillment Services, available, reserved, inbound, on hand, days of supply,
Walmart's suggested units and Walmart's forecast. It also carries `complete`,
`warnings` and `counted`. Take exact field names from the response and from
`mixshift walmart marketplace operations` notes; never rename or invent them.

Present it **summary first, then detail**:

1. **One-paragraph summary:** how many SKUs, how many are at risk. The biggest
   risks are SKUs with low days of supply and SKUs where Walmart's suggested
   units is above zero. Name the worst few, with days of supply and suggested
   units.
2. **A per-SKU table**, riskiest first (lowest days of supply, then highest
   suggested units): SKU, sold 7 / 30 / 60 days, average per day, available,
   inbound, on hand, days of supply, suggested units.
3. **Then the detail** the user asks for: reserved units, orders over 60 days,
   Walmart's forecast, a single SKU.

Rules for honest numbers:

- **Check `complete` and `warnings` before you state anything.** If `complete`
  is false, say which part is partial and that the totals may be low. Relay
  every warning in plain words.
- **A seller without WFS** has wfs null and a warning. Show sales only, say
  that stock, inbound and days of supply need Walmart Fulfillment Services,
  and do not compute days of supply yourself from a different stock source.
- **Days of supply is Walmart's number** (or the service's). Do not recompute
  it silently. If you derive anything (for example units sold per day over a
  different window), label it as your calculation.
- A SKU that is not in the snapshot is not "zero sales": say it was not
  counted, and use `counted` to say how many were.
- Never present sandbox numbers as real.

If the user asks "what should we reorder," answer from suggested units and
days of supply, show the reasoning (sold per day, stock, inbound), and say the
number is a starting point from Walmart's own suggestion, not a purchase order.
Placing the reorder happens outside Claude.

### "Show my Walmart orders"

```bash
mixshift walmart marketplace operations --family orders
mixshift walmart marketplace call mp.list_orders --seller 1234567890 \
  --query '{"createdStartDate":"2026-10-01","createdEndDate":"2026-10-07"}' --json
```

Use the parameter names from the operation's notes (the example shows the
shape only). Always state the date window you used. Lead with the count and
status mix, then the orders the user cares about. Page through results only as
far as the user needs, and say when you stopped.

### "List my Walmart items"

```bash
mixshift walmart marketplace call mp.list_items --seller 1234567890 --json
```

Lead with the count and the publish or lifecycle status mix, then the items
the user asks about. Large catalogs come back in pages; say how many you read.

### "What is my inventory?" / "WFS inventory" / "What is inbound?"

Find the right operations with `walmart marketplace operations` (inventory
operations such as `mp.wfs_inventory`, and inbound shipment operations if the
catalog lists them). For a combined sales, stock and inbound picture across
SKUs, prefer `mp.sku_snapshot`. Use the single inventory and shipment reads
when the user wants the raw record for one SKU or one shipment.

### "Which sellers are connected?"

Run `walmart marketplace sellers --json` and answer with each label,
production or sandbox, and what it can read. If none is connected, give the
steps in "Connecting a seller".

## Reactive error handling (branch on failure_kind, never on HTTP status)

A failure in `--json` carries `failure_kind`, `message` (safe to show),
and sometimes `detail`, `http_status`, `walmart_status`, `seller_id`,
`required_scope`, `fix`, `source`, `retryable`. Each kind has its own exit
code. These are reads, so retrying a read is always safe.

| `failure_kind` | Exit | What to tell the user |
|---|---|---|
| `not_authenticated` / `session_expired` | 2 | Not signed in, or the session ended. Run `mixshift auth login`. |
| `tenant_not_allowed` | 6 | Walmart Marketplace is not turned on for this MixShift account yet. Ask MixShift at support@mixshift.io. Stop. |
| `walmart_not_configured` | 6 | Marketplace is not set up on MixShift's service. Contact MixShift. Stop. |
| `seller_not_allowed` | 7 | That seller is not connected to this MixShift account. Re-run `walmart marketplace sellers` and use a listed id, or give the steps in "Connecting a seller". |
| `not_found` | 7 | Walmart has no such record. Re-check the SKU, order or item id. |
| `throttled` | 8 | Walmart is rate-limiting. Wait a minute and try again. |
| `insufficient_scope` | 11 | This sign-in is not allowed to read that data. Ask the MixShift account admin to grant it. |
| `write_refused` | 11 | That operation changes the account. Claude only reads; make the change in the MixShift app. |
| `bad_request` | 12 | Walmart rejected the request as sent. Fix it from the operation notes and Walmart's answer (`walmart_response`); do not resend unchanged. |
| `upstream_auth` | 14 | Walmart refused. If `walmart_status` is 401 or 403, Walmart refused **this one read** for this seller: they did not grant that permission, and the connection itself is fine. Say which read, carry on with the other reads, and do not tell them to reconnect. Only if every read is refused, suggest they reconnect at https://mcp.mixshift.io/walmart/marketplace/connect or contact support@mixshift.io. |
| `invalid_request` | 15 | MixShift refused the request before sending anything: an unknown operation, a missing parameter, a wrong shape. Read the message, check `operations`, fix it; never resend unchanged. |
| `upstream_unavailable` | 1 | Walmart is not answering right now. This is on Walmart's side: **the seller does not need to reconnect.** Try again in a minute. |
| `host_unreachable` / `unknown` | 1 | MixShift's service did not answer, or an unexpected error. Retry once, then relay the message. Never loop. |

A sign-in or access failure (`not_authenticated`, `session_expired`,
`tenant_not_allowed`, `seller_not_allowed`) stops the whole plan: report it
once with the remedy. A refused single read (`upstream_auth` with a 401 or
403) does not.

## Hard rules

- **Read only.** Never try to change prices, inventory or orders. Point the
  user to the MixShift app.
- **One seller per call**, always by `--seller` from `walmart marketplace
  sellers`.
- **Never present sandbox data as real.**
- **Never guess operation ids, parameters or field names.** Read the notes.
- **Do not fabricate account data.** If a call fails or returns nothing, say
  so. Never invent SKUs, units, stock or days of supply.
- **State completeness.** Relay `complete`, `warnings` and `counted` honestly.
- **Branch on `failure_kind`, never on HTTP status.**
- No Walmart logos, and no claims of a Walmart partnership or endorsement.

## Output template

Lead with the result:

```
Example Seller (production): 42 SKUs counted. 5 need attention.
  - ABC-1: 6 days of supply, Walmart suggests 400 units
  - ABC-9: 9 days of supply, 120 units inbound, Walmart suggests 150 units
  ...

| SKU   | Sold 7d | Sold 30d | Avg/day | Available | Inbound | Days of supply | Suggested |
|-------|---------|----------|---------|-----------|---------|----------------|-----------|
| ABC-1 | 210     | 880      | 29.3    | 175       | 0       | 6              | 400       |
```

If the snapshot is partial, say so on the first line ("Partial: orders for the
last 60 days could not all be read, so sold units may be low").

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-walmart-retail
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-walmart-retail --trigger-phrase "<the user's exact phrase>"
```

At the END (when the session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-walmart-retail --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (the user got the Walmart data they wanted), `failed` (could
not satisfy, e.g. `tenant_not_allowed`), `deferred` (waiting on the seller to
connect), `skipped` (they wanted a different skill, e.g. Walmart ads).

You do **not** need to emit per-call events. The harness fires
`walmart.marketplace.called` (plus `walmart.marketplace.sellers_listed` and
`walmart.marketplace.operations_listed`) on each `walmart marketplace` command,
with the operation id, seller id, environment and outcome. It never records the
payload or query values.
