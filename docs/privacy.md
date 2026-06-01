# Privacy & telemetry

During the beta, `mixshift-ai` collects anonymized usage data so we can iterate on the plugin — fix bugs, optimize slow queries, identify onboarding friction, and prioritize new features based on what customers actually use.

This page explains exactly what we collect, what we don't, and how to opt out.

**By using the plugin, you agree to this collection.** The same agreement is referenced once during onboarding as part of the welcome screen.

---

## What we collect

**Installation + identity:**
- An anonymous install ID (generated on your machine at first run; a UUID)
- Plugin version
- Which install path you used (Cowork personal / Cowork org / Claude Code / CLI direct)
- Operating system family + Node version
- The work email (`person_label`) you provided during sign-in — links anonymous installs to MixShift accounts so we can see "X customer orgs are using the plugin"

**Onboarding funnel:**
- Welcome viewed
- Sign-in started / completed / failed (with the failure class, not the credentials or tokens)
- Token refresh failures (when the auth service rejects a refresh attempt — used to spot stale-session friction)
- Brand discovery / brand add events
- (Legacy raw-MySQL path only): IP whitelist request submitted

**Usage events:**
- Skills invoked (which skill, when, duration, outcome)
- CLI commands run (`mixshift data list-tables`, etc.) — command name + outcome, not arguments
- Trigger phrases that activated a skill (the natural-language phrase you used to invoke a skill). These are bounded to phrases declared in our skill manifests — i.e. what's already public surface, not arbitrary chat content.

**Warehouse query events:**
- Which library SQL query ID or ad-hoc query ran
- Normalized SQL (the query template, with `:param` placeholders intact — not the resolved param values)
- Table(s) touched
- Seller IDs referenced
- Duration and row count
- Error classification (`access_denied_table`, `timeout`, `syntax_error`, etc.) — friendly category, not raw stack traces

**Feedback:**
- Whatever you send via `mixshift feedback "..."` — these are direct submissions to MixShift, not passive collection.

## What we do NOT collect

- **The contents of your query results.** We log that you ran a query and how many rows it returned; we never see the row data itself. (MixShift already has database-level access to the warehouse, so the query results aren't a privacy boundary either way — but we still don't bother collecting them since they aren't useful for telemetry.)
- **Your MixShift password.** It's entered on the sign-in page in your browser, never seen by the plugin or by Claude.
- **Your auth tokens.** The access + refresh tokens at `~/.mixshift/auth/credentials` stay on your machine. They're sent only as Bearer credentials to the MixShift auth service when querying the warehouse.
- **Your chat content with Claude.** We don't have access to the conversational stream between you and Claude. Only the trigger phrases that activated our skills (via the skill manifest match) are visible to us.
- **Brand context.** The files under `~/.mixshift/clients/<brand>/` — your context.yaml, narrative.md, corpora — never leave your machine. They're your IP.
- **Resolved parameter values for queries.** We log `SELECT * FROM campaignmetric WHERE SellerID = :seller_id`, not `SELECT * FROM campaignmetric WHERE SellerID = 12345`. (The seller IDs themselves are logged as a separate field for cohort analysis, but the SQL text is the template form.)

## Why we collect this

Three concrete uses:

1. **Onboarding diagnostics.** When a user stalls at, say, "auth setup attempted, never completed," we want to know how often that happens and what the failure class was. If 30% of installs stall at the same step, that's a UX bug we need to fix.
2. **Query optimization.** MixShift's warehouse has decades of accumulated SQL. The library queries we ship are tuned, but ad-hoc customer queries can be slow. We can see which queries are slowest (by template) and either ship covering indexes, materialized views, or upgrade those queries into the library.
3. **Feature prioritization.** Which skills get used, which trigger phrases match, which never do. Tells us where to spend engineering time.

This is not a marketing data play. We don't sell it, don't share it with third parties, don't use it for advertising. It's strictly product analytics for an internal team iterating on the plugin.

## Where it goes

- **MixShift's Supabase backend.** A dedicated Postgres database operated by MixShift, accessed only by MixShift engineering.
- **No third-party analytics services.** No PostHog cloud, no Mixpanel, no Google Analytics. Data stays inside MixShift infrastructure.
- **MixShift ops Discord channel (a subset only):** plugin crashes, feedback submissions, table-access requests, and (on the legacy raw-MySQL auth path) IP whitelist requests. These are forwarded server-side from the same Supabase events table — a database trigger calls an internal Edge Function that posts a summary to the ops channel. The plugin itself never holds a Discord URL; it only writes to Supabase. The full event firehose stays in Supabase.

## Retention

We retain raw events for 12 months and aggregate-only summaries indefinitely. If you want your data deleted before 12 months — e.g. you've stopped using the plugin and want a clean slate — send `mixshift feedback "delete my telemetry: <your install_id>"` and we'll process the deletion.

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

When you've opted out, the harness still writes events to its local queue file (`~/.mixshift/telemetry/queue.jsonl`) but never sends them anywhere. The queue is bounded to avoid disk growth. If you want zero local logging too, the env-var approach + checking `~/.mixshift/telemetry/` periodically is your tightest setting.

## What changes after beta

When the plugin exits beta, we'll move from "collection is on by default" to "opt-in only" — meaning a customer affirmatively chooses to share usage data. The privacy disclosure here will be updated at that time.

Beta status is published in the plugin's `version` field. Today the plugin is pre-beta (releases in the `0.5.x` line); the production-grade release will be tagged at `1.0.0`.

## Questions

- Open a GitHub issue at <https://github.com/miXshift/mx-claude-plugin/issues> with the label `privacy`.
- Or send via `mixshift feedback "privacy question: ..."` (in a terminal) or "send feedback to mixshift: privacy question..." (in chat).
- Or reach out via your existing MixShift account team.
