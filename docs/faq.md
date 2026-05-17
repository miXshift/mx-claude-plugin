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

---

## Auth + credentials

### Where do I get my warehouse credentials?

From the MixShift portal: `https://www.mydashapplications.com/database-admin` (or your tenant's URL). Enter the master password (shared across all MixShift customers — `mixshift welcome` prints it). The page shows your HostName, Username, Port, Schema, and Password.

If you don't know your tenant URL, ask your MixShift account team or run `mixshift welcome` after install — it prints the right URL for your account.

### What's the "master password" and why is it shared across all customers?

It's a guard against accidental credential exposure on the credentials page, not a per-user secret. Anyone with the URL but not the password can't see anything; the password keeps the page from leaking values to a logged-in user who shouldn't be there. Your per-tenant MySQL credentials are what actually identify you to the warehouse.

### Does my teammate see the same data as me?

**Today, yes.** MixShift's legacy system uses **a single MySQL login per customer organization** — there are no row-level permissions, no per-user data scoping. Every user at your MixShift org sees the same merchants.

**Future:** MixShift 2.0 will introduce per-user logins with role-based data scoping. Until then, treat the warehouse login as a shared org credential.

### Do my teammates and I share credentials, or does each of us enter our own?

The credential **values** are the same for everyone in your MixShift customer org (single-login model). The **entry** is per-user — each teammate runs `mixshift auth setup` on their own machine, writing their own `~/.mixshift/auth/credentials`. Cowork doesn't share local filesystem state across users.

For teams of >3, the [pre-bundling pattern](./auth-setup.md#pre-bundling-credentials-for-a-team) (admin saves credentials to two files and shares with team) turns this into a one-command operation per user.

### Why does each user have to re-enter the same credentials?

Because the credentials live in each user's home directory (`~/.mixshift/auth/credentials`), not in shared Cowork state. Cowork doesn't currently expose an "org-wide plugin state" API for plugins to consume. The pre-bundling pattern minimizes the per-user friction.

In MixShift 2.0 (per-user roles), each person will have genuinely different credentials, so the current pattern becomes the right one anyway.

### My password contains characters that look like a shell command — does that matter?

No. The auth flow uses a `--password-file` mechanism that reads the password from disk via Node's `fs.readFile` — no shell interpolation, no chat-history exposure. Characters like `!`, `$`, `&`, `|`, quotes, etc. work fine. Just save the password to a text file and pass the path to `auth setup`.

### My IP isn't whitelisted. What do I do?

Run `mixshift auth setup --request-whitelist` (or say "request IP whitelist" in chat). The harness posts your email + public IP to MixShift ops via Discord webhook. An operator grants access manually, typically within a few hours during business hours. You'll get an email when access is live.

IP whitelists are per-public-IP, not per-MixShift-org. Each user goes through this the first time they auth from a new network. (Same applies if you move office, switch ISP, or roam to a coffee shop.)

### What if I rotate my password or move to a different host?

Re-run `mixshift auth setup`. It overwrites `~/.mixshift/auth/credentials` with the new values. Same command, same flow.

### Are my credentials sent anywhere?

No. They live on your local machine at `~/.mixshift/auth/credentials` with `0600` permissions. The harness reads them locally to connect to the warehouse. The IP whitelist webhook sends your email + public IP (no password), and `mixshift feedback` sends whatever message you ask it to send — nothing else phones home.

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

### Can I get data MixShift doesn't have?

No. The plugin is a query interface to your MixShift warehouse — if MixShift's ingestion pipeline isn't pulling a data source for you, the plugin can't access it. Open a feature request via `mixshift feedback "need data source: X"` and we'll route it to MixShift's data team.

### What's the data freshness?

Depends on the source. Ad metrics typically update daily (T-1 freshness). Seller Central ops data has a 1-day settlement lag; Vendor Central has 2 days. The `data-explore` skill doesn't enforce freshness — it returns whatever's in the warehouse. The analytical skills (when enabled) check freshness and surface warnings or hard-gate based on the recency of the source.

### Are the analytical skills (daily-health-check, runaway-spend-check, etc.) available?

Present in the codebase but **not yet enabled for general customer use** as of plugin version `0.3.0`. We're vetting each skill end-to-end with real brand contexts before opening them broadly. The launch surface today is:

- `welcome` — first-run orientation
- `auth-setup` — credentials flow
- `data-explore` — ad-hoc query / sample / export
- `brand discover` + `brand add` — brand onboarding plumbing

The analytical skills will be opened in subsequent releases as each one is validated. Watch the changelog / release notes.

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

**Option A — Cowork organization install + pre-bundled credentials.**
You (admin) publish the plugin once to your Cowork org marketplace. You pre-bundle credentials to two files (`creds.yaml` + `pw.txt`) and share via your team's secrets manager. Each user downloads the files and runs one command to auth. Best UX for teams. See [Cowork organization install](./install/cowork-organization.md).

**Option B — Each user installs individually.**
Each teammate installs via [Cowork personal install](./install/cowork-personal.md) and goes through auth setup with the org-shared credentials. Five identical setups. Works but adds friction.

### Can two users on the same machine both use the plugin?

Yes. The plugin state lives at `~/.mixshift/` which is per-OS-user. If two users share a Mac (rare but possible), each one's `~/.mixshift/` is independent — they auth separately and have independent brand-onboarding state.

### What if I work for an agency with multiple MixShift customers?

The MySQL login is per-MixShift-org, so each customer has its own login. Today, you'd need to swap credentials when switching customers (re-run `mixshift auth setup` with the other org's values). Not ideal — we're tracking this as a feature request for v0.4+.

Workaround: use `--data-dir` to maintain separate workspaces:

```bash
mixshift --data-dir ~/.mixshift-customer-a auth setup
mixshift --data-dir ~/.mixshift-customer-b auth setup
# Then for queries:
mixshift --data-dir ~/.mixshift-customer-a data list-tables
```

In chat, this doesn't help (Claude doesn't know which workspace to pick) — for chat-based workflows, swap credentials when you switch customers.

---

## Troubleshooting

### "command not found: mixshift"

Cowork / Claude Code didn't auto-PATH the plugin's `bin/` directory. Workarounds:

- Invoke via absolute path: `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js <command>`
- File a Cowork support ticket if the auto-PATH behavior is broken — it's documented to work.

### "User force closed the prompt" during auth setup

Cowork / Claude Code's Bash tool doesn't pass an interactive TTY. The chat-orchestrated `--from-file` + `--password-file` flow is the right path. If Claude is trying to run `mixshift auth setup` without those flags, say "use the password file flow" to push it onto the chat-orchestrated path.

### Connection test hangs forever

IP whitelist hasn't been granted yet. Run `mixshift auth setup --request-whitelist` to send the request. You'll get an email when access is live.

### Query returns 0 rows but I know the data is there

Two common causes:
1. **Wrong SellerID.** Confirm with `mixshift brand discover` — you may be querying a SellerID that isn't in your warehouse view.
2. **Date range filter excludes everything.** Sample queries default to a recent window; if your data is older, widen the range.

If neither, surface it via `mixshift feedback "no data for seller X table Y date range Z"` and we'll investigate.

### "access_denied_table" on a specific table

Your MySQL user doesn't have SELECT on that table. The plugin can request access on your behalf:

In chat: "request access to table `<name>`" — Claude runs `mixshift feedback ... --category feature_request` with the table name + your SellerID context. MixShift ops grants the additional grant manually.

### Plugin update available — how do I install it?

- **Cowork personal install:** Customize → find `mixshift-ai` → check for updates.
- **Cowork organization install:** org admin re-publishes from Organization settings → Plugins.
- **Claude Code:** `/plugin update mixshift-ai`.
- **CLI direct:** `git pull && npm install && npm run build`.

Auth credentials carry over across updates.

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
