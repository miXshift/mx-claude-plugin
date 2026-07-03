# Changelog

All notable changes to the `mixshift-ai` plugin are recorded here. This log
starts at 0.5.39; earlier versions predate the changelog.

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
