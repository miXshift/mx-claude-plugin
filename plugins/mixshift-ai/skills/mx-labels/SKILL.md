---
name: mx-labels
description: >
  Item and campaign labels in MixShift: the label fields your team puts on
  ASINs and Amazon campaigns to organize and report on them (Item Group,
  Brand, Nickname, Parent ASIN, Item Label 1 and 2, Tags 1 to 4, and for
  campaigns Manager and Objective). Use it for "which item label fields do we
  have and what is each one named", "which values are in use", "what labels
  are on these ASINs", "set Item Label 1 to X for these ASINs", clearing or
  renaming a value, naming a field for the account, what changed and who
  changed it, undoing a label change, and asking MixShift to turn labels on
  for the account ("ask to turn on labels for our account"). Changes preview first and apply
  only after the user confirms. NOT sub-brands (finding
  the brands inside a seller account, promoting a brand label, retiring a
  brand): that is mx-brand-context. Not Amazon Ads campaign settings:
  mx-amazon-ads. Not FBA shipment, box, prep or barcode labels:
  mx-amazon-inbound.
  Uses the MixShift plugin sign-in; no brand setup needed.
metadata:
  version: "0.2.0"
  author: "MixShift"
trigger_phrases:
  - item labels
  - item label fields
  - which label fields do we have
  - what is each label field named
  - what is item label 1 called
  - label values in use
  - labels on these asins
  - set item label 1
  - set the item group
  - set tag 1 for these asins
  - clear the label on these asins
  - rename an item group
  - rename a label value
  - campaign labels
  - set the manager on these campaigns
  - set the objective on these campaigns
  - name a label field
  - what changed in our labels
  - who changed this label
  - undo a label change
  - ask to turn on labels for our account
  - turn on labels for our account
---

# Labels (item and campaign labels: read, preview, commit, undo)

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), scan for the bundled CLI with `find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null`. **If that returns more than one path, take the highest version, not the first line.** A machine keeps every version it has ever installed. Skip any path under a `.trash` folder, and read each remaining copy's version from `.claude-plugin/plugin.json` in its plugin folder (the path minus `/harness/dist/cli.js`), not from the path text and not by running it: many paths carry no version, and text order is not version order (as text, `0.8.10` sorts before both `0.8.9` and `0.9.0`). Set `MIXSHIFT_CLI` to the path you picked, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates. Say the CLI could not be found only after the scan has run to the end and printed no path; a scan that timed out or was stopped has not finished, so run it again before concluding anything. A `not_authenticated` error, or "No credentials found", means the CLI ran and the user is not signed in (normal in every fresh Cowork sandbox): that is a sign-in, so use the `mx-auth-login` skill (Path A, device-init), and never report the plugin, its CLI or the connector as not installed. **In a resumed conversation, resolve the CLI again this way; never reuse an absolute `cli.js` path from earlier turns.** The plugin may have updated since, and an old path keeps running the old version.

## What this is, and what it is not

Labels are the values a team puts on its **items** (ASINs) and **Amazon campaigns** so reports can group and filter by them. They are kept on the Legacy platform, and MixShift reads and edits them there.

- **Item fields:** `item_group`, `nickname`, `brand`, `parent_asin`, `label_1`, `label_2`, `tag_1` to `tag_4` (Item Group, Item Nickname, Brand, Parent ASIN, Item Label 1 and 2, Tag 1 to 4).
- **Campaign fields:** `item_group`, `brand`, `label_1`, `label_2`, `tag_1` to `tag_4`, `manager`, `objective`.
- An account can give a field its own name (for example Item Label 2 shown as "Collection"). `labels fields` shows what each field is called on that account. Use the account's name when talking to the user and the key in commands.

**This is not sub-brands.** Finding the brands hiding inside one seller account, building a promotion plan, promoting a brand label into a brand, or retiring a brand is `mx-brand-context`. FBA shipment, box, prep and barcode labels are `mx-amazon-inbound`. This skill edits the label values themselves, not which brands exist. It is also not Amazon Ads campaign settings (budgets, bids, status): that is `mx-amazon-ads`.

Labels are turned on account by account. Until they are on for the account, each command says so in one sentence (exit 6): relay it, then follow "When labels are not on for the account" below.

## Step 1: pick the account

The reads and writes that work on an account take `--account <id>`, the legacy seller id (digits) from the command below: `fields`, `get`, `search`, `drift`, `changes`, `sets`, `preview` and `field-name`. `state`, `commit`, `undo`, `set` and `cancel` do not take it (the first needs nothing; the others take a change set id).

```bash
mixshift amazon merchants --json
```

One merchant in one marketplace is one account. If there are several, ask which by name.

## Step 2: reads first (free, change nothing)

| The user asks | Run |
|---|---|
| Is this on, how fresh is it | `mixshift labels state` |
| Which label fields do we have, what is each named, which values are in use | `mixshift labels fields --account <id> [--entity item\|campaign]` |
| What labels are on these ASINs or campaigns | `mixshift labels get --account <id> --ids a,b,c` (or `--ids-file <path>`) `[--entity campaign]` |
| Which items or campaigns have a value | `mixshift labels search --account <id> [--entity ...] --field <key> --value "<text>" [--limit n] [--all]` |
| Where do the Data Manager rows disagree | `mixshift labels drift --account <id> [--entity ...] [--all]` |
| What changed lately | `mixshift labels changes --account <id> --since <UTC time> [--all]` (always give `--since`; without it the feed starts at the oldest change) |
| Past and pending change sets, who made them | `mixshift labels sets --account <id>`, then `mixshift labels set <change-set-id>` |

Add `--json` to any of them when you need to read the answer. Take field keys from `labels fields`; never guess one. An id shown as never seen has not been read by MixShift yet, which is different from an item with no label.

## Step 3: changes, always preview first

1. **Preview** (changes nothing). Pick the targets with one of: `--ids a,b` or `--ids-file <path>`, `--where field="exact value"`, `--file <changes.csv>`, or `--rename <field> --from "<old>" --to "<new>"`. With ids or `--where`, add `--set field="value"` and/or `--clear field` (repeatable). Items by default; add `--entity campaign` for campaigns.

   ```bash
   mixshift labels preview --account <id> --ids B0EXAMPLE01,B0EXAMPLE02 --set label_1="Spring" --scope region
   ```

2. **Show the user the preview in plain words:** how many items or campaigns change, which accounts it reaches, what was left out and why, any warnings, the before and after sample. Ask for a yes to exactly that change set. A different selection or value is a new preview.
3. **Commit** only after the yes, which must come in a later turn than the preview (see the rule below): `mixshift labels commit <change-set-id> --commit`. Without `--commit` it shows the change set and sends nothing. If the user drops it: `mixshift labels cancel <change-set-id> --commit`. A preview expires after 24 hours.
4. **Read the result.** An item changed by someone else after the preview is left as it is and reported stale; the rest still apply and the command exits 17. Say exactly which were not applied. Never call a partial result a success.

**Undo** works the same way: `mixshift labels undo <change-set-id>` previews the reversal. Show it, then `mixshift labels commit <new-id> --commit` after the user confirms. Anything changed again since is left alone.

**Naming a field for the account** has no preview: tell the user the field and the exact new name, wait for the yes, then `mixshift labels field-name --account <id> [--entity ...] --field <key> --name "<text>" --commit` (or `--remove` to go back to the standard name).

Limits: a change set holds up to 1,000 items or campaigns, counted once for every account the change reaches. With `region` or `all`, 400 ASINs that exist in 3 marketplaces count as 1,200 and are refused: split them into parts.  A `--file` CSV (header `asin` or `campaign_id`, then one column per field; an empty cell leaves a field alone and `<clear>` removes it) makes one change set per different combination of values, at most 10. A cell cannot start with = + - or @; use `--set` for such a value. A value is one line of plain text and cannot be blank (to remove a label, clear it).

**Confirmation rule (applies to `commit`, committing an undo, `cancel` and `field-name`).** The user's request ("set Item Label 1 to Spring", "undo that", "name the field Collection") authorizes the preview (for `field-name`, the run without `--commit`), not the change. Show the preview and get a fresh yes to exactly what it shows, in a LATER turn. Never preview and commit in the same turn. Never commit in a scheduled or unattended run: there, preview, say what is waiting, and stop.

Write-flow edge cases:

- A preview that says it cannot be committed (label changes switched off, or not turned on for the account yet): relay that sentence as it is. Do not ask for a yes, and do not try to commit.
- `commit` exits 16 with "no approval on this machine" (or the preview expired or was cancelled): nothing was sent. Run the preview again, show it, and ask again.

## Scope rules (say these before a write that could reach more than the user expects)

- **Items** take `--scope region` (the default: every marketplace of that merchant) or `--scope all` (every account of that merchant type). A per-marketplace scope for items is refused by the service. If the user wants only one marketplace, say that is not possible for items and let them choose.
- **Campaigns** belong to one marketplace account, so a campaign change reaches only that account. A campaign preview accepts only `--scope marketplace` (or none).
- Name the scope in the preview words before the user confirms, since `region` and `all` reach more than the account they named.

## After a commit

After a commit, every label read from MixShift shows the new value at once, marked `[pending]` until the Legacy platform has it. The Legacy platform's own screens show the change within a few minutes. Do not claim a change is applied from the preview alone; go by the commit result.

## When labels are not on for the account

There are three cases. Their messages differ, so tell them apart by the message (on a write command, `--json` also carries `reason` and `state`):

1. **Labels are off for the account** ("Labels are not turned on for your account yet", exit 6 on any command; `labels state` shows labels not turned on yet; on a write command `reason: labels_off`, `state: off`): MixShift has not turned labels on for this account yet. Say so in one sentence and offer: "Want me to ask MixShift to turn them on?"
2. **Label changes are not on yet** (`state: observing`): MixShift is still checking its copy of this account's labels. A preview works but says it cannot be committed yet (`blocked_by: tenant_not_on`); a commit answers `not_enabled` with `reason: tenant_not_on`. Say so. Offer the request below only if none was sent earlier in this conversation.
3. **Label changes are turned off on MixShift as a whole** (`reason: writes_off`, "Label changes are turned off on MixShift right now"): there is nothing to request. Say so.

**Sending the request.**

- This is the one exception to `mx-feedback`'s confirm-first rule: if the user asked for it in their own words (for example "ask to turn on labels for our account"), that request is their yes. If you offered it, wait for the user's yes in a later turn. Never send it in an unattended run (scheduled task, CI, headless): there, say that labels are off and stop.
- First run `mixshift labels state`. If labels are already on, there is nothing to request: say so and carry on with what the user wanted. If it fails because the user is not signed in, help them sign in first (`mx-auth-login`): a request sent without a sign-in cannot be matched to their account.
- Then send exactly this, run the same way as every other `mixshift` command above, with the message in single quotes:

```bash
mixshift feedback 'Labels request: please turn on labels for our account.' --category feature_request --skill mx-labels
```

- Keep the opening words `Labels request:` unchanged, because MixShift routes requests on them. The user may add their own note after that sentence (for example when they need it by); if the note has an apostrophe, rephrase it without one. Never add account names, seller ids, ASINs or merchant names yourself.
- Count it as sent only when the command says the feedback was sent ("Feedback sent to MixShift ops"). Then show the user what was sent and tell them MixShift turns labels on account by account and will let them know when theirs is on. If it says the feedback was queued ("Feedback queued locally"), or sent without an account identity ("Sent without an account identity"), tell the user it may not have reached MixShift and ask them to email support@mixshift.io instead.
- Where there is no shell to run `mixshift` (for example claude.ai on the web), tell the user to email support@mixshift.io to ask for labels.

## When it does not fit

- Something the commands cannot do: say so plainly, and offer `mixshift feedback "<what they wanted>" --category feature_request --skill mx-labels`, sent only after the user agrees.
- Sub-brand and brand-promotion work goes to `mx-brand-context`.

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-labels
# If a natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-labels --trigger-phrase "<the user's exact phrase>"
```

At the END (when the session winds down or the user pivots), run:

```bash
mixshift telemetry emit skill.completed --skill mx-labels --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (the user got the answer, or the confirmed change was applied), `failed` (could not satisfy, e.g. labels not turned on, exit 6), `deferred` (a preview is waiting on the user's yes), `skipped` (they wanted a different skill, e.g. sub-brands).

You do **not** need to emit per-call events. The harness fires `labels.called` on each `labels` command with counts and the outcome. It never records a label value, an ASIN or a campaign id, or the answer. It does carry the account id and the change set id.
