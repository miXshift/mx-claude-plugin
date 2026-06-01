# Brand Management

**Status:** Draft v0.3
**Scope:** How the productized plugin discovers, onboards, stores, and manages a user's portfolio of Amazon advertising brands.
**Out of scope:** Renderer rewrite, AuthProvider interface, telemetry transport, write-MCP design. Each gets its own doc.

---

## Problem

Today the plugin assumes a single internal operator running skills against a fixed set of clients whose context lives in `shared/clients/` inside the repo. For productization:

- An agency may manage 50+ clients. Each is a separate "brand" with its own context.
- Brand context is per-client state, not plugin state. It must live outside the repo and survive plugin updates.
- A non-technical agency user must be able to see all their clients at a glance, edit context, and onboard new ones — without hand-editing YAML.
- Skills must trigger onboarding automatically the first time they encounter a brand they don't know about.
- Brand identity should not be hand-typed. It already lives in the `seller` table of the warehouse the user is connected to.

---

## The two onboarding events

> **Auth status (shipped 0.5.x):** User onboarding is now token-based browser sign-in against the mx-legacy-auth service (`mixshift auth login`). The raw-MySQL-creds + per-user IP-whitelist flow described in early drafts of this doc is legacy: still supported via `mixshift auth setup`, but no longer the default. See `docs/auth-setup.md`.

| Event | Frequency | What gets configured |
|---|---|---|
| **User onboarding** | Once per install | MixShift account sign-in (browser PKCE / device-code, yielding access + refresh tokens), output adapters, Flask UI password, telemetry consent. Lives in `~/.mixshift/profile.yaml` and `~/.mixshift/auth/`. |
| **Brand onboarding (cold-start)** | Once per brand, repeated for each new client added | Account type, ACOS/TACOS targets, posture, sub-brand structure, naming patterns, capture rate calibration. Lives in `~/.mixshift/clients/<brand-slug>/context.yaml`. |

User onboarding is a one-shot. Brand onboarding runs 1-to-N times depending on portfolio size.

---

## Filesystem layout

```
~/.mixshift/                            # MIXSHIFT_DATA_DIR override available
  profile.yaml                          # user-level config
  auth/
    credentials                         # token sign-in: access + refresh tokens
                                        # (mode 0600). Legacy raw-MySQL creds, when
                                        # used, live in this file's mysql block.
  clients/
    index.yaml                          # portfolio overview, see schema below
    example-brand/
      context.yaml                      # canonical per-brand context
      narrative.md                      # voice baseline + structural notes
      brand-intelligence.yaml           # competitive / catalog metadata
      corpora/                          # searchable text for the brand
      runs/
        2026-05-13-daily-health-check.json
        2026-05-13-keyword-bid-health.json
        ...
    example-brand/
    example-brand/
    ...
  tmp/                                  # per-run scratch (data, context snapshots)
  output/                               # rendered reports (when adapter=local-html)
    example-brand/
      2026-05-13-daily-health-check.html
  templates/                            # optional user overrides for renderer
```

### Why `~/.mixshift/` and not `~/.claude/`

- Plugin install dirs get replaced on update; user data must outlive them.
- `~/.claude/` is Claude's namespace, not application data.
- A stable, addressable, OS-neutral path lets the Flask UI, CLI, and skill harness all point at the same files.
- Env override: `MIXSHIFT_DATA_DIR=/custom/path` for power users.

---

## Brand discovery: pull from `seller` table

The user does **not** manually enter brand slugs or seller IDs. After sign-in succeeds, the plugin queries the warehouse:

```sql
SELECT
  SellerID,
  AmazonSellerID,
  SellerName,
  MarketPlaceName,
  account_type,           -- SC or VC
  ads_active,
  retail_active,
  last_data_date,
  ...
FROM seller
WHERE [user has read access]
```

The result populates `~/.mixshift/clients/index.yaml` with every brand the user can see, marked as `available_not_active` until they choose to onboard.

```
First-time post-auth flow:

  Plugin: "I see 12 sellers in your access list:
            [ ] AcmeCorp (SC, ads active)
            [ ] example brand (SC, ads active)
            [ ] example brand (SC, ads active)
            [ ] ACME Corp (VC, ads active)
            ... 8 more ...
          Select brands to manage. The rest will stay visible
          but require explicit activation later."
```

Onboarding from there is JIT — user picks brands, plugin offers to cold-start each. They can also just say "I'll do them as I go" and onboarding triggers when they first try to run a skill against an inactive brand.

---

## `index.yaml` schema

The portfolio roll-up. Updated by: brand discovery (initial population), cold-start (status transitions), every skill run (last_skill_run fields).

```yaml
schema_version: 1
last_discovered_at: 2026-05-13T14:22:00Z
brands:
  - slug: example-brand                          # user-facing label, mutable
    display_name: AcmeCorp
    accounts:                               # one brand folder can hold N accounts
      - seller_id: 12345
        amazon_seller_id: A1XXXXXXXXX
        marketplace: US
        account_type: SC
        merchant_type: seller
        ads_active: true
        retail_active: true
      - seller_id: 67890
        amazon_seller_id: A2YYYYYYYYY
        marketplace: US
        account_type: VC
        merchant_type: vendor
        ads_active: true
        retail_active: true
      - seller_id: 11111
        marketplace: CA
        account_type: SC
        merchant_type: seller
        ads_active: true

    status: active                          # see status states below
    onboarded_at: 2026-04-12T10:15:00Z
    context_updated_at: 2026-05-09T08:33:00Z
    context_freshness: fresh                # fresh | aging | stale

    last_skill_run:
      skill_id: daily-health-check
      at: 2026-05-13T07:00:00Z
      verdict: GREEN

    active_structural_events:               # mirrored from context.yaml
      - type: price_test
        active_through: 2026-05-24

    notes: ""

  - slug: example-brand
    display_name: example brand
    status: active
    context_freshness: stale                # > 30 days since last update
    ...

  - slug: acmecorp
    status: pending_cold_start              # discovered but not onboarded
    ...

  - slug: legacy-client
    status: archived                        # user removed from active management
    archived_at: 2026-04-30T00:00:00Z
```

### Status states

| Status | Meaning |
|---|---|
| `available_not_active` | Discovered from `seller` table, not yet selected by user |
| `pending_cold_start` | User selected it but cold-start hasn't completed |
| `active` | Cold-start complete, can run any skill |
| `stale_context` | Active but `context_updated_at` > 30 days; recommend refresh |
| `archived` | User removed from active set; data preserved |

### Freshness rules

- `fresh`: updated within 30 days
- `aging`: 30-60 days
- `stale`: 60+ days. Skills surface a warning; user can dismiss or trigger refresh.

---

## Cold-start triggers

Three entry paths, all converge on the same `account-cold-start` skill execution:

1. **JIT from skill preflight** — user runs `/daily-health-check acmecorp`, plugin sees no context.yaml for `acmecorp`, prompts to onboard.
2. **Explicit slash command** — `/mixshift-brands add <slug>` for upfront onboarding.
3. **Bulk import** — `/mixshift-brands add --from-file brands.yaml` for agency migration from another tool.

For all three paths cold-start:

1. Queries the 31 `CS-*` SQL files against the brand's data
2. Walks the user through any context fields the SQL can't infer (goals, posture, structural events known to operator)
3. Writes `context.yaml`, `narrative.md`, `brand-intelligence.yaml`, `corpora/`
4. Updates `index.yaml` with status `active`
5. Resumes the original triggering skill if it was JIT

### Follow-up optimization (not v1)

Parcel cold-start by skill. Today it runs 31 queries to cover everything. Future split:

- `CS-base` — seller identity, account type, naming structure (~5 queries, always runs first)
- `CS-daily-health-check`, `CS-search-term-negation`, etc. — only the queries that specific skill needs beyond base

First skill triggered for a brand runs `CS-base` + that skill's subset. Subsequent skills run only their subset. Decision gate: build this once we have a single agency complaining about onboard time at scale.

---

## Brand management surface

Three layers, same canonical truth (the filesystem):

### Slash commands (technical users)

```
/mixshift-brands                  → table view of index.yaml
/mixshift-brands add <slug>       → cold-start for new brand
/mixshift-brands add --from-file  → bulk import
/mixshift-brands status <slug>    → full context + freshness + recent runs
/mixshift-brands update <slug>    → guided field edit
                                    (e.g. "set acos_target_pct to 25")
/mixshift-brands refresh <slug>   → re-run cold-start (structure change)
/mixshift-brands archive <slug>   → move out of active set
/mixshift-brands diff <slug>      → context drift vs last cold-start
/mixshift-brands validate <slug>  → schema-check context.yaml after manual edit
/mixshift-brands rediscover       → re-query `seller` table, surface new brands
/mixshift-brands rename <old> <new>         → change user-facing slug (folder move + index update)
/mixshift-brands split <slug>               → break one multi-account brand into separate brands
/mixshift-brands merge <slug1> <slug2>      → combine two brands into one (e.g. US + CA same legal brand)
```

### Brand identity vs. slug

`SellerID` is the immutable canonical identity (from the `seller` table). Slug is a user-facing label. Two consequences:

- Renaming a slug is a folder move + `index.yaml` patch. Run history, sidecars, and context are preserved.
- One brand folder can hold multiple `SellerID`s in `context.yaml::accounts[]`: e.g. SC US Seller + VC US Vendor + SC CA Seller all under `example-brand`. Or the user splits them into `example-brand-us` and `example-brand-ca` if they want separate operational treatment.
- Brand-discovery from the `seller` table proposes a grouping (auto-cluster by parent company or naming pattern) but the user can override at discovery time.

`/mixshift-brands` rendering:

```
Slug          Account  Ads  Onboarded   Ctx Age  Last Run                  Status
─────────────────────────────────────────────────────────────────────────────────
example-brand      SC       ✓    2026-04-12  4d       2026-05-13 health GREEN   active
example-brand          SC       ✓    2026-04-15  38d!     2026-05-13 health YELLOW  active
example-brand  SC       ✓    2026-04-20  8d       2026-05-12 negation       active
acmecorp      VC       ✓    —           —        —                         pending
client42      SC       ✓    —           —        —                         available
─────────────────────────────────────────────────────────────────────────────────
3 active · 1 pending · 8 available (not activated)
```

### Conversational editing (universal — works in every Claude surface)

This is the primary non-technical edit path because it works the same way in Cowork (no terminal, no localhost), Claude Code, and eventually Claude.ai chat:

```
User: /mixshift-brand-edit hydrapak

Claude: Reads ~/.mixshift/clients/hydrapak/context.yaml.
        Presents the editable fields as a markdown table.
        "What would you like to change?"

User: "Set ACOS target to 22% and add a price test on B000XXX
       from May 14 to May 28."

Claude: [validates inputs, writes context.yaml, runs schema check]
        Confirms the diff in chat. "Applied. Anything else?"
```

Same harness writes the file regardless of where the conversation runs. No external UI to host or maintain.

### Local Flask UI (Claude Code only — richer experience for technical users)

When the user is on Claude Code (terminal available, localhost works), they can opt into a richer form-based UI. `mixshift ui` (or `/mixshift-ui-start`) launches a local Node/Express + Vite server on `localhost:8080`, serving:

- `/` — portfolio dashboard mirroring `index.yaml`, click-through to each brand
- `/brand/<slug>` — view + edit form for one brand's `context.yaml`
- `/brand/<slug>/runs` — run history with verdict + report link
- `/brand/<slug>/cold-start` — guided cold-start wizard
- `/brands/discover` — re-query seller table, see new brands
- `/settings` — profile.yaml editor (output adapters, telemetry, etc.)

**Properties:**

- No network calls except to the user's own MySQL (the local server reads/writes local files only)
- No persistent process — runs only while user has it open; `mixshift ui stop` kills it
- Optional password gate via `profile.yaml.ui_password` so a shared laptop doesn't leak context
- Same validation as conversational editing — bad input gets a form error, not a corrupt file
- **Not available in Cowork** — sandbox doesn't allow localhost servers. Cowork users use conversational editing.

### Direct YAML editing (power users)

Always works. `~/.mixshift/clients/<slug>/context.yaml` is plain YAML. Schema documented in `_schema/context.schema.yaml`. After hand-editing, `validate` surfaces any schema violations before the next skill run breaks.

---

## Per-skill output adapter

Output destination is per-skill AND per-surface — different skills produce different artifacts, and the right destination shifts depending on whether the user is in Cowork (no localhost), Claude Code (local files OK), or eventually Claude.ai chat. The per-skill best default is TBD until we see how each skill actually performs in real use; we ship safe surface-aware fallbacks and tune them based on beta feedback.

`profile.yaml`:

```yaml
output:
  # Surface-aware defaults — used when a skill doesn't specify
  default_by_surface:
    claude_code: local-html         # local file:// link, opens in browser
    cowork: inline-markdown         # rendered in chat
    chat: inline-markdown           # rendered in chat (when chat support lands)

  # Per-skill overrides — explicit destination for specific skills
  # All fields optional; falls back to default_by_surface
  per_skill:
    monthly-performance-report:
      claude_code: google-doc       # narrative report, user wants to edit
      cowork: google-doc
    search-term-negation:
      claude_code: csv              # imported into Amazon
      cowork: csv
    # daily-health-check, portfolio-quick-scan, etc. → TBD per surface;
    # use default_by_surface until we've tuned them with beta data
```

We'll lock per-skill defaults skill-by-skill as we optimize each one (see "Iteration loop" in the testing plan). Until then, surface-aware fallback is the safe baseline.

### Adapter catalog

| Adapter | Best for | Implementation |
|---|---|---|
| `local-html` | Tabular reports with fixed format | Writes to `~/.mixshift/output/<brand>/<date>-<skill>.html`, opens in default browser |
| `terminal` | Quick triage outputs (portfolio scan) | Prints to stdout, no file |
| `google-doc` | Narrative reports user wants to edit | Requires Google OAuth in user onboarding; writes to a user-designated Drive folder |
| `csv` | List outputs that get imported into Amazon | Writes to `~/.mixshift/output/<brand>/<date>-<skill>.csv` |
| `markdown` | Pastable into Notion / Slack / docs | Writes `.md` file + copies to clipboard if available |
| `flask-serve` | Sharing with non-CLI stakeholders during a session | Adds the rendered output to the Flask UI's `/reports/` routes |

The renderer reads a structured JSON sidecar (the skill's deliverable) and the adapter transforms it. Skills never produce raw HTML / CSV / Markdown directly.

---

## Telemetry (aggressive in beta)

Beta users are existing MixShift customers under existing user agreements. MixShift already has full access to their warehouse data and client lists. The privacy boundary is external attackers, not MixShift visibility. **Under-collecting in beta wastes our only chance to learn how the plugin actually gets used end-to-end.**

Telemetry is required for beta access. Disclosure happens at install (one screen, plain language, ties back to the existing user agreement). No anonymization theater.

### Collection goals

We need to learn, for every user, every brand, every skill run:

| Goal | What it answers |
|---|---|
| **Adoption** | Which skills get used? Which never get used? Daily/weekly/monthly cadence per skill per brand. |
| **Friction** | Where do users abandon a flow? Cold-start step 7 of 12? A specific slash command that errors? A Flask form? |
| **Drift** | Where does skill output disagree with itself across runs for the same brand? Are recommendations getting acted on or dismissed? |
| **Customization** | What do users hand-edit in `context.yaml` after cold-start? What `skill_config` overrides do they apply? |
| **Cost** | Token counts per skill per run. Wall-clock duration. Which skills are expensive? |
| **Correctness** | Errors with full stack traces. Preflight gate failures. SQL drift events. |

### What gets collected

Full-fidelity events. Plaintext brand slugs, full skill inputs/outputs, prompt + completion text where useful, error messages with stack traces. Examples:

```json
{
  "event": "skill.run.completed",
  "ts": "2026-05-13T07:00:00Z",
  "user_email": "operator@agency.com",
  "plugin_version": "0.2.1",
  "skill_id": "daily-health-check",
  "skill_version": "0.1.1",
  "brand_slug": "example-brand",
  "brand_accounts": [
    { "seller_id": 12345, "account_type": "SC", "marketplace": "US" }
  ],
  "duration_ms": 14823,
  "tokens": { "prompt": 18420, "completion": 3221, "cached": 12100 },
  "preflight": {
    "context_loaded": true,
    "context_age_days": 4,
    "warnings": []
  },
  "skill_config_overrides": { "acos_target_pct": 25 },
  "verdict": "GREEN",
  "recommendations": [
    { "type": "hold_posture", "magnitude": null, "confidence": 0.92 }
  ],
  "output_path": "~/.mixshift/output/example-brand/2026-05-13-daily-health-check.html",
  "sidecar_json_excerpt": { ... headline metrics ... }
}
```

Additional event types:

```
plugin.installed                  ← first run, OS, plugin version
auth.signin.started/succeeded/failed     ← token browser sign-in (default path)
auth.token.refresh_failed                ← stale-session friction
auth.mysql.attempted/succeeded/failed    ← legacy raw-MySQL path only
auth.ip_whitelist.requested/granted      ← legacy raw-MySQL path only
brand.discovered                  ← list of available brands from seller table
brand.activated/archived/renamed/split/merged
brand.cold_start.started/step_completed/abandoned/completed
brand.context.edited              ← captures diff between before and after
brand.context.validated/invalid
skill.run.started
skill.run.preflight_failed
skill.run.completed               ← shown above
skill.recommendation.actioned/dismissed/snoozed
skill.run.feedback                ← optional user reaction (thumbs up/down, free text)
ui.flask.started/page_view/form_submit/abandoned
slash_command.invoked
error.harness/skill/render
telemetry.heartbeat               ← daily, lets us measure active users
```

### Friction signals specifically

We need explicit instrumentation for fall-off points:

- **Cold-start step abandonment**: each step in the 31-query + question sequence emits `brand.cold_start.step_completed` with step number. Drop-offs become visible as gaps in the funnel.
- **Recommendation reaction**: every skill that produces actionable output asks the user (in chat or Flask UI) "Did you act on this?" The response is captured. No response within 7 days = inferred dismissal.
- **Manual context edits**: when the user changes `context.yaml`, capture the diff. If they're consistently overriding the same field, that field's default is wrong.
- **Error recoverability**: classify errors as recovered (user retried successfully) vs. abandoned (no further activity on that brand for 24h).

### Transport

Single HTTPS endpoint that accepts batched events. Plugin buffers events in `~/.mixshift/telemetry/buffer/` and flushes on a schedule or when the buffer fills. Offline-tolerant — if the endpoint is unreachable, the buffer accumulates and flushes when connectivity returns. No data loss.

Detailed transport schema, retention, and access controls go in `docs/productization/TELEMETRY.md`.

### Promotion to GA

When the plugin exits beta, the default capture profile narrows (probably opt-in for full payloads, always-on for aggregate events). Beta gives us the data to know which signals matter; GA defaults are decided based on what we actually used.

---

## Brand-shaped skills (default + per-brand overlay)

Skills ship from MixShift with a canonical default. Per-brand customization happens through a `skill_config` block in `context.yaml`. The skill reads its overrides at preflight and applies them — no skill forking required for normal customization.

```yaml
# ~/.mixshift/clients/example-brand/context.yaml (excerpt)
skill_config:
  daily-health-check:
    acos_target_pct: 25                  # override management.acos_target_pct for this skill only
    severity_threshold: aggressive       # plugin-defined enum
    suppress_dimensions: [item_group]    # skip a section of the report

  keyword-bid-health:
    bid_floor_p_percentile: 35           # override default P25 spend floor
    posture_multiplier: 1.2

  search-term-negation:
    relevance_check_required: true       # force LLM relevance pass on all tiers, not just ambiguous
    excluded_campaigns: ["HP-Brand-*"]
```

### Mechanics

- Skills declare `configurable_fields` in their manifest with type + default + valid range.
- Plugin validates overrides at preflight. Bad values are flagged before run.
- Telemetry captures which overrides are in use, per skill per brand. We learn what users override most → those defaults are wrong → next release promotes the popular override into the canonical default.
- Overrides are visible in the Flask UI as a "Skill behavior" panel per brand, with reset-to-default button.

### When overlay isn't enough

If a user genuinely needs to fork a skill (different logic, not just different thresholds), the v1.5+ escape hatch:

```
~/.mixshift/skills/
  custom/
    daily-health-check-example-brand/
      SKILL.md                # forked, user-owned
      skill.manifest.yaml
```

Resolution order at skill invocation:
1. Brand-scoped custom skill (`skills/custom/<skill-id>-<brand-slug>/`)
2. User-scoped custom skill (`skills/custom/<skill-id>/`)
3. Plugin default

Telemetry captures fork events so MixShift sees which skills are getting forked and why. Frequent forking = canonical skill has a gap worth filling.

This is **not v1**. v1 is overlay only. Forking comes when overlay proves insufficient for real users.

---

## Future: execution engines

Skills today produce **signals** — recommendations with magnitude, confidence, and reversal plan. They do not execute. The next layer, post-launch, is execution engines that consume signals and take action.

```
[Skill]                       [Signal]                    [Engine]
keyword-bid-health    → bid_change(kw, +12%, conf=0.88)   → MixShift Bid Engine (OSS)
                                                          → or Amazon Ads MCP (write)
search-term-negation  → add_negative(term, exact, scope)  → Negation Engine
                                                          → or Amazon Ads MCP (write)
runaway-spend-check   → pause_keyword(kw, reason)         → Bid Engine emergency stop
asin-target-negation  → negate_asin(asin, scope)          → Negation Engine
```

### Design constraints

- **Signal contract is stable.** Skills emit signals in a well-defined shape; engines consume them. Either side can be swapped without breaking the other.
- **Engines are opt-in per signal type.** A user might enable the bid engine for `bid_health` but not for `runaway_spend_check`. Granular autonomy.
- **Every executed action writes to audit.** Same audit trail the V3 ADR-009 calls for: observation, hypothesis, intervention, expected impact, confidence, reversal plan, actual outcome.
- **Reversal is first-class.** Every engine must support undo within an SLA (e.g., 24 hours).

### Engine candidates

- **MixShift Bid Engine** (open-source, MixShift-owned) — consumes `bid_change` and `pause_keyword` signals
- **Negation Engine** (could be Bid Engine module or separate) — consumes negation signals
- **Amazon Ads MCP** — Amazon's own write capabilities, used selectively where coverage is sufficient and the action shape is a clean match

Decision gates for each engine:
- Coverage: does Amazon's MCP do this without losing our HCAM context?
- Liability: who's responsible if the action is wrong?
- Telemetry: can we observe the outcome?
- Reversibility: can we undo within SLA?

This is post-v1. Capturing here so the v1 signal format anticipates execution downstream.

---

## Shared brand context across teammates

**v1: not supported.** Each user has their own `~/.mixshift/clients/`. Two agency users managing the same brand will each have their own context.yaml that may drift. Documented as a known limitation.

**v1.5 workaround:** "Share via your own git repo. Commit `~/.mixshift/clients/` to a private repo, teammates clone. We don't manage the sync."

**v2:** Brand context moves server-side as part of the Data Hub / brain service. Local files become a cache. Multi-teammate is native.

---

## Storage trajectory

```
v1.0  Local filesystem only.
      ~/.mixshift/ is canonical truth.
      Plugin reads/writes directly.

v1.5  Optional sync.
      `mixshift sync push/pull` to a MixShift-hosted backup endpoint.
      Multi-machine restore via `mixshift restore`.
      Still local-first; sync is opt-in backup.

v2.0  Brain service.
      Brand context becomes a server-owned entity with pipelines,
      enrichments, and multiple input sources. Plugin calls API.
      Local files become a cache for offline / fast access.
      The Flask UI either talks to the API or remains a local viewer.
```

The plugin's read path should already abstract storage behind an interface (`BrandContextProvider`) so the v1.0 → v2.0 transition is invisible to skills.

---

## Resolved decisions (cumulative)

**v0.1 → v0.2:**

- **Harness language**: Node/TypeScript. No Python required for default install. Specific skills may declare Python dep via `uv` if they need real statistical work; most won't.
- **Slug mutability**: slugs are user-facing labels, fully mutable. `SellerID` is canonical identity. Rename/split/merge are first-class operations.
- **Credentials at rest**: token sign-in stores access + refresh tokens in a plaintext file at 0600 (or Windows ACL equivalent) at `~/.mixshift/auth/credentials`. Trust boundary = user's home directory; the short-lived (24h) access token plus server-side refresh-replay revocation replaces the legacy per-user IP whitelist as the second factor, and the raw DB password never lands on disk. OS keychain remains available as opt-in via `profile.yaml: { credential_store: keychain }`. Legacy raw-MySQL creds, when that path is used, live in the same file's `mysql` block.
- **Multi-account brands**: one brand folder can hold N entries in `accounts[]` (SC + VC, multiple marketplaces). User can split into separate brands if they want separate operational treatment.
- **Telemetry posture**: aggressive in beta — plaintext brand slugs, full payloads, friction signals, recommendation reactions, manual edit deltas. Existing user agreements cover this. Promoted to GA with narrower defaults once we know what we actually use.
- **Skill shaping**: overlay (`skill_config` in context.yaml) for v1. Skill forking via `~/.mixshift/skills/custom/` is the v1.5+ escape hatch when overlay is insufficient.
- **Execution engines**: post-v1 layer that consumes structured skill signals. v1 signal format must anticipate downstream execution (magnitude, confidence, reversal plan).

**v0.2 → v0.3:**

- **Cross-surface architecture**: Plugin must work in Cowork (no localhost, no terminal-as-user) and Claude Code (full terminal, localhost OK), and be ready to bridge to Claude.ai chat later. See "Surface compatibility" section.
- **Two UIs for editing brand context**: (a) **Conversational editing** via slash commands — universal across all surfaces, primary path for non-technical Cowork users; (b) **Local Flask/Node UI** — Claude Code only, richer form-based experience for technical users. Both write to the same `~/.mixshift/clients/` files.
- **Per-skill output adapter is surface-aware**: defaults route to `local-html` in Claude Code, `inline-markdown` in Cowork, with per-skill overrides. Specific per-skill defaults are TBD until beta data tells us what works.
- **Harness as internal Node CLI**: Claude invokes harness commands via Bash tool inside skill execution. Not user-facing. Eventually mirrored as an MCP server when chat surface support lands. See HARNESS-REWRITE.md.

## Open questions

1. **Slug auto-derivation policy**. `seller.SellerName` of "AcmeCorp Inc." → slug `example-brand` (strip suffixes like Inc, LLC, Co) or `example-brand-inc` (literal)? Auto-suggest with user confirmation at discovery time seems right. Need a rule for what counts as a corporate suffix.
2. **Brand archival of historical runs**. When a brand is archived, do we keep `runs/` history forever or purge after N days? Argument for keeping: re-onboarding the same brand later restores continuity. Argument for purging: storage cost over time. Lean keep, document the path for manual cleanup.
3. **Cold-start parcelling**. Build per-skill SQL subsets in v1 or wait for volume complaint? Lean wait — 31 queries × 10 beta users is fine. Flag for revisit if a single agency onboards 50+ brands at once.
4. **Brand selection UI at scale**. 50+ brand checkbox list is unwieldy. Add filter/search to discovery UI from day one. What's the right grouping (alphabetical, by parent SellerName cluster, by ads_active)?
5. **Re-discovery cadence**. Should the plugin auto-rerun `seller` table discovery (weekly?) or only on `/mixshift-brands rediscover`? Lean manual for v1 to avoid surprise rows in `index.yaml`. Auto-discovery becomes a Flask UI toggle later.
6. **Skill overlay versioning**. When a plugin update changes a skill's `configurable_fields` (renames a field, removes one), how do we handle existing brand `skill_config` blocks that reference the old shape? Migration script per release? Best-effort fallback with warnings? Lean migration script, surfaced in the UI.
7. **Execution engine boundary**. Of the future signal types, which should be MixShift-owned engines (more control, full audit) vs. routed through Amazon's MCP (cheaper, less custom)? Likely answer: keep `bid_change` and `negation` MixShift-owned because they're our differentiation; route routine things like `pause_campaign` through Amazon. Defer until we're building the bid engine integration.
8. **Telemetry storage destination**. Where does the event log actually land? Options: ClickHouse (V3 already uses it), Postgres on Neon, S3 + Athena, dedicated event-store SaaS. Volume estimate: ~10 events × 10 beta users × ~5 brands × ~5 skills/day = ~2,500/day. Trivial volume; pick simplest. Likely answer: write to V3 ClickHouse so analytics are co-located.
9. **In-chat vs. UI recommendation reaction capture**. To capture "did the user act on this recommendation," do we ask in chat (intrusive) or surface a question in the next Flask UI session (lower signal)? Maybe both — chat ask after high-magnitude recommendations only, UI ask for everything else.

---

## Iteration anchors

These map directly to the productization sequencing in the broader plan:

- Filesystem layout + status states → unblocks Step 2 (filesystem split)
- `index.yaml` schema → drives the brand management UI work
- Per-skill output adapter → drives the renderer rewrite
- Telemetry spec → drives the transport doc
- Storage trajectory → keeps v1 decisions reversible toward v2

Update this doc as decisions are made on the open questions. Bump `Status` to `v0.2`, `v0.3` etc. as we converge.
