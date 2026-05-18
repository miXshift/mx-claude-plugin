# mx-claude-plugin

A Claude plugin for MixShift customers — Amazon advertising + retail data exploration and analytical workflows, built by [MixShift](https://mixshift.ai).

**Status:** Pre-beta. The `data-explore` skill (query / sample / export your MixShift warehouse) is the initial launch surface. Analytical skills (daily health checks, bid management, search-term workflows, etc.) are present in the codebase but staged behind vetting and not yet enabled for general customer use.

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

All four paths land at the same place: a working `mixshift` CLI on your machine, plus the plugin's skills available to Claude. After install, every path goes through the same [auth setup](./docs/auth-setup.md).

## Quickstart (Cowork — Personal install)

The most common path:

1. In Cowork desktop: **Customize** → **+** → **"Add marketplace from GitHub"** → paste `miXshift/mx-claude-plugin`.
2. Open the Directory → install `mixshift-ai`.
3. In a Cowork chat, say: **"welcome"** or **"how do I get started"**. Claude runs the welcome skill, which prints the warehouse-credentials URL and the master password.
4. Open the credentials URL, enter the master password, copy the values from the page.
5. In chat, say: **"set up my credentials"**. Claude walks you through the auth setup safely (your MixShift password goes through a temp file, never into chat history).
6. From there you can:
   - **"explore my data"** — sample tables, export CSVs, run ad-hoc queries
   - **"what brands do I have access to"** — discovery
   - **"export this brand's campaign data to CSV"** — bulk extraction

Full step-by-step in the install docs.

## Requirements

- A Claude account (Cowork or Claude Code)
- An active MixShift customer account with warehouse access
- Read credentials to your MixShift warehouse (you retrieve them via the MixShift portal — your team admin or onboarding contact knows the URL, and `mixshift welcome` prints it too)
- An IP whitelist grant on the warehouse (handled automatically by the plugin on first connection; manual approval typically lands within hours)

Everything else — brand context, run history, output destinations — lives at `~/.mixshift/` on your local machine. The plugin manages it.

## Architecture in one paragraph

A deterministic harness (`mixshift` CLI, bundled in this repo) handles authentication, pre-fetch, validation, and audit. Claude (the model) only analyzes pre-fetched data and writes recommendations — it never reads SQL files directly, never executes queries, and never pushes to Amazon's APIs. Skills are read-only by default; execution capabilities are opt-in additions that will be staged in later releases. The harness writes all state to `~/.mixshift/` on your machine; the plugin install itself ships no customer data.

## Security & privacy

- The plugin is **read-only** at the database level — the MySQL credentials issued by MixShift have SELECT permissions only.
- Your warehouse credentials live at `~/.mixshift/auth/credentials` on your local machine. They never leave your device.
- IP whitelist requests send your email and public IP to MixShift ops via the telemetry pipeline (Supabase events table → ops Discord channel server-side) so an operator can grant access.
- **Beta telemetry:** during the beta, the plugin sends anonymized usage events (which skills run, query timings, onboarding funnel transitions) to MixShift's Supabase so we can iterate. We do **not** collect query result contents, your warehouse credentials, your brand context files, or your chat with Claude. Full details + opt-out instructions in [`docs/privacy.md`](./docs/privacy.md). The welcome screen shows a short notice on first run.

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
