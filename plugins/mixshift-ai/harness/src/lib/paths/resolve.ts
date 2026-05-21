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
 * Per-brand OCL (Objective Level Configuration) file. Stores user-tuned
 * defaults for each skill keyed by skill_id. Sovereign post-edit — see
 * lib/calibration/brand-config.ts for the read/write contract.
 */
export function brandConfigPath(brandSlug: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), 'config.yaml');
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

export function indexPath(dataDirOverride?: string): string {
  return join(clientsDir(dataDirOverride), 'index.yaml');
}

export function tmpDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'tmp');
}

export function outputDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'output');
}

export function telemetryDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'telemetry');
}

export function telemetryQueuePath(dataDirOverride?: string): string {
  return join(telemetryDir(dataDirOverride), 'queue.jsonl');
}
