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
 *     skips with no per-brand stamp and no mkdir, so a typo'd or hostile
 *     slug can never create a phantom brand dir or touch anything outside
 *     clients/. NOT quite "no save" though (FIX F): consulting the manifest
 *     for a missing dir still costs one budgeted client.fetchManifest() call
 *     per TTL window (getCachedOrgManifest below) and persists ITS OWN
 *     org-wide cache file on a cold/expired cache, even for a slug that
 *     turns out unlisted — that cache write is shared across every brand's
 *     lookups, never a per-brand side effect, and still never touches
 *     clients/<slug>/. Likewise, a tenant-identity mismatch with tracked
 *     docs on disk skips entirely: rebinding the ledger stays an
 *     explicit-sync behavior, never a passive-read side effect.
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
 *
 * US4 honest-failure notice ("sandboxed sessions fail honest, not silent"):
 * this hook used to be silent on every failure by design (an implicit
 * preflight hook firing on every skill step must not be chatty) — but
 * silent-on-blocked and silent-on-nothing-to-sync were byte-identical to the
 * user, the exact gap US4 targets. Past this point (every early-skip guard
 * cleared) a network/offline-shaped failure — a budget death, or the
 * underlying fetch classified 'host_unreachable' (client.ts / classify.ts,
 * threaded through engine.ts's BrandActionResult.kind) — now ALSO checks the
 * org-wide manifest CACHE (a local disk read, never network) for an
 * identity-valid entry listing this brand. When both hold, maybeAutoSync
 * prints ONE deduped stderr notice (see maybeNoticeUnreachable below),
 * modeled on push-after-write.ts's own notice: "your team has context for
 * this brand, this session just couldn't reach it, your local copy (if any)
 * is unchanged, run `mixshift doctor` if it keeps happening." Every other
 * failure/skip shape stays exactly as silent as before — a credentials or
 * server-side failure is a different, already-surfaced problem, and a quiet
 * early-skip (throttled/disabled/unsafe/missing-dir-and-unlisted) never even
 * reaches the check. The manual `mixshift context autosync` command shares
 * this exact code path, so a manual run can surface the same notice too —
 * deliberately: the honesty this hook owes a silent preflight read applies
 * just as much to an operator who asked for the sync directly.
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
      /**
       * Present (true) only when THIS attempt is the one that created the
       * brand dir (the seed path — D-032); absent otherwise (FIX H).
       * Mirrors the same-named field already carried on the internal
       * preflight telemetry payload (see finish()), now also surfaced on
       * the result itself so a manual `mixshift context autosync` run (and
       * its --json output) can report it too.
       */
      seeded?: boolean;
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
  // Read by finish() below to add payload.seeded to the telemetry event,
  // and attached to the returned AutoSyncResult itself (FIX H).
  let seeded = false;
  // Wall-clock time actually spent on the seed path's manifest check, if
  // any (stays 0 when the dir already existed — see the budget note
  // below). Subtracted from the sync/pull race's window further down so a
  // seed attempt's manifest-check-plus-sync total stays bounded by one
  // AUTOSYNC_BUDGET_MS, not two back-to-back ones.
  let manifestElapsedMs = 0;
  // FIX C: the exact brands list the seed decision was made from, set ONLY
  // on the seed path (stays undefined on the dir-exists path). Threaded
  // into op()'s EngineOptions.manifest below so buildDocPairs (engine.ts)
  // reuses the SAME manifest that justified creating this dir instead of
  // fetching its own — see the op() call site for the full reasoning.
  let seedManifestBrands: WireManifestBrand[] | undefined;

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
        // FIX A: thread the SAME identity override this call already
        // supports for the ledger through to the org-manifest cache too, so
        // a test (or a future caller) that pins identity gets ONE consistent
        // answer from both. When undefined, getCachedOrgManifest falls back
        // to its own resolveLedgerIdentity() read — identical in effect,
        // just resolved once more (a cheap local file read, not a network
        // call).
        identity: options.identity,
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
      // FIX C: remember the exact brands list this decision was made from —
      // op() below reuses it instead of buildDocPairs fetching its own (see
      // that call site). Safe to assert `ok` here: `listed` above already
      // required `manifestResult.ok`.
      seedManifestBrands = manifestResult.ok ? manifestResult.brands : undefined;
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
          // FIX C: on the seed path, reuse the EXACT manifest that just
          // justified creating this dir (EngineOptions.manifest — see
          // engine.ts's buildDocPairs, which otherwise fetches its own).
          // Two reasons: (1) the manifest that justified the mkdir must be
          // the manifest that resolves the docs — letting buildDocPairs
          // fetch AGAIN risks it disagreeing with the seed decision (the
          // brand deleted/renamed server-side in the gap, or the pre-check
          // being a cache hit the fresh fetch wouldn't repeat) and finding
          // NOTHING to pull, leaving a permanently empty orphan dir reported
          // as a clean success. (2) a second live fetchManifest() call
          // inside the SAME budget the pre-check already spent part of is
          // exactly the double-spend that starves a seed attempt a plain
          // dir-exists sync never pays (see the module doc's budget note;
          // empirically, two ~900ms manifest round trips alone exceed the
          // 2s default budget). The reused manifest can itself be up to
          // AUTOSYNC_THROTTLE_MS stale (a cache hit) and is now
          // identity-bound (FIX A), so staleness is bounded and scoped to
          // the right tenant; per-doc CONTENT is always fetched LIVE by
          // pullOneDoc regardless of where the manifest list came from, so a
          // doc truly deleted server-side in the gap still surfaces as a
          // per-doc 'error' (a failed, re-triable attempt), never silently
          // resurrected or silently reported clean. The dir-exists path
          // (seedManifestBrands stays undefined there) is unaffected:
          // buildDocPairs fetches its own manifest exactly as before.
          ...(seedManifestBrands !== undefined ? { manifest: seedManifestBrands } : {}),
          // NEVER force: diverged docs stay untouched by design.
        }),
        raceMs,
      );
      if (raced === DEADLINE) {
        controller.abort(); // cut the budgeted fetches; a refresh dies on its own timer
        debugLog(env, `autosync(${brandSlug}): budget of ${raceMs}ms exceeded`);
        // A wall-clock budget death IS a network/offline shape by
        // construction (see maybeNoticeUnreachable's module doc) — no kind
        // to check, unlike the !raced.ok branch below.
        await maybeNoticeUnreachable(brandSlug, options, env);
        return await finish({
          ran: false,
          reason: 'failed',
          detail: `timed out after ${raceMs}ms`,
        });
      }
      if (!raced.ok) {
        debugLog(env, `autosync(${brandSlug}): ${raced.message}`);
        // US4: only a network/offline-shaped failure (engine.ts threads the
        // manifest fetch's classified `kind` through buildDocPairs) earns the
        // "could not reach the org store" notice — a credentials/scope/
        // server-side failure is a different, already-surfaced problem.
        if (raced.kind === 'host_unreachable') {
          await maybeNoticeUnreachable(brandSlug, options, env);
        }
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
        // FIX H: additive on the ran:true result itself (not just the
        // internal telemetry payload, which already carried this via the
        // closure `seeded` flag — see finish()'s payload construction
        // above) — so a MANUAL `mixshift context autosync` run can surface
        // the seed outcome too, not only the implicit preflight hook's own
        // telemetry row.
        ...(seeded ? { seeded: true } : {}),
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
  /**
   * Ledger-identity override for tests; defaults to resolveLedgerIdentity()
   * over the stored credentials, exactly like AutoSyncOptions.identity for
   * the per-brand ledger. Explicit null = "no identity available" (the
   * identity check degrades to TTL-only, same as when neither side has an
   * identity to compare — see the comparison helper below). FIX A: this is
   * what binds/verifies the persisted org-manifest cache to a tenant.
   */
  identity?: string | null;
  /** Kill-switch + VITEST-guard env source (FIX E); defaults to
   *  process.env. Passed explicitly by this module's own tests to opt back
   *  in, exactly like AutoSyncOptions.env. Also used for MIXSHIFT_DEBUG
   *  stderr lines. */
  env?: NodeJS.ProcessEnv;
}

export type OrgManifestResult =
  | { ok: true; brands: WireManifestBrand[]; fromCache: boolean }
  | { ok: false };

/**
 * Bound for the AWAITED cache-persist write inside getCachedOrgManifest
 * below (FIX B) — separate from budgetMs/AUTOSYNC_BUDGET_MS, which bound
 * only the NETWORK fetch. saveOrgManifestCache does local disk I/O only
 * (tmp write + rename), normally negligible, but a slow write/rename (AV
 * scanning the .tmp file, a network home directory) previously had no
 * bound of its own: it sat, unraced, inside the budgeted path, so its
 * elapsed time was silently charged to the caller's budget accounting
 * (autosync.ts's `manifestElapsedMs`) with nothing stopping it from running
 * long past what that accounting assumes. A small FIXED constant, not
 * "budget remaining": the fetch above already spent an unpredictable share
 * of `budgetMs`, and computing what's left only to hand it to a local disk
 * write would conflate two different failure modes (a slow network vs. a
 * slow filesystem) for no real benefit — the write itself is a few hundred
 * bytes to a file we already know how to create. Deliberately small: on
 * deadline we stop WAITING, not the write — the write usually still lands
 * because the process lives past this call; the cache is an optimization
 * (the next caller just repeats the fetch), never a correctness
 * requirement. Mirrors TELEMETRY_EMIT_BUDGET_MS in push-after-write.ts,
 * which carries the identical bound + reasoning for its own best-effort
 * local write.
 */
export const ORG_MANIFEST_PERSIST_BUDGET_MS = 500;

/**
 * Whether a cached org-manifest's recorded identity still matches the
 * current one (FIX A). Mirrors state.ts's per-brand ledger identity check
 * (see resolveLedgerIdentity), but STRICTER: the ledger tolerates a
 * schema-1 file with NO identity field at all (silently adopts the current
 * one) because a missing per-brand ledger only ever degrades ONE brand's
 * verdict to 'diverged' at worst. A shared, org-wide cache with no identity
 * binding is exactly the FIX A defect (a cache warmed under tenant A's
 * login silently served under tenant B) — so here, identity absent on
 * EITHER side while the OTHER side has one is ALSO treated as a mismatch,
 * not a free pass. Only true absence on BOTH sides (no credentials
 * resolvable right now, and the cache was never bound either — e.g. a
 * pre-FIX-A file, or offline with no prior identity) skips the check and
 * falls back to TTL-only gating, same as before identity binding existed.
 */
function cachedManifestIdentityMatches(
  cachedIdentity: string | undefined,
  currentIdentity: string | null | undefined,
): boolean {
  if (cachedIdentity === undefined) {
    return currentIdentity === undefined || currentIdentity === null;
  }
  return typeof currentIdentity === 'string' && currentIdentity === cachedIdentity;
}

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
 * best-effort (bounded — ORG_MANIFEST_PERSIST_BUDGET_MS, FIX B) before
 * returning it. A failed or over-budget cold fetch returns {ok:false} —
 * NEVER throws, and never partially updates the cache.
 *
 * OWN guards (FIX E): this is a SECOND entry point into the module — unlike
 * every other exported function here, it is called directly by auth.ts's
 * computeOrgAwareness, not only through maybeAutoSync — so it carries its
 * OWN copy of the kill switch (AUTOSYNC_ENV) and the VITEST test-isolation
 * guard, checked first, before any file or network activity, exactly like
 * maybeAutoSync's. BOTH callers (maybeAutoSync's seed path and
 * commands/auth.ts's computeOrgAwareness) inherit these for free; neither
 * needs its own copy.
 *
 * Identity-bound (FIX A): the persisted cache now records the resolving
 * identity (options.identity, defaulting to resolveLedgerIdentity()) the
 * same way the per-brand ledger does. A stored identity that does not
 * match the current one (or is present on only one side) is treated as a
 * cache MISS, never served — see cachedManifestIdentityMatches above.
 */
export async function getCachedOrgManifest(
  options: OrgManifestOptions = {},
): Promise<OrgManifestResult> {
  const env = options.env ?? process.env;
  const now = options.now ? options.now() : new Date();
  const throttleMs = options.throttleMs ?? AUTOSYNC_THROTTLE_MS;
  try {
    // FIX E: kill switch, checked before any file or network activity —
    // byte-for-byte the same check maybeAutoSync itself does.
    const flag = (env[AUTOSYNC_ENV] ?? '').toLowerCase();
    if (flag === 'off' || flag === '0' || flag === 'false') {
      return { ok: false };
    }
    // FIX E: same VITEST test-isolation guard as maybeAutoSync — this
    // function's own tests pass an explicit `env` to opt back in.
    if (options.env === undefined && process.env.VITEST) {
      debugLog(env, `getCachedOrgManifest: disabled under test runner (VITEST set)`);
      return { ok: false };
    }

    const identity =
      options.identity !== undefined
        ? options.identity
        : await resolveLedgerIdentity(options.dataDirOverride);

    const cached = await loadOrgManifestCache(options.dataDirOverride);
    if (cached && cachedManifestIdentityMatches(cached.identity, identity)) {
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
      // The WAIT is bounded too (ORG_MANIFEST_PERSIST_BUDGET_MS, FIX B, via
      // raceDeadline): on deadline we stop waiting, not the write — see
      // that constant's doc for why a small fixed bound beats computing
      // budget-remaining here.
      await raceDeadline(
        saveOrgManifestCache(
          {
            fetched_at: now.toISOString(),
            brands: raced.brands,
            ...(identity ? { identity } : {}),
          },
          options.dataDirOverride,
        ),
        ORG_MANIFEST_PERSIST_BUDGET_MS,
      );
      return { ok: true, brands: raced.brands, fromCache: false };
    } finally {
      clearTimeout(abortTimer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(env, `getCachedOrgManifest: swallowed error: ${message}`);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// User-facing notice: org has this brand, this attempt could not reach it
// (US4 — "sandboxed sessions fail honest, not silent")
// ---------------------------------------------------------------------------

/** Brands we have already shown the "could not reach the org store" notice
 *  for THIS process — the per-brand dedupe so a busy session (many skill
 *  steps hitting the same offline/blocked brand) prints one line, not one
 *  per step. A separate Set from push-after-write.ts's own noticedBrands:
 *  different module, different notice, and a brand can legitimately earn
 *  both in one process (a failed write notice AND a failed read notice). */
const noticedUnreachableBrands = new Set<string>();

/** Test-only: forget every emitted-notice memo so each case starts clean.
 *  Mirrors push-after-write.ts's __resetPushAfterWriteNotices. */
export function __resetAutosyncNotices(): void {
  noticedUnreachableBrands.clear();
}

/**
 * Emit the US4 honest-failure notice: this session tried to reach the org
 * store for a brand it has good reason to believe the org HAS context for,
 * and could not. Modeled precisely on push-after-write.ts's
 * noticeLineFor/emitNotice pattern — one deduped stderr line per brand per
 * process, on by default, plain sentences, no em dashes — but unlike that
 * write-side notice this is called from only TWO call sites (both already
 * past every early-skip guard and already classified network-shaped), so
 * the "should we say anything" decision lives at the call site and this
 * function's own job is just the manifest-cache check + the dedup + the
 * write.
 *
 * The manifest-CACHE check (loadOrgManifestCache) is a local disk read, never
 * a network call — this can never itself be the reason a read is slow, and it
 * runs only after the budgeted sync/pull race has already settled, so it
 * cannot meaningfully extend maybeAutoSync's wall-clock promise either. Never
 * throws: a broken cache read or a stderr write failure must never turn an
 * already-classified sync failure into a crash.
 *
 * Silent (no cache read even attempted) whenever:
 *   - this brand already got the notice this process (dedup);
 *   - the cache is missing, or was fetched under a DIFFERENT tenant identity
 *     than this attempt's (cachedManifestIdentityMatches) — a cache we can't
 *     trust for THIS session says nothing about what the org has;
 *   - the (identity-valid) cache does not list this brand.
 */
async function maybeNoticeUnreachable(
  brandSlug: string,
  options: AutoSyncOptions,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    if (noticedUnreachableBrands.has(brandSlug)) return;
    const identity =
      options.identity !== undefined
        ? options.identity
        : await resolveLedgerIdentity(options.dataDirOverride);
    const cached = await loadOrgManifestCache(options.dataDirOverride);
    if (!cached || !cachedManifestIdentityMatches(cached.identity, identity)) return;
    if (!cached.brands.some((b) => b.brand_slug === brandSlug)) return;
    noticedUnreachableBrands.add(brandSlug);
    process.stderr.write(unreachableNoticeLine(brandSlug));
  } catch (err) {
    // Never let the notice turn an already-classified sync failure into a
    // crash; the AutoSyncResult the caller returns already reflects the real
    // outcome regardless of whether this line got printed.
    const message = err instanceof Error ? err.message : String(err);
    debugLog(env, `maybeNoticeUnreachable(${brandSlug}): swallowed error: ${message}`);
  }
}

/** Copy rules: no em dashes, plain sentences (house style for customer-
 *  facing text). Substance: the org is known to have this brand's context;
 *  this session specifically could not reach it just now; the local copy
 *  (if the brand was ever synced here before) is untouched; where to look if
 *  it keeps happening. */
function unreachableNoticeLine(brandSlug: string): string {
  return (
    `Your team has context for ${brandSlug}, but this session could not reach the ` +
    `org store just now. Your local copy, if any, is unchanged. Run ` +
    '`mixshift doctor` if this keeps happening.\n'
  );
}
