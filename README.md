<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="plugins/mixshift-ai/harness/assets/design-system/mixshift-logo-white.svg">
    <img alt="MixShift" src="plugins/mixshift-ai/harness/assets/design-system/mixshift-logo-dark.svg" width="300">
  </picture>
</p>

# mx-claude-plugin

A Claude plugin for MixShift customers — Amazon advertising + retail data exploration and analytical workflows, built by [MixShift](https://mixshift.ai).

**Status:** Beta (0.7.x). Everything that needs only sign-in is usable today: warehouse query and export (`mx-data-explore`), on-demand Amazon SP-API reports, live retail lookups, AMC and DSP analytics, and Amazon Ads management (including audited writes). The analytical PPC tier (daily health checks, bid management, search-term workflows) needs a one-time brand-context build per brand and is rolling out in waves as each skill is validated.

---

## What this is

`mixshift-ai` is a Claude plugin that lets you work with your Amazon advertising and retail data from inside Claude. Sample and export your MixShift warehouse, run ad-hoc SQL, pull reports and live lookups straight from Amazon, and make audited changes to your Amazon Ads campaigns. Everything routes through a bundled CLI that signs in with your MixShift account. Warehouse access is read-only; any change to Amazon previews first and is sent only after you confirm it.

## What the plugin can do

Everything runs through the bundled `mixshift` CLI, which signs in once with your MixShift account and routes every call through MixShift's auth service at `mcp.mixshift.io` over a single Bearer token. There are no raw database passwords on disk and no per-user IP whitelist; the service holds the one static egress IP server-side.

- **Authenticate to MixShift.** Browser-based sign-in for people, or an admin-issued service credential for unattended runs (scheduled Cowork tasks, CI, cron). Tokens are short-lived and stored locally at `~/.mixshift/auth/credentials`.
- **Explore your historical warehouse data.** Query, sample, and CSV-export the MixShift warehouse: Sponsored Ads (SP/SB/SD), DSP, Seller and Vendor Central revenue and orders, inventory, and catalog. Read-only.
- **Pull fresh data straight from Amazon.** On-demand SP-API reports (Sales and Traffic, Brand Analytics, FBA, orders, returns, vendor), live retail lookups (catalog, inventory, finances, pricing), AMC clean-room SQL, DSP reports, and SP-API pricing batches. For data the warehouse does not already hold, or a specific ad-hoc window.
- **Make changes to your Amazon Ads account.** Pause and enable campaigns, edit bids and budgets, and create or delete keywords, ASIN targets, and negatives across Sponsored Products, Brands, and Display. Every write previews as a dry run first and is sent to Amazon only after you confirm the exact change set; each committed change is logged with an audit id.
- **Run analytical PPC workflows.** Daily health checks, runaway-spend detection, bid reviews, monthly reports, portfolio triage, and the search-term suite. These read a one-time brand-context build per brand (see [Available skills](#available-skills)) and are rolling out in waves.
- **Share brand context across your team.** Brand context lives in a MixShift org store, so everyone working a brand builds on the same verified knowledge instead of a separate private copy. Before a skill reads a brand, the plugin quietly pulls any updates a teammate published, and once you have shared a brand, your later edits publish back automatically. `mixshift context` (`status`, `pull`, `push`, `sync`, `migrate`) syncs it; a brand timeline (`mixshift timeline`) records context edits, Amazon Ads changes, and notes you add, each attributed to the person or automation that made it. Your local files stay as a fast cache the skills read.
- **Record event stakes on the brand timeline.** Capture the events that move a brand's numbers (promotions, stockouts, media spikes, price tests, launches, content and strategy changes) as typed, dated stakes with `mixshift timeline add`, then attach evidence and a verdict with `mixshift timeline corroborate` as the data comes in. Reporting skills use stakes as evidence when they explain performance, and can capture new ones as you review a report.

## Which install path is right for me

Pick the row that matches your situation:

| Your situation | Use | Doc |
|---|---|---|
| You're a MixShift customer, want to install on your own Cowork seat | **Cowork — Personal install** | [`docs/install/cowork-personal.md`](./docs/install/cowork-personal.md) |
| You're a Cowork org admin, want to deploy to your whole team | **Cowork — Organization install** | [`docs/install/cowork-organization.md`](./docs/install/cowork-organization.md) |
| You use Claude Code (terminal-based) | **Claude Code** | [`docs/install/claude-code.md`](./docs/install/claude-code.md) |
| You want the harness CLI directly (without a plugin host) | **CLI direct** | [`docs/install/cli-direct.md`](./docs/install/cli-direct.md) |

All four paths land at the same place: a working `mixshift` CLI on your machine, plus the plugin's skills available to Claude. After install, every path goes through the same browser-based sign-in flow — kicked off automatically by the `welcome` skill on first chat.

Using a non-Claude AI client? You can also point Cursor or Codex at the MixShift server, or set up a ChatGPT app, with the same sign-in. See [Connecting other AI clients](./docs/auth-setup.md#connecting-other-ai-clients-cursor-codex) in the auth setup guide.

## Quickstart (Cowork — Personal install)

The most common path:

1. In Cowork desktop: **Customize** → **+** → **"Add marketplace from GitHub"** → paste `miXshift/mx-claude-plugin`.
2. Open the Directory → install `mixshift-ai`.
3. In a Cowork chat, say: **"welcome"** or **"how do I get started"**. Claude walks you through sign-in inline: asks for your work email, opens a browser tab for you to sign in with your MixShift account, then verifies the connection. Takes about 30 seconds.
4. From there you can:
   - **"explore my data"** — sample tables, export CSVs, run ad-hoc queries
   - **"what brands do I have access to"** — discovery
   - **"export this brand's campaign data to CSV"** — bulk extraction

Full step-by-step in the install docs.

## Available skills

The plugin ships **24 skills**. Each is invoked naturally in chat: say what you want and Claude picks the right one. Two tiers, based on whether the skill needs a brand-context build first:

### Available right after sign-in (no brand setup needed)

| Skill | What it does |
|---|---|
| `mx-welcome` | First-run orientation: your current state and suggested next steps. |
| `mx-help` | Navigation and discovery hub: what the plugin can do, how to fix something, where the docs are. Say "help" or "what can this do". |
| `mx-auth-login` | Sign in via browser, switch accounts, refresh expired sessions. |
| `mx-auth-service-setup` | Set up an admin-issued service credential for unattended runs: scheduled Cowork tasks, CI, cron. |
| `mx-data-explore` | Query, sample, and CSV-export your MixShift warehouse: Sponsored Ads (SP/SB/SD), DSP, Seller / Vendor Central operational revenue, inventory, catalog. Read-only. |
| `mx-amazon-report` | Pull Amazon SP-API reports on demand, straight from Amazon, for any merchant and window: Sales and Traffic, Brand Analytics, FBA inventory, orders, returns, vendor reports. Read-only. |
| `mx-amazon-retail` | Live SP-API retail lookups: catalog, inventory, orders, finances, listings, offer pricing. The title / brand source for ASINs missing from the warehouse. Read-only. |
| `mx-amazon-amc` | Run Amazon Marketing Cloud (AMC) clean-room SQL: submit a query, poll it, fetch the result CSV. Read-only. |
| `mx-amazon-dsp` | Pull Amazon DSP reports (campaign, inventory, audience) on demand. Read-only. |
| `mx-amazon-ads` | Read and change a live Amazon Ads account: campaign / ad group / keyword / target lists, live bids and budgets, recommendations, plus pause / enable, bid and budget edits, and keyword / target / negative create and delete across SP / SB / SD. Writes preview first and need your explicit confirmation. |
| `mx-feedback` | Send feedback, bug reports, or feature requests to MixShift directly from chat. |
| `mx-share-skill` | Share a skill you built with the plugin so MixShift can add it to the library. Say "I built a skill". |
| `mx-brand-context` | One-time per brand: build the brand-context layer that unlocks every analytical skill below. Walks you through SellerID confirmation, campaign-structure detection, brand-term collection, and posture / target capture. (Formerly `mx-account-cold-start`.) |

### Require brand context (run `mx-brand-context <brand>` first)

| Skill | What it does |
|---|---|
| `mx-daily-health-check` | Comprehensive daily exception-based account review — spend / ACoS anomalies via percentile-based confidence intervals, broken into campaign-type / objective / item-group cuts. |
| `mx-runaway-spend-check` | Acute daily keyword-level overspend detection — flags T-1 spikes + zero-conversion runaways. |
| `mx-keyword-bid-health` | Weekly keyword-level bid review — scale-up candidates with proven conversions, pullback candidates on high-ACoS. |
| `mx-monthly-report` | MoM / YoY performance report in MixShift's analytical voice, H-Bridge efficiency, item-group highlights, forecast beat/miss, Looking Ahead. |
| `mx-portfolio-quick-scan` | Multi-brand daily triage. One status card per brand: do I need to log in today? GREEN / YELLOW / RED verdicts. |
| `mx-search-term-negation` | Search-term irrelevance analysis + surgical negative keywords. |
| `mx-search-term-harvest` | Promote high-performing auto / broad search terms to explicit keyword targeting. |
| `mx-search-term-data-pull` | Pure data-extraction layer for search-term analysis (consumed by negation + harvest). |
| `mx-phrase-negative-discovery` | Phrase-negative candidates from n-gram decomposition of the search-term corpus. |
| `mx-asin-target-negation` | Phase 2 negation review for ASIN targets matched through auto / category / PAT paths. |
| `mx-ppc-relevance-check` | Semantic relevance classification for search terms and ASIN targets — separate from threshold logic. |

## Requirements

- A Claude account (Cowork or Claude Code)
- An active MixShift customer account — the same email + password you use to log into MixShift authenticates the plugin (via a browser-based sign-in, not pasted in chat)

No MixShift account yet? Create one at `https://www.mydashapplications.com/auth/registration`, then connect your Amazon accounts and activate ads + retail data per the [getting started guide](https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift). Most accounts are fully populated within 24-48 hours of activation; large catalogs can take longer.

That's it. The plugin holds a short-lived token after sign-in (24h access / 30d refresh), stored at `~/.mixshift/auth/credentials` on your machine. No raw database passwords on disk, no IP whitelist setup — MixShift's auth service holds the single egress IP server-side.

Everything else — brand context, run history, output destinations — lives at `~/.mixshift/` on your local machine. The plugin manages it.

## Architecture in one paragraph

A deterministic harness (the `mixshift` CLI, bundled in this repo) handles authentication, pre-fetch, validation, and audit. Claude (the model) analyzes pre-fetched data and writes recommendations; it never reads SQL files directly and never executes queries itself. Warehouse access is read-only. Writes to Amazon Ads go through the harness's audited path: the service validates the change, snapshots current state, and returns a preview, and nothing reaches Amazon until you confirm it with an explicit commit. The harness writes all state to `~/.mixshift/` on your machine; the plugin install itself ships no customer data.

## Security & privacy

- **The warehouse is read-only.** Every warehouse user issued by MixShift has SELECT permissions only, so no plugin command can modify warehouse data. Changes to your live Amazon Ads account are a separate, audited path: they preview first and reach Amazon only after your explicit confirmation (see `mx-amazon-ads`).
- Your **session tokens** (Bearer + refresh, issued by MixShift's auth service on sign-in) live at `~/.mixshift/auth/credentials` on your local machine, mode 0600. They never leave your device. Your MixShift password is entered on the sign-in page in your browser and is never seen by the plugin or by Claude.
- Tokens are short-lived: 24h access, 30d refresh. Expired access tokens auto-refresh; if the refresh token expires or is revoked, you re-run `welcome` / `auth login` to sign in again. No per-user IP whitelist coordination — MixShift's auth service holds the single static egress IP that talks to the warehouse.
- **Beta telemetry:** during the beta, the plugin sends usage events (which skills run, query timings, onboarding funnel transitions, and the command lines you run) to MixShift's Supabase so we can iterate. During the beta these are attributed to your MixShift account and the person or service credential that ran them (intentionally not anonymous, so we can understand real usage and improve it); command lines have credential-shaped values stripped before anything is stored. We do **not** collect query result contents, your tokens, your brand context file contents, or your chat with Claude. Full details + opt-out instructions in [`docs/privacy.md`](./docs/privacy.md). The welcome screen shows a short notice on first run.

## License

Source-available under PolyForm Perimeter License 1.0.0. See [`LICENSE`](./LICENSE).

In plain English: MixShift customers and individual users may install, run, modify, and fork the plugin for their own internal use. Commercial use that competes with MixShift's products requires a separate license. Full terms in `LICENSE`; the author's prose summary is at <https://polyformproject.org/licenses/perimeter/1.0.0/>.

## Productization status

This is a hard fork of MixShift's internal agent system, reorganized for distribution to MixShift customers. Fork point and attribution: [`UPSTREAM.md`](./UPSTREAM.md). The patent-pending HCAM bridge math (App. No. 19/070,768) anchors causal attribution claims; deterministic functional relationships only, not probabilistic statistical inference.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Contributions require a contributor license agreement that assigns rights to MixShift, given the patent surface of the underlying domain.

## Contact

- Issues + discussions: open a GitHub issue on this repo.
- Customer support + beta access: through your existing MixShift account team.
- In-plugin: `mixshift feedback "your message"` from a terminal, or **"send feedback to mixshift: ..."** in chat.

## FAQ

Common questions (auth, data visibility, team usage, troubleshooting) in [`docs/faq.md`](./docs/faq.md).
