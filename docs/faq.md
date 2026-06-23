# FAQ

Common questions about `mixshift-ai` across all install paths. If something isn't covered, open a GitHub issue or send `mixshift feedback "your question"` and we'll add it.

---

## Install + access

### Which install path should I use?

| Your situation | Use |
|---|---|
| Solo MixShift user on Cowork | [Cowork — Personal install](./install/cowork-personal.md) |
| Team admin deploying to your org's Cowork | [Cowork — Organization install](./install/cowork-organization.md) |
| Claude Code (terminal CLI) | [Claude Code](./install/claude-code.md) |
| Scripting / CI / no plugin host | [CLI direct](./install/cli-direct.md) |

You can mix and match — there's no conflict between, e.g., installing on Cowork personally and also building the CLI from source for ad-hoc shell scripts. They share the same `~/.mixshift/` state.

### Do I need a Claude / Anthropic enterprise account?

No. A regular Cowork or Claude Code account works. You need a MixShift customer account for the warehouse credentials, but Claude-side it's just a standard install.

### Does this work on Windows? Mac? Linux?

Yes to all three. The harness is Node 20+, the bundled CLI is platform-portable. Some shell-command syntax in the docs assumes a Unix-y terminal (bash/zsh); on Windows use Git Bash, WSL, or translate paths and quoting as needed.

### Is `mixshift-ai` available in Anthropic's official plugin marketplace?

Not yet. Today you install from the public GitHub repo (`miXshift/mx-claude-plugin`). Submission to Anthropic's "Anthropic & Partners" curated directory is a future move; until then, install from GitHub via the docs above.

### How do I get back to the Cowork Directory modal after installing?

The Directory modal is the surface where you add marketplaces, install plugins, check for updates, toggle Sync automatically, and remove plugins. It's only obvious during first install. To reopen it:

- **Cowork desktop:** click **Customize** in the left sidebar → click the **+** next to **Personal plugins** (or **Organization plugins** for org-managed installs). The Directory opens with your already-added marketplaces.
- From the Directory, click your marketplace name (`mx-claude-plugin`) → the three-dot menu next to it has **Sync automatically** (toggle), **Check for updates**, and **Remove**.

If you can't find the **+** button at all, your Cowork build may not expose user-level marketplace controls (older builds didn't). The Organization install path is the fallback for those builds.

### What does "Sync automatically" do?

Found in the Directory modal → three-dot menu next to a marketplace. When on, Cowork periodically pulls the latest commit from your marketplace's GitHub source so you get newly-shipped plugin code without manually checking for updates.

**Important caveat (known bug, tracked with Anthropic):** Sync automatically pulls the latest commit and refreshes file contents (descriptions, skills, code) on disk, **but it does not currently refresh the displayed version field** in the plugin detail page. So you may see version `0.3.0` in the UI even after a newer version has been synced and the actual files on disk are at `0.4.1`. The plugin behavior reflects the latest synced files; only the version label is stale.

Workaround until Anthropic fixes this: remove + re-add the plugin (see below) when MixShift ships a notable release. We'll update this FAQ once the upstream fix lands.

### My plugin shows an old version even after "Check for updates" — what do I do?

This is the version-field bug above. Quickest reliable workaround:

1. Cowork → Customize → **+** next to Personal plugins → Directory modal opens.
2. Click the three-dot menu next to `mx-claude-plugin` → **Remove**. (Confirms removal of the marketplace, which also uninstalls plugins from it.)
3. Same modal → re-add the marketplace via "Add marketplace from GitHub" → `miXshift/mx-claude-plugin`.
4. Open the newly-listed marketplace → install `mixshift-ai`.

Cowork preserves its internal `marketplace_*` and `plugin_*` IDs across this — safe, no data loss. Your local auth credentials (`~/.mixshift/auth/credentials`) are independent of Cowork's plugin state and also carry over.

---

## Auth + credentials

### How do I sign in?

Say "welcome" or "sign in to mixshift" in chat (Cowork or Claude Code). The plugin walks you through inline: asks for your work email, opens a browser tab at the MixShift sign-in page, you sign in with your MixShift account, and we're done in about 30 seconds.

From a terminal: `mixshift auth login --person-label you@yourcompany.com`.

Full details: [`docs/auth-setup.md`](./auth-setup.md).

### What credentials do I use to sign in?

The same email + password you use to log into MixShift. Your credentials stay on the sign-in page in your browser; the plugin never sees them. After sign-in, the plugin only holds a short-lived token (24h access / 30d refresh).

### Where are my brands listed? I expected to see all my Amazon accounts.

After you sign in, the harness automatically discovers every brand you have warehouse access to and writes them to `~/.mixshift/clients/index.yaml`. To see them in chat: *"show my brands"* or *"what brands do I have"*. From a terminal: `mixshift brand list`.

By default the listing hides **dormant** brands — those with no active ads access AND no active SP-API (retail) access. Dormants are still in the registry; they just don't surface unless you ask. Common ways to see them:

- *"show all my brands"* / `mixshift brand list --all` — everything including dormants
- *"what brands are dormant?"* / *"who do I need to activate?"* / `mixshift brand list --only-inactive`
- *"why don't I see brand X?"* — Claude looks up X in the registry, shows you whether ads + SP-API are flagged active and what to do if not

If you expected a brand to appear and it's not even in the dormant list, it likely hasn't been activated in MixShift yet. Head to the Account Manager view to begin: `https://dash.mydashapplications.com/account-manager`. Onboarding help doc: `https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift`.

The registry refreshes automatically every 24 hours when you run a chat command, or on demand via `mixshift brand discover` / `mixshift brand list --refresh`.

### I manage 200+ accounts but only care about 5. Do I have to scan all of them?

No. Mark the brands you actually focus on as **key brands**. Portfolio-level skills (e.g. portfolio quick scan) default to running against your key brands; only fall back to all-active when you haven't set any. The full list stays available in the registry — you can always opt into the full set with `--all` flags.

In chat, the natural pattern is to just describe what you manage:

> *"I manage Summit, Ridgeline Cell, AOP, and Hearth IQ"*

Claude resolves each name against your registry (Summit → Summit Labs, AOP → Aspen Outdoor Provisions, etc.) and adds them all to your key list. Ambiguous names ("Ridge" matches both Ridgepak and Ridgeline Cell) get a clarifying question.

Other phrasings that work the same way:
- *"mark Ridgepak as key"* — single brand
- *"add Glacier Bottle to my key brands"*
- *"set my key brands to Ridgepak, Summit Labs, and Glacier Bottle"*

To inspect / change later:
- *"show my key brands"* / `mixshift brand key list`
- *"remove Kiwa from key brands"* / `mixshift brand key remove kiwa`
- *"clear my key brands"* / `mixshift brand key clear`

Key brands live in `~/.mixshift/profile.yaml::brands.key`. The list is yours alone — no syncing across machines (per-machine state, like everything else the plugin tracks). When you re-auth on a different machine, you set your key brands again there.

### Does my teammate see the same data as me?

**Today, yes.** MixShift's legacy backing system uses **a single MySQL login per customer organization** — there are no row-level permissions, no per-user data scoping. Every user at your MixShift org sees the same merchants once they sign in.

**Future:** MixShift 2.0 will introduce per-user logins with role-based data scoping. Until then, treat the warehouse view as shared org-wide.

### Do my teammates and I sign in with the same account?

Each person signs in with their **own** MixShift account (their own email + password). The auth service maps each user to your tenant's shared data view, but with their own session and their own `person_label` for attribution. So admin tooling can see WHO at your org ran what.

Each teammate runs sign-in once on their own machine; tokens land at their own `~/.mixshift/auth/credentials`. Cowork doesn't share local filesystem state across users.

### My IP needs to be whitelisted, right?

**No** (on the recommended token-based path). The MixShift auth service runs from a single static egress IP that's pre-whitelisted on the warehouse. Your IP is irrelevant — you can sign in from any network: office, home, coffee shop, mobile hotspot, anywhere.

(The legacy raw-MySQL path still has a per-user IP whitelist requirement. See [`docs/auth-setup.md`](./auth-setup.md#legacy-raw-mysql-path-mixshift-auth-setup) if you're explicitly on that path.)

### What if my session expires?

Access tokens refresh automatically (~60s before expiry). If the refresh token expires (>30d since last sign-in) or is revoked, you'll see "Your session expired. Run `mixshift auth login`." in chat or terminal. Just re-run sign-in — same flow, ~30 seconds.

### What if I rotate my MixShift password?

Nothing happens to your existing token until it expires. New sign-ins use the new password. If you want to invalidate the existing session immediately, you can re-run sign-in (which overwrites the local token pair).

### Are my credentials sent anywhere?

Your **MixShift password** is entered on the sign-in page in your browser. It never touches the plugin, Claude, your shell history, or any harness command.

Your **tokens** (access + refresh) live on your local machine at `~/.mixshift/auth/credentials` with `0600` permissions. They're sent only as Bearer credentials to `https://mcp.mixshift.io/api/query` and the auth-refresh endpoints when needed — nowhere else.

`mixshift feedback` sends whatever message you ask it to send. The telemetry firehose (during beta) sends anonymized usage events ([details](./privacy.md)).

---

## Data + analytical scope

### What data does the plugin have access to?

Whatever your MixShift account has access to in the legacy `dashamazon` warehouse:

- **Sponsored Ads** (Sponsored Products, Sponsored Brands, Sponsored Display)
- **Amazon DSP** (display campaigns)
- **Seller Central** operational revenue (sales, orders, units, sessions, page views, buy box, returns, settlements)
- **Vendor Central** operational revenue (ordered/shipped revenue, units, COGS, glance views)
- **Inventory** (FBA + vendor)
- **Catalog metadata** (Brand, ItemGroup, Tags, TargetACOS, CustomBrand)

The full curated list is in `mixshift data list-tables`. There are ~38 surfaced tables; some legacy tables exist but aren't surfaced because they're empty stubs or deprecated.

Beyond the warehouse, the plugin can also pull **live, on-demand data straight from Amazon** for any merchant you're authorized for: SP-API reports (Sales and Traffic, Brand Analytics, FBA, orders, returns, vendor), point-in-time retail lookups (catalog, inventory, finances, pricing), AMC clean-room SQL, and DSP reports. See `mx-amazon-report`, `mx-amazon-retail`, `mx-amazon-amc`, and `mx-amazon-dsp`.

### Can I get data MixShift doesn't have?

Two answers, depending on the source. **From the warehouse:** no, the warehouse holds whatever MixShift's ingestion pipeline pulls for you, so if a source isn't ingested, `mx-data-explore` can't see it. Open a feature request via `mixshift feedback "need data source: X"` and we'll route it to MixShift's data team. **Straight from Amazon:** often yes, the `mx-amazon-*` skills call Amazon's APIs live for any merchant you're authorized for, so you can pull reports, catalog, inventory, pricing, AMC, and DSP data the warehouse doesn't hold.

### What's the data freshness?

Depends on the source. Ad metrics typically update daily (T-1 freshness). Seller Central ops data has a 1-day settlement lag; Vendor Central has 2 days. The `mx-data-explore` skill doesn't enforce freshness — it returns whatever's in the warehouse. The analytical skills (when enabled) check freshness and surface warnings or hard-gate based on the recency of the source.

### Are the analytical skills (mx-daily-health-check, mx-runaway-spend-check, etc.) available?

The boundary is whether a skill needs a brand-context build. **Everything that needs only sign-in is available today:**

- `mx-welcome`, `mx-auth-login`, `mx-auth-service-setup`, `mx-help`, `mx-feedback`, `mx-share-skill` for onboarding and support
- `mx-data-explore` for ad-hoc warehouse query, sample, and export
- `mx-amazon-report`, `mx-amazon-retail`, `mx-amazon-amc`, `mx-amazon-dsp` for live reads straight from Amazon
- `mx-amazon-ads` for live Amazon Ads reads plus audited writes (preview, confirm, commit)

The **analytical PPC tier** (`mx-daily-health-check`, `mx-runaway-spend-check`, `mx-keyword-bid-health`, `mx-monthly-report`, `mx-portfolio-quick-scan`, and the search-term suite) reads a one-time brand-context build per brand. These are being vetted end-to-end on real brand contexts and roll out in waves. Watch the changelog / release notes.

### Can I pause campaigns, edit bids, or create negatives from the plugin?

Yes. `mx-amazon-ads` reads a live Amazon Ads account (campaigns, ad groups, keywords, targets, bids, budgets) and makes **audited changes** to it: pause and enable campaigns, edit bids and budgets, and create or delete keywords, ASIN targets, and negatives across Sponsored Products, Brands, and Display. It works right after sign-in, with no brand-context build required.

### How do Amazon Ads writes work?

Every write is preview-gated. The harness sends the change to MixShift's service as a **dry run** first: the service validates it, snapshots the current state, logs an audit row, and returns a preview of the exact change set without touching Amazon. Claude shows you that preview and waits. Only when you explicitly confirm does it re-issue the call with `--commit`, the only thing that mutates your account. A declined preview sends nothing. Each committed change carries an audit id so it can be traced and reversed.

### What's cold-start and why do I need it?

**Cold-start teaches the plugin about your brand.** It's a one-time setup (~3–5 minutes per brand) that runs structured queries against your warehouse + walks you through a short intake — your catalog, marketplaces, target ACOS, recent launches and structural events. After it's done, every analytical skill (mx-daily-health-check, runaway-spend, monthly report, etc.) already knows your brand and doesn't need re-explaining when you run it.

**Without cold-start**, the analytical skills are locked. You can still use `mx-data-explore` to query and export anything, but skills like *"run daily health check on Ridgepak"* won't have the context to be useful — they need to know what "normal" looks like for your brand.

**To run it:** in chat, say *"cold start Ridgepak"* (or any key brand). Claude orchestrates the harness's data-fetch step, then asks the intake questions inline. Output lives in `~/.mixshift/clients/<slug>/` — preserved across plugin updates and across transient access lapses (if a marketplace temporarily goes inactive, cold-start state stays).

**You don't have to cold-start every brand.** Most users start with their top 1–2 brands, see the analytical skill output, then decide whether to cold-start more. The `mixshift brand list` output shows ✓ next to cold-started brands so you can see at a glance what's ready.

### Can I run a custom SQL query?

Yes. `mixshift data query --sql "<your SQL>"` runs arbitrary read-only SQL. The warehouse user has SELECT permissions only — destructive operations (INSERT/UPDATE/DELETE/DDL) fail at the database level. Statement-level timeout is 60s; narrow your query if it takes longer.

In chat: "run this query: SELECT ..." → Claude routes through `data query`.

### How do I export to CSV?

```bash
mixshift data export --table <name> --seller-id <N> \
  --start 2026-05-01 --end 2026-05-17 \
  --out ~/my-export.csv
```

Or in chat: "export <brand>'s campaign data for May to CSV". Default output location is `~/.mixshift/output/`.

CSVs are unbounded — useful for >100K row exports that wouldn't fit inline in chat.

### What's a "SellerID" and how do I find mine?

A `SellerID` is MixShift's internal numeric ID for an Amazon merchant account. Each row in the warehouse is keyed by SellerID. You can have multiple SellerIDs if you manage multiple Amazon accounts (different marketplaces, separate SC/VC entities, etc.).

To list yours: say "what brands do I have access to" in chat, or run:

```bash
mixshift brand discover --json
```

Each brand shows its SellerIDs, account types (SC/VC), and marketplaces.

---

## Multi-user + team scenarios

### My team has 5 people at the same MixShift org. How should we set up?

Two options, both work:

**Option A — Cowork organization install.**
You (admin) publish the plugin once to your Cowork org marketplace, optionally marking it as required so it auto-installs for every seat. Each user signs in with their own MixShift account when they first use the plugin (~30 seconds in chat). No credential distribution. Best UX for teams. See [Cowork organization install](./install/cowork-organization.md).

**Option B — Each user installs individually.**
Each teammate installs via [Cowork personal install](./install/cowork-personal.md) and signs in with their own MixShift account. Same end state as Option A; just no admin involvement.

### Can two users on the same machine both use the plugin?

Yes. The plugin state lives at `~/.mixshift/` which is per-OS-user. If two users share a Mac (rare but possible), each one's `~/.mixshift/` is independent — they auth separately and have independent brand-onboarding state.

### What if I work for an agency with multiple MixShift customers?

The MixShift account-tenant binding is per-customer-org, so each customer has its own tenant. Today, you'd swap sessions when switching customers — sign in with the other tenant's MixShift account (re-run `mixshift auth login --person-label ...` with the MixShift account that belongs to that customer's tenant). Not ideal — we're tracking this as a feature request for a future release.

Workaround: use `--data-dir` to maintain separate workspaces:

```bash
mixshift --data-dir ~/.mixshift-customer-a auth login --person-label you@example.com
mixshift --data-dir ~/.mixshift-customer-b auth login --person-label you@example.com
# Then for queries:
mixshift --data-dir ~/.mixshift-customer-a data list-tables
```

In chat, this doesn't help (Claude doesn't know which workspace to pick) — for chat-based workflows, swap sessions when you switch customers.

---

## Troubleshooting

### "command not found: mixshift"

Cowork / Claude Code didn't auto-PATH the plugin's `bin/` directory. Workarounds:

- Invoke via absolute path: `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js <command>`
- File a Cowork support ticket if the auto-PATH behavior is broken — it's documented to work.

### Browser didn't open during sign-in

PKCE tries to open your default browser via the OS-native handler. If that fails (rare — headless environment, container, SSH session), the harness auto-falls-back to a device-code flow and prints a URL Claude surfaces in chat or that you see in the terminal. Open that URL on any device with a browser. To force device-code up front: `mixshift auth login --mode device --person-label you@yourcompany.com`.

### "Your session expired" or "no datahub credentials"

Your refresh token expired (>30d since last sign-in) or was revoked. Just re-run sign-in: say "sign in to mixshift" in chat, or `mixshift auth login --person-label you@yourcompany.com` in a terminal. Same flow, ~30 seconds.

### Query returns 0 rows but I know the data is there

Two common causes:
1. **Wrong SellerID.** Confirm with `mixshift brand discover` — you may be querying a SellerID that isn't in your warehouse view.
2. **Date range filter excludes everything.** Sample queries default to a recent window; if your data is older, widen the range.

If neither, surface it via `mixshift feedback "no data for seller X table Y date range Z"` and we'll investigate.

### "access_denied_table" on a specific table

Your MySQL user doesn't have SELECT on that table. The plugin can request access on your behalf:

In chat: "request access to table `<name>`" — Claude runs `mixshift feedback ... --category feature_request` with the table name + your SellerID context. MixShift ops grants the additional grant manually.

### How do I send feedback / report a bug / request a feature?

Three equally-good ways, depending on where you are:

| Path | Use |
|---|---|
| **In chat** (Cowork / Claude Code) | `/mx-feedback` slash command — Claude walks you through it. Or just say things like "send feedback to mixshift: the export is slow", "report a bug: X is broken", "feature request: I wish this could Y". |
| **Mid-skill** | If you're using `mx-data-explore` (or any skill) and hit a pain, just say "this is frustrating because..." or "I wish this did..." — Claude will offer to file feedback without making you leave the session. |
| **Terminal** | `mixshift feedback "your message" --category bug` (or `feature_request`, `comment`). |

Feedback routes to two places: a real-time post to MixShift's Discord ops channel (so a human sees it quickly) and the telemetry events table (so engineering can analyze patterns across customers). Both happen automatically — you don't pick.

We read every piece during beta. Bugs typically get a response within a couple business days; feature requests get triaged into the roadmap.

### Plugin update available — how do I install it?

- **Cowork personal install:** Customize → **+** next to Personal plugins → Directory modal → three-dot menu next to `mx-claude-plugin` → **Check for updates**. (See "How do I get back to the Directory modal" above if you can't find this surface.)
- **Cowork organization install:** org admin re-publishes from Organization settings → Plugins.
- **Claude Code:** in your terminal, run `claude plugin marketplace update mixshift` to refresh the catalog first, then `claude plugin update mixshift-ai`. (Refreshing first matters: an update without it can reinstall the same version when your local catalog is stale.)
- **CLI direct:** `git pull && npm install && npm run build`.

**Then load the new version: start a new session.** A running session keeps the plugin version it started with, so an update never takes effect until you open a fresh one. In Claude Code, fully quit the `claude` process and relaunch; a new chat in the same process is not enough. In Cowork, fully quit and reopen the app.

Auth credentials carry over across updates.

**If Cowork shows a stale version after "Check for updates"** (known bug — see "What does 'Sync automatically' do?" above), do a remove + re-add of the marketplace via the Directory modal. The `marketplace_*` and `plugin_*` IDs are preserved across this, so it's safe.

### My data.json / data.md / report file is huge

The harness caps `data.md` at 48 KB for chat-friendly summaries. The full `data.json` is unbounded. Both live under `~/.mixshift/clients/<brand>/runs/<skill>/<date>/`.

For CSV exports: large results don't get capped — `mixshift data export` writes the full row set to disk. If you're hitting memory issues during export (>1M rows), narrow the date range or filter by additional dimensions.

---

## License + contribution

### Can I fork this?

Yes, under the PolyForm Perimeter 1.0.0 license. MixShift customers and individual users may install, run, modify, and fork for their own internal use. Commercial use that competes with MixShift's products requires a separate license. Full terms in [`LICENSE`](../LICENSE).

### Can I contribute back?

Yes — see [`CONTRIBUTING.md`](../CONTRIBUTING.md). Contributions require a contributor license agreement (CLA) that assigns rights to MixShift, given the patent surface of the underlying domain.

### Can I use the plugin without being a MixShift customer?

You can install the plugin code, but you won't have warehouse credentials and so can't actually run anything against data. The plugin is built for MixShift customers; if you're interested in becoming one, contact MixShift sales.

---

## Anything else?

If your question isn't here, send it via `mixshift feedback "your question"` (in a terminal) or "send feedback to mixshift: ..." (in chat) and we'll add it. Or open a GitHub issue on the public repo.
