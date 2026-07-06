/**
 * Throttled preflight auto-sync — the P2 "pull-if-stale before skill runs".
 *
 * maybeAutoSync(brand) is hooked at the top of resolveBrandFields (the
 * Step-0 brand-context accessor every skill entry goes through; see
 * lib/brain/read.ts) and exposed manually via `mixshift context autosync`.
 * It opportunistically freshens the local cache from the org store before
 * the local read happens.
 *
 * HARD CONSTRAINTS (mirrored in tests):
 *   - Never blocks meaningfully: every network request shares one
 *     AUTOSYNC_BUDGET_MS AbortSignal budget; on timeout / offline / missing
 *     credentials / any error the function returns a quiet no-op and the
 *     local read proceeds unchanged. It NEVER throws.
 *   - Throttled: at most one ATTEMPT per brand per AUTOSYNC_THROTTLE_MS,
 *     stamped in the per-brand ledger (`last_autosync_at`, schema-tolerant —
 *     see state.ts). Failures count as attempts so an offline machine isn't
 *     hammered on every skill step.
 *   - Pull-only and conservative: delegates to engine.pull WITHOUT force,
 *     which only writes docs whose verdict is 'server-ahead' or
 *     'server-only' (no local modification by construction). Diverged /
 *     conflicting docs are never touched; nothing is ever pushed. Post-run
 *     push-after is deliberately NOT automatic in this phase — flows opt in
 *     explicitly via `mixshift context sync --quiet`.
 *   - Kill switch: MIXSHIFT_CONTEXT_AUTOSYNC=off (also '0'/'false')
 *     disables it entirely, before any file or network activity.
 */

import { pull } from './engine.js';
import { createContextSyncClient, type ContextSyncClient } from './client.js';
import { loadState, resolveLedgerIdentity, saveState } from './state.js';
import type { DocActionReport } from './types.js';

/** Overall wall-clock budget for ALL autosync network activity. */
export const AUTOSYNC_BUDGET_MS = 2_000;

/** At most one autosync attempt per brand per window. */
export const AUTOSYNC_THROTTLE_MS = 15 * 60 * 1_000;

/** Env kill switch. 'off' | '0' | 'false' (case-insensitive) disables. */
export const AUTOSYNC_ENV = 'MIXSHIFT_CONTEXT_AUTOSYNC';

export interface AutoSyncOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to the real HTTP client (budgeted). */
  client?: ContextSyncClient;
  /** Injectable for tests; the real path wraps this with the budget signal. */
  fetchImpl?: typeof fetch;
  /** Bypass the throttle (manual `context autosync --force`). The attempt
   *  is still stamped. */
  force?: boolean;
  budgetMs?: number;
  throttleMs?: number;
  /** Clock injection for tests. */
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export type AutoSyncResult =
  | { ran: false; reason: 'disabled' | 'throttled' }
  | { ran: false; reason: 'failed'; detail: string }
  | { ran: true; pulled: number; conflicts: number; errors: number; reports: DocActionReport[] };

/**
 * Attempt one throttled, budgeted, pull-only sync for a brand. Safe to call
 * from any read path: never throws, never prints (MIXSHIFT_DEBUG stderr
 * lines at most), and the worst outcome of any failure is "the local cache
 * stays as it was".
 */
export async function maybeAutoSync(
  brandSlug: string,
  options: AutoSyncOptions = {},
): Promise<AutoSyncResult> {
  const env = options.env ?? process.env;
  try {
    const flag = (env[AUTOSYNC_ENV] ?? '').toLowerCase();
    if (flag === 'off' || flag === '0' || flag === 'false') {
      return { ran: false, reason: 'disabled' };
    }
    // House precedent (lib/brain/spawn.ts): never kick off background
    // network activity from inside the test runner — unit tests exercising
    // read paths must not hit a real (or test-stub) service. Autosync's own
    // tests pass an explicit `env` to opt back in.
    if (options.env === undefined && process.env.VITEST) {
      return { ran: false, reason: 'disabled' };
    }

    const now = options.now ? options.now() : new Date();
    const throttleMs = options.throttleMs ?? AUTOSYNC_THROTTLE_MS;
    const identity = await resolveLedgerIdentity(options.dataDirOverride);
    const state = await loadState(brandSlug, options.dataDirOverride, identity);

    if (!options.force && state.last_autosync_at !== undefined) {
      const last = Date.parse(state.last_autosync_at);
      if (Number.isFinite(last) && now.getTime() - last < throttleMs) {
        return { ran: false, reason: 'throttled' };
      }
    }

    // Stamp the ATTEMPT before any network work, so a hung/failed pull
    // still opens a full quiet window (best-effort save — see state.ts).
    state.last_autosync_at = now.toISOString();
    await saveState(brandSlug, state, options.dataDirOverride);

    // One shared abort budget across every request the pull makes
    // (manifest + per-doc fetches). The per-request timeouts inside the
    // client (30s/120s) are far looser, so simply REPLACING the signal
    // keeps the strictest bound without needing AbortSignal.any.
    const controller = new AbortController();
    const budgetMs = options.budgetMs ?? AUTOSYNC_BUDGET_MS;
    const timer = setTimeout(() => controller.abort(), budgetMs);
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

      const result = await pull(brandSlug, {
        client,
        dataDirOverride: options.dataDirOverride,
        // NEVER force: diverged docs stay untouched by design.
      });
      if (!result.ok) {
        debugLog(env, `autosync(${brandSlug}): ${result.message}`);
        return { ran: false, reason: 'failed', detail: result.message };
      }
      const pulled = result.reports.filter((r) => r.action === 'pulled').length;
      const conflicts = result.reports.filter((r) => r.action === 'conflict').length;
      const errors = result.reports.filter((r) => r.action === 'error').length;
      return { ran: true, pulled, conflicts, errors, reports: result.reports };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(env, `autosync(${brandSlug}): swallowed error: ${message}`);
    return { ran: false, reason: 'failed', detail: message };
  }
}

function debugLog(env: NodeJS.ProcessEnv, message: string): void {
  if (env.MIXSHIFT_DEBUG) process.stderr.write(`[debug] ${message}\n`);
}
