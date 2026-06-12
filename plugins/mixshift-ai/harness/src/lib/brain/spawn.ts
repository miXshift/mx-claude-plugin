/**
 * Detached background launch of `mixshift brand brain fetch <slug>`.
 *
 * Used by the `brand key add` success path: keying must return to the
 * user immediately, so the brain fetch runs in a separate process that
 * outlives the CLI invocation. Progress lands in `.brain-status.json`
 * (see lib/brain/fetch.ts) for the chat surface to poll.
 *
 * Failure to spawn is never fatal: keying succeeds regardless, and the
 * caller surfaces the manual fallback (`mixshift brand brain fetch`).
 */

import { spawn } from 'node:child_process';

export interface SpawnBrainFetchResult {
  spawned: boolean;
  reason?: string;
}

/** Env kill-switch: tests + users who want keying without background
 *  warehouse activity. */
export const BRAIN_NO_SPAWN_ENV = 'MIXSHIFT_BRAIN_NO_SPAWN';

/** Exported for unit tests (arg construction without process spawning). */
export function buildBrainFetchArgv(
  cliEntry: string,
  slug: string,
  dataDirOverride?: string,
): string[] {
  const argv = [cliEntry, 'brand', 'brain', 'fetch', slug];
  if (dataDirOverride) {
    argv.push('--data-dir', dataDirOverride);
  }
  return argv;
}

export function spawnBrainFetchDetached(
  slug: string,
  dataDirOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnBrainFetchResult {
  if (env[BRAIN_NO_SPAWN_ENV] === '1') {
    return { spawned: false, reason: `disabled via ${BRAIN_NO_SPAWN_ENV}=1` };
  }
  // Never spawn from inside a test runner: argv[1] is the vitest binary
  // there, so a detached child would re-launch the test suite.
  if (env.VITEST) {
    return { spawned: false, reason: 'test environment (VITEST set)' };
  }
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    return { spawned: false, reason: 'CLI entry path unavailable (argv[1] empty)' };
  }
  try {
    const child = spawn(
      process.execPath,
      buildBrainFetchArgv(cliEntry, slug, dataDirOverride),
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return { spawned: true };
  } catch (err) {
    return {
      spawned: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
