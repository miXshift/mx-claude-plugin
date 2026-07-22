# Upstream Attribution

This repository is a hard fork of [`miXshift/mx-claude`](https://github.com/miXshift/mx-claude), the internal MixShift Claude Code plugin used by the original author for operational PPC management.

## Fork point

- **Source:** `miXshift/mx-claude`
- **Fork commit:** `c894488ba2a3f79b2fb52b950d2ba8af90b5561c`
- **Fork commit message:** `fix(cold-start): normalize readiness review gaps`
- **Fork date:** 2026-05-13
- **Fork direction:** One-way. This repository does not auto-sync from upstream.

## Original authorship

The skill content (prompts, SQL patterns, format conventions, narrative voice) was originally authored by the internal MixShift operator and the team that built the upstream agent system. Their work is the basis for the analytical opinions and patent-pending HCAM bridge methodology (App. No. 19/070,768) that this plugin encodes.

## What was carried over

- 13 skills (`SKILL.md` + `skill.manifest.yaml` + generic `references/` per skill). The productized plugin has since grown to 25 skills, adding the live Amazon API surface (SP-API reports, retail lookups, AMC, DSP, and Amazon Ads reads plus audited writes), the onboarding / help / feedback skills, and scheduled-task setup.
- 66 SQL queries in `shared/sql-library/` keyed by skill prefix
- Schema and contract documents in `shared/_schema/`, `shared/skill-runtime-contract.md`, `shared/skill-manifest.schema.yaml`, `shared/run-sidecar.schema.yaml`, `shared/tables.yaml`
- The `.mcp.json` MySQL MCP shim for warehouse read access

## What was removed during the fork

- All per-brand client context bundles (`shared/clients/<brand>/`)
- Per-skill brand-specific reference files
- Internal MixShift research / strategy notes that ended up in skill `references/` folders
- Operator-specific identifiers (email addresses, Google Drive folder IDs, internal-system names, person names)
- The legacy Python harness in `scripts/` — being rewritten in TypeScript. The original Python implementation remains accessible at the upstream repository for reference.

## Why we forked instead of branched

The upstream repo is operational for its original author. The productization scope (filesystem restructure, renderer rewrite, onboarding flow, harness in TypeScript, no client data, license change) diverges enough that an automatic merge would not be useful in either direction. A clean fork lets the upstream continue to evolve for internal use while this fork serves the productized public release.

## Selective re-syncing from upstream

If skill content improvements upstream are worth pulling forward, we cherry-pick the specific commits manually after verifying they don't reintroduce scrubbed content. There is no automated sync.
