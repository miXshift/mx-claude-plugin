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
 * The seams AWAIT this call — it is NOT fire-and-forget. Awaiting is
 * deliberate: a CLI process would exit before a detached push finished, so a
 * genuine background publish would simply never land. Instead the call is
 * bounded (PUSH_AFTER_WRITE_BUDGET_MS) and result-first — the local write is
 * already durable, so the awaited result is discarded and never surfaced, and
 * the worst the await costs is the wall-clock budget.
 *
 * HARD CONSTRAINTS (mirrored in tests):
 *   - Never fails the user's write: the local write is already durable by the
 *     time this runs (result-first). The WHOLE attempt (token load/refresh
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
 *   - Participant-gated: enriches only a brand ALREADY in the org store (its
 *     sync ledger has tracked docs). A brand with an empty ledger has never
 *     been published, so it is skipped — the first publish stays an explicit
 *     `context push` / `context migrate`. Mirrors autosync, which pulls only
 *     for brands it already tracks.
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
import { loadState } from './state.js';
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
  /**
   * User-facing STDERR notice (see emitNotice). On by default; pass false to
   * suppress it (e.g. a caller that renders its own summary). The notice is
   * ALSO silent whenever the whole hook short-circuits to a no-op (disabled /
   * unsafe / missing-dir / nothing-changed).
   */
  notify?: boolean;
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
 * Safe to call from any write path: never throws, and the worst outcome of any
 * failure is "the write is durable locally and will publish on the next
 * explicit sync". Emits ONE concise user-facing line to STDERR (opt out with
 * `notify: false`) confirming the share, nudging an unshared brand toward
 * `context push`, or noting a transient sync failure; STDOUT/--json stay clean.
 */
export async function pushAfterWrite(
  brandSlug: string,
  options: PushAfterWriteOptions = {},
): Promise<PushAfterWriteResult> {
  const env = options.env ?? process.env;
  const result = await computePushResult(brandSlug, options, env);
  // SINGLE emit point: all 7 write seams await pushAfterWrite, so emitting the
  // user-facing notice HERE (and never from the seams) means one place owns
  // the copy and the per-brand dedup. See emitNotice for why STDERR + why a
  // print is right here (unlike the silent autosync preflight).
  emitNotice(brandSlug, result, options.notify ?? true);
  return result;
}

async function computePushResult(
  brandSlug: string,
  options: PushAfterWriteOptions,
  env: NodeJS.ProcessEnv,
): Promise<PushAfterWriteResult> {
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

    // PARTICIPANT GATE: auto-publish only ENRICHES a brand already in the org
    // store; it never bootstraps a brand's first publish. A brand's FIRST
    // publish stays explicit (the mx-brand-context skill's closing `context
    // push`, or `context migrate`), which is what creates this ledger; only
    // AFTER that do writes auto-enrich. An empty ledger means the brand has
    // never been synced — pushing now would surprise-publish the whole
    // local-ahead doc set for a user who never opted into org-brain, and would
    // charge every non-participant an awaited network round-trip on every
    // write. This makes pushAfterWrite the mirror image of autosync (which
    // pulls only for brands it already tracks; see autosync.ts). Load the
    // ledger RAW (no identity binding) — presence of tracked docs is all we
    // gate on; push itself owns tenant-identity handling. Skip is a safe
    // no-op, never a throw.
    const state = await loadState(brandSlug, options.dataDirOverride);
    if (Object.keys(state.docs).length === 0) {
      return {
        published: false,
        reason: 'skipped',
        detail:
          'brand not yet in the org store; publish it explicitly first ' +
          '(context push / context migrate)',
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
      // Racing the whole push bounds the await we hand back to the write path
      // regardless of where the hang is. On deadline we STOP awaiting and
      // return the quiet no-op; the raced push promise is abandoned un-awaited
      // (its errors are already swallowed by the result-envelope contract, and
      // a push that happens to settle after we returned just publishes the doc
      // a moment later — harmless).
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

// ---------------------------------------------------------------------------
// User-facing notice
// ---------------------------------------------------------------------------

/** Brands we have already shown a notice for THIS process — the per-brand
 *  dedup so a command that writes one brand several times prints one line. */
const noticedBrands = new Set<string>();

/** Test-only: forget every emitted-notice memo so each case starts clean.
 *  (Mirrors __resetDotenvCache / __resetPluginVersionCache house style.) */
export function __resetPushAfterWriteNotices(): void {
  noticedBrands.clear();
}

/**
 * Emit the auto-publish outcome as ONE user-facing line to STDERR.
 *
 * WHY STDERR (and why a print belongs here at all): this is NOT the silent
 * autosync PREFLIGHT (a best-effort PULL before a read, where any chatter is
 * noise). This fires immediately AFTER the user's explicit WRITE, and the one
 * thing a user wants to know then is "did my work reach the team?" — a
 * one-line confirmation or nudge is expected and wanted. Writing to STDERR
 * (never STDOUT) is the load-bearing guarantee: --json and every other
 * structured STDOUT consumer stay byte-for-byte clean; the notice shares the
 * stderr channel with the MIXSHIFT_DEBUG debugLog lines but is a distinct,
 * on-by-default (opt-out via `notify`) surface, not gated on MIXSHIFT_DEBUG.
 *
 * Deduped per brand per process. Silent for the intentional-off / no-news
 * outcomes (disabled kill switch, unsafe slug, missing dir, published-but-
 * nothing-changed) — see noticeLineFor. Silent in the test suite too: the
 * VITEST guard turns the whole hook into a 'disabled' no-op unless a test
 * opts back in with an explicit `env` (as this module's own tests do).
 */
function emitNotice(
  brandSlug: string,
  result: PushAfterWriteResult,
  notify: boolean,
): void {
  if (!notify) return;
  const line = noticeLineFor(brandSlug, result);
  if (line === null) return; // intentional-off or no news: stay silent
  if (noticedBrands.has(brandSlug)) return; // one line per brand per process
  noticedBrands.add(brandSlug);
  process.stderr.write(line + '\n');
}

/** Map an auto-publish result to its user-facing line, or null when the
 *  outcome warrants no notice. Copy rules: no em dashes, "brand context" not
 *  "cold start". */
function noticeLineFor(brandSlug: string, result: PushAfterWriteResult): string | null {
  if (result.published) {
    const shared = result.pushed + result.created;
    // Published but nothing actually moved (all noop / conflict / server-side):
    // no news to report.
    if (shared <= 0) return null;
    return `✓ Shared ${brandSlug} to your team's brand context (${shared} doc(s)).`;
  }
  switch (result.reason) {
    case 'disabled':
      return null; // kill switch: intentional-off, say nothing
    case 'skipped':
      // Only the PARTICIPANT-GATE skip (brand not yet in the org store) earns a
      // nudge — that is the "(a) I thought this was accruing to the team" +
      // "(b) I don't know how to commit it" case the notice exists for. The
      // other 'skipped' details (unsafe slug, no local dir) are silent no-ops.
      if (result.detail.includes('not yet in the org store')) {
        return (
          `Saved locally. ${brandSlug} is not shared with your team yet. ` +
          `Run \`mixshift context push --brand ${brandSlug}\` to commit it.`
        );
      }
      return null;
    case 'failed':
      return (
        `Could not sync ${brandSlug} to your team just now; your work is saved locally. ` +
        `Retry with \`mixshift context push --brand ${brandSlug}\`.`
      );
  }
}
