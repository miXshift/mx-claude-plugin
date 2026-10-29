---
name: mx-amazon-inbound
description: >
  Walk an FBA inbound shipment from start to finish, one confirmed step at a
  time: create the plan, packing, placement, carrier, labels and tracking, or
  cancel a plan. Every fee Amazon would charge (placement, a partnered
  carrier, a late cancel) is shown to you first and committed only after you
  say yes, and a repeated request never sends the same step twice. Also the
  look-up side for everyone: plan and shipment status, tracking, past boxes
  reused as case-pack templates, and prep details. Building or changing a
  shipment needs a MixShift service credential with shipment write access,
  which your MixShift admin creates; a normal plugin sign-in gets the look-up
  side plus a plain explanation of what to ask the admin for. Triggers:
  create an inbound shipment, send inventory to FBA, confirm placement,
  cancel an inbound plan, reuse box contents.
metadata:
  version: "0.1.0"
  author: "MixShift"
trigger_phrases:
  - create an inbound shipment
  - create an fba shipment
  - build an fba shipment
  - send inventory to fba
  - send inventory to amazon
  - new inbound plan
  - create an inbound plan
  - set packing information
  - confirm placement
  - confirm the placement option
  - confirm the carrier for my shipment
  - print fba box labels
  - add tracking to my inbound shipment
  - cancel an inbound plan
  - reuse past box contents
  - case pack from a past shipment
  - prep details for my skus
---

# FBA inbound shipment walk (look up, build, confirm, label, cancel)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.

## About this skill (authoritative, do not guess)

- **What it is:** a guided walk over Amazon's FBA inbound shipment API
  (`fulfillment_inbound.*`, version 2024-03-20), through `mixshift amazon call`.
  Amazon's own inbound plan is the only state: every step is its own call and
  you walk them in Amazon's order. Nothing is stored by MixShift except an audit
  record of each step.
- **Two halves.** The **look-up half** (Part A) is read-only and works for any
  signed-in user. The **build half** (Part B) creates and changes a real plan on
  Amazon and can commit Amazon fees. It needs a service credential with
  shipment write access (see "Step 0"). The plugin's normal sign-in cannot do
  it.
- **Not duplicated here:** the full tour of the look-up operations, their
  paging and their gotchas lives in `mx-amazon-retail` (section "Fulfillment
  Inbound (2024-03-20)"). This skill reuses it; when Part A needs more than the
  recipes below, read that section.
- **Which shipments:** this walk is for ordinary FBA inbound. Amazon Warehousing
  and Distribution (AWD) is a different program; AWD plans show up in the plan
  list but cannot be read or built here (see "Boundaries").
- Say "directly from Amazon" when asked where data comes from. Amazon holds the
  plan; MixShift passes your step through.

## When to use this skill

- "Where is my inbound shipment / is it received yet / what is the tracking?"
  (Part A)
- "Reuse the boxes from last month's shipment" (Part A, then Part B step 2)
- "Create an inbound shipment for these SKUs" / "send 600 units of X to FBA"
  (Part B)
- "Confirm the placement", "pick the carrier", "print the box labels", "add
  tracking", "cancel that plan" (Part B)

Not for: AWD (`mx-amazon-retail` covers the AWD reads), listing edits, or
anything outside inbound shipments.

## Step 0: what kind of sign-in is this? (do this before any Part B step)

Run:

```bash
mixshift auth status --json
```

**Look for the shipping credential folder first.** A normal sign-in and a
shipping service credential live side by side, and a plain `auth status` only
shows the normal one (it wins). So before you conclude from `credential: human`
that the user has no write access, check whether `.mixshift-shipping` exists in
the working folder or the user's home folder, and if it holds `auth/credentials`,
run `MIXSHIFT_DATA_DIR=<that folder> mixshift auth status --json` as well. If
that says `service`, use that folder for every Part B command (see below) and
treat the user as having a service credential.

Then read `credential` (from the folder that applies):

- **`human`** (a normal plugin sign-in). Part A works. Part B does not: Amazon
  shipment writes need a service credential that carries shipment write access,
  and a personal sign-in never does. Say so plainly, in the user's terms, and do
  not attempt any write call (it would only fail). Use this wording:

  "Your sign-in lets me look up your shipments, tracking and past boxes, but
  not build or change one. To build a shipment from here, ask your MixShift
  admin for a service credential with shipment write access. They create it in
  the MixShift admin page and tick the shipment write box (it is off by
  default). They then send you a one-time setup code, and I can finish the
  setup with you in a minute. Until then I can do everything on the look-up
  side. Want to start there?"

  If they have a setup code, set it up as `mx-auth-service-setup` describes
  (Steps 0 to 2), with ONE difference that matters here: **a personal sign-in on
  the same machine wins over a service credential, so install the service
  credential in its own folder** and run every Part B command with that folder:

  ```bash
  MIXSHIFT_DATA_DIR="<a folder you created for this, e.g. <workspace>/.mixshift-shipping>" \
    mixshift auth service-setup --setup-code <the code> --json
  ```

  Name the folder `.mixshift-shipping` so the next session can find it. It holds
  a secret: **keep it out of version control.** If you create it inside a
  workspace that is a git repository, add `.mixshift-shipping/` to that repo's
  `.gitignore` (or put the folder in the user's home folder instead), and tell
  the user why in one sentence.

  Then run every Part B command (and `auth status`) with the same
  `MIXSHIFT_DATA_DIR=` prefix. Confirm `auth status` now says `service`. Keep
  using the normal sign-in, with no prefix, for Part A.
- **`service`**: the credential may or may not include shipment write access;
  `auth status` cannot tell. The first Part B call (the dry run of the create,
  which sends nothing and costs nothing) is the check. If it fails with
  `failure_kind: insufficient_scope`, give the same message as the `human` case
  ("this credential cannot build shipments; ask your admin for one with
  shipment write access") and stop Part B.
- **`none`** or `signed_in: false`: sign in first (`mx-auth-login`).
- **`legacy_mysql`**: not usable for Amazon calls; sign in with `mx-auth-login`.

Also: `failure_kind: shipping_write_disabled` or `shipping_write_not_enabled`
means shipment building is switched off for this account right now. Tell the
user it is not available yet and to contact MixShift; never retry.

Pick the merchant once, for the whole walk:

```bash
mixshift amazon merchants --json
```

Use `--legacy-seller-id <id>` (or `--seller-id`) on every call below when the
account has more than one marketplace row, and say which marketplace you are
building in.

## Call shapes used throughout

Reads and dry runs (nothing is sent to Amazon beyond a read):

```bash
mixshift amazon call <operation> --path inboundPlanId=<wf...> [--query k=v] \
  [--body-file <file>] --json
```

A commit (Part B only) adds `--commit`, and for a fee-committing step the
preview's id and hash, and always an idempotency key:

```bash
mixshift amazon call <operation> --path inboundPlanId=<wf...> [--body-file <file>] \
  --commit --preview-id <previewId> --approved-quote-hash <quoteHash> \
  --idempotency-key <key> --json
```

- **Without `--commit`, a write is a dry run.** Nothing reaches Amazon. For a
  fee-committing step the dry run also records a one-time preview and returns
  its `previewId` and `quoteHash` under `write` in the `--json` output.
- **Write request bodies go in a file** (`--body-file`), written with your
  file-writing tool. Never build JSON inline in a shell command.
- **Ids:** plan `wf...`, shipment `sh...` (what every shipment-level call
  takes), the `FBA...` shipment id only for labels and the bill of lading.
  Ids are 38 characters; copy them exactly from the previous answer.
- **Every commit carries an idempotency key** (8 to 128 letters, digits,
  `. : - _`). See "Idempotency".

### Idempotency (every commit, no exceptions)

A repeated commit with the same key is answered from the first one and never
reaches Amazon twice. So:

0. `--commit` is refused by the CLI without `--idempotency-key`, so the key is
   not optional.
1. Make a fresh key for each intended commit, before you send it, and keep it in
   the conversation: `<short-plan-label>-<step>-<8 random characters>`, for
   example `reorder-placement-k3x9q2ab`. For the create, there is no plan id
   yet: `create-<date>-<8 random characters>`.
2. If the answer to a commit is lost (timeout, `host_unreachable`, `outcome:
   UNCERTAIN` or `PENDING`), resend the IDENTICAL command with the SAME key. You
   get the first commit's result, marked `replayed: true`. Do not make a new key
   and do not re-preview.
   **Keep a running note of every key** (step, plan id, key, and whether it
   was sent) in a small working file with your file-writing tool, so a long walk
   or a resumed conversation can still resend the same key instead of inventing
   a new one. Delete the working files (request bodies, the note) when the walk
   is done, unless the user wants them.
3. Use a NEW key only when the request itself is new: a corrected body, or a
   fresh preview after the old one was refused or expired. Never reuse a key for
   a different request (`idempotency_key_conflict`).
4. A replay that reports `FAILED` applied nothing; fix the cause, then use a new
   key.

### Reading a commit's result

The answer carries `outcome`: `DONE` (Amazon reported success), `IN_PROGRESS` or
`ACCEPTED` (Amazon took it and is still working: not done), `FAILED`, `PENDING`
or `UNCERTAIN`. Only `DONE` means the step happened.

- `IN_PROGRESS` / `ACCEPTED`: poll
  `mixshift amazon call fulfillment_inbound.get_inbound_operation_status --path operationId=<operationId> --json`
  every few seconds (steps take 3 to 15 seconds in practice) until
  `operationStatus` is `SUCCESS` or `FAILED`. Do not start the next step before
  `SUCCESS`.
- `FAILED`: show `operationProblems` in plain words and stop that step.
- `operationProblems` can carry a **WARNING on a step that still succeeded**. The
  one seen in practice is `FBA_INB_0166` on setting box contents: a box is under
  Amazon's expected minimum volume. Report it as a warning, ask whether the
  box dimensions are right, and carry on only if the user says so. It is not a
  failure.
- A commit the CLI reports as `status: uncertain` (exit code 21) is an
  `UNCERTAIN` / `PENDING` outcome; `status: failed` is `FAILED`. Neither is
  success. A failed call whose `--json` shows `request_outcome: unknown` (a
  timeout, a dropped connection or a gateway error during a commit) means the
  same thing as `UNCERTAIN`, even though the failure kind may read
  `host_unreachable`. Do not tell the user to "try again in a minute".
- `UNCERTAIN` / `PENDING`, or a failure that says `request_outcome: unknown`:
  Amazon may or may not have applied it. **Do not send it again as a new
  request.** Resend with the same key (rule 2), or read the plan first
  (`get_inbound_plan`). For a create whose answer was lost, see step 1: replay
  with the same key first.

---

## Part A: look up (read-only, everyone)

All of these are reads. `mx-amazon-retail` has the full operation notes; these
are the recipes.

### A1. What plans and shipments do I have, and where are they?

```bash
mixshift amazon call fulfillment_inbound.list_inbound_plans --query pageSize=30 --json
mixshift amazon call fulfillment_inbound.list_inbound_plans --query status=SHIPPED \
  --query sortBy=LAST_UPDATED_TIME --query sortOrder=DESC --json
```

- **No `status` returns ACTIVE plans only.** Pass `status=SHIPPED` for shipped
  plans and `status=VOIDED` for voided ones; each is its own paged list.
- Page with `--query paginationToken=<pagination.nextToken>` until it is absent.
- Then `get_inbound_plan --path inboundPlanId=<wf...>` for the plan and its
  shipments (`shipmentId`, `status`). **If it answers `bad_request` "not
  supported for Amazon Warehousing and Distribution inbound plans", that is an
  AWD plan: skip it quietly and say "N of these are AWD plans, which I can't
  open here".** Never report it as an error.
- Then `get_shipment --path inboundPlanId=<wf...> --path shipmentId=<sh...>`:
  status, destination warehouse, delivery windows, tracking, and
  `shipmentConfirmationId` (the `FBA...` id).

### A2. Tracking

Tracking is only what was entered on the shipment, so it is often empty
(typically only own-carrier freight has it). Read it from `get_shipment`:
small parcel is `trackingDetails.spdTrackingDetail.spdTrackingItems[]`, freight
is `trackingDetails.ltlTrackingDetail` (`freightBillNumber` is the PRO). If it
is absent, say "no tracking recorded on this shipment"; never infer a number.
The carrier is the transportation option whose id equals
`selectedTransportationOptionId` (`list_transportation_options --path
inboundPlanId=... --query shipmentId=<sh...>`).

For received quantities of one shipment use the older call keyed by the `FBA...`
id: `fulfillment_inbound.get_shipment_items_by_shipment --path
shipmentId=<FBA...>` (`QuantityReceived`). It lists at most 200 items; if a
shipment may hold more, say the list is capped and use
`list_shipment_items` (v2024, paged to 1000 per page, no cap) for what was
declared. Received quantities beyond 200 items are not available from here.

### A3. Past boxes as case-pack templates

Amazon has no API to read or apply Seller Central packing templates. What it does
keep is every past shipment's boxes, and those carry the contents, dimensions,
weight, count and the template name they were packed with.

```bash
mixshift amazon call fulfillment_inbound.list_inbound_plan_boxes \
  --path inboundPlanId=<a SHIPPED plan wf...> --query pageSize=100 --json
```

Show them to the user grouped by template name and SKU: "Box of 24 x SKU-A,
14 x 10 x 8 in, 12.5 lb, used 30 times". Offer to reuse one in Part B step 2. A
plan's box list is paged (up to 1000 per page; follow `paginationToken`).

### A4. Prep details

Before a create, check what prep and labeling each SKU needs and who may do it:

```bash
mixshift amazon call fulfillment_inbound.list_prep_details --query mskus=<one SKU> --json
```

One SKU per call from this skill (loop for several). Returns `prepCategory`,
`prepTypes`, and which owners are allowed. If Amazon owns prep or labeling,
that can be billed per unit with no amount in the API; tell the user.

### A5. Capacity limits

There is no Amazon API for FBA capacity limits. The closest proxies are the
storage and overage fee reports (`mx-amazon-report`). Say so rather than guess a
limit.

---

## Part B: build (needs a service credential with shipment write access)

Do Step 0 first. The shape of every step:

1. **Dry run** (no `--commit`): validate, show the user what would be sent.
2. **Confirm** with the user.
3. **Commit** with `--commit`, an idempotency key, and for fee steps the preview.
4. **Check the outcome** (see "Reading a commit's result") before the next step.

### Which steps need which confirmation

| Tier | Steps | What you do before the commit |
|---|---|---|
| **Fee-committing** | confirm packing option, **confirm placement option**, **confirm transportation (a partnered carrier commits its charge)**, **cancel plan** | Dry run for the preview. Show every fee line exactly as returned. Get an explicit yes **in a separate message from the one that asked for the step**. Commit only that preview. |
| **Creates or changes data** | create plan, set packing information, add tracking | Dry run, show the content being sent, ask "send this?", commit on a yes. |
| **Free "ask Amazon" steps** | generate packing / placement / transportation / delivery-window options; confirm delivery window (no fee in Amazon's model) | The user starting the walk covers these; for the delivery-window confirm, name the window you are about to pick. Dry run is optional. Commit, check the outcome. |

An upfront instruction ("go ahead and do the whole shipment") authorizes the
dry runs. It does **not** authorize a fee-committing commit: that needs a yes
about the fees you showed.

### The fee-committing rule, in full

1. Run the step **without** `--commit`. The answer under `write` has
   `previewId`, `quoteHash`, `quote` (the live fee lines or carrier quotes),
   `expiresAt`, and `irreversible` / `irreversibleDetail`.
2. Show the user every fee and discount line **as returned**, one per line, with
   its amount and currency. **Never add lines up or round them.** A fee of 0 is
   shown as 0, not hidden. If the quote carries no fee lines, say "Amazon lists
   no fee for this option" rather than "free". Show irreversible warnings in
   plain words ("once confirmed, this can't be changed").
3. Ask: "Confirm this? It commits the fee(s) above." Wait for the answer.
4. On a clear yes, run the SAME command again with `--commit --preview-id
   <previewId> --approved-quote-hash <quoteHash> --idempotency-key <key>`. The
   request path and body must be identical to the previewed one.
5. A preview is good for **one** commit, for 30 minutes or until Amazon's own
   option expiry, whichever comes first. If the user comes back later, or you
   are unsure, run the dry run again and ask again. Never commit an old preview
   on an old "yes".
6. The commit re-reads the live option right before it confirms. If it refuses:
   - `quote_changed`: the fee or quote moved. **Nothing was confirmed.** Run the
     dry run again, show the NEW fees, and ask again from scratch.
   - `option_not_offered`: the option is gone or expired. Generate options again
     and let the user choose.
   - `preview_already_used`: **the outcome is UNKNOWN, not "nothing happened".**
     A preview is used up by the first commit that took it, so this usually
     means an earlier commit of the same preview already went through (the
     typical case is a lost answer that was resent without the original key).
     Do not tell the user the fee was not committed, and do not run a new
     preview and commit. Resend the commit with the ORIGINAL idempotency key
     (check your key note), which replays the first result; or read what
     happened (`get_inbound_plan`, `list_placement_options` or
     `list_transportation_options`, whichever step it was) and report that.
   - `preview_expired`, `preview_mismatch`, `preview_not_found`: nothing was
     committed; run the dry run again and ask again, with a new key.
   - `preview_required`: you left the preview off the commit; nothing was sent.

### 1. Create the plan

Collect from the user: the ship-from address, the destination marketplace, the
SKUs (`msku`), the quantity of each, and who labels and preps each (`SELLER`,
`AMAZON` or `NONE`). **The ship-from address needs a phone number**; the call is
refused without one (before it reaches Amazon). Run A4 for the SKUs first when
the user is unsure about prep.

Body file (`create.json`):

```json
{
  "name": "Reorder Nov",
  "sourceAddress": {
    "name": "Warehouse contact",
    "addressLine1": "100 Example Street",
    "city": "Exampleville",
    "stateOrProvinceCode": "CA",
    "postalCode": "90001",
    "countryCode": "US",
    "phoneNumber": "555-0100"
  },
  "items": [
    { "msku": "EXAMPLE-SKU-1", "quantity": 600, "labelOwner": "SELLER", "prepOwner": "SELLER" }
  ]
}
```

Optional: `destinationMarketplaces` (defaults to the merchant's), per item
`expiration` (YYYY-MM-DD) and `manufacturingLotCode`. 1 to 2000 items.

```bash
mixshift amazon call fulfillment_inbound.create_inbound_plan --body-file create.json --json
```

- Show the user the address, SKUs and quantities. If the dry run returns
  `warnings` (a `labelOwner` or `prepOwner` of `AMAZON` asks Amazon to label or
  prep the units, which **Amazon can bill per unit; the API gives no amount**),
  say that in plain words and ask whether to keep it.
- The create itself charges no fee. Ask "create this plan?", then commit with
  `--commit --idempotency-key <create key>`. Takes about 11 seconds.
- MixShift adds a short token to the plan name (for example `Reorder Nov
  mx-1a2b3c4d`; names are cut to 28 characters). The result returns
  `inboundPlanId` (`wf...`) and `nameToken`. **Keep the plan id.**
- If the create's answer is lost, **do not create again with a new key**.
  First resend the IDENTICAL command with the SAME key: the answer is replayed
  from the first send and carries the plan id and name token (`replayed:
  true`). Only if that cannot answer (no replay, or still `UNCERTAIN`), search by
  the name token as the fallback: `list_inbound_plans --query pageSize=30`
  (ACTIVE plans) and find the name that ends with it. Never create a second plan
  to find out.

### 2. Packing

1. Ask Amazon for packing options (free):
   `fulfillment_inbound.generate_packing_options --path inboundPlanId=<wf...>
   --commit --idempotency-key <key>` and wait for `SUCCESS`. Then
   `list_packing_options --path inboundPlanId=<wf...>`.
2. Each option has `packingGroups` (the groups of items that go in boxes
   together), `fees` (empty in practice, but show whatever is there) and an
   expiry. The user picks one. If the plan is multi-group, read each group with
   `list_packing_group_items --path inboundPlanId=<wf...> --path
   packingGroupId=<group>`.
3. **Confirm the packing option** with the fee-committing rule above
   (`confirm_packing_option --path inboundPlanId=... --path
   packingOptionId=<id>`). When `fees` is empty, say so, and still ask for the
   yes.
4. **Set what is in each box** (`set_packing_information`, creates data). Ask how
   the units are boxed, or offer to **reuse a past box** (A3). Body file
   (`packing.json`):

   ```json
   {
     "packageGroupings": [
       {
         "packingGroupId": "<the group id>",
         "boxes": [
           {
             "contentInformationSource": "BOX_CONTENT_PROVIDED",
             "dimensions": { "length": 14, "width": 10, "height": 8, "unitOfMeasurement": "IN" },
             "weight": { "value": 12.5, "unit": "LB" },
             "quantity": 25,
             "items": [
               { "msku": "EXAMPLE-SKU-1", "quantity": 24, "labelOwner": "SELLER", "prepOwner": "SELLER" }
             ]
           }
         ]
       }
     ]
   }
   ```

   `quantity` on a box is the number of identical boxes (1 to 10000). Use
   `BOX_CONTENT_PROVIDED` or `BARCODE_2D`. **`MANUAL_PROCESS` is refused**:
   Amazon charges to open and enter box contents by hand and the API states no
   amount, so tell the user plainly and use box contents provided instead.
   Total units across the boxes should equal the group's items; Amazon rejects
   a mismatch.
   - **Reusing a past box:** copy `msku`, `quantity`, `labelOwner`
     (`expiration` and `manufacturingLotCode` if present), plus the box's
     dimensions, weight and count. Take `prepOwner` from
     `prepInstructions[].prepOwner`. **Drop `asin` and `fnsku` on items, and do not send
     `templateName`, `boxId`, `packageId` or the external container fields on a box.** Show the user the resulting boxes and let them change the
     count or SKUs.
   - A dry run, then "send this?", then commit. Takes 3 to 5 seconds.
   - A `FBA_INB_0166` warning on success: see "Reading a commit's result".

### 3. Placement (this commits the placement fee)

1. Generate options (free): write `{}` to `placement-generate.json` with your
   file-writing tool, then `generate_placement_options --path
   inboundPlanId=<wf...> --body-file placement-generate.json` with `--commit
   --idempotency-key <key>`,
   wait for `SUCCESS` (about 11 seconds). Then `list_placement_options --path
   inboundPlanId=<wf...>`.
2. Show each option with status, how many shipments it makes, its fee and
   discount lines exactly as listed (one seen is "Placement Services", which can
   be 0 in some marketplaces) and its expiry. **A placement option expires about
   72 hours after it was generated.** If it is `EXPIRED` or past its expiry,
   generate again. Only `OFFERED` options can be confirmed.
3. The user picks one. **Confirm placement** with the fee-committing rule
   (`confirm_placement_option --path inboundPlanId=... --path
   placementOptionId=<id>`). This is **irreversible**: Amazon does not allow a
   placement to be changed once confirmed. Say so before you ask for the yes.
4. After `DONE`, `get_inbound_plan` lists the plan's `shipments` (`sh...` ids).

### 4. Transportation (a partnered carrier commits its charge)

1. If the shipments are small parcel or freight and you need delivery windows,
   `generate_delivery_window_options` / `list_delivery_window_options` (per
   shipment) are needed only when a transportation option lists
   `CONFIRMED_DELIVERY_WINDOW` in its preconditions; then
   `confirm_delivery_window_options` (no fee in Amazon's model).
2. Ask the user for the ready-to-ship date for each shipment (and a contact name
   and phone if freight needs one). Body (`transport.json`):

   ```json
   {
     "placementOptionId": "<the confirmed placement option>",
     "shipmentTransportationConfigurations": [
       { "shipmentId": "<sh...>", "readyToShipWindow": { "start": "2026-11-05T00:00:00Z" } }
     ]
   }
   ```

   `generate_transportation_options --path inboundPlanId=<wf...> --body-file
   transport.json --commit --idempotency-key <key>`, wait for `SUCCESS`, then
   `list_transportation_options --path inboundPlanId=<wf...> --query
   placementOptionId=<id>`.
3. Show, per shipment: carrier, shipping mode, whether it is **Amazon partnered**
   or **your own carrier**, and the quote cost with its currency. A partnered
   option **charges the quoted amount when confirmed**; an own-carrier option
   carries no charge from Amazon. **A partnered option with no readable quote
   cannot be confirmed** (the dry run refuses it): offer another option.
4. **Confirm transportation** with the fee-committing rule. Body
   (`select.json`): `{ "transportationSelections": [ { "shipmentId": "<sh...>",
   "transportationOptionId": "<id>" } ] }` (one per shipment).
   `confirm_transportation_options --path inboundPlanId=<wf...> --body-file
   select.json`. Show each selection's quote, `voidableUntil` (a partnered
   charge can be voided until then) and that it **cannot be redone** after
   confirmation.

### 5. Labels and tracking

- **Labels** use the older call keyed by the `FBA...` id (`shipmentConfirmationId`
  from `get_shipment`), not the `sh...` id:

  ```bash
  mixshift amazon call fulfillment_inbound.get_labels --path shipmentId=<FBA...> \
    --query PageType=PackageLabel_Letter_6 --query LabelType=BARCODE_2D \
    --query NumberOfPackages=<n> --json
  ```

  The answer is a `DownloadURL` that **works for only about 15 seconds**. Download
  it immediately (`curl -sL -o labels.pdf "<url>"`) and give the user the saved
  file; never paste the link for later. Use `PackageLabel_Thermal` for thermal
  printers, `LabelType=PALLET` with `NumberOfPallets` for freight. Partnered LTL
  shipments also have a bill of lading
  (`get_bill_of_lading --path shipmentId=<FBA...>`, same 15-second rule).
- **Tracking (own carrier only; partnered carriers report their own).** Get box
  ids from `list_shipment_boxes --path inboundPlanId=... --path
  shipmentId=<sh...>`. Small parcel body: `{ "trackingDetails": {
  "spdTrackingDetail": { "spdTrackingItems": [ { "boxId": "<id>", "trackingId":
  "<number>" } ] } } }`. Freight: `{ "trackingDetails": { "ltlTrackingDetail": {
  "freightBillNumber": ["<PRO>"], "billOfLadingNumber": "<BOL>" } } }`.
  `update_shipment_tracking_details --path inboundPlanId=... --path
  shipmentId=<sh...> --body-file track.json`: dry run, show, "send this?",
  commit with a key. Read it back with `get_shipment`.

### 6. Cancel a plan (can be charged after a carrier is confirmed)

`cancel_inbound_plan --path inboundPlanId=<wf...>` is fee-committing, so it uses
the same preview and confirm rule.

- **Before any confirm** (placement or carrier) there is nothing to charge:
  cancelling a freshly created plan is free, and create then cancel is a safe
  first run of this whole skill.
- The preview shows the plan status and, per shipment, the confirmed carrier, any
  partnered quote and `voidableUntil`, with a charge risk. Amazon's void window is
  about 24 hours for partnered small parcel and 1 hour for partnered LTL. If the
  preview warns that a charge is past, near or of unknown void window, say in
  plain words that **Amazon may charge for this cancel** and ask again.
- A plan that is already `SHIPPED` or `VOIDED` has nothing to cancel.

## Boundaries and special cases

- **AWD plans in the list:** skip them; `get_inbound_plan` cannot open them. Do
  not try to cancel or edit them here.
- **Expired placement option:** do not confirm it; regenerate (step 3).
- **200-item cap:** the older shipment-items call returns at most 200 items.
  For bigger shipments say the received-quantity view is capped, and use the
  paged v2024 item list for the declared quantities.
- **Plan status:** only ACTIVE plans can be built on. SHIPPED and VOIDED plans
  are read-only history.
- **One plan, one marketplace.** A plan is built for the destination marketplace
  you chose at the create; say which one when the account has several.
- **Rate limits:** Amazon allows a few writes per second; the walk is slower
  than that anyway. If a call says `throttled`, wait the `retry_after_ms` shown
  and run the same command again (with the same key if it was a commit).

## Reactive error handling (branch on `failure_kind`, never on HTTP status)

| `failure_kind` | What to do |
|---|---|
| `insufficient_scope` | This sign-in or credential cannot build shipments. Use the Step 0 message (ask the admin for a service credential with shipment write access). Nothing was sent. |
| `shipping_write_disabled` / `shipping_write_not_enabled` | Building shipments is switched off (for everyone, or for this account). Tell the user, do not retry, suggest contacting MixShift. |
| `invalid_request` | MixShift refused the request before sending it. Read `fix`/`message` (missing phone number, `MANUAL_PROCESS`, a wrong id length, a bad key). Change the request; never resend unchanged. |
| `bad_request` | Amazon rejected the request. Show its reason in plain words, fix the body, preview again if it was a fee step. |
| `quote_changed`, `option_not_offered`, `preview_expired`, `preview_mismatch`, `preview_not_found`, `preview_required` | See "The fee-committing rule", item 6. Nothing was committed. |
| `preview_already_used` | The outcome is UNKNOWN: an earlier commit probably took the preview. Resend with the ORIGINAL idempotency key or read the plan; never say the fee was not committed. |
| `idempotency_key_conflict` | That key was used for a different request. Make a new key for the new request. |
| `throttled` | Wait `retry_after_ms`, run it again. |
| `host_unreachable`, `upstream_unavailable`, `unknown` on a commit (or `request_outcome: unknown`) | The outcome may be unknown. Do NOT start a new request: resend the identical commit with the same key, or read the plan. |
| `not_authenticated`, `session_expired` | Sign in again (`mx-auth-login`); for a service credential, redo the setup. |
| `merchant_not_found` | Re-run `amazon merchants` and pass `--legacy-seller-id`. |

Failures also carry `source` (who acts) and `retryable` in `--json`. A failure
whose `retryable` is `false` can never succeed unchanged.

## Hard rules

- **Never commit a fee without showing it first and getting a yes about it.**
  Placement, a partnered carrier, a packing option and a cancel are all
  fee-committing. A yes to an earlier preview, an upfront "do it all", or a yes
  to a different step is not a yes.
- **Show fee lines exactly as Amazon returned them.** Never add, net, round or
  restate them. A missing or unreadable fee is "not shown", never "free".
- **Always `--commit` with an idempotency key.** Resend a lost commit with the
  same key; never re-issue it as a new request.
- **Never retry an uncertain write as new.** Read the plan or replay by key.
- **Never call a write step from a normal sign-in.** Explain, offer Part A.
- **Never put credentials or the setup code in a file or a message back to the
  user.** The setup code goes on the command line once.
- **Do not pass `MANUAL_PROCESS`** or any other charge the API cannot price.
- **Do not invent ids, fees, dates or tracking.** If a call returns nothing, say so.
- **Branch on `failure_kind`.**

## Output template

Lead with where the walk stands and what is next.

```
Plan wf...(Reorder Nov): created, packing confirmed, boxes set (25 boxes of 24).
Next: Amazon needs to work out where to send it. Generate placement options?
```

For a fee step, show the preview and ask:

```
Placement option 1 of 2: 3 shipments to 3 warehouses.
  Fees: Placement Services, 0.00 USD
  Discounts: none listed
Expires Nov 2 at 4:10 PM. Once confirmed, the placement cannot be changed.
Confirm this option and its fee?
```

After a commit:

```
Placement confirmed (DONE). Plan wf... now has 3 shipments.
Next: choose a carrier for each shipment.
```

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-amazon-inbound
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-amazon-inbound --trigger-phrase "<the user's exact phrase>"
```

At the END (when the walk finishes or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-amazon-inbound --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (the user got the look-up they wanted, or each step committed as
confirmed), `failed` (could not complete, e.g. a step failed at Amazon),
`deferred` (waiting on the user's confirmation, on an admin to issue the
credential, or on an operation still in progress), `skipped` (the user opted out,
or turned out to need a different skill).
