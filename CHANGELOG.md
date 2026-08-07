# Changelog

All notable changes to the `mixshift-ai` plugin are recorded here. This log
starts at 0.5.39; earlier versions predate the changelog.

## 0.8.8

### Added

- **Your brand's events now reach your team's timeline automatically.** The
  structural events you record during brand setup (promos, stockouts,
  launches, migrations) used to live only in that machine's brand context
  file, invisible to reporting and to teammates. They now publish to your
  org's brand timeline as declared stakes: automatically after context edits
  and before skill reads, when you run `mixshift context push` or `migrate`,
  and on demand with the new `mixshift timeline sync` (add `--dry-run` to
  preview; without `--brand` it covers every local brand, which is the
  one-time backfill for brands you set up before this version). Publishing is
  idempotent, so nothing is ever recorded twice, and an event with no start
  date is marked "recorded as of now" so a reader can tell when you learned
  about it apart from when it happened.

- **Brand context now shares itself, both directions.** Before a skill reads
  a brand, MixShift already pulled your team's newer copy; it now also sends
  your newer local changes back, and edits publish on every write, including
  a brand's very first share (previously the first share required an explicit
  `mixshift context push`). Nothing is ever overwritten: a doc edited in both
  places is reported as a conflict for you to resolve, exactly as before.
  Every automatic share prints a one-line notice so you always know when
  something left this machine, and setting `MIXSHIFT_CONTEXT_AUTOPUBLISH=off`
  restores the old keep-it-manual behavior.

- **Brand events no longer have to fit a fixed list.** Three new structural
  event types: `off_amazon_media` for a standing off-Amazon media program
  (outside demand generation, media mix modeling attribution, non-Amazon ad
  lines), `assortment_change` for expected catalog rotation (seasonal
  flavors, planned discontinuations), and `other` as an explicit escape so
  you can record anything you consider an event; `other` asks for a short
  `kind` slug naming what it is, so the specifics are never lost. Every event
  can also carry freeform `tags`. The same three categories and tags work on
  timeline stakes: `mixshift timeline add --category ... --tag ...`, and
  `timeline list --tag <slug>` filters by them.

### Fixed

- **Brand setup no longer assumes your campaigns are named the way ours are.**
  Two brand-context queries used to sort campaigns into objectives, and brand
  versus non-brand, by looking for specific text fragments in campaign names.
  Those fragments come from one particular naming scheme, so any account that
  names campaigns differently had every campaign filed as "unknown" or as
  non-brand. Because the queries still returned rows, the report looked
  complete while the numbers underneath it were wrong. Brand setup now reads
  your campaigns' spend and performance and works out the grouping for your
  account: it uses the campaign format Amazon already reports, and matches
  campaign names against the naming vocabulary recorded for your brand rather
  than against a fixed list. It also tells you what share of your spend it
  could confidently group, so a partial answer reads as partial instead of as
  fact.

- **The daily health check no longer silently drops unlabeled campaign
  spend.** The Objective and Item Group tables previously skipped any
  campaign whose Objective or ItemGroup label was never filled in. Accounts
  that do not label campaigns (most accounts) got empty sections with no
  explanation, and partially labeled accounts saw totals that quietly missed
  the unlabeled share of spend. Unlabeled spend now appears as an explicit
  `(unclassified)` row, so every table adds up to the account total and the
  report says when objective-level analysis is limited instead of hiding it.
  The fix is server-side and applies regardless of plugin version; this
  release keeps the bundled fallback queries and the health-check guidance in
  sync with it.

- **Brands are now labeled with the name you actually curate, not an old
  Amazon storefront label.** Brand discovery built a brand's display name
  from a retained storefront name that can go stale: it stays fixed even
  after you rename or clean up an account, so the label you saw could be a
  name you stopped using a long time ago. The label now comes from the name
  you edit and keep current. Only the label changes. Brands are still filed
  exactly where they were, so your existing brand folders, registries, and
  everything you already type to find a brand keep working with no migration.

- **Your ACoS and TACoS targets now display correctly on the brand summary
  card, in both view modes.** Your target is stored as a whole number (22
  means 22%), but the card was treating that number as if it were already a
  fraction. Viewed as a percent, a 22% target showed as 2200%; viewed as its
  return-on-spend equivalent, the same target showed 0.05x instead of the
  correct 4.55x. Both views now read your target correctly, whichever one you
  have set as your default.

- **`mixshift version` and `mixshift doctor` now check what your host
  actually has installed, not just what this session loaded.** Both commands
  used to compare only the running session's payload against the latest
  published release and called that comparison the whole picture. A host
  installs an update once per app launch, so a session that was already
  running when the update landed keeps serving the old payload until the
  application is fully quit, not just until you start a new chat. When that
  happened, both commands told people who had already updated to update
  again, with no explanation. They now also read the host's own install
  record and say plainly when the installed version and the running session
  disagree: fully quit the application (not just start a new session) and
  relaunch it, and if the old version still shows after that, an earlier
  application process may still be running in the background and needs to
  be closed too.

- **`brand config --apply` no longer crashes on a numeric edit value.**
  Editing a field like an ACoS target with a plain JSON number (`20` instead
  of `"20"`) used to throw a raw error and save nothing. Numbers are now
  accepted the same as the equivalent quoted string, and a value that truly
  cannot be used names the field and what was expected instead of failing
  with no explanation.

## 0.8.7

### Added

- **Sponsored Brands product target bids can now be changed through
  MixShift.** Sponsored Brands was the one ad type with no way to apply a
  product target bid or state change, so those rows had to be entered in
  Amazon's console by hand while everything else in the same plan applied
  automatically. Ask for a Sponsored Brands target bid change and it now goes
  through the usual preview, confirm, and commit flow alongside your Sponsored
  Products and Sponsored Display changes, video campaigns included. Listing
  Sponsored Brands targets and creating or retiring negative product targets
  work too.

- **New: MixShift Intelligence, in closed beta.** A new `mixshift
  intelligence` command family runs MixShift's analysis engine over a merchant
  and a period and hands back a finished read instead of raw rows. Browse what
  is available with `intelligence catalog`, start a run with `intelligence
  run`, and pick a long one back up later with `intelligence poll` and
  `intelligence get`; `intelligence runs` lists what you have going. The
  opening set covers an operations read, an advertising read, a combined view
  of TACOS and paid pressure, a month over month and year over year bundle,
  and lost sales. This is a closed beta: it is switched on per account, so the
  commands will tell you the service is not enabled until yours is added. To
  ask for early access, write to support@mixshift.io or mention it to your
  MixShift contact.

### Changed

- **Built-in skill queries no longer send their SQL in usage reporting.** The
  queries that ship inside MixShift skills used to include their SQL text, and
  the values filled into it, alongside the anonymized usage event. Those
  queries are already identified by name, so the text added nothing we did not
  already have, and it could carry account identifiers such as a seller id.
  It is now left out entirely. Queries you write yourself with `mixshift data
  query` are unchanged, and exactly what they do and do not report is now
  spelled out in the privacy documentation.

### Fixed

- **`whatsnew`, update checks, and the guided update now work in sandboxed
  sessions.** All three read the plugin's published release files, and they
  fetched them from a GitHub address that Cowork and Claude Code sandboxes
  block, so they quietly did nothing in those environments. They now fetch
  through mcp.mixshift.io, the one domain every install already reaches, and
  fall back to the old address if that is unavailable. Nothing new to
  allowlist.

- **Long feedback reports are no longer cut short.** A report longer than
  about 2,000 characters was quietly trimmed before it was sent, so the end of
  a detailed bug report could be lost with nothing to tell you it had happened.
  Reports now go through complete, however long they run.

- **Product-attribute targeting pulls now warn against a filter that can flip
  a trend.** Targeting data holds ASIN targets, category targets, and
  automatic-match rows together. Filtering it to ASIN rows for an account-wide
  view quietly drops the rest, and because those rows can move in the opposite
  direction, an account read can come back pointing the wrong way. The table
  reference now spells out the different kinds of targeting rows and says
  plainly not to filter to ASIN rows for account-level roll-ups.

- **The Brand Context page's seasonality card no longer presents generic
  assumptions as brand facts.** The card previously showed a fixed tentpole
  calendar that ignored your brand's own curated events and asserted a
  specific Prime Day window as fact even though the dates change every
  year. It now shows your brand's structural_events first, clearly labels
  the generic calendar as typical windows rather than brand data, and stops
  asserting exact dates for events that move.
- **Keyword bid health now matches keywords reliably when combining its
  data pulls.** The two warehouse tables behind the review store the keyword
  match type with different capitalization, so combining their results the
  way the skill describes could silently match nothing and report far fewer
  keywords than you actually have. The queries now normalize match type
  before returning, and the table reference documents the trap for anyone
  writing their own queries.
- **A brand's ACOS target now says where it came from.** When a brand is
  first added and the warehouse has no ACOS target for it, the setup writes
  a starting value of 20 percent. That number was previously shown as if it
  came from your own brand setup, and bid recommendations were quietly
  measured against it. For brands added from this version on, brand context
  records whether the target came from your account data or is the
  unconfirmed starting default, and keyword bid health will not treat an
  unconfirmed default as your real target. For brands added earlier, the
  target cannot be told apart from a real one yet, so keyword bid health
  keeps working as before but labels the target unverified and asks you to
  confirm it once on the calibration card. Setting the target yourself with
  `mixshift brand config` marks it as confirmed either way.
- **Skill verdict declarations now allow the low-data verdict.** Keyword bid
  health, daily health check, runaway spend check, and portfolio quick scan
  can all legitimately return an OBSERVATIONAL verdict when there is not
  enough data to judge; their declared verdict ranges now say so.
- **`mixshift skill apply` explains itself honestly.** The command requires
  a structured suggestions file that no shipped skill produces yet. Instead
  of a confusing error, it now says the apply path is not wired up yet and
  points at the mx-amazon-ads preview-and-confirm flow for applying approved
  changes today.
- **Corrected the posture vocabulary in the bundled brand-context
  reference.** The reference document listed posture values the validator
  rejects. It now shows the real vocabulary (scale, efficiency, defend,
  clear_bleed), and the copies bundled with each skill are kept in sync
  automatically so they cannot drift apart again.
- **Asking for a brand's DSP numbers no longer comes back empty when the data is
  there.** DSP performance is filed under your DSP seat rather than under each
  brand's individual seller account, so the natural way to ask for one brand's
  DSP could return nothing even when months of data were present. MixShift now
  knows to look it up by advertiser, resolves the right advertiser by name
  instead of trusting the id Amazon returns alongside your account list, and
  tells you when a brand genuinely has no DSP data rather than leaving you to
  guess. Three DSP tables that no longer exist (audience, product, and geography
  performance) have been dropped from the data catalog so they are no longer
  offered.
- **`mixshift whatsnew` no longer shows an internal maintenance note.** A
  behind-the-scenes marker in the changelog could surface as a stray line in the
  "what's new" output between releases; it is now filtered out of the rendered
  notes.

## 0.8.6

### Added

- **Sessions now let you know when the plugin updated, or when a newer
  version is available.** At the start of a session, if the plugin just
  updated since you last used it, or a newer release has shipped, you will
  get a short heads-up with the option to see what changed. Run
  `mixshift whatsnew` any time for a rundown of recent releases, or
  `mixshift whatsnew --dismiss` to stop the reminder until the next version
  ships.
- **Guided update and post-update catch-up.** Say "update the plugin" (or
  "catch me up" after you already have) and the new `mx-update` skill walks
  you through the exact update steps for your surface, shows what changed,
  and offers any recommended follow-up steps for what shipped since you last
  updated, one at a time, with your confirmation before anything runs.
  `mixshift update-actions` is the read-only command behind it.
- **New skill: scheduled task setup (`mx-scheduled-task`).** Say "set up a
  scheduled task" and Claude builds the whole thing so it keeps working with
  nobody at the keyboard: a persistent folder attached to the task, a service
  credential stored inside it, task instructions that re-establish everything
  at the start of every run, and a verified first run. It also repairs
  existing scheduled tasks that report "not signed in" or "No credentials
  found" on every fire.
- **New command: `mixshift task preflight`.** The first thing a scheduled run
  executes. It finds the service credential (even in a brand-new sandbox),
  verifies it against the service for real, fetches brand context for the
  brands the task uses, and either reports READY or tells you exactly what is
  blocking the run and how to fix it, with a distinct exit code per blocker.
  When the credential it finds turns out to be revoked, it automatically tries
  the next one it discovered (newest first) instead of failing on a stale
  leftover, and tells you to clean the stale one up.

### Fixed

- **Skills reliably find the MixShift CLI on Cowork.** Cowork does not run the
  plugin's session hook, so `mixshift` is never on the command path there and
  each skill has to locate the bundled CLI itself. Most skills previously gave
  up when they could not find it, and sometimes reported the plugin as "not
  installed" when it was in fact installed and working. Every skill now locates
  the CLI by scanning for it, so commands run on Cowork the same as anywhere
  else. This most affects the first thing a new Cowork user does (`mx-welcome`
  and signing in), which could previously stall.
- **Service credential setup no longer reports success from a location that
  will not survive.** In a sandboxed session with no persistent folder
  attached, setup used to write the credential somewhere temporary and look
  successful; the next scheduled run then started signed out. Setup now stops
  and walks you through attaching a folder first, and recommends read-only
  scopes unless the scheduled work actually writes.
- **Search-term data pulls return the full window again.** The search-term
  data-pull skill (and the negation, harvest, and relevance reviews built on
  it) had been reading a stale internal table that stopped updating, so recent
  date ranges came back empty. It now reads the live source table, so a pull
  returns the complete window of search-term performance.
- **Clearer message when an AWD call needs a token update.** Amazon Warehousing
  & Distribution (AWD) is a newer permission. If a merchant was connected before
  it was added, AWD lookups returned a vague "restricted" error and could get
  retried in a loop. The plugin now tells you plainly that the merchant needs
  its token updated to add the AWD role, and points you to the exact place to do
  it, so the call is not retried until it can succeed.
- **Feedback and usage reporting now work from sandboxed and scheduled
  runs.** `mixshift feedback` and the plugin's anonymized usage events used
  to post to a separate host that sandboxed environments block, so reports
  queued locally and never arrived. Both now travel through mcp.mixshift.io,
  the one domain every install already requires, so a bug report sent from a
  scheduled task actually reaches the MixShift team. Skill sharing
  (`mixshift share-skill`) rides the same path. No new domains to allowlist,
  and one less embedded credential in the plugin.
- **Large query results no longer flood the screen.** When a `data query`
  returns a lot of rows, the plugin now saves the full result to a CSV and
  gives you a short summary plus a preview of the first rows, instead of
  printing every row. Pass `--inline` if you really want the whole result
  printed, or `--rows N` for a larger inline preview. Writing to a chosen file
  with `--out` works as before.
- **Large Amazon report downloads are more reliable, and never dump a huge
  document on screen.** Fetching a big report to a file (`report get`/`report
  run` with `--out`) used to fail after a fixed timeout with no retry if the
  download was slow or the connection hiccuped, so you had to run it again by
  hand. It now keeps a slow-but-progressing download going, retries a stalled
  or dropped one automatically, and only gives up with a clear "the report is
  still ready, just fetch it again" message if every attempt fails. Fetching a
  large report without `--out` now saves it to a file and shows a preview
  rather than printing the whole document (pass `--inline` to print it all).

## 0.8.5

Amazon's ASIN-level Search Query Performance report now works, and you can pull
it for any number of ASINs in one command.

### Fixed

- **Search Query Performance reports no longer fail.** Amazon's ASIN-level
  Search Query Performance report needs a list of ASINs to run. Without one,
  Amazon accepted the request and then failed the report while generating it,
  with an unhelpful error. The plugin now always sends the ASIN list, and tells
  you right away if it is missing, so the report completes.

### Added

- **Pull Search Query Performance for any number of ASINs.** Amazon limits a
  single request to roughly 18 ASINs. `mixshift amazon report run` now
  automatically splits a longer list across as many pulls as it takes and
  merges the results into one file, so you can request your whole catalog at
  once. Large lists take proportionally longer because Amazon rate limits Brand
  Analytics heavily; the run tells you how many pulls it made.

### Practical guidance

- Gather the ASINs first (your key products, or a quick catalog pull), then
  pass them with `--option "asin=B0... B0..."`. A WEEK window must run Sunday to
  Saturday. In a terminal, `report run` handles any size list end to end and
  writes one merged file; in chat, keep a single request to about 18 ASINs.

## 0.8.4

Big query and export results now come back automatically instead of failing
with a size error.

### Changed

- **Large `data query` and `data export` results no longer hit a size limit.**
  Previously a query or export that returned too many rows or too much data
  came back as a size error and you had to narrow it and retry. Now the harness
  pages through the full result set for you, so you get every row. Pass
  `--out <path>` to stream a large result straight to a CSV file. If you run a
  large query without `--out`, the harness writes the result to a temporary CSV
  and tells you the file path instead of trying to render it inline.

### Practical guidance

- For big pulls, add `--out <path>` (or in chat, ask to export to CSV) so the
  result lands in a file you can open directly. This comfortably covers pulls up
  to tens of thousands of rows; for genuinely massive extracts, still narrow by
  date range or add filters.

## 0.8.3

Restores the ability to install the plugin through claude.ai surfaces (desktop
app plugin panel, Cowork, and the admin console).

### Fixed

- **Installs through claude.ai were being rejected.** A new claude.ai plugin
  validation rule disallows plugins that ship a top-level `bin/` directory,
  which blocked zip uploads and marketplace syncs of 0.8.2 and earlier. The
  `mixshift` command now lives at `harness/bin/` and is placed on the session
  PATH by a new SessionStart hook, which is the mechanism the validator
  endorses. No behavior change for existing installs: `mixshift <command>`
  works exactly as before.

### Added

- **Session hook scaffolding.** The plugin now ships a `hooks/` directory with
  a SessionStart hook (currently used for PATH registration; it also exports
  `MIXSHIFT_CLI`, the absolute path to the bundled CLI). Skills carry an
  explicit two-step fallback so every command still runs even on a surface
  where hooks are unavailable: `node "$MIXSHIFT_CLI"`, or resolving the plugin
  root from the skill's own base directory.

### Upgrade note for Cowork scheduled tasks

- Cowork does not run plugin session hooks, so scheduled-task prompts must
  not call bare `mixshift`. If you have a scheduled task created before
  0.8.3, update its stored prompt to resolve the CLI entrypoint at runtime
  (see the mx-auth-service-setup skill's runtime-discovery block) and invoke
  commands as `node "$MIXSHIFT_CLI" <command>`. Interactive skills are
  unaffected; they fall back automatically.

### Upgrade note for direct-CLI users

- If you cloned the repo and symlinked or PATH-exported `bin/mixshift` per the
  old install guide, update your link: the entry point moved to
  `harness/bin/mixshift`. Example:
  `sudo ln -sf <clone>/plugins/mixshift-ai/harness/bin/mixshift /usr/local/bin/mixshift`.

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
