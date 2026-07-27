/**
 * Path resolution for the harness.
 *
 * Resolves user-scoped paths under `~/.mixshift/` (or `MIXSHIFT_DATA_DIR`
 * override). All harness file I/O goes through these helpers so the
 * data root is settable for tests and self-hosted variations.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Resolve the data directory root. Precedence:
 *   1. explicit `dataDirOverride` arg (typically from --data-dir CLI flag)
 *   2. `MIXSHIFT_DATA_DIR` env var
 *   3. `~/.mixshift/` (default)
 *
 * Always returns a normalized absolute path. On Windows, this attaches a
 * drive letter to drive-relative absolute paths like `/tmp/x` →
 * `C:\tmp\x`. That matters because the resolved path appears in error
 * messages, telemetry, and the Discord webhook — an ambiguous
 * `\tmp\...` prefix reads as a bug to Windows users.
 */
export function resolveDataDir(dataDirOverride?: string): string {
  const candidate = dataDirOverride ?? process.env.MIXSHIFT_DATA_DIR ?? join(homedir(), '.mixshift');
  return resolve(candidate);
}

/**
 * Resolve a path relative to the data dir.
 *
 * Examples:
 *   profilePath()                     → ~/.mixshift/profile.yaml
 *   profilePath(dataDir)              → <dataDir>/profile.yaml
 *   clientsDir(dataDir)               → <dataDir>/clients
 *   brandDir(dataDir, 'acmecorp')     → <dataDir>/clients/acmecorp
 *   contextPath(dataDir, 'acmecorp')  → <dataDir>/clients/acmecorp/context.yaml
 */
export function profilePath(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'profile.yaml');
}

export function authDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'auth');
}

export function credentialsPath(dataDirOverride?: string): string {
  return join(authDir(dataDirOverride), 'credentials');
}

export function clientsDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'clients');
}

/** Local ledger of async pricing run handles (see lib/amazon/pricing-handles.ts). */
export function pricingRunsPath(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'pricing-runs.json');
}

/** Local ledger of async MixShift Intelligence run handles (see
 *  lib/intelligence/ledger.ts). */
export function intelligenceRunsPath(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'intelligence-runs.json');
}

/**
 * Root for saved Intelligence run artifacts when the run has no resolvable
 * brand context:
 *   ~/.mixshift/intelligence/
 * Distinct from `reports/` (fetched SP-API documents) and `output/` (ad-hoc
 * warehouse exports) so the three surfaces don't collide.
 */
export function intelligenceDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'intelligence');
}

/**
 * Default artifact path for one `intelligence run` / `intelligence get`
 * result:
 *   - brand known (the run's `params.merchant.brand` was set):
 *       ~/.mixshift/clients/<brand>/runs/intelligence/<id>-<timestamp>.json
 *   - brand unknown (seller/marketplace selector, or nothing resolvable):
 *       ~/.mixshift/intelligence/<id>-<timestamp>.json
 *
 * `timestamp` is caller-supplied and must already be filesystem-safe (no
 * colons) — see fsSafeTimestamp in commands/intelligence.ts.
 */
export function intelligenceOutputPath(
  id: string,
  timestamp: string,
  brandSlug: string | undefined,
  dataDirOverride?: string,
): string {
  const filename = `${id}-${timestamp}.json`;
  if (brandSlug) {
    return join(brandDir(brandSlug, dataDirOverride), 'runs', 'intelligence', filename);
  }
  return join(intelligenceDir(dataDirOverride), filename);
}

export function brandDir(brandSlug: string, dataDirOverride?: string): string {
  return join(clientsDir(dataDirOverride), brandSlug);
}

export function contextPath(brandSlug: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), 'context.yaml');
}

export function narrativePath(brandSlug: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), 'narrative.md');
}

/**
 * Tier-2 Brand Brain document (auto-discovered facts + derived patterns;
 * see lib/brain/schema.ts). Distinct from context.yaml (Tier 3,
 * AM-confirmed) which always wins on conflict.
 */
export function brainPath(brandSlug: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), 'brand-brain.yaml');
}

/**
 * Background brain-fetch progress file. Written by `mixshift brand brain
 * fetch`; polled by the chat surface for up to ~90s after a key-add so it
 * can render the "discovery done" line without blocking the user.
 */
export function brainStatusPath(brandSlug: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), '.brain-status.json');
}

/**
 * Per-brand OCL (Objective Level Configuration) file. Stores user-tuned
 * defaults for each skill keyed by skill_id. Sovereign post-edit — see
 * lib/calibration/brand-config.ts for the read/write contract.
 */
export function brandConfigPath(brandSlug: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), 'config.yaml');
}

/**
 * Brand-level pending discoveries — capture proposals accumulated across runs
 * (the confirm card proposing a SHARED brand field for context promotion).
 * Drained by the Phase-9 promotion step. Schema: shared/clients/_schema/
 * discoveries.schema.yaml; runtime contract: lib/brain/discoveries.ts.
 */
export function pendingDiscoveriesPath(
  brandSlug: string,
  dataDirOverride?: string,
): string {
  return join(brandDir(brandSlug, dataDirOverride), '.pending-discoveries.json');
}

/**
 * Per-run OCL snapshot — captures the effective config used for one run of
 * one skill. Lives under runs/<skill_id>/<run_date>/ocl.yaml so audit can
 * answer "what config was actually used for this run".
 */
export function runOclPath(
  brandSlug: string,
  skillId: string,
  runDate: string,
  dataDirOverride?: string,
): string {
  return join(
    brandDir(brandSlug, dataDirOverride),
    'runs',
    skillId,
    runDate,
    'ocl.yaml',
  );
}

/**
 * Apply-gate sidecar — written by `mixshift skill apply` after suggestions
 * + overrides are reconciled. Dry-run for 0.5.0, real writes once the
 * Amazon write MCP/API lands.
 */
export function runAppliedPath(
  brandSlug: string,
  skillId: string,
  runDate: string,
  dataDirOverride?: string,
): string {
  return join(
    brandDir(brandSlug, dataDirOverride),
    'runs',
    skillId,
    runDate,
    'applied.json',
  );
}

/**
 * Brand-context Phase 1.5 enrichment artifact (settlement curve + stockout
 * candidates + brand-typo clusters). Written by `mixshift brand enrich`
 * (or auto by delta-mode); read by the renderer's Detected Anomalies
 * section and by `mixshift brand merge-delta` for patching into context.
 *
 * Run-dir is keyed to the mx-brand-context skill (formerly mx-account-cold-start).
 * New runs land under runs/mx-brand-context/; pre-rename artifacts under the old
 * dir are regenerable and not migrated.
 */
export function enrichmentPath(
  brandSlug: string,
  runDate: string,
  dataDirOverride?: string,
): string {
  return join(
    brandDir(brandSlug, dataDirOverride),
    'runs',
    'mx-brand-context',
    runDate,
    `${runDate}.enrichment.json`,
  );
}

/**
 * Per-brand corpus documents directory. Every regular file directly in this
 * directory is an org-shared corpus doc (doc_type 'corpus') for context sync;
 * see lib/context-sync/local.ts for the enumeration contract.
 */
export function corporaDir(brandSlug: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), 'corpora');
}

/**
 * Per-brand context-sync state ledger (see lib/context-sync/state.ts).
 * Records the last-synced server revision + content hash per doc so
 * `mixshift context status|pull|push|sync` can tell local edits from
 * server-side moves. Local-only — never synced itself.
 */
export function contextSyncStatePath(brandSlug: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), '.context-sync-state.json');
}

export function indexPath(dataDirOverride?: string): string {
  return join(clientsDir(dataDirOverride), 'index.yaml');
}

export function tmpDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'tmp');
}

export function outputDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'output');
}

/**
 * Root for fetched SP-API report documents.
 *   ~/.mixshift/reports/
 * Distinct from `output/` (ad-hoc CSV exports of warehouse queries) so the
 * two surfaces don't collide and a user can `ls ~/.mixshift/reports` to see
 * everything they've pulled on demand.
 */
export function reportsDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'reports');
}

/**
 * On-disk home for one fetched report document:
 *   ~/.mixshift/reports/<scope>/<date>-<reportType>.<ext>
 *
 * `scope`      — brand slug when the merchant maps to a known brand, else the
 *                amazonSellerId (so reports for a merchant not yet in the
 *                brand registry still get a stable, greppable home).
 * `runDate`    — YYYY-MM-DD the document was retrieved (not the data window).
 * `reportType` — the Amazon GET_* enum, used verbatim so the filename is
 *                self-describing.
 * `ext`        — 'tsv' for flat-file reports, 'json' for vendor / Brand
 *                Analytics. The service returns bytes as-is; the caller picks
 *                the extension from the catalog's document_format.
 */
export function reportOutputPath(
  scope: string,
  runDate: string,
  reportType: string,
  ext: 'tsv' | 'json',
  dataDirOverride?: string,
): string {
  return join(reportsDir(dataDirOverride), scope, `${runDate}-${reportType}.${ext}`);
}

export function telemetryDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'telemetry');
}

export function telemetryQueuePath(dataDirOverride?: string): string {
  return join(telemetryDir(dataDirOverride), 'queue.jsonl');
}
