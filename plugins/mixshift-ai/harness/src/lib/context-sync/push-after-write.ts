/**
 * Auto-publish-on-write — the org-brain P2.5 "push what I just wrote" hook.
 *
 * pushAfterWrite(brand) is fired by the brand-context write seams (bootstrap,
 * the context editor, delta-merge, skill config save/reset, config migration,
 * brain fetch, observations) AFTER their local write is durable. It publishes
 * the brand's locally-ahead docs to the org store using the same engine.push
 * machinery `mixshift context push` uses, scoped to the one brand written.
 *
 * It is the automatic counterpart to the explicit `mixshift context sync
 * --quiet` opt-in (see autosync.ts, which stays pull-only). Where autosync
 * pulls before a read, this pushes after a write; both share the exact same
 * bounded, non-throwing, best-effort discipline as ads-emit and the key-brand
 * assignment mirror.
 *
 * HARD CONSTRAINTS (mirrored in tests):
 *   - Never blocks or fails the user's write: the write already returned by
 *     the time this runs (result-first). The WHOLE attempt (token load/refresh
 *     included — a refresh rides the global fetch with its own 30s timeout,
 *     outside any per-request signal we control) is raced against one
 *     PUSH_AFTER_WRITE_BUDGET_MS wall-clock deadline, and every request the
 *     push makes additionally shares an AbortSignal on the same budget. On
 *     deadline / offline / missing credentials / any error it returns a quiet
 *     no-op. It NEVER throws.
 *   - Non-destructive: delegates to engine.push WITHOUT force, so only
 *     local-ahead / local-only docs go up. Diverged docs stay conflicts (never
 *     force-overwritten); server-ahead docs are left for an explicit pull.
 *   - A write stays a write: the brand slug must pass the strict safety
 *     pattern (brandDir() joins it into a filesystem path verbatim) AND the
 *     brand directory must already exist locally — which it always does right
 *     after a write. A typo'd or hostile slug is skipped with no side effect.
 *   - Kill switch: MIXSHIFT_CONTEXT_AUTOPUBLISH=off (also '0'/'false')
 *     disables it entirely, before any file or network activity.
 *
 * No telemetry is emitted here (the context-sync events belong to the explicit
 * `mixshift context` commands; a passive write side-channel stays silent, the
 * same way the autosync preflight hook and the assignment mirror do).
 */

import { push } from './engine.js';
import { createContextSyncClient, type ContextSyncClient } from './client.js';
import { brandDirExists, isSafeBrandSlug } from './local.js';
import { DEADLINE, raceDeadline } from '../utils/deadline.js';
import type { DocActionReport } from './types.js';

/** Overall wall-clock budget for one auto-publish attempt (network inclusive).
 *  Matched to the other best-effort side-channels (autosync + ads-emit + the
 *  assignment mirror all 2s). */
export const PUSH_AFTER_WRITE_BUDGET_MS = 2_000;

/** Env kill switch. 'off' | '0' | 'false' (case-insensitive) disables. */
export const PUSH_AFTER_WRITE_ENV = 'MIXSHIFT_CONTEXT_AUTOPUBLISH';

export interface PushAfterWriteOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to the real HTTP client (budgeted). */
  client?: ContextSyncClient;
  /** Injectable for tests; the real path wraps this with the budget signal. */
  fetchImpl?: typeof fetch;
  budgetMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type PushAfterWriteResult =
  | { published: false; reason: 'disabled' }
  /** Preconditions not met (unsafe/unknown slug). Nothing touched. */
  | { published: false; reason: 'skipped'; detail: string }
  | { published: false; reason: 'failed'; detail: string }
  | {
      published: true;
      pushed: number;
      created: number;
      conflicts: number;
      errors: number;
      reports: DocActionReport[];
    };

/**
 * Publish a brand's locally-ahead context docs to the org store, best-effort.
 * Safe to call from any write path: never throws, never prints (MIXSHIFT_DEBUG
 * stderr lines at most), and the worst outcome of any failure is "the write is
 * durable locally and will publish on the next explicit sync".
 */
export async function pushAfterWrite(
  brandSlug: string,
  options: PushAfterWriteOptions = {},
): Promise<PushAfterWriteResult> {
  const env = options.env ?? process.env;
  try {
    const flag = (env[PUSH_AFTER_WRITE_ENV] ?? '').toLowerCase();
    if (flag === 'off' || flag === '0' || flag === 'false') {
      return { published: false, reason: 'disabled' };
    }
    // House precedent (autosync.ts / lib/brain/spawn.ts): never kick off
    // background network activity from inside the test runner — unit tests
    // exercising write paths must not hit a real (or test-stub) service. A
    // truthy VITEST in ANY process disables auto-publish; the safe direction.
    // This module's own tests pass an explicit `env` to opt back in.
    if (options.env === undefined && process.env.VITEST) {
      debugLog(env, `push-after-write(${brandSlug}): disabled under test runner (VITEST set)`);
      return { published: false, reason: 'disabled' };
    }

    // SECURITY: the slug reaches brandDir(), which joins it into a path
    // verbatim — a slug with separators or '..' would read OUTSIDE clients/.
    // Reject before ANY filesystem call.
    if (!isSafeBrandSlug(brandSlug)) {
      debugLog(env, `push-after-write: unsafe brand slug ${JSON.stringify(brandSlug)}; skipped`);
      return { published: false, reason: 'skipped', detail: 'not a valid brand slug' };
    }

    // Publish serves EXISTING local brands only (which the brand always is,
    // immediately after a write). A missing dir means the caller passed a slug
    // that never landed on disk — skip rather than fabricate a push.
    if (!(await brandDirExists(brandSlug, options.dataDirOverride))) {
      return {
        published: false,
        reason: 'skipped',
        detail: 'no local brand directory',
      };
    }

    // Fetch-level budget: one shared abort across every request the push
    // makes (manifest + per-doc PUTs). The per-request timeouts inside the
    // client (30s/120s) are far looser, so replacing the signal keeps the
    // strictest bound without needing AbortSignal.any.
    const controller = new AbortController();
    const budgetMs = options.budgetMs ?? PUSH_AFTER_WRITE_BUDGET_MS;
    const abortTimer = setTimeout(() => controller.abort(), budgetMs);
    abortTimer.unref?.();
    try {
      const baseFetch = options.fetchImpl ?? fetch;
      const budgetedFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        baseFetch(input, { ...init, signal: controller.signal })) as typeof fetch;
      const client =
        options.client ??
        createContextSyncClient({
          dataDirOverride: options.dataDirOverride,
          fetchImpl: budgetedFetch,
        });

      // Wall-clock budget: the abort signal above only covers the fetches the
      // CLIENT makes; authedRequest first awaits getValidAccessToken, and a
      // token refresh/mint rides the GLOBAL fetch with its own 30s timeout.
      // Racing the whole push keeps the promise to the write path regardless
      // of where the hang is. On deadline the detached push is left to finish
      // on its own: its errors are already swallowed by the result-envelope
      // contract, and a push that completes after the write returned just
      // publishes the doc a moment later.
      const raced = await raceDeadline(
        push(brandSlug, {
          client,
          ...(options.dataDirOverride !== undefined
            ? { dataDirOverride: options.dataDirOverride }
            : {}),
          // NEVER force: diverged docs stay conflicts by design.
        }),
        budgetMs,
      );
      if (raced === DEADLINE) {
        controller.abort(); // cut the budgeted fetches; a refresh dies on its own timer
        debugLog(env, `push-after-write(${brandSlug}): budget of ${budgetMs}ms exceeded`);
        return { published: false, reason: 'failed', detail: `timed out after ${budgetMs}ms` };
      }
      if (!raced.ok) {
        debugLog(env, `push-after-write(${brandSlug}): ${raced.message}`);
        return { published: false, reason: 'failed', detail: raced.message };
      }
      const pushed = raced.reports.filter((r) => r.action === 'pushed').length;
      const created = raced.reports.filter((r) => r.action === 'created').length;
      const conflicts = raced.reports.filter((r) => r.action === 'conflict').length;
      const errors = raced.reports.filter((r) => r.action === 'error').length;
      return { published: true, pushed, created, conflicts, errors, reports: raced.reports };
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(env, `push-after-write(${brandSlug}): swallowed error: ${message}`);
    return { published: false, reason: 'failed', detail: message };
  }
}

function debugLog(env: NodeJS.ProcessEnv, message: string): void {
  if (env.MIXSHIFT_DEBUG) process.stderr.write(`[debug] ${message}\n`);
}
