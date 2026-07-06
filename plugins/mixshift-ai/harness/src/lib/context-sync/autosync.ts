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
 *   - Never blocks meaningfully: the WHOLE attempt (token load/refresh
 *     included — a refresh rides the global fetch with its own 30s timeout,
 *     outside any per-request signal we control) is raced against one
 *     AUTOSYNC_BUDGET_MS wall-clock deadline, and every request the pull
 *     makes additionally shares an AbortSignal on the same budget. On
 *     deadline / offline / missing credentials / any error the function
 *     returns a quiet no-op and the local read proceeds unchanged. It
 *     NEVER throws.
 *   - A read stays a read: the brand slug must pass a strict safety
 *     pattern (brandDir() joins it into a filesystem path verbatim) AND
 *     the brand directory must already exist locally — otherwise the hook
 *     skips with no stamp, no mkdir, no save, so a typo'd or hostile slug
 *     can never create a phantom brand dir or touch anything outside
 *     clients/. Likewise, a tenant-identity mismatch with tracked docs on
 *     disk skips entirely: rebinding the ledger stays an explicit-sync
 *     behavior, never a passive-read side effect.
 *   - Throttled: at most one ATTEMPT per brand per AUTOSYNC_THROTTLE_MS,
 *     stamped in the per-brand ledger (`last_autosync_at`, schema-tolerant
 *     — see state.ts). Failures count as attempts so an offline machine
 *     isn't hammered on every skill step. When the stamp cannot be
 *     persisted (e.g. read-only brand dir) the network attempt is skipped
 *     too — otherwise every skill step would stall for the full budget
 *     with zero signal.
 *   - Pull-only and conservative: delegates to engine.pull WITHOUT force,
 *     which only writes docs whose verdict is 'server-ahead' or
 *     'server-only' (no local modification by construction). Diverged /
 *     conflicting docs are never touched; nothing is ever pushed. Post-run
 *     push-after is deliberately NOT automatic in this phase — flows opt
 *     in explicitly via `mixshift context sync --quiet`.
 *   - Kill switch: MIXSHIFT_CONTEXT_AUTOSYNC=off (also '0'/'false')
 *     disables it entirely, before any file or network activity.
 */

import { pull } from './engine.js';
import { createContextSyncClient, type ContextSyncClient } from './client.js';
import { brandDirExists, isSafeBrandSlug } from './local.js';
import { loadState, resolveLedgerIdentity, saveState } from './state.js';
import { DEADLINE, raceDeadline } from '../utils/deadline.js';
import type { DocActionReport } from './types.js';

/** Overall wall-clock budget for one autosync attempt (network inclusive). */
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
  /** Ledger-identity override for tests; defaults to resolveLedgerIdentity. */
  identity?: string | null;
  env?: NodeJS.ProcessEnv;
}

export type AutoSyncResult =
  | { ran: false; reason: 'disabled' | 'throttled' }
  /** Preconditions not met (unsafe/unknown slug, foreign-tenant ledger,
   *  unpersistable stamp). Nothing was touched; detail says why. */
  | { ran: false; reason: 'skipped'; detail: string }
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
    // read paths must not hit a real (or test-stub) service. Deliberate
    // consequence: a truthy VITEST in ANY process (not just our own test
    // runs) disables autosync; that is the safe direction. Autosync's own
    // tests pass an explicit `env` to opt back in.
    if (options.env === undefined && process.env.VITEST) {
      debugLog(env, `autosync(${brandSlug}): disabled under test runner (VITEST set)`);
      return { ran: false, reason: 'disabled' };
    }

    // SECURITY: the slug reaches brandDir()/contextSyncStatePath(), which
    // join() it into a path verbatim — a slug with separators or '..'
    // would read/write OUTSIDE clients/. Reject before ANY filesystem
    // call, with no stamp and no save.
    if (!isSafeBrandSlug(brandSlug)) {
      debugLog(env, `autosync: unsafe brand slug ${JSON.stringify(brandSlug)}; skipped`);
      return { ran: false, reason: 'skipped', detail: 'not a valid brand slug' };
    }

    // Autosync serves EXISTING local brands only. Without this check the
    // throttle stamp's saveState would mkdir clients/<slug>/ as a side
    // effect, so any read of a typo'd slug would permanently create a
    // phantom brand that status/sync/list then report forever. Fetching a
    // brand-new brand stays an explicit `context pull --brand <slug>`.
    if (!(await brandDirExists(brandSlug, options.dataDirOverride))) {
      return {
        ran: false,
        reason: 'skipped',
        detail:
          'no local brand directory; fetch it explicitly with ' +
          '`mixshift context pull --brand <slug>`',
      };
    }

    const now = options.now ? options.now() : new Date();
    const throttleMs = options.throttleMs ?? AUTOSYNC_THROTTLE_MS;
    const identity =
      options.identity !== undefined
        ? options.identity
        : await resolveLedgerIdentity(options.dataDirOverride);

    // Load the ledger RAW (no identity binding) so a mismatch is visible
    // instead of silently emptied.
    const state = await loadState(brandSlug, options.dataDirOverride);

    // Tenant-identity mismatch with tracked docs on disk: rebinding wipes
    // org A's entries, and both our stamp save and the pull's own saves
    // would persist that wipe from a PASSIVE READ. Skip entirely — an
    // explicit `mixshift context sync/pull/push` is the rebind surface.
    if (
      typeof identity === 'string' &&
      typeof state.identity === 'string' &&
      state.identity !== identity &&
      Object.keys(state.docs).length > 0
    ) {
      debugLog(env, `autosync(${brandSlug}): ledger bound to another tenant; skipped`);
      return {
        ran: false,
        reason: 'skipped',
        detail:
          'context ledger is bound to a different tenant; run ' +
          '`mixshift context sync --brand <slug>` to rebind it explicitly',
      };
    }
    // Safe adoption: no stored identity (schema-1 era) or nothing tracked.
    if (typeof identity === 'string' && state.identity !== identity) {
      state.identity = identity;
    }

    if (!options.force && state.last_autosync_at !== undefined) {
      const last = Date.parse(state.last_autosync_at);
      if (Number.isFinite(last) && now.getTime() - last < throttleMs) {
        return { ran: false, reason: 'throttled' };
      }
    }

    // Stamp the ATTEMPT before any network work, so a hung/failed pull
    // still opens a full quiet window. If the stamp cannot be persisted
    // (read-only dir, ...), skip the attempt too: an unstampable brand
    // would otherwise pay the full budget on EVERY skill step.
    state.last_autosync_at = now.toISOString();
    const stamped = await saveState(brandSlug, state, options.dataDirOverride);
    if (!stamped) {
      debugLog(env, `autosync(${brandSlug}): throttle stamp not persistable; skipped`);
      return {
        ran: false,
        reason: 'skipped',
        detail: 'could not persist the throttle stamp (brand dir not writable?)',
      };
    }

    // Fetch-level budget: one shared abort across every request the pull
    // makes (manifest + per-doc fetches). The per-request timeouts inside
    // the client (30s/120s) are far looser, so simply REPLACING the signal
    // keeps the strictest bound without needing AbortSignal.any.
    const controller = new AbortController();
    const budgetMs = options.budgetMs ?? AUTOSYNC_BUDGET_MS;
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

      // Wall-clock budget: the abort signal above only covers the fetches
      // the CLIENT makes; authedRequest first awaits getValidAccessToken,
      // and a token refresh/mint rides the GLOBAL fetch with its own 30s
      // timeout. Racing the whole pull keeps the promise to the read path
      // regardless of where the hang is. On deadline the detached pull is
      // left to finish on its own: its errors are already swallowed by the
      // result-envelope contract, and a pull that completes after this
      // read returned just updates the local cache for the NEXT read.
      const raced = await raceDeadline(
        pull(brandSlug, {
          client,
          dataDirOverride: options.dataDirOverride,
          // NEVER force: diverged docs stay untouched by design.
        }),
        budgetMs,
      );
      if (raced === DEADLINE) {
        controller.abort(); // cut the budgeted fetches; a refresh dies on its own timer
        debugLog(env, `autosync(${brandSlug}): budget of ${budgetMs}ms exceeded`);
        return { ran: false, reason: 'failed', detail: `timed out after ${budgetMs}ms` };
      }
      if (!raced.ok) {
        debugLog(env, `autosync(${brandSlug}): ${raced.message}`);
        return { ran: false, reason: 'failed', detail: raced.message };
      }
      const pulled = raced.reports.filter((r) => r.action === 'pulled').length;
      const conflicts = raced.reports.filter((r) => r.action === 'conflict').length;
      const errors = raced.reports.filter((r) => r.action === 'error').length;
      return { ran: true, pulled, conflicts, errors, reports: raced.reports };
    } finally {
      clearTimeout(abortTimer);
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
