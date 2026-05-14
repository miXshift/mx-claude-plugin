# mx-claude-plugin

A Claude Code + Cowork plugin for MixShift customers — analytical skills for Amazon advertising and retail operations, built by [MixShift](https://mixshift.ai).

**Status:** Pre-beta. Active productization. Not yet ready for general install.

---

## What this is

A plugin (`mixshift-ai`) that ships analytical skills for MixShift customers. The initial release covers Amazon advertising — 13 skills for managing Amazon Sponsored Products, Sponsored Brands, and Vendor Central accounts:

- **Daily** — `daily-health-check`, `runaway-spend-check`, `portfolio-quick-scan`
- **Bid management** — `keyword-bid-health`
- **Search term workflows** — `search-term-data-pull`, `search-term-harvest`, `search-term-negation`, `phrase-negative-discovery`, `ppc-relevance-check`
- **Targeting** — `asin-target-negation`
- **Reporting** — `monthly-performance-report`, `competitive-analysis`
- **Bootstrap** — `account-cold-start` (prerequisite for all other skills)

Each skill produces a structured, audit-trailed analysis output. Skills are read-only by default — they recommend actions, they don't execute them. Execution engines come later as opt-in additions.

## Architecture in one paragraph

A deterministic harness handles pre-fetch, validation, rendering, and audit. The agent (Claude) only analyzes pre-fetched data and writes recommendations — it never reads SQL files directly, never executes queries, and never pushes to Amazon's APIs. Skills are governed by a risk-tier model (Tier 3 production-facing skills require preflight gates, prior-run sidecars, and explicit human approval). The patent-pending HCAM bridge math (App. No. 19/070,768) anchors causal attribution claims: deterministic functional relationships only, not probabilistic statistical inference.

## Requirements

- Claude Code or Cowork
- An active MixShift customer account
- Read credentials to your MixShift warehouse (available via the legacy platform — instructions below)
- An IP whitelist grant (handled automatically by the plugin on first connection)

Everything else — brand context, run history, output destinations — lives at a user-scoped path (`~/.mixshift/`) the plugin manages on first run.

## Quick start

```
1. Install the plugin in Claude Code or Cowork.

2. Run `mixshift welcome` — it walks you through everything below
   and shows you the URL + master password right when you need them.

3. Get your warehouse credentials:
     - Open https://www.mydashapplications.com/database-admin
       (or your tenant URL, e.g. yourcompany.mydashapplications.com/database-admin)
     - When prompted, enter the master password (same for all MixShift
       customers; shown by `mixshift welcome`).
     - The page shows HostName, Username, Port, Schema, and Password.

4. Run `mixshift auth setup` and paste the credentials.
   The harness pre-fills HostName, Port, and Schema with sensible defaults
   that work for most accounts — you can override them at the prompts if
   the credentials page shows different values.

5. If your IP isn't whitelisted on the warehouse yet, the plugin asks
   for your permission to request access. We POST your email + public IP
   to a MixShift ops channel; an operator grants the read access manually
   (typically within a few hours). You'll get an email when access is
   live, then re-run any skill.

6. From there you can:
     - `mixshift brand discover`  — list brands you have access to
     - "Explore my data"          — Claude triggers the data-explore skill
                                    (export CSVs, sample tables, run queries)
     - `mixshift brand add <slug>` then `/account-cold-start <slug>` —
                                    onboard a brand for analytical skills
                                    (daily health, search-term negation, etc.)
     - `mixshift feedback "..."`  — send us bugs, requests, comments
```

## Productization status

This is a hard fork of an internal MixShift agent system, reorganized for distribution to MixShift customers. The fork point and attribution are documented in [`UPSTREAM.md`](./UPSTREAM.md).

Active design work and decisions:

- [`docs/productization/BRAND-MANAGEMENT.md`](./docs/productization/BRAND-MANAGEMENT.md) — filesystem layout, brand onboarding flow, slash commands, telemetry posture, skill-shaping overlay, future execution engines.

## License

Source-available under PolyForm Perimeter License 1.0.0. See [`LICENSE`](./LICENSE).

In plain English: MixShift customers and individual users may install, run, modify, and fork the plugin for their own internal use. Commercial use that competes with MixShift's products requires a separate license. The full terms are in `LICENSE`; the intent summary is the LICENSE author's prose at <https://polyformproject.org/licenses/perimeter/1.0.0/>.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Contributions to the upstream require a contributor license agreement that assigns rights to MixShift, given the patent surface of the underlying domain.

## Contact

Issues + discussions: open a GitHub issue on this repo.
Beta access + customer support: through your existing MixShift account team.
