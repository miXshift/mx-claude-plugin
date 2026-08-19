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
 *   - ALWAYS-ON (Sam, 2026-08-04 — supersedes the 0.8.0 participant gate):
 *     every write publishes, including a brand's FIRST. The 0.8.0 design made
 *     the first share an explicit `context push` / `migrate`; in practice
 *     unshared brands piled up locally (the exact telemetry signal the gate's
 *     own docs said would argue for always-on) and their curated events never
 *     reached the team timeline. engine.push creates the sync ledger on the
 *     first publish; the notice line makes every share visible.
 *   - Kill switch: MIXSHIFT_CONTEXT_AUTOPUBLISH=off (also '0'/'false')
 *     disables it entirely, before any file or network activity — this is
 *     also the opt-out for anyone who wants first-share-stays-manual back.
 *
 * Telemetry: unlike the assignment mirror (still silent by design), this
 * seam now fires ONE ContextPushCompleted event per completed attempt —
 * published, failed, or skipped alike — tagged trigger:'write' so its rows
 * sit alongside the explicit `mixshift context push` command's rows of the
 * SAME event instead of forking a parallel one. The one exception is the
 * kill switch: 'disabled' returns before telemetry too, so MIXSHIFT_CONTEXT_
 * AUTOPUBLISH=off keeps its documented zero-fs/zero-network guarantee above
 * — telemetry's own track() reads/writes local files (install id, profile,
 * queue), so calling it from that branch would quietly break the promise.
 * The emit is AWAITED (see emitPushTelemetry) rather than fire-and-forget:
 * this fires once per write, not per query, so its cost is negligible
 * against the 2s budget, and awaiting avoids the emit racing the process
 * (or a caller's own cleanup) exiting before the queue append lands.
 * This replaces the old silent-by-design stance: a one-shot 2s-budget push
 * firing from 7 write seams with no visibility into how often it actually
 * reaches the team (offline, expired creds, a budget death) was a real
 * observability gap, not a deliberate one. The autosync preflight hook
 * (autosync.ts) gained the equivalent instrumentation alongside this.
 */

import { push } from './engine.js';
import { createContextSyncClient, type ContextSyncClient } from './client.js';
import { brandDirExists, isSafeBrandSlug } from './local.js';
import { DEADLINE, raceDeadline } from '../utils/deadline.js';
import { runBudgetedStakeLeg, type StakeLegSummary } from '../timeline/stake-sync.js';
import type { TimelineClient } from '../timeline/client.js';
import type { DocActionReport } from './types.js';
import { track, EventName } from '../telemetry/index.js';

// Re-exported for existing consumers; the canonical definition moved to
// lib/timeline/stake-sync.ts when the autosync read preflight gained the
// same leg.
export type { StakeLegSummary } from '../timeline/stake-sync.js';

/** Overall wall-clock budget for one auto-publish attempt (network inclusive).
 *  Matched to the other best-effort side-channels (autosync + ads-emit + the
 *  assignment mirror all 2s). */
export const PUSH_AFTER_WRITE_BUDGET_MS = 2_000;

/** Separate budget for the stake-sync leg (#37499) that follows a successful
 *  doc push. Same 2s discipline; the common case never spends it (the
 *  structural_events hash in the sync ledger skips the leg entirely when
 *  nothing changed, and idempotency keys make a re-run convergent when a
 *  budget death strands a partial sync). */
export const STAKE_SYNC_AFTER_WRITE_BUDGET_MS = 2_000;

/** Env kill switch. 'off' | '0' | 'false' (case-insensitive) disables. */
export const PUSH_AFTER_WRITE_ENV = 'MIXSHIFT_CONTEXT_AUTOPUBLISH';

export interface PushAfterWriteOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to the real HTTP client (budgeted). */
  client?: ContextSyncClient;
  /** Injectable for tests; the real path wraps this with the budget signal. */
  fetchImpl?: typeof fetch;
  budgetMs?: number;
  /** Injectable for tests; defaults to the real timeline client (budgeted). */
  stakeClient?: TimelineClient;
  stakeBudgetMs?: number;
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
      /** Present after the stake leg ran (it runs on every published:true). */
      stake_events?: StakeLegSummary;
    };

/**
 * Publish a brand's locally-ahead context docs to the org store, best-effort.
 * Safe to call from any write path: never throws, and the worst outcome of any
 * failure is "the write is durable locally and will publish on the next
 * explicit sync". Emits ONE concise user-facing line to STDERR (opt out with
 * `notify: false`) confirming the share or noting a transient sync failure; STDOUT/--json stay
 * clean.
 */
export async function pushAfterWrite(
  brandSlug: string,
  options: PushAfterWriteOptions = {},
): Promise<PushAfterWriteResult> {
  const t0 = Date.now();
  const env = options.env ?? process.env;
  let result = await computePushResult(brandSlug, options, env);
  // Stake-sync leg (#37499): after a successful doc push, publish the
  // brand's context.yaml structural_events to the timeline as declared
  // stakes. Runs ONLY on published:true, so it inherits every gate above it
  // (kill switch, VITEST, slug safety) with no re-checks. Same never-throws
  // discipline; a stake failure never demotes the doc push.
  if (result.published) {
    const stakeLeg = await runStakeLeg(brandSlug, options, env);
    result = { ...result, stake_events: stakeLeg };
  }
  // SINGLE emit point: all 7 write seams await pushAfterWrite, so emitting the
  // user-facing notice HERE (and never from the seams) means one place owns
  // the copy and the per-brand dedup. See emitNotice for why STDERR + why a
  // print is right here (unlike the silent autosync preflight).
  emitNotice(brandSlug, result, options.notify ?? true);
  await emitPushTelemetry(brandSlug, result, Date.now() - t0, options.dataDirOverride);
  return result;
}

/**
 * The stake-sync leg — delegates to the shared budgeted implementation in
 * lib/timeline/stake-sync.ts (also used by the autosync read preflight), so
 * both automatic seams stay behaviorally identical: cheap local pre-checks
 * (no events / unchanged hash = zero network), one wall-clock race + shared
 * AbortSignal, never throws, failing events named in the debug log, ledger
 * stamp owned by syncStakes.
 */
async function runStakeLeg(
  brandSlug: string,
  options: PushAfterWriteOptions,
  env: NodeJS.ProcessEnv,
): Promise<StakeLegSummary> {
  return runBudgetedStakeLeg(brandSlug, {
    ...(options.dataDirOverride !== undefined
      ? { dataDirOverride: options.dataDirOverride }
      : {}),
    ...(options.stakeClient !== undefined ? { client: options.stakeClient } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    budgetMs: options.stakeBudgetMs ?? STAKE_SYNC_AFTER_WRITE_BUDGET_MS,
    env,
  });
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

    // ALWAYS-ON (Sam, 2026-08-04): the 0.8.0 participant gate — skip brands
    // whose sync ledger had no tracked docs, keeping the FIRST publish an
    // explicit act — is removed. Every write now publishes, first ones
    // included; engine.push creates the ledger as part of that first publish,
    // and the stderr notice keeps each share visible. The kill switch above
    // remains the opt-out.

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
      // (a push that settles after we returned just publishes the doc a moment
      // later — harmless). push()'s contract is envelope errors, never a
      // rejection, but an ABANDONED promise is exactly where that invariant
      // must hold even if it someday breaks (an abort landing mid-refresh, a
      // future edit): a late rejection with no awaiter is an unhandled
      // rejection crashing the CLI after the user's write already succeeded.
      // The pre-attached catch pins that at the seam (review).
      const pushPromise = push(brandSlug, {
        client,
        ...(options.dataDirOverride !== undefined
          ? { dataDirOverride: options.dataDirOverride }
          : {}),
        // NEVER force: diverged docs stay conflicts by design.
      });
      pushPromise.catch((err: unknown) => {
        debugLog(
          env,
          `push-after-write(${brandSlug}): abandoned push rejected: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      const raced = await raceDeadline(pushPromise, budgetMs);
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
    // Stake leg (#37499): newly recorded brand events earn a mention. Only
    // NEW ones — duplicates and skips are no news, and a failure stays a
    // silent debugLog (the events remain locally and re-sync next write).
    const staked = result.stake_events?.created ?? 0;
    const stakeNote =
      staked > 0 ? ` Recorded ${staked} brand event(s) on the team timeline.` : '';
    // Published but nothing actually moved (all noop / conflict / server-side):
    // no news to report, unless events landed.
    if (shared <= 0 && staked <= 0) return null;
    if (shared <= 0) {
      // stakeNote carries its own leading space, which supplies the separator
      // after the colon (do not trim it away).
      return `✓ ${brandSlug}:${stakeNote}`;
    }
    return `✓ Shared ${brandSlug} to your team's brand context (${shared} doc(s)).${stakeNote}`;
  }
  switch (result.reason) {
    case 'disabled':
      return null; // kill switch: intentional-off, say nothing
    case 'skipped':
      // The remaining 'skipped' details (unsafe slug, no local dir) are
      // silent no-ops. (The 0.8.0 participant-gate nudge lived here until
      // Sam made auto-publish always-on, 2026-08-04.)
      return null;
    case 'failed':
      return (
        `Could not sync ${brandSlug} to your team just now; your work is saved locally. ` +
        `Retry with \`mixshift context push --brand ${brandSlug}\`.`
      );
  }
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Fire one telemetry event per completed pushAfterWrite attempt — published,
 * failed, or skipped (unsafe slug / no local dir) alike. The one outcome that
 * never reaches here is 'disabled': the kill switch returns before this is
 * even called (see computePushResult's first check + the module doc's
 * zero-fs/zero-network guarantee), and track() itself does local file I/O
 * (install id, profile, queue), so calling it from the kill-switch path would
 * quietly break that promise.
 *
 * Reuses ContextPushCompleted — the SAME event `mixshift context push`
 * emits (see commands/context.ts's registerActionSubcommand) — tagged
 * payload.trigger:'write' rather than forking a parallel event, so both
 * sources are queryable together and diffable apart.
 *
 * AWAITED, not fire-and-forget: lib/data/query-runner.ts and lib/brain/
 * fetch.ts use `void track(...)` for telemetry on a hot, per-query path
 * where every millisecond compounds across thousands of calls — this seam
 * fires once per write, so track()'s cost (a handful of local file reads/
 * writes, no network — that happens later, on the next invocation's flush)
 * is negligible against the 2s budget it is measured inside of. Awaiting
 * also matters here in a way it wouldn't for a hot path: pushAfterWrite is
 * itself awaited specifically so a short-lived CLI process doesn't exit
 * before a background publish lands (see the module doc); a detached
 * `void track(...)` would reopen exactly that risk for this rare,
 * high-value signal — the process could exit (or, in a test, the caller
 * could tear down its temp dir) before the queue append finishes.
 */
async function emitPushTelemetry(
  brandSlug: string,
  result: PushAfterWriteResult,
  durationMs: number,
  dataDirOverride: string | undefined,
): Promise<void> {
  if (result.published) {
    await track(
      {
        event_name: EventName.ContextPushCompleted,
        outcome: 'ok',
        duration_ms: durationMs,
        payload: {
          trigger: 'write',
          brand: brandSlug,
          published: true,
          pushed: result.pushed,
          created: result.created,
          conflicts: result.conflicts,
          errors: result.errors,
        },
      },
      dataDirOverride,
    );
    return;
  }
  if (result.reason === 'disabled') return; // kill switch: zero fs/network, telemetry included
  await track(
    {
      event_name: EventName.ContextPushCompleted,
      outcome: result.reason === 'failed' ? 'failed' : 'skipped',
      duration_ms: durationMs,
      payload: {
        trigger: 'write',
        brand: brandSlug,
        published: false,
        reason: result.reason,
        detail: result.detail,
      },
    },
    dataDirOverride,
  );
}
