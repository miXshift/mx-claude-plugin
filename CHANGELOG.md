# Changelog

All notable changes to the `mixshift-ai` plugin are recorded here. This log
starts at 0.5.39; earlier versions predate the changelog.

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

- Removed the `mx-competitive-analysis` skill. It was an internal MixShift tool
  that was not intended to ship in the public plugin.

### Internal

- Added continuous integration (type-check, test suite, manifest and skill
  validation, version-consistency check, build) on every pull request.
- Added a golden-fixture test layer built on fully synthetic brand data.
