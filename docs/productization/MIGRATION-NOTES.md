# Migration Notes — Fork from `miXshift/mx-claude`

This document captures what was dropped, what was scrubbed, and what decisions were made during the initial fork from the upstream repository.

**Fork commit:** `c894488ba2a3f79b2fb52b950d2ba8af90b5561c` (mx-claude, "fix(cold-start): normalize readiness review gaps")
**Fork date:** 2026-05-13
**Status:** v0.0.1 fork — additional productization work to follow.

---

## Dropped entirely

### Client data (would-be exfiltration)
- `plugins/mixshift-amazon-ppc/shared/clients/*` — four brand bundles with real `context.yaml`, `narrative.md`, `brand-intelligence.yaml`, `corpora/` contents.
- Per-skill brand reference files in every skill's `references/` directory:
  - `<brand-slug>.md` files (4 brand slugs × 13 skills, plus index/portfolio rosters)
  - `account-index.md` (client roster with SellerIDs and operator names)
  - `portfolio-accounts.yaml` (client roster)

### Internal MixShift research / strategy
- `amazon-ads-api.md` — internal API research with implementation hints
- `amazon-api-deep-dive.md` — internal strategy doc containing ARR, customer count, competitive positioning
- `amazon-endpoints-reference.md` — internal ingestion reference
- `amazon-marketing-attribution-ai.md` — internal strategy doc on attribution positioning
- `amazon-sp-api.md` — internal SP-API research

None of these are skill execution references — they ended up in `references/` folders because the upstream treats `references/` as a general note dump. Removed.

### Deprecated content
- `hcam-vercel-deployment.md` — file is explicitly marked DEPRECATED in its own header. The productized plugin will not use Vercel for output. Removed.

### Legacy Python harness
- `plugins/mixshift-amazon-ppc/scripts/*` — 13 Python scripts: `bootstrap-context.py`, `enrich-context.py`, `pre-fetch-data.py`, `render-keyword-bid-health.py`, `report-append.py`, `validate-context.py`, `merge-context-delta.py`, `compare-sidecars.py`, `check-sql-drift.py`, `render-brand-context.py`, `run-readiness.py`, `skill_version.py`, `write-sidecar.py`.
- Decision: will be rewritten in TypeScript per the productization plan. The original Python implementation remains in the upstream repository as a reference.

---

## Scrubbed (find / replace across all `*.md`, `*.sql`, `*.yaml`, `*.yml`, `*.html`, `*.json`)

| Pattern | Replacement | Rationale |
|---|---|---|
| `dashamazon` (DB name in prose) | `warehouse` | Generic warehouse reference; actual DB name is connection-time config |
| `Hydrapak`, `HydraPak`, `hydrapak` | `example brand`, `AcmeCorp`, `example-brand` (context-dependent) | Customer name |
| `Rowdy Parrot`, `rowdy-parrot` | `example brand`, `example-brand` | Customer name |
| `Popl`, `Popl Co`, `popl` | `example brand`, `example-brand` | Customer name |
| `Skratch`, `skratch` | `example brand`, `example-brand` | Customer name |
| `Polar Bottle`, `polar-bottle`, `polar_bottle` | `example brand`, `example-brand`, `example_brand` | Sub-brand of removed customer |
| `New Zealand Honey Co`, `newzealandhoneyco` | `example brand`, `example-brand` | Customer name |
| `Hydrapeak`, `hydramax` | `competitor-brand`, `competitor-brand-2` | Competitor brand names that identify the customer by competitive context |
| `Todd`, `Todd's <thing>` | `the operator`, `canonical <thing>`, or context-dependent | Internal operator identification |
| `Tai`, `TAI` | `MixShift` | Internal system identification (TAI = the upstream agent system, before the fork) |
| `Tony` | `co-author` | Co-author identification in internal HCAM design notes |
| `OpenClaw`, `openclaw` | `upstream`, where appropriate | Internal system name |
| `~/.openclaw/...` | `~/.mixshift/...` | Path scoping for the productized plugin matches the design in BRAND-MANAGEMENT.md |
| `owner: tai`, `Author: Tai`, `Schema owner: Tai` | `owner: mixshift`, `Author: MixShift`, `Schema owner: MixShift` | Frontmatter metadata |
| `ported-from: "tai/<name>"` | `ported-from: "upstream/<name>"` | Skill manifest metadata |
| `Validated: Todd, <date>` | `Validated: domain expert, <date>` | Removes person name while preserving validation timestamp |
| `Built from Tai's production agent skills` | (removed clause) | Plugin manifest description |
| Drive folder IDs (`drive.google.com/drive/folders/...`) | (removed via deletion of containing files) | Operator's Drive |
| `rooty@mixshift.io` | (removed via deletion of containing files) | Operator's email |
| `*.vercel.app` report URLs | (removed via deletion of containing files; also: Vercel output is being replaced wholesale) | Operator's hosting |
| `Garrison`, `VanderStelt` | (removed via deletion of containing files) | Person names |
| `sam.hager` | (n/a — never present in carried files) | — |

---

## Verification

After the scrub passes:

```bash
grep -ri 'dashamazon\|hydrapak\|popl\|rowdy-parrot\|skratch\|newzealandhoneyco\|polar.bottle\|rooty@\|vercel\.app\|drive\.google\.com\|Todd\|Tai\|Tony\|OpenClaw\|openclaw\|Garrison\|VanderStelt' .
```

Returns zero hits.

---

## Carried over with no scrub needed

- `.claude-plugin/marketplace.json` (marketplace listing)
- `plugins/mixshift-amazon-ppc/.claude-plugin/plugin.json` (after scrubbing one phrase)
- `plugins/mixshift-amazon-ppc/.mcp.json` (warehouse MCP shim)
- All `skill.manifest.yaml` files (except `monthly-performance-report` which mentioned voice attribution)
- `shared/sql-library/*.sql` (66 queries, all unqualified table references)
- `shared/skill-runtime-contract.md` (risk-tier governance, already generic)
- `shared/skill-manifest.schema.yaml`, `shared/run-sidecar.schema.yaml`
- `shared/tables.yaml` (after replacing `dashamazon` in line 1)
- `shared/clients/_schema/context.schema.yaml` (after scrubbing example references)
- `.gitignore`

---

## Open follow-ups from the migration

1. **Recreate an example brand context.** Several skills reference `shared/clients/example-brand/context.yaml` after the scrub. Need to either (a) create a real example template at `shared/clients/_template/context.yaml` and update SKILL.md pointers, or (b) remove the references in favor of `shared/clients/_schema/context.schema.yaml` as the only example surface.
2. **Rewrite Python harness in TypeScript.** Largest single follow-up. See BRAND-MANAGEMENT.md, "Storage trajectory" section.
3. **Renderer adapter system.** Replace the current "skill writes HTML" pattern with structured JSON sidecar + renderer adapter (local-html, google-doc, csv, etc.). See BRAND-MANAGEMENT.md, "Per-skill output adapter."
4. **Update `.mcp.json`** to reflect productized credential flow (env vars come from `~/.mixshift/auth/credentials` rather than user shell env). Pending the credential storage design.
5. **De-duplicate reference files.** Many `references/*.md` files are byte-identical across skills (BRAND-CONTEXT-SCHEMA.md, BRAND-CONTEXT-GAP-AUDIT.md, hcam-*.md). Move to `shared/references/` and have skill manifests link by reference. Lower priority — current duplication isn't breaking anything.
