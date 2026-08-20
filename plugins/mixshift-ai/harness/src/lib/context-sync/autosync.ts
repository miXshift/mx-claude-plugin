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
 *     EITHER the brand directory already exists locally OR the org-wide
 *     manifest lists the slug (the seed path below) — otherwise the hook
 *     skips with no stamp, no mkdir, no save, so a typo'd or hostile slug
 *     can never create a phantom brand dir or touch anything outside
 *     clients/. Likewise, a tenant-identity mismatch with tracked docs on
 *     disk skips entirely: rebinding the ledger stays an explicit-sync
 *     behavior, never a passive-read side effect.
 *   - Seed path (D-032, slice 2 — US1/US2): a MISSING brand dir is no
 *     longer an automatic skip. getCachedOrgManifest (below) consults the
 *     org-wide manifest — cached at <dataDir>/.context-sync-org-manifest.json
 *     (see state.ts), TTL = AUTOSYNC_THROTTLE_MS by default, refreshed via
 *     the SAME budgeted client.fetchManifest() this function already uses —
 *     and a slug the org store lists gets SEEDED: falling through into the
 *     exact same throttle-stamp-save + sync()/pull() flow as an
 *     already-existing brand, so the dir gets created (a side effect of the
 *     throttle-stamp save below, the same mkdir the guard above exists to
 *     PREVENT for an unlisted slug) and the engine's normal doc pull/push
 *     populates it. The path-safety property is UNCHANGED, not weakened:
 *     mkdir only ever happens for a slug that ALSO passes isSafeBrandSlug
 *     (re-checked as belt-and-braces right after the manifest confirms
 *     membership) — the manifest only ever upgrades the TRUST SOURCE for
 *     "is this a real brand" from "a local dir happens to exist" to "the
 *     org store itself lists it"; a client-guessed or user-typed slug still
 *     can never create anything. A slug NOT in the manifest skips exactly
 *     as before seeding existed: no stamp, no mkdir. THROTTLING A MISSING
 *     BRAND: it has no per-brand ledger yet to stamp `last_autosync_at`
 *     against, so repeat seed ATTEMPTS for an unshared/typo'd slug are
 *     throttled by the ORG-MANIFEST CACHE'S OWN TTL instead — a slug absent
 *     from the cached manifest is not re-fetched against the network until
 *     that cache expires — rather than a new per-slug mechanism. The
 *     manifest check shares the sync/pull call's own AUTOSYNC_BUDGET_MS
 *     race (its measured duration is subtracted from the budget left for
 *     the op() call below), so a seed attempt's total wall-clock stays
 *     bounded by one budget, not two back-to-back ones.
 *   - Throttled: at most one ATTEMPT per brand per AUTOSYNC_THROTTLE_MS,
 *     stamped in the per-brand ledger (`last_autosync_at`, schema-tolerant
 *     — see state.ts). Failures count as attempts so an offline machine
 *     isn't hammered on every skill step. When the stamp cannot be
 *     persisted (e.g. read-only brand dir) the network attempt is skipped
 *     too — otherwise every skill step would stall for the full budget
 *     with zero signal.
 *   - TWO-WAY since 0.8.8 (Sam, 2026-08-04 — supersedes the P2 pull-only
 *     design): delegates to engine.sync WITHOUT force, which pulls every
 *     non-conflicting server change AND pushes every non-conflicting local
 *     change; diverged docs stay conflicts, nothing is ever overwritten.
 *     After a successful doc sync it also runs the budgeted stake leg
 *     (lib/timeline/stake-sync.ts), so a brand's curated structural_events
 *     reach the team timeline even when nobody EDITS the brand — this is
 *     the zero-touch initial backfill for already-onboarded brands. The
 *     push half + the stake leg honor the MIXSHIFT_CONTEXT_AUTOPUBLISH
 *     kill switch: with publishing off, autosync degrades to the original
 *     pull-only behavior.
 *   - Kill switch: MIXSHIFT_CONTEXT_AUTOSYNC=off (also '0'/'false')
 *     disables it entirely, before any file or network activity.
 *
 * Telemetry + ledger outcome: every attempt that clears the guards above
 * (i.e. everything past the throttle stamp write) now records
 * last_autosync_outcome / last_autosync_success_at on the ledger (see
 * state.ts) and fires one ContextAutosyncCompleted event — the SAME event
 * `mixshift context autosync` already emits — tagged payload.trigger
 * ('preflight' by default; a caller may pass 'manual'), plus
 * payload.seeded:true when THIS attempt is the one that created the brand
 * dir (absent otherwise) — so the seed path (US1/US2) is observable in the
 * field. Early-skip outcomes
 * (disabled, unsafe slug, missing dir, throttled, foreign-tenant ledger, an
 * unpersistable stamp) get neither: this hook runs on every skill step but
 * only truly attempts a sync once per brand per throttle window, so
 * instrumenting the skip path would mostly log "throttled" noise, and the
 * kill switch keeps its documented zero-fs/zero-network guarantee (telemetry
 * itself does local file I/O).
 *
 * The ledger save AND the telemetry emit both happen in finish(), AFTER
 * op() (pull/sync) has already returned — op() loads and persists its OWN
 * state object inside engine.ts's buildDocPairs, so finish() must re-load
 * the ledger fresh rather than reusing the copy it captured before op() ran
 * (see finish()'s own comment). The telemetry emit itself is bounded
 * (TELEMETRY_EMIT_BUDGET_MS, raced via raceDeadline) so a locked/contended
 * local queue.jsonl cannot extend this hook's wall-clock promise beyond that
 * small extra margin, on top of AUTOSYNC_BUDGET_MS.
 */

import { pull, sync } from './engine.js';
import { PUSH_AFTER_WRITE_ENV, TELEMETRY_EMIT_BUDGET_MS } from './push-after-write.js';
import { runBudgetedStakeLeg, type StakeLegSummary } from '../timeline/stake-sync.js';
import { createContextSyncClient, type ContextSyncClient } from './client.js';
import { brandDirExists, isSafeBrandSlug } from './local.js';
import {
  loadOrgManifestCache,
  loadState,
  resolveLedgerIdentity,
  saveOrgManifestCache,
  saveState,
  type ContextSyncState,
} from './state.js';
import { DEADLINE, raceDeadline } from '../utils/deadline.js';
import type { DocActionReport, WireManifestBrand } from './types.js';
import { track, EventName } from '../telemetry/index.js';
import { scrubDetail } from './telemetry-detail.js';

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
  /**
   * Telemetry provenance. 'preflight' (the default — the implicit
   * resolveBrandFields hook) makes this function emit one
   * ContextAutosyncCompleted event per attempt that clears the early-skip
   * guards. 'manual' (passed by `mixshift context autosync` in
   * commands/context.ts) SUPPRESSES the internal emit: the CLI wrapper owns
   * its own single emission, which also covers the early-skip outcomes this
   * function's telemetry tail never sees. Ledger outcome fields are written
   * for both triggers; only the event is trigger-scoped, so one invocation
   * always yields exactly one row.
   */
  trigger?: 'preflight' | 'manual';
}

export type AutoSyncResult =
  | { ran: false; reason: 'disabled' | 'throttled' }
  /** Preconditions not met (unsafe/unknown slug, foreign-tenant ledger,
   *  unpersistable stamp). Nothing was touched; detail says why. */
  | { ran: false; reason: 'skipped'; detail: string }
  | { ran: false; reason: 'failed'; detail: string }
  | {
      ran: true;
      pulled: number;
      /** Docs pushed/created by the two-way half; 0 in pull-only mode. */
      pushed: number;
      created: number;
      conflicts: number;
      errors: number;
      reports: DocActionReport[];
      /** Present when the publish half ran (see PUSH_AFTER_WRITE_ENV). */
      stake_events?: StakeLegSummary;
    };

/**
 * Attempt one throttled, budgeted, two-way sync for a brand (pull-only when
 * publishing is switched off). Safe to call from any read path: never
 * throws, never prints (MIXSHIFT_DEBUG stderr lines at most), and the worst
 * outcome of any failure is "the local cache stays as it was".
 */
export async function maybeAutoSync(
  brandSlug: string,
  options: AutoSyncOptions = {},
): Promise<AutoSyncResult> {
  const env = options.env ?? process.env;
  const t0 = Date.now();
  const trigger = options.trigger ?? 'preflight';
  // Flips true only once an attempt has cleared every early-skip guard (see
  // the throttle-stamp write below) — `finish()` below uses it to decide
  // whether THIS outcome is a real attempt (record + telemetry) or one of
  // the early returns above/below it (neither; same as `last_autosync_at`
  // itself is only ever stamped for a cleared attempt).
  let pastGuards = false;
  let ledgerState: ContextSyncState | undefined;
  // True only when THIS attempt created the brand dir (the seed path).
  // Read by finish() below to add payload.seeded to the telemetry event.
  let seeded = false;
  // Wall-clock time actually spent on the seed path's manifest check, if
  // any (stays 0 when the dir already existed — see the budget note
  // below). Subtracted from the sync/pull race's window further down so a
  // seed attempt's manifest-check-plus-sync total stays bounded by one
  // AUTOSYNC_BUDGET_MS, not two back-to-back ones.
  let manifestElapsedMs = 0;

  /**
   * Common tail for every outcome that cleared the guards: persists
   * last_autosync_outcome/last_autosync_success_at on the already-loaded
   * ledger (best-effort, mirrors the throttle-stamp save below — saveState
   * never throws) and fires one ContextAutosyncCompleted event. See the
   * module doc for why early-skip outcomes never reach here.
   */
  async function finish(result: AutoSyncResult): Promise<AutoSyncResult> {
    if (pastGuards && ledgerState) {
      const succeeded = result.ran && result.errors === 0;
      const finishedAt = options.now ? options.now() : new Date();
      // Re-load the ledger FRESH rather than reusing `ledgerState` (captured
      // above at the throttle-stamp write, BEFORE op() ran): pull/push/sync
      // (engine.ts's buildDocPairs) load and persist their OWN state object,
      // independent of this closure's copy — by the time we get here the
      // on-disk ledger already carries every per-doc revision op() just
      // wrote (engine.ts's own saveState calls) and, when the stake leg ran,
      // its `stakes` stamp too. Saving `ledgerState` here would overwrite
      // ALL of that with its PRE-ATTEMPT snapshot — a successful pull would
      // then read back as 'diverged' on the very next status check.
      // `state`/`ledgerState` above are untouched by this reload (they stay
      // exactly what the identity/throttle-stamp guard logic before this
      // point needs); the reload is scoped to the save right below. See the
      // FIX A regression test ("finish() does not clobber the engine's own
      // save").
      const freshState = await loadState(brandSlug, options.dataDirOverride);
      freshState.last_autosync_outcome = succeeded ? 'success' : 'failed';
      if (succeeded) freshState.last_autosync_success_at = finishedAt.toISOString();
      await saveState(brandSlug, freshState, options.dataDirOverride);
      // Preflight attempts only: the manual `mixshift context autosync`
      // wrapper (commands/context.ts) emits its OWN ContextAutosyncCompleted
      // row covering every outcome — including the early skips this tail
      // never sees — so emitting here too would double-count manual runs.
      // The ledger outcome above is written for BOTH triggers; only the
      // event is preflight-scoped.
      if (trigger === 'preflight') {
        // AWAITED, not fire-and-forget: this fires once per real attempt (at
        // most once per brand per AUTOSYNC_THROTTLE_MS), not per query. The
        // WAIT is bounded too (TELEMETRY_EMIT_BUDGET_MS, via raceDeadline):
        // track()'s local queue-append is normally negligible against the 2s
        // sync budget, but a locked/contended queue.jsonl could otherwise
        // stall this read-path hook indefinitely with no bound of its own.
        // On deadline we stop WAITING, not the write — the append usually
        // still lands because the process lives past this call; only a
        // pathological stall plus an immediate process exit loses the event,
        // an acceptable corner (see push-after-write.ts, which carries the
        // identical bound for its own ContextPushCompleted emit). A detached
        // `void track(...)` would reopen a different risk: the emit racing
        // the process (or a caller's cleanup) exiting before the queue
        // append lands.
        await raceDeadline(
          track(
            {
              event_name: EventName.ContextAutosyncCompleted,
              outcome: succeeded ? 'ok' : 'failed',
              duration_ms: Date.now() - t0,
              payload: {
                trigger,
                brand: brandSlug,
                force: options.force ?? false,
                ran: result.ran,
                // Present (true) only when THIS attempt created the brand
                // dir; absent otherwise — additive field, same event (see
                // the module doc and design D-032).
                ...(seeded ? { seeded: true } : {}),
                ...(result.ran
                  ? {
                      pulled: result.pulled,
                      pushed: result.pushed,
                      created: result.created,
                      conflicts: result.conflicts,
                      errors: result.errors,
                    }
                  : {
                      reason: result.reason,
                      // Non-ENOENT fs errors (EBUSY/EPERM from readLocalDocs)
                      // can embed an absolute local path in their raw
                      // Node.js message; events.ts's contract for
                      // context_sync.* payloads is slugs/counts/outcomes,
                      // never file paths — scrub before it ever reaches the
                      // queue (see telemetry-detail.ts). AutoSyncResult's own
                      // `detail` (returned to the caller) stays unscrubbed —
                      // this is telemetry-only.
                      ...(result.reason === 'failed'
                        ? { detail: scrubDetail(result.detail) }
                        : {}),
                    }),
              },
            },
            options.dataDirOverride,
          ),
          TELEMETRY_EMIT_BUDGET_MS,
        );
      }
    }
    return result;
  }

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

    // Configured budget, resolved once (hoisted ahead of its original spot
    // further down) so the seed path's manifest check — the only new
    // network call this function can make before its normal guards — can
    // race it too, and its measured duration can be subtracted from the
    // remaining budget the sync/pull race gets below.
    const budgetMs = options.budgetMs ?? AUTOSYNC_BUDGET_MS;

    // Autosync serves EXISTING local brands, OR one the org store itself
    // vouches for (the seed path — D-032). Without SOME check here the
    // throttle stamp's saveState would mkdir clients/<slug>/ as a side
    // effect for ANY slug, so a read of a typo'd or hostile slug would
    // permanently create a phantom brand that status/sync/list then report
    // forever. A brand-new brand no source vouches for stays an explicit
    // `context pull --brand <slug>`.
    if (!(await brandDirExists(brandSlug, options.dataDirOverride))) {
      const manifestCheckStart = Date.now();
      const manifestResult = await getCachedOrgManifest({
        dataDirOverride: options.dataDirOverride,
        client: options.client,
        fetchImpl: options.fetchImpl,
        now: options.now,
        throttleMs: options.throttleMs,
        budgetMs,
        env,
      });
      manifestElapsedMs = Date.now() - manifestCheckStart;

      const listed =
        manifestResult.ok &&
        manifestResult.brands.some((b) => b.brand_slug === brandSlug);
      if (!listed) {
        // Covers BOTH sub-cases identically (offline/timeout during the
        // manifest check, and a manifest that came back but doesn't list
        // this slug): from the caller's perspective neither can vouch for
        // this brand right now, so both get the same quiet "do it
        // explicitly" outcome as a plain missing dir always has.
        return {
          ran: false,
          reason: 'skipped',
          detail:
            'no local brand directory; fetch it explicitly with ' +
            '`mixshift context pull --brand <slug>`',
        };
      }
      // Belt-and-braces (design D-032): isSafeBrandSlug was already checked
      // above, before ANY fs/network call, so this is provably true here
      // today — kept as an explicit second gate so mkdir is NEVER reachable
      // solely because the org manifest listed a slug, even under a future
      // refactor that reorders these checks. The manifest is server data,
      // not a trust source for local path safety.
      if (!isSafeBrandSlug(brandSlug)) {
        return { ran: false, reason: 'skipped', detail: 'not a valid brand slug' };
      }
      seeded = true;
      // Fall through: the throttle-stamp save a few lines down creates
      // clients/<slug>/ as a side effect of saveState's mkdir — the exact
      // mechanism the comment above exists to prevent for an unlisted slug,
      // now deliberate because the org store itself vouches for this slug.
      // The normal sync()/pull() call further down (unchanged) then
      // populates it exactly as it would for an already-existing brand.
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

    // From here on this is a REAL attempt (every early-skip guard is
    // cleared): `finish()` below will record its outcome on the ledger and
    // in telemetry. `state` already carries the just-written last_autosync_at
    // and any identity rebind from above.
    pastGuards = true;
    ledgerState = state;

    // Fetch-level budget: one shared abort across every request the pull
    // makes (manifest + per-doc fetches). The per-request timeouts inside
    // the client (30s/120s) are far looser, so simply REPLACING the signal
    // keeps the strictest bound without needing AbortSignal.any.
    //
    // raceMs is the budget REMAINING after the seed path's manifest check
    // (if any) already spent part of it: 0 on the dir-exists path
    // (manifestElapsedMs stays 0 there, so this is exactly budgetMs,
    // unchanged) — see the module doc's budget note.
    const raceMs = Math.max(0, budgetMs - manifestElapsedMs);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), raceMs);
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
      // Publishing half: honored kill switch = the original pull-only mode.
      const publishFlag = (env[PUSH_AFTER_WRITE_ENV] ?? '').toLowerCase();
      const publishDisabled =
        publishFlag === 'off' || publishFlag === '0' || publishFlag === 'false';
      const op = publishDisabled ? pull : sync;
      const raced = await raceDeadline(
        op(brandSlug, {
          client,
          dataDirOverride: options.dataDirOverride,
          // NEVER force: diverged docs stay untouched by design.
        }),
        raceMs,
      );
      if (raced === DEADLINE) {
        controller.abort(); // cut the budgeted fetches; a refresh dies on its own timer
        debugLog(env, `autosync(${brandSlug}): budget of ${raceMs}ms exceeded`);
        return await finish({
          ran: false,
          reason: 'failed',
          detail: `timed out after ${raceMs}ms`,
        });
      }
      if (!raced.ok) {
        debugLog(env, `autosync(${brandSlug}): ${raced.message}`);
        return await finish({ ran: false, reason: 'failed', detail: raced.message });
      }
      const pulled = raced.reports.filter((r) => r.action === 'pulled').length;
      const pushed = raced.reports.filter((r) => r.action === 'pushed').length;
      const created = raced.reports.filter((r) => r.action === 'created').length;
      const conflicts = raced.reports.filter((r) => r.action === 'conflict').length;
      const errors = raced.reports.filter((r) => r.action === 'error').length;
      // Stake leg (zero-touch backfill): publish the brand's curated
      // structural_events even when nobody edits the brand. Cheap in the
      // steady state (the ledger hash skips with zero network) and bounded
      // by its own budget; a failure never demotes the doc result.
      let stakeLeg: StakeLegSummary | undefined;
      if (!publishDisabled) {
        stakeLeg = await runBudgetedStakeLeg(brandSlug, {
          ...(options.dataDirOverride !== undefined
            ? { dataDirOverride: options.dataDirOverride }
            : {}),
          ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
          env,
        });
      }
      return await finish({
        ran: true,
        pulled,
        pushed,
        created,
        conflicts,
        errors,
        reports: raced.reports,
        ...(stakeLeg !== undefined ? { stake_events: stakeLeg } : {}),
      });
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(env, `autosync(${brandSlug}): swallowed error: ${message}`);
    return await finish({ ran: false, reason: 'failed', detail: message });
  }
}

function debugLog(env: NodeJS.ProcessEnv, message: string): void {
  if (env.MIXSHIFT_DEBUG) process.stderr.write(`[debug] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Org-wide manifest cache (D-032 seed path + login-time org-brand-count line)
// ---------------------------------------------------------------------------

export interface OrgManifestOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to the real HTTP client (budgeted). */
  client?: ContextSyncClient;
  /** Injectable for tests; the real path wraps this with the budget signal. */
  fetchImpl?: typeof fetch;
  /** Clock injection for tests. */
  now?: () => Date;
  /** Cache freshness window. Defaults to AUTOSYNC_THROTTLE_MS — this is
   *  deliberately the SAME constant the per-brand ledger throttle uses (see
   *  the module doc), not an independent knob. */
  throttleMs?: number;
  /** Wall-clock budget for a COLD fetch only; ignored on a cache hit.
   *  Defaults to AUTOSYNC_BUDGET_MS. */
  budgetMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type OrgManifestResult =
  | { ok: true; brands: WireManifestBrand[]; fromCache: boolean }
  | { ok: false };

/**
 * Org-wide brand manifest, cached at <dataDir>/.context-sync-org-manifest.json
 * (see state.ts) with a TTL = AUTOSYNC_THROTTLE_MS by default. Shared by two
 * callers that both want "does/how much does the org store know" without
 * hammering GET /api/context/manifest on every call:
 *   - maybeAutoSync's seed path (a missing brand dir consults this to decide
 *     whether to seed);
 *   - commands/auth.ts's login-time org-brand-count line (a natural
 *     cache-warm moment).
 *
 * Quiet no-op contract, same shape as the rest of this module: a cache hit
 * never touches the network; a cold/expired cache does ONE budgeted
 * client.fetchManifest() call and, on success, persists the cache
 * best-effort before returning it. A failed or over-budget cold fetch
 * returns {ok:false} — NEVER throws, and never partially updates the cache.
 */
export async function getCachedOrgManifest(
  options: OrgManifestOptions = {},
): Promise<OrgManifestResult> {
  const now = options.now ? options.now() : new Date();
  const throttleMs = options.throttleMs ?? AUTOSYNC_THROTTLE_MS;
  try {
    const cached = await loadOrgManifestCache(options.dataDirOverride);
    if (cached) {
      const fetchedAt = Date.parse(cached.fetched_at);
      if (Number.isFinite(fetchedAt) && now.getTime() - fetchedAt < throttleMs) {
        return { ok: true, brands: cached.brands, fromCache: true };
      }
    }

    const budgetMs = options.budgetMs ?? AUTOSYNC_BUDGET_MS;
    if (budgetMs <= 0) return { ok: false };
    const controller = new AbortController();
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
      const raced = await raceDeadline(client.fetchManifest(), budgetMs);
      if (raced === DEADLINE || !raced.ok) return { ok: false };
      // Best-effort persist; a failed cache write just means the next
      // caller repeats this fetch — never fails the read we already have.
      await saveOrgManifestCache(
        { fetched_at: now.toISOString(), brands: raced.brands },
        options.dataDirOverride,
      );
      return { ok: true, brands: raced.brands, fromCache: false };
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (err) {
    if (options.env?.MIXSHIFT_DEBUG) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[debug] getCachedOrgManifest: swallowed error: ${message}\n`);
    }
    return { ok: false };
  }
}
