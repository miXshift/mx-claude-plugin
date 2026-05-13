# mx-claude-plugin

A Claude Code plugin for Amazon PPC account management, built by [MixShift](https://mixshift.ai).

**Status:** Pre-beta. Active productization. Not yet ready for general install.

---

## What this is

A Claude Code plugin (`mixshift-amazon-ppc`) that adds 13 skills for managing Amazon Sponsored Products, Sponsored Brands, and Vendor Central advertising accounts:

- **Daily** — `daily-health-check`, `runaway-spend-check`, `portfolio-quick-scan`
- **Bid management** — `keyword-bid-health`
- **Search term workflows** — `search-term-data-pull`, `search-term-harvest`, `search-term-negation`, `phrase-negative-discovery`, `ppc-relevance-check`
- **Targeting** — `asin-target-negation`
- **Reporting** — `monthly-performance-report`, `competitive-analysis`
- **Bootstrap** — `account-cold-start` (prerequisite for all other skills)

Each skill produces a structured, audit-trailed analysis output. Skills are read-only by default — they recommend actions, they don't execute them. Execution engines come later as opt-in additions.

## Architecture in one paragraph

A deterministic harness handles pre-fetch, validation, rendering, and audit. The agent (Claude) only analyzes pre-fetched data and writes recommendations — it never reads SQL files directly, never executes queries, and never pushes to Amazon's APIs. Skills are governed by a risk-tier model (Tier 3 production-facing skills require preflight gates, prior-run sidecars, and explicit human approval). The patent-pending HCAM bridge math (App. No. 19/070,768) anchors causal attribution claims: deterministic functional relationships only, not probabilistic statistical inference.

## Requirements (target — not yet finished)

- Claude Code
- Read access to a MixShift-managed Amazon warehouse (provisioned per customer)
- An IP whitelist grant (handled via the in-plugin onboarding flow)

Everything else — brand context, run history, output destinations — lives at a user-scoped path (`~/.mixshift/`) the plugin manages on first run.

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
