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

---

## Roadmap (Out of Scope for v1.0)

These are defined here to prevent reinvention, but are not implemented:

- **SkillRun status machine** (queued → running → waiting → done → failed) —
  requires a persistent job runner
- **RunEvent log** (AGENT_START → PREFLIGHT → TOOL_CALL_START → TOOL_CALL_END →
  ARTIFACT_WRITTEN → DONE) — requires middleware in execution environment
- **HumanReviewQueue as a system** — UI/notification layer; rules defined above,
  mechanism deferred
