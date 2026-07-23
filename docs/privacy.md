# Privacy & telemetry

During the beta, `mixshift-ai` collects usage data so we can iterate on the plugin: fix bugs, optimize slow queries, identify onboarding friction, and prioritize new features based on what customers actually use. During beta this data is attributed to your account and actor (it is not anonymous) so we can understand who is doing what and improve your experience. The specifics, and how to opt out, are below.

This page explains exactly what we collect, what we don't, and how to opt out.

**By using the plugin, you agree to this collection.** The same agreement is referenced once during onboarding as part of the welcome screen.

---

## What we collect

**Installation + identity:**
- An anonymous install ID (generated on your machine at first run; a UUID)
- Plugin version
- Which install path you used (Cowork personal / Cowork org / Claude Code / CLI direct)
- Operating system family + Node version
- The work email (`person_label`) you provided during sign-in, which links anonymous installs to MixShift accounts so we can see which people and orgs use the plugin
- A CLI user-agent string (`mixshift-cli/<version> ...`) and the surface you ran on (Cowork, Claude Code, or direct CLI)
- An actor tag on every event: whether it came from a person, an automated service credential, or an anonymous pre-sign-in install. For a service credential (unattended automation) we also record the owning account, who minted the credential, its label / purpose and granted scopes, and the network IP the auth service saw when it issued the token, so we can tell which automation is doing what

**Onboarding funnel:**
- Welcome viewed
- Sign-in started / completed / failed (with the failure class, not the credentials or tokens)
- Token refresh failures (when the auth service rejects a refresh attempt, used to spot stale-session friction)
- Brand discovery / brand add events
- (Retired legacy raw-MySQL path only): IP whitelist request submitted

**Usage events:**
- Skills invoked (which skill, when, duration, outcome)
- CLI commands run, captured as the full command line: the command, subcommand, and arguments (flags, table names, brand slugs, and any ad-hoc SQL you type). Credential material is stripped first (see "Secret redaction" below)
- Trigger phrases that activated a skill (the natural-language phrase you used to invoke a skill). These are bounded to phrases declared in our skill manifests, i.e. what's already public surface, not arbitrary chat content.

**Warehouse query events:**
- Which library SQL query ID or ad-hoc query ran
- For built-in library queries, the query-execution event logs the stable query ID. When the client analyzes the statement locally, it may also log a structural shape (primary table, whether it uses `SELECT *`, and projected-column count). It does not log the SQL text or resolved parameter values
- For ad-hoc queries, the SQL text is captured in the command line and in the query-execution event (truncated to 2,000 characters). The command-line secret redactor does not parse inside SQL text, so do not put credentials or other secrets in SQL literals
- The primary table, when the client can derive it
- Duration and row count
- Error classification (`access_denied_table`, `timeout`, `syntax_error`, etc.), a friendly category, not raw stack traces

**Amazon API events:**
- Which Amazon operation or report type ran (report type, Ads operation, pricing batch, AMC / DSP run)
- The account identifiers the call was for (seller id, advertiser / profile id, marketplace), so usage can be attributed to an account, plus item / row counts, duration, and outcome
- We do **not** collect the returned documents, response bodies, or row data

**Feedback:**
- Whatever you send via `mixshift feedback "..."`, which is a direct submission to MixShift, not passive collection.

## What we do NOT collect

- **The contents of your query results.** We log that a query ran and how many rows it returned; we never store the row data itself. (MixShift already has database-level access to the warehouse, so results are not a new privacy boundary, and we do not collect them.)
- **Your MixShift password.** It is entered on the sign-in page in your browser, never seen by the plugin or by Claude.
- **Your auth tokens or client secrets.** The tokens at `~/.mixshift/auth/credentials` stay on your machine and are sent only as Bearer credentials to the MixShift auth service. A secret passed on the command line (a setup code, a client secret) is redacted before any event is stored (see below).
- **Your chat content with Claude.** We do not have access to the conversational stream between you and Claude. Only the skill trigger phrases (manifest matches) are visible to us.
- **Brand-context contents as telemetry.** Telemetry events do not include the contents of `context.yaml`, `narrative.md`, or corpora. Brand-context sharing is a separate, user-controlled product feature described below.
- **SQL text or resolved parameters from built-in library queries.** Their execution events use a stable query ID and structural shape instead. This is distinct from an ad-hoc query you type yourself, which is captured as part of the command line (see Usage events and Secret redaction).

## Brand-context sharing (separate from telemetry)

Brand files remain local unless you explicitly start sharing a brand with the MixShift organization store by running `mixshift context push --brand <brand>` or `mixshift context migrate`. Those commands upload the selected context documents, including their contents, so authorized teammates and MixShift services can use the shared organizational context.

After that explicit first share, later local writes to the same shared brand are automatically published to keep the organization copy current. The plugin prints a notice when an automatic publish succeeds or needs attention. Brands that have never been shared are not automatically uploaded.

To disable automatic publishing, set `MIXSHIFT_CONTEXT_AUTOPUBLISH=off`. Explicit `mixshift context push` and `mixshift context migrate` commands still share documents when you run them.

## Secret redaction

Because we now capture full command lines, the harness runs a redactor over every captured argument vector before the event is stored. It replaces credential material with `<redacted>`:

- the value of any secret-named flag (for example `--setup-code`, `--client-secret`, `--token`, `--password`, `--api-key`), and
- any argument shaped like a token: a JWT, an `sk_` / `pk_` style API secret, or a `SVC-XXXX` service setup code.

One limitation to know: the redactor does not parse inside a larger string. If you paste a raw secret inside a `--body` JSON blob or inside the text of a `data query "SELECT ..."`, that string is preserved as the command you chose to run. Do not inline raw credentials into query or body text.

## Why we collect this

Three concrete uses:

1. **Onboarding diagnostics.** When a user stalls at, say, "auth setup attempted, never completed," we want to know how often that happens and what the failure class was. If 30% of installs stall at the same step, that's a UX bug we need to fix.
2. **Query optimization.** MixShift's warehouse has decades of accumulated SQL. The library queries we ship are tuned, but ad-hoc customer queries can be slow. We can see which queries are slowest (by template) and either ship covering indexes, materialized views, or upgrade those queries into the library.
3. **Feature prioritization.** Which skills get used, which trigger phrases match, which never do. Tells us where to spend engineering time.

This is not a marketing data play. We don't sell it, don't share it with third parties, don't use it for advertising. It's strictly product analytics for an internal team iterating on the plugin.

## Where it goes

- **MixShift's Supabase backend.** A dedicated Postgres database operated by MixShift, accessed only by MixShift engineering.
- **No third-party analytics services.** No PostHog cloud, no Mixpanel, no Google Analytics. Data stays inside MixShift infrastructure.
- **MixShift ops Discord channel (a subset only):** plugin crashes, feedback submissions, table-access requests, and (on the retired legacy raw-MySQL auth path) IP whitelist requests. These are forwarded server-side from the same Supabase events table: a database trigger calls an internal Edge Function that posts a summary to the ops channel. The plugin itself never holds a Discord URL; it only writes to Supabase. The full event firehose stays in Supabase.

## Retention

We retain raw events for 12 months and aggregate-only summaries indefinitely. If you want your data deleted before 12 months (e.g. you've stopped using the plugin and want a clean slate), send `mixshift feedback "delete my telemetry: <your install_id>"` and we'll process the deletion.

To find your install ID: `mixshift telemetry status`.

## How to opt out

**Per-command opt-out** (one-shot):

```bash
MIXSHIFT_TELEMETRY=0 mixshift <command>
```

**Persistent opt-out** (stored in your profile):

```bash
mixshift telemetry opt-out
```

To re-enable later: `mixshift telemetry opt-in`.

To check current status: `mixshift telemetry status`.

When you've opted out, the harness does not enqueue new events and does not send telemetry. Events queued before you opted out remain local and are not flushed while telemetry is disabled. You can remove `~/.mixshift/telemetry/queue.jsonl` if you also want to delete that previously queued local data.

## What changes after beta

When the plugin exits beta, we'll move from "collection is on by default" to "opt-in only", meaning a customer affirmatively chooses to share usage data. The privacy disclosure here will be updated at that time.

Beta status is published in the plugin's `version` field. Releases before `1.0.0` are beta; the production-grade release will be tagged at `1.0.0`.

## Questions

- Open a GitHub issue at <https://github.com/miXshift/mx-claude-plugin/issues> with the label `privacy`.
- Or send via `mixshift feedback "privacy question: ..."` (in a terminal) or "send feedback to mixshift: privacy question..." (in chat).
- Or reach out via your existing MixShift account team.
