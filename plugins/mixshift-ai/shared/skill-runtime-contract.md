# Skill Runtime Contract
**Version:** 1.0.0
**Date:** 2026-05-06
**Status:** Active

Skills are not free-form prompts or open-ended agent sessions. Each skill is a
governed, inspectable, versioned run. The agent analyzes, synthesizes, and
recommends. The deterministic harness (pre-fetch scripts, renderers, validators)
owns preflight, state transitions, artifact persistence, and any external mutation.
Agent output may create artifacts and recommendations. A deterministic runner or
explicit human action performs mutation.

---

## Risk Tiers

Every skill is assigned a `risk_tier`. Tier determines required controls; controls
are not optional for the assigned tier.

### Tier 1 — Informational
- **Definition:** Read-only output. Human-readable insight or research. No durable
  files written. No production-facing recommendations.
- **Examples:** mx-ppc-relevance-check
- **Controls:**
  - Preflight: none required
  - Output: human-reviewable on request
  - Audit trail: none required
  - Autonomous execution: permitted

### Tier 2 — Artifact-Writing
- **Definition:** Writes durable files (context.yaml, HTML reports, JSON artifacts,
  CSVs) to `tmp/` or `shared/clients/<brand>/`. No direct production mutation.
- **Examples:** mx-brand-context, mx-search-term-data-pull, mx-monthly-report,
  mx-portfolio-quick-scan
- **Controls:**
  - Preflight: validate required context fields before execution (HARD GATE)
  - Output: human review before downstream skills consume new context files
  - Audit trail: run sidecar required
  - Rollback path: prior context.yaml preserved in runs/ archive before overwrite
  - Autonomous execution: permitted for artifact writes; human approval required
    before durable context changes take effect downstream

### Tier 3 — Production-Facing
- **Definition:** Output directly drives bid changes, negation lists, keyword
  promotions, campaign structure changes, or pauses. Even when execution is manual,
  the skill artifact IS the production instruction.
- **Examples:** mx-daily-health-check, mx-runaway-spend-check, mx-keyword-bid-health,
  mx-search-term-harvest, mx-search-term-negation, mx-asin-target-negation,
  mx-phrase-negative-discovery
- **Controls:**
  - Preflight: mandatory — validate all required context fields, confirm data
    freshness, confirm prior-run sidecar loaded (HARD GATE on all three)
  - Output: explicit human approval before acting on recommendations
  - Audit trail: run sidecar required; sidecar must include context_snapshot
    and headline_metrics
  - No autonomous mutation: agent output never directly pushes to Amazon Ads API,
    MixShift DB, or any external system
  - Escalation: stop and surface to human if HARD GATE fails, if context fields
    are stale (>7 days), or if verdict regresses from prior run without a
    structural_events explanation

---

## Allowed Tools Vocabulary

The `allowed_tools` field in `skill.manifest.yaml` declares which tool categories
a skill may invoke. The harness validates declared tokens against this vocabulary
when it parses the manifest (a schema check — misspelled or unknown tokens fail
validation); it does NOT yet enforce tool access at runtime. The declaration is
the contract of record, kept honest by review; unlisted tools require a manifest
update before use.

| Token | What it permits |
|---|---|
| `db_read` | SQL queries via pre-fetch-data.py against MixShift MySQL |
| `file_read` | Read context.yaml, narrative.md, sidecars, artifacts, SQL library |
| `file_write` | Write to `tmp/` or `shared/clients/<brand>/` (scoped paths only) |
| `renderer` | Run a deterministic Python renderer script (render-*.py) |
| `validator` | Run validate-context.py or check-sql-drift.py |
| `web_search` | External web/social searches (Phase 0.5 brand scrub only) |
| `prefetch` | Invoke pre-fetch-data.py to collect and stage query results |
| `insight_read` | Read finished insight envelopes from the MixShift Intelligence service via `mixshift intelligence run\|poll\|get` (no warehouse SQL, no writes) |
| `ads_write` | Gated mutating Amazon Ads API calls via `mixshift ads call ... --commit`. Preview/dry-run by default; nothing reaches Amazon until the user confirms the exact change set; every commit is audited server-side. Skills carrying this token pair it with `side_effect_policy: write_gated`. |
| `forecast_write` | Save the user's own forecast inputs: the monthly sponsored ads budget via `mixshift forecast budget set` (the computed forecast uses it as planned spend), and the definition of a brand inside an account via `mixshift forecast sub-brand add` (the labels its forecast reads). Written only after the user has seen the exact months and amounts and said yes; `--dry-run` previews a change. Pairs with `side_effect_policy: write_gated`. |

No skill has permission to write to the SQL database, modify skill definitions,
or alter schedules — those paths are not in this vocabulary and must be
human-initiated. External API writes exist in exactly one sanctioned form: the
`ads_write` gate above, which is preview-first and user-confirmed per commit.

---

## Side-Effect Policy

The `side_effect_policy` field declares what durable state a skill changes.

| Value | Meaning |
|---|---|
| `none` | No files written, no external state changed. Session-only output. |
| `artifact_write` | Writes to `tmp/` only. Transient, human-reviewable, not consumed by other skills. |
| `context_write` | Writes to `shared/clients/<brand>/`. Durable — consumed by downstream skills. Requires human review before downstream execution. |
| `recommendation_only` | Writes report artifact to `tmp/`. Output is a recommendation; no execution without explicit human approval. |
| `write_gated` | Like `recommendation_only`, plus the skill may execute the approved changes against the Amazon Ads API through the `ads_write` gate (dry-run preview first, explicit user-confirmed `--commit`, server-side audit trail). Never writes silently. |

---

## Review Required

The `review_required` field declares when human review is mandatory before acting
on skill output.

| Value | Meaning |
|---|---|
| `never` | Tier 1 skills. Output is informational; no action gated on it. |
| `on_non_green` | Review required if verdict is YELLOW or RED. Green runs can proceed. |
| `always` | Any durable context write or production-facing recommendation requires review before execution. |

---

## Artifact Spill Policy

Large tool outputs must not remain in active prompt context. This rule is enforced
by pre-fetch-data.py and any deterministic renderer.

- **Threshold:** `.data.md` artifacts exceeding **12,000 tokens** (~48KB) are
  truncated at query boundaries. The truncation point and a retrieval path are
  injected as a compact digest in place of the omitted content.
- **Error traces:** Errors are never truncated. Full error output stays in context
  to enable recovery.
- **Digest format:** `[TRUNCATED: <query_id> — <row_count> rows, <size>KB. Full
  result at <path>]`
- **Renderer outputs:** HTML and JSON artifacts are written to disk. The model reads
  only `headline.json` (~500 tokens), not the full HTML.

---

## Preflight Checklist (Tier 2 and Tier 3)

Every Tier 2 and Tier 3 skill MUST complete this checklist before Phase 1 execution.
Skills document their specific required fields in `required_context_fields` in the
manifest. The model checks each at the top of the skill run.

```
PREFLIGHT — <skill-id> — <brand> — <date>
[ ] context.yaml loaded and schema version confirmed
[ ] All required_context_fields present and non-null
[ ] Data artifact present (tmp/<brand>-<skill>-<date>.data.md or .data.json)
[ ] CS-01 / identity confirmed (first-run skills only)
[ ] Prior-run sidecar loaded (Tier 3 only — used for drift detection)
[ ] No active HARD GATE conditions (stale context, missing posture, etc.)
```

If any item fails: stop, report the failure, do not proceed.

---

## Run Sidecar (required for Tier 2 and Tier 3)

Every Tier 2 and Tier 3 skill emits one sidecar JSON per run. Schema defined in
`shared/run-sidecar.schema.yaml`. The sidecar is the audit trail; it must be
sufficient for a reviewer to reconstruct what happened without reading the HTML.

Minimum required fields:
- `skill`, `skill_version`, `brand_slug`, `run_at_utc`, `data_date`
- `context_snapshot` — only fields the skill consumed (not the full context.yaml)
- `verdict`
- `artifacts` — paths to all written files

---

## Human Review Queue (Rules)

The following actions require explicit human approval before execution. The
mechanism (email, Slack, UI) is out of scope for this contract; the rules are not.

**Requires approval before acting:**
- Any durable update to `context.yaml` or `narrative.md`
- Any bid change, negative addition, keyword promotion, or campaign pause
- Any skill definition edit, manifest change, or schedule change
- Any portfolio-level config change

**Does not require approval:**
- Writing HTML/JSON reports to `tmp/`
- Emitting run sidecars
- Reading context or artifacts

---

## Demos (guided walkthroughs)

A demo is a skill showing a user what it does, on the user's own account, by
doing it: a fixed handful of steps, read first, each ending with the plain
sentence that runs it again. It doubles as discovery for new users and as the
script for a partner walkthrough. Every skill can have one; the pattern is the
same for all of them so users learn it once.

### What a skill declares

1. **A `demo:` block in `skill.manifest.yaml`** (schema: `skill-manifest.schema.yaml`):
   `say` (the phrase, always `demo <name>`, e.g. `demo Walmart ads`), `summary`
   (one line), `minutes`, `steps` (3 to 8 short user-facing titles), `changes`
   (`none` or `preview`), optional `needs` (what the account must have).
   `mixshift demo` and the guide read this block; nothing else registers a demo.
2. **A `## Demo` section in `SKILL.md`** with one subsection per manifest step,
   in the same order, each naming the calls it makes and the "next time, just
   say" sentence. The section starts by running `mixshift demo <skill-id>` and
   ends by running `mixshift demo <skill-id> --finished --steps-shown <n>`.
3. **Trigger phrases** in both the manifest and the SKILL.md frontmatter: the
   `say` phrase plus the skill-specific forms below, and the word "demo" in
   the frontmatter `description` so the router finds it.

### Rules every demo follows

- **Open with the harness opener.** Run `mixshift demo <skill-id>` and show its
  output verbatim (title, length, numbered steps, what changes, what it needs),
  then start step 1 without asking again: the user asked for the demo.
- **Real data, read first.** Every step runs on the user's own account. Show
  results short (top 5, counts, one screen per step). Empty is shown as empty;
  never fill a gap with example data.
- **End each step with the sentence that runs it again**: "Next time, just say:
  ...". These sentences are what the user takes away.
- **A demo never commits a change on a live account.** A change is shown as a
  preview (the write contract's dry run), with current and new values, and the
  user is told nothing was sent. If they ask to apply it, the demo ends there and
  the skill's write contract takes over (their yes to that exact preview is the
  confirmation). A test account (for example a Walmart sandbox advertiser) may
  walk committed changes, each one still previewed and confirmed first.
- **The user steers.** "skip" moves on, "stop" ends, and a question mid-step is
  answered before moving on. A user who leaves the demo to do real work is the
  demo succeeding.
- **Missing setup stops the calls, not the demo.** If step 1 shows the account
  is not set up (not signed in, nothing connected), say what is needed and who
  does it, then describe the remaining steps in words, with no invented data.
- **Budget:** about 10 API calls and the manifest's `minutes`. A report that is
  still building after a minute or two is left running: move to the next step
  and come back to it.
- **Close with a recap:** the "next time" sentences from the steps shown, two or
  three more things the skill can do, and a question about what they want to do
  now. Then `mixshift demo <skill-id> --finished --steps-shown <n>`.

### How users find a demo (entry points)

- **Say it, named:** `demo <name>` (canonical), and natural forms: "show me a
  demo of <name>", "<name> demo", "walk me through <name>", "tour <name>", "show
  me how <name> works". These are the skill's own trigger phrases.
- **Say it, unnamed:** "demo", "give me a demo", "give me a tour", "show me
  around", "walk me through it". mx-help catches these and runs `mixshift demo`
  to list the demos. ("I'm new" and "get started" stay with mx-welcome, whose
  closing line points at demos.)
- **Ask what it can do:** "what can you do with <name>?" The skill answers in
  two lines and offers its demo.
- **The guide** (`help`): a "See it in action" section lists every demo, built
  from the manifests.
- **Welcome:** first-run and returning-user welcome end with "say demo".
- **Release notes:** a release that adds a demo names its phrase.
- **Customer notes and playbooks** from MixShift lead with the demo phrase as
  the first thing to try.

Telemetry (`mixshift demo` emits these; skill ids and counts only):
`demo.listed`, `demo.requested` (with `available: false` when a user asks for
a skill that has no demo yet, which is the signal for which demo to build
next), `demo.finished` (steps shown of steps total).

---

## Implementation Status

| Primitive | Implemented | Notes |
|---|---|---|
| risk_tier | ✅ | In skill-manifest.schema.yaml; declared on all current manifests |
| allowed_tools | ✅ (declaration) | In manifest schema + all current manifests; validated at parse time. Runtime access enforcement NOT implemented — see the Allowed Tools section. |
| side_effect_policy | ✅ (declaration) | In manifest schema + all current manifests (incl. `write_gated`, added 2026-06-18 with `ads_write`) |
| review_required | ✅ | In manifest schema; declared where applicable |
| Preflight checklist | Partial | Tier 3 hard gates exist in prose; template not standardized |
| Artifact spill threshold | ❌ | Add to pre-fetch-data.py |
| Run sidecar | ✅ | Schema defined; mx-brand-context emits; not all skills emit |
| Audit trail | Partial | Sidecar schema solid; not universally emitted |
| Human review rules | Partial | Informal in SKILL.md; not machine-readable |
| Demos | ✅ | `demo:` manifest block + `mixshift demo` + guide section (2026-10-13); first demo: mx-walmart-ads |

---

## Roadmap (Out of Scope for v1.0)

These are defined here to prevent reinvention, but are not implemented:

- **SkillRun status machine** (queued → running → waiting → done → failed) —
  requires a persistent job runner
- **RunEvent log** (AGENT_START → PREFLIGHT → TOOL_CALL_START → TOOL_CALL_END →
  ARTIFACT_WRITTEN → DONE) — requires middleware in execution environment
- **HumanReviewQueue as a system** — UI/notification layer; rules defined above,
  mechanism deferred
