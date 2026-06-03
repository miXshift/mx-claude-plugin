# mx-claude-plugin

A Claude plugin for MixShift customers — Amazon advertising + retail data exploration and analytical workflows, built by [MixShift](https://mixshift.ai).

**Status:** Pre-beta. The `mx-data-explore` skill (query / sample / export your MixShift warehouse) is the initial launch surface. Analytical skills (daily health checks, bid management, search-term workflows, etc.) are present in the codebase but staged behind vetting and not yet enabled for general customer use.

---

## What this is

`mixshift-ai` is a Claude plugin that lets you talk to your MixShift warehouse from inside Claude — sample tables, export CSVs, run ad-hoc SQL, and (soon) get full analytical reports. The plugin is read-only and routes every query through a bundled CLI that authenticates with your MixShift credentials.

## Which install path is right for me

Pick the row that matches your situation:

| Your situation | Use | Doc |
|---|---|---|
| You're a MixShift customer, want to install on your own Cowork seat | **Cowork — Personal install** | [`docs/install/cowork-personal.md`](./docs/install/cowork-personal.md) |
| You're a Cowork org admin, want to deploy to your whole team | **Cowork — Organization install** | [`docs/install/cowork-organization.md`](./docs/install/cowork-organization.md) |
| You use Claude Code (terminal-based) | **Claude Code** | [`docs/install/claude-code.md`](./docs/install/claude-code.md) |
| You want the harness CLI directly (without a plugin host) | **CLI direct** | [`docs/install/cli-direct.md`](./docs/install/cli-direct.md) |

All four paths land at the same place: a working `mixshift` CLI on your machine, plus the plugin's skills available to Claude. After install, every path goes through the same browser-based sign-in flow — kicked off automatically by the `welcome` skill on first chat.

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

The plugin ships **18 skills**. Each is invoked naturally in chat — say what you want and Claude picks the right one. Two tiers based on whether the skill needs a brand-context build first:

### Available right after sign-in (no brand setup needed)

| Skill | What it does |
|---|---|
| `welcome` | First-run orientation + your current state + suggested next steps. |
| `mx-auth-login` | Sign in via browser, switch accounts, refresh expired sessions. |
| `mx-data-explore` | Query, sample, and CSV-export your MixShift warehouse — Sponsored Ads (SP/SB/SD), DSP, Seller / Vendor Central operational revenue, inventory, catalog. Read-only. |
| `mx-report-pull` | Pull Amazon SP-API reports on demand, straight from Amazon, for any merchant and window: Sales and Traffic, Brand Analytics, FBA inventory, orders, returns, vendor reports. Fetches data the warehouse may not hold yet, or a known report for a specific time frame. Read-only. |
| `feedback` | Send feedback, bug reports, or feature requests to MixShift directly from chat. |
| `mx-competitive-analysis` | Research-driven SWOT + competitor positioning + pricing-tier maps. Web-based, no warehouse data required. |
| `mx-account-cold-start` | One-time per brand: build the brand-context layer that unlocks every analytical skill below. Walks you through SellerID confirmation, campaign-structure detection, brand-term collection, and posture / target capture. |

### Require brand context (run `mx-account-cold-start <brand>` first)

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

That's it. The plugin holds a short-lived token after sign-in (24h access / 30d refresh), stored at `~/.mixshift/auth/credentials` on your machine. No raw database passwords on disk, no IP whitelist setup — MixShift's auth service holds the single egress IP server-side.

Everything else — brand context, run history, output destinations — lives at `~/.mixshift/` on your local machine. The plugin manages it.

## Architecture in one paragraph

A deterministic harness (`mixshift` CLI, bundled in this repo) handles authentication, pre-fetch, validation, and audit. Claude (the model) only analyzes pre-fetched data and writes recommendations — it never reads SQL files directly, never executes queries, and never pushes to Amazon's APIs. Skills are read-only by default; execution capabilities are opt-in additions that will be staged in later releases. The harness writes all state to `~/.mixshift/` on your machine; the plugin install itself ships no customer data.

## Security & privacy

- The plugin is **read-only** at the database level — every warehouse user issued by MixShift has SELECT permissions only.
- Your **session tokens** (Bearer + refresh, issued by MixShift's auth service on sign-in) live at `~/.mixshift/auth/credentials` on your local machine, mode 0600. They never leave your device. Your MixShift password is entered on the sign-in page in your browser and is never seen by the plugin or by Claude.
- Tokens are short-lived: 24h access, 30d refresh. Expired access tokens auto-refresh; if the refresh token expires or is revoked, you re-run `welcome` / `auth login` to sign in again. No per-user IP whitelist coordination — MixShift's auth service holds the single static egress IP that talks to the warehouse.
- **Beta telemetry:** during the beta, the plugin sends anonymized usage events (which skills run, query timings, onboarding funnel transitions) to MixShift's Supabase so we can iterate. We do **not** collect query result contents, your tokens, your brand context files, or your chat with Claude. Full details + opt-out instructions in [`docs/privacy.md`](./docs/privacy.md). The welcome screen shows a short notice on first run.

## License

Source-available under PolyForm Perimeter License 1.0.0. See [`LICENSE`](./LICENSE).

In plain English: MixShift customers and individual users may install, run, modify, and fork the plugin for their own internal use. Commercial use that competes with MixShift's products requires a separate license. Full terms in `LICENSE`; the author's prose summary is at <https://polyformproject.org/licenses/perimeter/1.0.0/>.

## Productization status

This is a hard fork of MixShift's internal agent system, reorganized for distribution to MixShift customers. Fork point and attribution: [`UPSTREAM.md`](./UPSTREAM.md). The patent-pending HCAM bridge math (App. No. 19/070,768) anchors causal attribution claims; deterministic functional relationships only, not probabilistic statistical inference.

Active design notes:

- [`docs/productization/BRAND-MANAGEMENT.md`](./docs/productization/BRAND-MANAGEMENT.md) — filesystem layout, brand onboarding flow, slash commands, telemetry posture, skill-shaping overlay, future execution engines.
- [`docs/productization/HARNESS-REWRITE.md`](./docs/productization/HARNESS-REWRITE.md) — the Node/TypeScript rewrite of the legacy Python harness.
- [`docs/productization/MIGRATION-NOTES.md`](./docs/productization/MIGRATION-NOTES.md) — what migrated from the legacy plugin, what didn't, and why.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Contributions require a contributor license agreement that assigns rights to MixShift, given the patent surface of the underlying domain.

## Contact

- Issues + discussions: open a GitHub issue on this repo.
- Customer support + beta access: through your existing MixShift account team.
- In-plugin: `mixshift feedback "your message"` from a terminal, or **"send feedback to mixshift: ..."** in chat.

## FAQ

Common questions (auth, data visibility, team usage, troubleshooting) in [`docs/faq.md`](./docs/faq.md).
