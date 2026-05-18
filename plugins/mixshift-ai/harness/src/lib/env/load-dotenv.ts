/**
 * Load environment variables from a `.env.local` file before the rest of
 * the harness reads `process.env`.
 *
 * Why we have this:
 *   The plugin needs runtime secrets — most importantly the rotated Discord
 *   webhook URL — that can't be committed to the public repo. Customers /
 *   MixShift internal team set them via a local `.env.local` file. This
 *   loader reads that file early in CLI startup and pushes values into
 *   `process.env`.
 *
 * Lookup order (first match wins):
 *   1. `~/.mixshift/.env.local`            — preferred. Durable across plugin
 *                                            reinstalls (lives outside the
 *                                            plugin's install dir).
 *   2. `<repo-root>/.env.local`            — standard. Where `.gitignore` and
 *                                            `.env.local.template` live;
 *                                            convention for most projects.
 *   3. `<plugin-root>/.env.local`          — fallback. For setups where
 *                                            someone keeps env config alongside
 *                                            the plugin itself.
 *
 * Existing shell environment ALWAYS wins. If you already exported
 * `MIXSHIFT_DISCORD_WEBHOOK=...` in your shell, the `.env.local` value is
 * ignored. This matches dotenv semantics and avoids surprise overrides.
 *
 * File format:
 *   - One `KEY=VALUE` per line
 *   - Lines starting with `#` are comments
 *   - Blank lines OK
 *   - Quotes optional; if present, paired single or double quotes are stripped
 *   - No multi-line values (KISS — if you need a newline, it doesn't go in env)
 *   - No variable interpolation (no `$OTHER_VAR` expansion)
 *
 * Why no `dotenv` dependency:
 *   30 lines of code; adding an npm dep for this is overkill. Node 20+ has
 *   native `--env-file` but that flag must be on the `node` invocation, and
 *   the plugin runtime invokes `bin/mixshift` directly — we can't inject
 *   flags. So we read + parse manually.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePluginRoot } from '../prefetch/plugin-root.js';

export interface LoadEnvResult {
  /** Path to the file we loaded, or undefined if no file was found. */
  source_path?: string;
  /** Number of variables actually set (not already present in process.env). */
  applied_count: number;
  /** Variables in the file that we skipped because the shell had them set. */
  skipped_existing: string[];
}

/**
 * Cached result from the first successful load. Subsequent calls return
 * this cached value rather than re-applying — which would report misleading
 * "0 applied, N skipped" counts because the FIRST load already set the
 * vars in process.env (so the second pass sees them as shell-existing).
 */
let cachedResult: LoadEnvResult | undefined;

/**
 * Locate + load `.env.local`. Best-effort: never throws. **Idempotent —
 * subsequent calls return the cached result from the first load.** Returns
 * metadata for diagnostics (`mixshift telemetry status` surfaces which
 * file was loaded, how many vars applied, etc.).
 */
export async function loadDotenvIfPresent(): Promise<LoadEnvResult> {
  if (cachedResult) return cachedResult;

  const candidates = candidatePaths();
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = parseDotenv(raw);
      const result = applyToEnv(parsed);
      cachedResult = {
        source_path: path,
        applied_count: result.applied,
        skipped_existing: result.skipped,
      };
      return cachedResult;
    } catch (err) {
      if (isFileNotFoundError(err)) continue;
      // Unreadable file (permission denied, etc.) — skip silently. Loading
      // env config should never break the CLI.
      continue;
    }
  }

  cachedResult = { applied_count: 0, skipped_existing: [] };
  return cachedResult;
}

/**
 * Test-only: clear the cached result so tests that mutate `.env.local`
 * fixtures can re-trigger the file-read path between cases.
 */
export function __resetDotenvCache(): void {
  cachedResult = undefined;
}

/**
 * Resolve the ordered candidate paths the loader checks. Exposed for tests
 * + the `telemetry status` command which surfaces "loaded env from <path>".
 */
export function candidatePaths(): string[] {
  const paths = [join(homedir(), '.mixshift', '.env.local')];
  try {
    const pluginRoot = resolvePluginRoot();
    // The repo root is the parent of `plugins/<plugin-id>/` — that's where
    // .gitignore + .env.local.template live, so it's the standard place for
    // .env.local. Use `..` twice: plugin root → plugins/ → repo root.
    const repoRoot = join(pluginRoot, '..', '..');
    paths.push(join(repoRoot, '.env.local'));
    paths.push(join(pluginRoot, '.env.local'));
  } catch {
    // Plugin root resolution can fail in test envs / out-of-tree invocations.
    // That's fine — we just skip the path-derived candidates.
  }
  return paths;
}

/**
 * Parse the contents of a `.env.local` file into a key/value map. Pure
 * function — exposed for tests.
 *
 * Returns the parsed map. Skips malformed lines silently (best-effort
 * loading; we don't want a typo'd `.env.local` to break the CLI).
 */
export function parseDotenv(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // Malformed: no `=`, or `=` is the first char.
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue; // Invalid identifier.
    let value = line.slice(eq + 1).trim();
    // Strip wrapping single or double quotes if both present.
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Set the parsed values on `process.env`. Skips keys already present in
 * the shell environment so the shell always wins.
 *
 * Exposed for tests so they can verify the precedence rule.
 */
export function applyToEnv(parsed: Map<string, string>): {
  applied: number;
  skipped: string[];
} {
  let applied = 0;
  const skipped: string[] = [];
  for (const [key, value] of parsed) {
    if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    applied++;
  }
  return { applied, skipped };
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
