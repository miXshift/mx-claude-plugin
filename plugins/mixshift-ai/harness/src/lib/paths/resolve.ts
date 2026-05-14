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

export function indexPath(dataDirOverride?: string): string {
  return join(clientsDir(dataDirOverride), 'index.yaml');
}

export function tmpDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'tmp');
}

export function outputDir(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'output');
}
