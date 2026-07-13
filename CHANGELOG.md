# Changelog

All notable changes to the `mixshift-ai` plugin are recorded here. This log
starts at 0.5.39; earlier versions predate the changelog.

## 0.8.2

A new way for Claude Team and Enterprise admins to roll the plugin out to their
whole organization.

### Added

- **Organization-level install through the Claude admin console.** Admins can
  now deploy `mixshift-ai` from the Claude admin console, either by uploading a
  release zip from our GitHub Releases page or by pointing the console at a
  private mirror that tracks our public stable branch automatically. Every
  tagged release now publishes two install zips (a marketplace-layout zip for
  the console and a single-plugin zip), and there is a new
  "Organization-level install (Claude admin console)" guide in the install docs.

### Fixed

- **Ad group names in query results.** Warehouse queries and exports that
  surface ad-group-level rows now show the ad group name again alongside its
  id, restoring a data point that had briefly gone missing from data
  exploration.

## 0.8.1

Readable names instead of raw numbers in your results.

### Changed

- **Skills now show names, not just IDs.** Where results used to print an
  opaque campaign, ad group, keyword, or target number, they now lead with the
  human-readable name and keep the id alongside it (the id is still there for
  any follow-up change you make). Product rows show the product title next to
  the ASIN. This applies across data exploration, the Amazon Ads views, and the
  ASIN target negation report.

### Added

- **`mixshift data asin-titles`** turns a list of ASINs into their product
  titles and brands. Ask for the titles behind a set of ASINs and the plugin
  resolves them from your catalog (and tells you which ones it could not find
  so they can be looked up live).

## 0.8.0

Event stakes on the brand timeline, and automatic publishing of brand context
edits for brands you have shared with your team.

### Added

- **Event stakes on the brand timeline.** Record the events that move a brand's
  numbers (promotions, stockouts, media spikes, price tests, launches, content
  and strategy changes) as first-class stakes. `mixshift timeline add` now takes
  a typed `--category`, a required `--interpretation` (what the event means for
  the brand), an optional date range (`--ts` and `--end`, backdated or scheduled
  ahead), scope refs (`--affects`), a magnitude (`--intensity`), a `--source`,
  and an initial `--evidence` object.
- **Corroboration.** `mixshift timeline corroborate <event-id>` attaches
  evidence to a stake and moves its status (unverified, corroborated, disputed,
  no effect) as the data comes in. Every corroboration is recorded as its own
  attributed timeline event, so the history of what the data showed is
  preserved alongside what the team declared.
- **Stake-aware timeline browsing.** `mixshift timeline list` gains `--stakes`,
  `--category`, `--status`, `--source`, `--affects`, `--overlap` for interval
  questions like "what was live that week", plus `--until` and
  `--include-future` for scheduled stakes.
- **Reports capture the story.** The monthly report skill now asks "what
  happened here?" when it finds an unexplained swing and, with your
  confirmation, records the answer as a stake it can cite. The daily health
  check can propose a suggested stake for an anomaly, or corroborate an
  existing one when the anomaly matches a known event.
- **Automatic publishing for shared brands.** Once a brand has been published
  to your team's org store, later brand-context edits publish back
  automatically after each write. The publish is quick, best-effort, and never
  overwrites a teammate's divergent copy; a one-line notice confirms each
  share. Brands you have not shared stay local until you run
  `mixshift context push`, and `mixshift context status` now points out
  unshared work.

### Changed

- Brand setup guidance now ends with an explicit first share
  (`mixshift context push`), and the welcome flow and FAQ point earlier
  adopters at the one-time `mixshift context migrate`.
- `brand key` commands respond faster when the org store is slow to reach
  (the mirror step is now bounded at two seconds, matching the other
  background sync paths).

## 0.7.4

Sturdier behavior when something goes wrong: clearer messages, no more crashes on a couple of edge cases, and more accurate run history.

### Fixed

- **A broken brand list no longer crashes a command.** If your local brand
  registry file ends up malformed or in an older format, commands like
  `brand key add` now stop with a clear message telling you to run
  `mixshift brand discover` to rebuild it, instead of failing with a raw error.
- **A bad plugin download now tells you how to fix it.** If the plugin's program
  file gets cut short during a sync (which previously broke every command,
  including help and feedback), the CLI now detects it and prints a short
  re-sync instruction instead of an unreadable crash.
- **More accurate run history.** A skill run that lands on a RED verdict is a
  successful run, and is now recorded that way. Previously some completed runs
  were logged as if the save had failed, and genuine save failures are now
  reported clearly.

## 0.7.3

A clear starting point for people who do not have a MixShift account yet.

### Added

- **New-user registration handoff.** When someone brand new tries to sign in or
  set up the plugin without a MixShift account, the plugin now points them to the
  right first step instead of failing quietly: create an account, connect your
  Amazon accounts, and activate ads and retail data, with a link to the getting
  started guide. It also sets expectations up front that most accounts finish
  populating within 24 to 48 hours of activation (large catalogs can take longer),
  so the data-backed skills become useful once the first pulls land. The sign-in,
  consent, admin, and developer pages carry the same pointer.

## 0.7.2

Internal telemetry accuracy only; no changes to any feature, command, or workflow.

### Fixed

- The plugin now records which Claude surface a session runs in (desktop app,
  Cowork, or terminal) accurately. This affects MixShift's own usage telemetry
  only and is invisible to your workflows.

## 0.7.1

Live Amazon Warehousing & Distribution (AWD) inventory and inbound shipments,
plus a small Amazon Ads documentation correction.

### Added

- **Amazon Warehousing & Distribution (AWD) lookups.** `mx-amazon-retail` can now
  read your AWD inventory and inbound shipments straight from Amazon: current
  stock per SKU in AWD distribution centers, and the inbound shipments flowing
  into them. Available for US sellers enrolled in AWD; just ask for "AWD
  inventory" or "inbound shipments to AWD."

### Fixed

- **Corrected the Sponsored Brands vs Sponsored Display media-type note** in
  `mx-amazon-ads` so the creative media-type guidance reads accurately.

## 0.7.0

Shared brand context across your team, clearer beta telemetry, and steadier
Amazon report pulls.

### Added

- **Shared brand context across your team.** Your brand context now lives in a
  MixShift org store, so everyone who works a brand builds on the same verified
  knowledge instead of a separate private copy. Before a skill reads a brand,
  the plugin quietly pulls any updates a teammate published, so you are always
  working from the current picture. Your local files under `~/.mixshift/` stay
  in place as a fast cache, and nothing about how the skills read context
  changes.
- New `mixshift context` commands (`status`, `pull`, `push`, `sync`,
  `migrate`) show what is in sync, publish your context to the org store, and
  pull teammates' updates. If you set up brand context before this release, run
  `mixshift context migrate` once to publish it so your team can build on it.
- A new brand timeline (`mixshift timeline list` and `add`) records what
  happened to a brand over time: context edits, Amazon Ads changes, and notes
  you add, each attributed to the person or automation that made it, in one
  shared history.
- Marking a brand as "key" now shares that with your org, so teammates can see
  which brands each person focuses on.

### Changed

- **Slow or rate-limited Amazon report pulls are steadier.** When Amazon
  returns a rate-limit response in the middle of a report run, the plugin now
  backs off and retries automatically instead of surfacing it as a failure, so
  a busy-Amazon moment no longer ends the pull.
- **Beta telemetry is clearer, and records more during the beta.** Usage events
  are now attributed to your MixShift account and the specific person or service
  credential that ran them (during the beta this is intentionally not anonymous,
  so we can understand real usage and improve it). The command lines you run are
  captured to see how the plugin is used, with credential-shaped values stripped
  before anything is stored. We still do not collect query results, your tokens,
  your brand context file contents, or your chat with Claude. The full
  disclosure and opt-out are in [`docs/privacy.md`](./docs/privacy.md), and the
  first-run notice now says this plainly.

### Fixed

- A key-brand change in `--json` mode no longer waits on the org-store sync
  before returning its result on a slow or unreachable network. The sync is now
  bounded, so scripted callers get their output promptly either way.

## 0.6.4

Connect more AI clients, clearer waits on slow Amazon pulls, and a tidied-up
TACOS goal field.

### Added

- You can now connect other AI clients to MixShift with the same sign-in. The
  setup guide covers pointing Cursor and Codex at the MixShift server and
  setting up a ChatGPT app, alongside the existing Claude clients.

### Changed

- Slow Amazon pulls now tell you what to expect. Before a report or a brand
  setup data pull that takes a few minutes, the plugin says so up front and
  reports back when it finishes, instead of going quiet. Rate-limit responses
  on Brand Analytics search-terms reports are now called out as normal and
  expected, so a slow pull is not mistaken for a broken one and is never
  canceled just for being slow.
- The account-level TACOS goal is now a single field named "TACoS goal"
  (`tacos_goal_pct`). Brand context files that used the older name
  (`tacos_target_pct`) keep working unchanged; nothing needs to be re-entered.
- Branded sales reporting is more accurate: product titles and brands now come
  from the most recent catalog row per product. The brand setup guide also
  explains common warehouse data quirks (merchant-fulfilled inventory, and
  advertising activity on a product with no current inventory rows) so they are
  read as expected patterns rather than errors.
- The setup docs no longer feature the legacy raw-MySQL sign-in path. Browser
  sign-in and service credentials are the supported ways to connect; the legacy
  command still exists for anyone who was relying on it.

## 0.6.3

First-run fixes learned from the first live onboarding calls, clearer setup
language, and a sign-in attribution fix.

### Added

- Setup now checks for Node.js before running anything else. On a machine
  without Node, plugin commands previously stalled with no error; the welcome
  flow now spots the gap and walks you through installing Node 20 or newer for
  your platform.
- The Claude Code install guide gains a permission-mode step, so your first
  session is not interrupted by a wall of approval prompts.
- Brand discovery results now render as a proper table in chat. The brand list
  stays readable in Cowork instead of collapsing into unaligned text.

### Changed

- Setup and onboarding copy now says "brand setup" and "brand context"
  throughout. (Some earlier screens called this a "cold start".)
- The Cowork install guide is more resilient: clearer marketplace steps, new
  troubleshooting entries for a missing plugin menu and add-marketplace
  failures, and a note that the sign-in approval page may say "return to your
  CLI" (that just means: come back to the chat and say you are done).

### Fixed

- Usage diagnostics now correctly record the work email you provide at
  sign-in. Previously only the shared account login was recorded, so support
  could not tell which teammate hit a problem. (This was always part of the
  disclosed diagnostics; see the privacy doc.)

## 0.6.2

A follow-up to 0.6.1: the sign-in network-block guidance now covers personal Pro and
Max plans, not just Team/Enterprise.

### Fixed

- The sign-in remediation previously described only the Team/Enterprise org-admin path,
  which is a dead end on a personal Pro or Max plan. `mixshift doctor`, the sign-in error
  message, and the personal-Cowork install guide now include the personal-plan fix: add
  the required domains yourself under Settings > Capabilities > "Allow network egress" >
  "Additional allowed domains", then start a new conversation. The guidance also flags the
  known Cowork bug where domains added under "Package managers only" mode aren't enforced
  (set the mode to "All domains").

## 0.6.1

A first-run reliability fix for Cowork and Claude Code. When the host sandbox
blocks the connection to MixShift, sign-in now fails clearly and tells you how
to fix it, instead of dead-ending on a cryptic network error.

### Changed

- Sign-in failures are now actionable. If the plugin cannot reach MixShift
  because the Cowork or Claude Code sandbox has not allowlisted its address, you
  get a plain explanation and the exact next step (allowlist the domain, or run
  `mixshift doctor`) rather than an opaque "network error" with no way forward.
- The welcome flow no longer hands you a sign-in link it cannot complete. If the
  connection is blocked, it stops and points you to the fix instead of leaving
  you waiting on a link that never works.

### Fixed

- Removed sign-in guidance that told you to run `mixshift` in your own terminal.
  The bundled command is not installed system-wide, so that produced a
  "command not found" dead end; sign-in now keeps you on a path that works.

## 0.6.0

The first stable beta release. It bundles the data, brand-context, and branding
work since 0.5.40 into the version the closed beta runs on.

### Added

- Large query results now come back complete. `mixshift data query` automatically
  pages through the service's per-request row and byte limits, so you no longer have
  to split a big pull into smaller queries by hand.
- New "Querying from your own app" section in the auth-setup docs, for connecting
  your own application directly to your MixShift data.

### Changed

- Refreshed MixShift branding: the new monogram logo and updated brand green now
  render across generated reports and the design system.
- Brand-context-driven skills now read your brand brain when deciding whether they
  have enough context to run, so they no longer show a false "blocked by context"
  when a brand brain is already in place.
- Building brand context now draws enrichment from the brand brain directly. The
  separate enrich step is folded into the build, so onboarding a brand takes one
  fewer manual command.

### Removed

- The standalone `brand enrich` command is retired. Its work now happens
  automatically as part of building brand context.

## 0.5.40

A reliability and transparency release: feedback is never dropped, the update
instructions work on every install, and you can read what changed without
leaving the plugin.

### Added

- **`mixshift whatsnew`** shows recent release notes right in the plugin. Run it
  any time to see what changed in the latest releases. It reads the published
  changelog (cached for a day, and it still works from cache when you are
  offline), and the "update available" notice now points you to it.

### Changed

- The "update available" notice now prints an update command that works no
  matter how the plugin was installed: the fully qualified
  `claude plugin update mixshift-ai@mixshift`, plus a note to add `--scope local`
  when you installed it for a single project. The previous notice printed a bare
  command that could fail with "Plugin not found" on project-scoped installs.
- For a brand that spans more than one Amazon seller account, brand context now
  picks the primary account by actual revenue and ad spend, falling back to the
  earlier heuristic only when those are unavailable.

### Fixed

- Sending feedback no longer fails when there is no email saved in your profile.
  `mixshift feedback` now picks up your signed-in identity automatically, and if
  none is available it still sends your message instead of losing it (and
  suggests signing in so we can follow up).

## 0.5.39

A correctness and consistency release. It folds in a full review pass across
the skills, hardens the build, and renames one skill for consistency.

### Changed

- **Renamed the `mx-report-pull` skill to `mx-amazon-report`.** This lines it up
  with the rest of the Amazon API skills (`mx-amazon-ads`, `mx-amazon-retail`,
  `mx-amazon-amc`, `mx-amazon-dsp`). The slash command is now
  `/mixshift-ai:mx-amazon-report`. The underlying `mixshift amazon report ...`
  CLI commands are unchanged, so any scripts that call the CLI keep working.

### Fixed

- Onboarding now points to the correct command for ad-hoc SQL
  (`mixshift data query`).
- Unattended and scheduled sessions locate their service credential reliably at
  run time instead of assuming a fixed path.
- The AMC and DSP skills now discover instances and advertisers correctly when
  the signed-in account manages other accounts, including seats and advertiser
  IDs that sit beneath a managed account.
- Large advertiser and account identifiers are read back without rounding.
- Amazon Ads write actions (for example pausing campaigns or changing bids)
  preview a dry run first and require an explicit, separate confirmation before
  anything is committed.
- Search Query Performance and Brand Analytics tables now show up when listing
  available warehouse tables.
- Live featured-offer pricing reads are attributed to the correct merchant and
  marketplace.

### Removed

- Removed an internal-only skill that was not intended to ship in the public
  plugin.
