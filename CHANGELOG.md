# Changelog

All notable changes to the `mixshift-ai` plugin are recorded here. This log
starts at 0.5.39; earlier versions predate the changelog.

## 0.8.13

<!-- unreleased: version bump happens at release cut, not in feature PRs -->

### Changed

- **Monthly Performance Report Max now runs on Vendor Central accounts, and on a
  whole brand at once.** Until now the figure battery behind the brief only knew
  Seller Central tables, so a vendor account came back empty and the report had to
  be built by hand. `mixshift report battery` now takes one seller id or several
  (repeat `--seller-id`, or `--brand <slug>` to take every account in brand context that
  is not marked inactive, since a winding-down account still sold this month), works out
  each account's channel from your MixShift account row, runs
  the right battery for it (vendor sales, glance views, vendor inventory and
  procurable out-of-stock for Vendor Central), lines every account up on the same
  day count, and rolls up what can honestly be added (ordered revenue, units, ad
  spend and sales) within one marketplace currency. Traffic and conversion stay per
  channel because sessions and glance views are not the same thing, and a brand
  that sells in two currencies gets two roll-ups rather than a made-up total. Ad
  figures come from the daily campaign table on every channel. New flags for Vendor
  Central: `--revenue-basis ordered|shipped`, `--oos-rate-threshold`, and `--attribution`
  to choose the ad attribution columns.

- **Monthly Performance Report Max pulls its warehouse figures through the
  MixShift service.** The figure battery behind the brief (data-aligned windows,
  dark-day normalization, the settled-window check, movers and reconciliation,
  out-of-stock days, page-view-weighted Buy Box by item) now runs inside the
  service and is fetched with one command, `mixshift report battery`, instead of a
  script bundled with the skill. Same figures, same JSON, same per-section
  degrade-and-label behavior; nothing changes in the brief. The call needs the
  token-based sign-in (`mixshift auth login`, or a service credential for
  unattended runs).

- **Amazon failures now report what actually went wrong instead of "unknown".**
  When a call to Amazon failed, some failures arrived labelled `unknown` even
  though MixShift knew exactly what had happened: a retired report type, an
  expired listings change set, a schema that moved, writes not enabled for your
  account. The message you read was already correct; the machine-readable
  `kind` in `--json` was not, so scripts and agents branching on it could not
  tell a permanent problem from a temporary one and would retry things that
  were never going to succeed. Fourteen failure kinds are now reported
  accurately, and their exit codes are unchanged (they keep exit code 1, exactly
  as before), so nothing you have scripted around them behaves differently.
  Two small things alongside. If the service ever sends a kind this version does
  not recognise, `--json` now carries the raw value as `unrecognized_kind` so it
  can be reported. And on that same rare path, the exit code now follows the
  HTTP status where the status is unambiguous (a 429 is treated as `throttled`
  and backed off rather than aborted; a 400 is `bad_request` only when Amazon's
  own error code is present) instead of always being 1.

- **MixShift Intelligence failures are reported more accurately too.** Two more
  service kinds are recognised, and a credential that lacks the Intelligence
  scope now reports exactly that (`insufficient_scope`, exit code 12) instead
  of being mistaken for an account with Intelligence switched off. A gateway
  rate limit reports as `throttled` (exit code 8). On the rare path where the
  service sends a kind this version does not recognise, the exit code follows
  the HTTP status where it is unambiguous (202 not ready, 400 bad params, 429
  busy) instead of always being 1.

### Fixed

- **The help map now lists Monthly Performance Report Max.** Asking for help in
  chat renders the plugin's capability map, and the max tier of the monthly
  report was missing from its reporting group even though it has been available
  since 0.8.9. It now appears next to the standard monthly report, with the
  phrase to say to start it.

## 0.8.12

### Changed

- **Monthly Performance Report Max now prepares your client call, not just your
  report.** Version 2.0 of the max tier produces two documents instead of one: a
  client-ready performance brief you can share as is, and a private internal
  companion with your talking points in call order, the numbers to keep off the
  call, and every open commitment from the last call checked against the data
  (landed, not landed, or not checkable). Each lives on a persistent per-brand
  page that stacks every period's edition, newest on top: the link you share
  once is the link your client bookmarks, new months just appear there, and
  nobody re-sends URLs. Before it writes anything, it works
  out what actually moved and why: availability, pricing and Buy Box, catalog
  mix, or demand, each tested rather than guessed, with Buy Box weighted by
  page views so an outage that already recovered is not reported as a live
  problem. Featured-offer losses get diagnosed against Amazon's live offer
  state, so the brief says whether the box was lost to a competitor or
  suppressed, and what the fix is. Core figures still come from the MixShift
  Intelligence service with the same typed extraction and checks. It also now
  works out of the box on any account with zero setup: a brand-new or empty
  account gets a baseline or setup read that asks questions instead of
  asserting trends, and each run records what it learned so the next one starts
  smarter. Monthly is the default; bi-weekly and QBR windows are a word in the
  ask. The standard-tier monthly report is unchanged.

- **The Report Max client brief now reads the way an account manager presents
  to a client's executives, and the machinery moves to your private companion.**
  Method notes, thresholds, table names and seller identifiers leave the client
  document, so it carries the findings and nothing about how they were
  produced; the internal companion keeps all of that, and opens with a receipt
  of what each layer contributed to the run: what the analysis engine found on
  its own, which brand-context facts shaped the read, which past commitments got
  a verdict, and what the run proposes to remember. Two charts are back in both
  documents, a monthly trend with the current and year-ago months emphasized and
  a bridge showing what pushed the number up and what pulled it down, both drawn
  from the same figures as the tables so a chart never introduces a number the
  tables do not show. Top-mover and item-group tables now use typed per-line
  figures, capped at the five that matter. Before anything is published you walk
  a plain-language review packet, one section per message: the settings used,
  what the report says, questions for you, and what it will remember; a question
  you answer can become a dated event on the brand's timeline, so next month's
  report already knows about the stockout or the Buy Box break. Each account
  manager, and each brand, can keep a voice profile seeded from writing samples
  and refined by the edits you make at review, so the next brief sounds like you
  from the first draft, and a brand can carry its own custom sections that pass
  the same checks as the standard ones. Say "show report settings" to see every
  option, its current value, and how to change it.

- **Engine-written report evidence now keeps its identity when the wording
  improves.** The analytics engine behind Report Max periodically rewords its
  "What we know" statements to read better. Each statement card now carries a
  stable id straight from the engine, and MixShift keys on that id rather than
  on the sentence, so a wording improvement upstream never changes how your
  reports cite their evidence. Reports also record which wording build phrased
  the statements next to the engine version that computed the numbers, so
  "why does this sentence read differently than last month" has a one-line
  answer.

### Fixed

- **Running several MixShift commands at once no longer signs you out.** When an
  assistant or a script ran multiple commands in parallel, they could race each
  other to refresh the sign-in, and the loser would wipe the credentials the
  winner had just saved, so every command after that failed and asked you to
  sign in again. Commands now take turns refreshing, a command that loses the
  race reuses the fresh sign-in instead of deleting it, and a session that has
  really expired produces one clear message naming the fix (`mixshift auth
  login`) rather than a string of silent retries. The MixShift service was fixed
  on its side at the same time, so a lost race now converges on one sign-in for
  that device instead of ending every session on the account.

- **Intelligence commands no longer call the service a closed beta.** MixShift
  Intelligence is open to every account, and the command help and the message
  shown when it is switched off for an account now say so, pointing to
  support@mixshift.io to turn it on.

## 0.8.11

### Added

- **You can now see how your Amazon DSP account is actually set up, not just how
  it performed.** DSP used to be reporting only: numbers, and nothing about what
  produced them. MixShift can now read the account itself and answer the
  questions that come up when something looks wrong. Which campaigns and line
  items exist. Which creatives you have, including ones built in the DSP console
  before you ever used MixShift. Which creatives are attached to which line
  items, and whether each placement is running or paused. Whether a placement
  was approved or rejected, and why. And which creatives Amazon will actually
  let you put on a given line item, which is worth asking rather than guessing:
  DSP names creative types and line-item types differently, so an "online video"
  line item is served by creatives Amazon labels simply "video", and comparing
  the two yourself gives the wrong answer. Finding your DSP advertiser in the
  first place is also much better handled, because a brand's DSP account and its
  Sponsored Ads account share no id and are often named differently; MixShift now
  looks in the right place, shows you the candidates, and asks you to confirm
  rather than guessing. Placing or changing a creative is still done in the
  Amazon DSP console; this is read-only, and MixShift will tell you so instead of
  pretending otherwise.

- **Sponsored Brands ads can now be created from MixShift.** Ask for the ad and
  it gets built: brand video, video, product collection, or store spotlight.
  Until now MixShift could read every part of a Sponsored Brands account and
  build a whole plan, but had no way to create the ad itself, so the last step
  had to be keyed into the Amazon console by hand. Creating an ad group is
  covered too. Amazon treats each ad type as its own thing with its own
  creative, so the MixShift skill now lays out which fields belong to which
  type, in what order to build, and the two rules that decide whether Amazon
  accepts the ad: the video and logo have to already exist in your Creative
  Asset Library, and every advertised product has to appear on the Store page
  you are sending shoppers to. Uploading a new video or logo is still done in
  the Amazon console; MixShift attaches assets that already exist. Amazon checks
  the creative when the change is committed rather than during the preview, so
  commit one ad first and add the rest once it goes through.

- **The daily health check can now break spend down by objective even when
  your account never filled that field in.** Most accounts leave the Objective
  and Item Group fields empty in the platform, so both breakdowns collapsed to
  a single "unclassified" row holding all the spend: accurate, and no use for
  deciding anything. When more than about a third of your spend is unlabelled,
  the health check now offers to sort it out: it reads your campaign names,
  proposes a set of buckets, and shows them to you to rename, merge or reject
  before anything is used. Confirmed buckets are remembered against the brand,
  so later runs pick them up, and new campaigns get caught the same way. A
  label somebody actually typed in the platform always wins over a proposed
  one, and nothing is written back to the platform or to Amazon: this changes
  how the report groups, and nothing else.

- **Monthly Performance Report Max now explains why a number moved using the
  analysis engine's own account, instead of writing its own.** The engine
  already worked out what drove each change and published that reasoning, but
  nothing in the report could reach it, so when the report said spend rose
  because of something, that explanation was composed by the assistant rather
  than sourced. It now quotes what the engine actually found and cites it. Where
  the engine has no explanation for a particular movement, the report says what
  it observed and leaves the cause open rather than inventing one, because a
  movement nobody has explained yet is a different thing from a movement with a
  confident-sounding guess attached to it.

- **You can now tell MixShift when it could not do something at all.** Feedback
  gained a "capability gap" type for the case where MixShift had no way to do a
  step and the work had to happen somewhere else. Your assistant raises it on
  its own when it hits one, and asks before sending anything. This is the one
  kind of problem that leaves no trace otherwise, because nothing fails: the
  work just quietly moves to another tool, and we never find out it was needed.

### Fixed

- **The Sponsored Brands documentation no longer describes operations that do
  not exist, or fields that a campaign will not accept.** The skill listed two
  ad-creation operations that were never available, which meant a plan could be
  built around them and only fall over at the last step. It also listed
  creative and ad-format fields on the campaign itself, which Amazon moved onto
  the ad. Both are corrected, and every release now checks that each operation
  named in the documentation is one that actually exists.

- **Monthly Performance Report Max now takes each figure's unit from the
  analysis engine instead of a list kept inside the plugin.** The engine
  publishes the unit and the precision for every metric it computes, along
  with how serious each caveat is. Until now the plugin kept its own copy of
  that information, which had to be updated by hand every time the engine
  gained a metric, and a metric it had not heard of fell back to being
  displayed as a plain count. Dollars could render as bare numbers that way.
  The plugin now uses what the engine publishes, so a new metric is labelled
  correctly the first time it appears. Reports built against an older engine
  are unaffected and render exactly as before.

- **A figure whose unit does not match the engine's is now caught before the
  report is written.** The report checks have always tested how claims and
  figures relate to each other, but never whether a unit actually describes
  the number it labels, so a mislabelled figure passed every check and
  shipped. A new check compares each figure's unit against the one the engine
  published for it. It only runs where the engine has published a unit, so it
  cannot invent problems on an older run. Point in `mixshift report validate`
  or `mixshift report render` at the extracted figures with `--figures` if
  you are working outside the folder they live in, or turn the check off for
  a run with `--no-figures`.

- **`mixshift report validate` now separates errors from warnings.** Every
  finding used to block rendering, including one plausibility check that can
  legitimately fire on a real number: an advertising cost of sale above
  1000% is genuine on an account with almost no sales and live spend. Because
  the only way past it was `--force`, which waives every other check too,
  one false alarm on a correct figure meant either not shipping the report or
  shipping it with all the real checks disabled. Warnings are now reported
  and do not block; errors still do. Read the warnings rather than relabelling
  a figure to silence one.

- **A caveat the engine marks as blocking now attaches to the totals as well
  as the change.** These caveats mean a number is not safe to quote on its
  own, and the number they usually mean is a total, not the month-over-month
  movement. Previously only the change carried the caveat, so a section could
  quote the flagged total with no warning shown and no check complaining.

- **When Amazon rejects your request, you now see Amazon's own reason, and the
  plugin stops pretending it was a server problem.** A request Amazon refused
  because of its own parameters used to come back looking like a MixShift
  outage, so the natural response was to try again, and trying again could
  never work. These failures are now reported as what they are: the request
  itself, terminal until it changes. You get Amazon's own error code alongside
  its message, and in `--json` the full response Amazon sent, so there is
  something complete to act on or to send us. Scripts get a distinct exit code
  (12) and can stop instead of retrying.

- **Failures caused by our own documentation are now findable.** The operation
  catalog is written by hand, so a required parameter Amazon enforces but does
  not document, or a combination only valid together, can send every caller
  into the same wall. When a call is rejected, the plugin now says so plainly
  and points at `mixshift feedback`, and the Amazon error code is recorded with
  the operation, so the same mistake repeating across accounts surfaces as a
  pattern instead of waiting for someone to write in. The error code is
  recorded, not the message: it is a short Amazon-defined label like
  `InvalidInput` and carries no account, order or product identifiers.

- **A failure on a non-report call no longer says a report failed.** When the
  service could not be reached, or answered in a shape the plugin did not
  recognize, the plugin fell back to its own wording, and that wording assumed
  every call was a report request. So a live Amazon call, an advertising call,
  or a pricing call could fail with "the report request failed unexpectedly",
  and a 403 on any of them was described as a restricted report needing a data
  role. The fallback now names the surface you actually called, and says
  nothing about reports when it does not know which surface you were on.
  Failure messages the service itself supplies were already correct and are
  unchanged.

- **The table catalog now says which seller column to filter on, so settlement
  queries take the fast path.** Most seller-scoped warehouse tables carry two
  seller columns that hold the same seller: an integer id and Amazon's own
  merchant token. They are not interchangeable for speed, because the indexes
  are generally built on the integer, and on the settlement table the integer
  is the one paired with the posted date. Filtering by the merchant token plus
  a date range leaves the date with no index to use and scans every row for
  that seller: on a live account the identical one-month count took 13.4
  seconds that way and 0.37 seconds filtering on the integer id. The catalog
  now records the rule, the settlement specifics, and the settlement date
  column, so queries and date-range exports built from it use the covering
  index. Writing the slow filter by hand still works and still returns the same
  rows, which is why this was easy to miss.

- **A skill that has to search for the plugin's own program now picks the newest copy
  it finds.** When the plugin's command is not on the PATH, a skill falls back to
  locating the bundled program itself. That search took whichever copy it happened to
  find first and then reused it for the rest of the session, and a machine keeps every
  version it has ever installed, so a skill could run an older build than the one you
  are on. It now takes the newest version it finds instead of the first result.

## 0.8.10

### Added

- **Team brand contexts now show up automatically the moment you work an
  account.** Previously, a brand's shared context only reached a machine if
  someone explicitly pulled it there or ran brand setup on that machine
  directly. Now, the first time any skill touches an account your team has
  already set up elsewhere, whether that's a brand-new machine or a fresh
  Cowork session, its shared context arrives in the background
  automatically. Nothing to run, nothing to remember.

- **`brand add` now tells you whether the new brand's context reached your
  team.** Bootstrapping a brand auto-publishes its context to your org's
  shared store in the background, but there was previously no way to tell
  from the command's own output whether that publish actually succeeded,
  only a separate notice printed on failure. `mixshift brand add <slug>` now
  prints one confirmation line when the publish lands, and `--json` output
  carries a `push` object (`attempted`, `published`, and a `reason`/`detail`
  on anything short of success) so scripts can check it too.

- **Context sync now reports what it's doing, and remembers whether it
  actually worked.** The background push that runs after every brand-context
  write, and the throttled sync that runs before skills read one, both emit
  telemetry now, the same way the `context push`/`context autosync` commands
  already did. The per-brand sync ledger also now tracks whether the last
  attempt actually succeeded, separately from when it was last attempted, so
  a string of offline attempts no longer looks the same as a healthy one.

- **Signing in now shows what your org has set up versus what's on this
  machine.** Sign-in already reported your local brand count. It now also
  reports how many brands your org has configured overall and how many of
  those are not yet on this machine, so a new teammate or a fresh machine
  can tell right away whether they're missing shared context instead of
  finding out the hard way.

- **Clearer guidance when a merchant isn't connected to MixShift yet.**
  Brand setup's fallback for an account it couldn't find used to mean the
  account manager had to hand-write the context files. It now checks
  whether the merchant might just be listed under a different name,
  explains exactly what it means when an account's Ads or Retail connection
  is inactive, and if the merchant genuinely isn't in your MixShift account
  yet, says so plainly with the next step instead of trying to work around
  it.

- **Clearer guidance when the sandbox blocks MixShift.** Signing in already
  told you when a Claude Cowork or Claude Code network sandbox was blocking
  MixShift, and pointed you at `mixshift doctor` for the fix. Data queries
  and context sync used to just say "check your network" with nothing to
  act on. They now carry the same diagnosis, so a blocked proxy, a DNS
  failure, or a timeout says what happened and points at `mixshift doctor`.
  The one exception is a direct legacy database connection, which `mixshift
  doctor` does not check; that failure still tells you to check your
  network, your VPN, or your IP allowlist instead.

- **A heads-up when your team has context for a brand but this session
  couldn't reach it.** The background sync that runs before a skill reads a
  brand's context used to fail silently, so an offline or blocked session
  looked exactly like a brand with nothing new to sync. Now, when your org
  is known to have context for a brand and a sync attempt can't reach the
  store, MixShift says so once, and confirms your local copy (if any) is
  unchanged, instead of staying quiet.

- **Brand setup now checks what MixShift already knows before it asks you
  anything.** Before the account manager interview starts, brand setup
  checks whether your team already set this brand up somewhere else and
  offers to adopt that work instead of re-asking the same questions, reads
  which target and campaign-organization fields are actually configured in
  the platform today, and reads the account's existing portfolio names for
  structure hints: brand lanes, campaign objectives, and prior-agency
  history. Where the platform already has an answer, brand setup shows it
  and asks you to confirm instead of asking cold. Where a field was
  genuinely never set up in the platform, it says so plainly instead of
  treating it like missing data.

### Fixed

- **`context autosync`'s built-in help no longer says pull-only.** The
  command's own description still described it as fetching server-side
  changes only ("nothing is pushed"), even though it has pushed
  non-conflicting local changes too since 0.8.8. The description now says
  what it actually does: two-way, never blocking, and a quiet no-op when
  you're offline or not signed in.

- **Monthly Performance Report Max now reads the full monthly run.** A monthly
  intelligence run returns a bundle that holds each period's analysis inside it,
  and the report skill was handing that whole bundle to the figure extractor,
  which found nothing it recognized and returned an empty set without
  complaining. The extractor now refuses a bundle instead of quietly returning
  nothing, and the skill pulls out one period at a time
  (`mixshift report extract <run.json> --select mom.ops`). Figures also carry
  which period they came from, so a month-over-month number and a year-over-year
  number can never be mistaken for each other in the same report. If you ran the
  smart-tier monthly report on 0.8.9, re-run it on this version.

- **Monthly Performance Report Max now labels every figure with the unit of
  the value it holds.** Some figures rendered in the wrong denomination: a
  2.06x return on ad spend printed as "206.0%", an $0.85 cost per click
  rounded to "$1", a dollar figure on a bridge could carry a percent label,
  and a few ad-driven metrics printed as bare numbers instead of dollars. The
  renderer now knows the reporting engine's unit vocabulary, a movement in a
  rate is shown in points rather than as a percent of a percent, and every
  figure carries the unit of the value it actually stores. The re-run advice
  above covers this fix too.

- **Portfolio budget caps now come from Amazon directly.** The stored copy of a
  portfolio's budget cap in the warehouse is often wrong, so asking what a
  portfolio is capped at could come back with a placeholder figure rather than
  the real one. That question now goes to the live Amazon read
  (`mixshift ads call portfolios.list --legacy-seller-id <id>`), which returns
  the current amount,
  currency, policy, and date range straight from your account. The data catalog
  also now explains that a portfolio's cap is not the sum of its campaigns'
  daily budgets: the cap exists to hold total portfolio spend below that sum, so
  the two figures are expected to differ, and a gap between them does not mean
  anything has failed to sync.

- **A sub-brand promotion plan can no longer be built on data that failed to
  load.** Sub-brand discovery runs four warehouse reads, and if one of them
  failed the plan was still built and shown as if everything had loaded. A lost
  ads read printed "no campaigns yet" as a statement of fact rather than
  reporting that the figure was unavailable, so two runs of the same plan
  minutes apart could disagree about how many campaigns a brand has. The plan
  now stops and tells you a read did not complete, instead of presenting a
  partial picture as a whole one. Re-running is also far less likely to be
  needed: a read that fails to reach the service before it gets an answer is
  now retried automatically, which covers the brief connection drops that
  caused this most often. A read that genuinely returns nothing is still
  reported as nothing, so "no campaigns yet" remains available when it is
  actually true.

- **Promotion candidates are ranked by money, not by how many items they
  have.** The plan decided which brand labels were worth promoting by counting
  catalog items, so a label sitting on a large but mostly inactive catalog
  could be proposed ahead of one carrying most of the account's revenue and ad
  spend, and a brand that was economically large but listed on relatively few
  items could be left out of the plan altogether. Candidates are now ranked on
  trailing revenue plus ad spend, and a label qualifies on either its catalog
  footprint or its share of the account's money, so neither kind of brand gets
  missed. Each item shows its trailing 365-day revenue and ad spend.

- **Brands that look wound down, or too small to be worth their own brand, are
  flagged rather than quietly proposed.** A brand with real revenue last year
  and nothing recent, or one carrying a trivial share of the account, is no
  longer offered for promotion by default. It still appears in the plan with
  its real figures and a plain explanation of why it was held back, and can
  still be promoted if the read is wrong: nothing is hidden and nothing is
  removed from any total, so the plan continues to reconcile against Seller
  Central and Vendor Central. Whether a brand is still trading is judged from
  observable activity (recent orders and recent ad spend) rather than from
  custom item labels, which every account uses differently.

- **Sub-brand discovery and promotion are findable now.** Asking to build a
  promotion plan did not reliably reach the right command, and `mixshift brand
  --help` still described the command group as "list, add, edit, archive" with
  no mention of `discover`, `promote`, or `demote`. The command group, the
  capability map shown by `mixshift guide`, and the brand-context skill's own
  description all list the sub-brand workflow now, and `brand discover` points
  at `brand promote` as the next step.

- **A total data outage can no longer come back as "this account is a single
  brand".** When every one of the queries that builds the label report failed,
  `mixshift brand discover` still reported a confident single-brand verdict,
  reached by reading an empty result as evidence that the account has no
  distinct brands, and exited as though it had succeeded. Anything reading
  that output, including automation, would have taken a network outage for a
  finding about the business. Discover now reports the failure, proposes
  nothing, and exits non-zero.

- **Promoting a brand can no longer create one that reads your whole account.**
  A brand qualifying on its revenue alone, without appearing in the catalog or
  ad coverage figures, could be turned into a sub-brand carrying no label
  filter at all: it would have been scoped to the entire seller account while
  describing itself as a sub-brand, and every figure it reported would have
  been the account's, not the brand's. Promotion now refuses to create a brand
  it cannot scope, and where the revenue figures identify which label field the
  brand was found in, it uses that and creates the brand correctly.

- **A brand with no revenue figures is no longer reported as "too small".** When
  the revenue lookup returned nothing for a particular brand, that brand was
  described as holding 0.00% of the account and held back as economically
  trivial, stating as measurement something that was only missing data. A
  brand we have no figures for is now proposed normally, and only a brand with
  real figures behind it can be held back for being small.

- **The plan no longer suggests moving your existing brand onto one it just
  flagged.** When an account already has a single whole-account brand, the plan
  proposes which label that brand should become. It picked whichever label
  carried the most items, without checking whether that same label had been
  flagged as wound down, so it could recommend, in one breath, both holding a
  brand back and rebinding your history onto it. Only labels the plan actually
  proposes are considered now. The percentages shown still count every label,
  flagged ones included, so the figures continue to reconcile.

- **A brand whose label carries stray spacing keeps its revenue figures.** The
  revenue lookup matched labels exactly while the rest of the plan matched them
  with surrounding whitespace trimmed, so a label stored as `" Acme "` on one
  side and `"Acme"` on the other was treated as two different brands and lost
  its figures, which then made it look economically trivial. Both sides now
  match labels the same way.

## 0.8.9

### Added

- **Early sub-brand label discovery, for accounts run as several brands under
  one Amazon seller.** Some agencies operate many distinct brands out of a
  single seller account, told apart only by a Brand label on the retail and
  ads sides. A new `mixshift brand discover --seller-id <id>` command reads
  those labels and reports, per side, how many distinct labels exist, how
  much of the catalog or ad spend has no label yet, and how well the retail
  and ads labels line up with each other. It proposes whether the account
  looks like one brand or several, but never decides for you and never
  creates or changes anything: that confirmation step comes in a later
  release. The underlying data queries this command depends on are still
  rolling out, so results may be incomplete for some accounts until that
  finishes.

- **Turning discovered sub-brand labels into real brands, and brand setup's
  new nested path.** `mixshift brand promote --seller-id <id>` builds a
  promotion plan from that discovery: which labels would become their own
  brand, what slug each would get, and whether a brand is already bound to
  that label so re-running never proposes the same thing twice. The default
  is always a plan only; nothing is written until you confirm one step at a
  time with `--apply`. Accounts already set up as one whole brand get a
  content triage proposal alongside the plan: for every existing note,
  event, and instruction, a suggested disposition (move it to a specific
  sub-brand, copy it to all of them, or retire it) that you review and edit
  before anything happens. `mixshift brand demote <slug>` reverses a
  promotion: it unsets the binding and sets the local folder aside without
  deleting anything, so restoring it later stays possible. Brand setup
  (`mx-brand-context`) now runs a shape check before it does anything else;
  on an account that looks like several brands, it walks you through
  picking which labels become brands, asks the questions that are the same
  across all of them once, and then sets up each one with just its own
  differences. Single-brand accounts see no change at all.

- **Sub-brand data scoping is now automatic, and it tells you the truth
  about what happened.** For a brand set up as a sub-brand, brand setup and
  the brand brain now apply that sub-brand's label filter to every data pull
  that supports one, so its context and baselines are built from its own
  catalog and campaigns instead of the whole seller account. Each run
  reports, pull by pull, which numbers are label-scoped, which describe the
  whole account (some data, like the Seller Central revenue baseline, has no
  label on it at all), and which could not be confirmed as label-scoped at
  all, rather than assuming a filter worked just because it was sent. It
  warns clearly if a label filter matches nothing, whether that happens
  during brand setup or an ongoing brand-brain refresh, so a typo in a label
  value cannot silently produce an empty brand, and it warns just as loudly
  if a filter you set was not actually applied, so a sub-brand's numbers are
  never quietly account-wide without you knowing it. Brands not set up as
  sub-brands see no change.

- **Monthly Performance Report Max: a smart tier of the monthly report, built
  on MixShift Intelligence.** The new `mx-monthly-report-max` skill composes
  the same monthly report from figures the intelligence service computes and
  publishes (H-Bridge decompositions with footing checks, MoM and YoY pairs,
  cross-domain TACOS), instead of numbers assembled in chat. Every figure in
  the report traces to its source; a sentence that quotes a number without
  its basis, claims a superlative the data does not support, or drops a
  required caveat is refused before the report renders, by mechanical
  validators the model cannot talk its way past. The nine claim errors that
  shipped in real reports are locked in as permanent must-fail tests. Your
  existing `mx-monthly-report` skill is unchanged and stays the standard
  tier. One report consumes one metered intelligence request; re-renders are
  free. Requires intelligence enrollment for the account; if the account is
  not enrolled the skill says so and offers the standard tier instead. New
  supporting commands: `mixshift report validate | extract | render`.

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

- **Stockout windows no longer carry an inflated dollar figure.** The Brand
  Brain's advisory stockout detection attached an "impacted revenue" amount
  to each out-of-stock window, computed by summing account-wide daily ad
  sales over the window's dates. Because windows for different ASINs
  overlap, the same day's revenue was counted once per overlapping window,
  which inflated the total severalfold. The dollar figure was never
  displayed anywhere; the advisory list now orders by days out of stock
  instead of the removed revenue score, so the ten candidates shown on the
  brand context page can differ for accounts with many concurrent
  stockouts. The windows themselves (ASIN, item, dates, days out of stock)
  are unchanged, and brand files written by older and newer versions keep
  loading on either side. A rigorous lost-sales estimate, scoped to the
  ASIN and period, is planned as a replacement.

- **A mistyped `brand config --apply` command no longer saves and shares
  changes you did not confirm.** The command reads a JSON instruction telling
  it whether to confirm, cancel, or edit. It positively recognised only
  "confirm" and "cancel", so anything else, including a simple misspelling of
  "edit", fell through to the editing path: your changes were written to the
  brand file and published to your team's shared brand context without the
  command ever being one MixShift understood. It now stops and tells you which
  actions are valid.

- **`brand config --apply` no longer reports a malformed edit as a success.**
  If the edits were sent in the wrong shape, for example a number or a list
  where a set of field changes was expected, the command answered "ok" and
  reported nothing changed, so anything reading that result had no way to tell
  a saved edit from a silently discarded one. Sending no edits at all, or an
  empty value, failed with a raw internal error instead of naming what was
  missing. Both now come back as a validation failure that names the field and
  shows the expected form. Asking to edit with an empty set of changes is
  still a valid way to do nothing.

- **Changing a skill setting to a plain number no longer fails with a raw
  error.** Every per-skill setting is edited by sending MixShift a small
  instruction describing the change. Writing a number the natural way, as
  `20` rather than `"20"`, produced an internal error message that named
  nothing and told you nothing about how to fix it. Plain numbers are now
  accepted, and any value that genuinely cannot be used says which setting it
  belongs to and what was expected. Two related problems are fixed at the same
  time: a mistyped instruction, including a simple misspelling of "edit", used
  to be treated as an edit and could save settings and share them to your
  team's shared brand context without ever being an instruction MixShift
  understood, and asking to edit without actually supplying any changes
  crashed. Both now stop and explain what is wrong, and nothing is saved or
  shared. Sending no changes on purpose still works.

- **A 1% goal is no longer saved as 100%.** Percent settings accept both a
  whole number and a decimal ("20", "20%" and "0.20" all mean twenty
  percent), and the value `1` sits exactly where those two readings collide:
  it can mean one percent or one hundred percent. MixShift used to pick one
  silently, so a TACoS goal of 1%, which is the lowest value the field itself
  says it accepts, was stored as 100% with no warning and quietly skewed every
  report and health check that read it. Typing `1` where both readings are
  possible now asks which you meant instead of guessing, and an explicit
  percent sign is always taken at face value, so `1%` is one percent and
  `100%` is one hundred. Every other input is unchanged.

- **Two dead tables no longer masquerade as live data sources.** The data
  catalog described `business_reports_dpst_item` and
  `business_reports_dpst_total` as usable daily sales tables, but neither has
  received new rows in years, so queries against them quietly returned stale
  history as if it were current. Both are now marked deprecated in the
  catalog with a pointer to the live equivalents
  (`business_reports_dpst_sku` for item/ASIN-level daily sales,
  `business_reports_dpst_date` aggregated for account-level totals), so
  anything reading the catalog steers to tables that are actually updated.

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
