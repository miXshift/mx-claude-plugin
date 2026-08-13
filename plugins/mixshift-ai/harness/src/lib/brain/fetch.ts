/**
 * Brand Brain fetch pipeline (P1 client transport).
 *
 * Resolves a brand slug to its seller ids (registry), runs the
 * BRAIN-SELLER catalog query through the dispatch registry (stored
 * procedure in production; MIXSHIFT_SPROC_SQL_DIR local SQL during
 * development), assembles the document (lib/brain/assemble.ts, pure),
 * and persists it via the accessor (lib/brain/read.ts).
 *
 * Progress is mirrored to `.brain-status.json` next to the brain file so
 * the chat surface can poll after a `brand key add` without blocking:
 * {status: fetching} → {status: complete, summary} | {status: failed}.
 *
 * Idempotency: a fresh brain (seller source fetched within the TTL) is a
 * no-op unless `refresh` is set. Re-fetches preserve accumulated S3
 * observations.
 */

import { writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runDispatched, MissingParamsError } from '../data/dispatch.js';
import { getQueryEntry } from '../prefetch/sql-library.js';
import { readIndex } from '../clients/index.js';
import type { IndexAccount } from '../clients/index-schema.js';
import { brainStatusPath, contextPath } from '../paths/resolve.js';
import { getPluginVersion } from '../plugin-version.js';
import { track, EventName } from '../telemetry/index.js';
import {
  assembleBrain,
  type RawSellerRow,
  type SourceInput,
} from './assemble.js';
import { loadBrain, saveBrain } from './read.js';
import type { BrandBrain } from './schema.js';
import type { BrandTermsBlock } from '../enrichment/brand-typos.js';
import { pushAfterWrite } from '../context-sync/push-after-write.js';
import { resolveBinding } from '../binding/resolve.js';
import {
  lensFor,
  summarizeLens,
  renderLensNotice,
  lensFilterWasSent,
  zeroRowConfidence,
  reconcileLensDecisions,
  type LensDecision,
  type LensSummary,
  type QueryLensOutcome,
} from '../binding/lens.js';
import type { BindingBlock } from '../context/schema.js';

/** Seller-source TTL: re-fetches inside this window are no-ops unless
 *  forced. */
export const BRAIN_TTL_DAYS = 30;

const BRAIN_SELLER_QUERY_ID = 'BRAIN-SELLER';
const BRAIN_CATALOG_SC_QUERY_ID = 'BRAIN-CATALOG-SC';
const BRAIN_CATALOG_VC_QUERY_ID = 'BRAIN-CATALOG-VC';
const BRAIN_CAMPAIGN_QUERY_ID = 'BRAIN-CAMPAIGN';
const BRAIN_HERO_SC_QUERY_ID = 'BRAIN-HERO-SC';
const BRAIN_HERO_VC_QUERY_ID = 'BRAIN-HERO-VC';
/** Recent-activity baseline: trailing-30d ad spend/sales rolled up across
 *  ALL the brand's sellers, cached at fetch time so skills need not
 *  re-pull it. A dedicated brand-scoped entry, NOT DHC-01-on-primary —
 *  that returned nulls for VC-primary brands whose ad activity sits on a
 *  different seat. */
const BRAIN_RECENT_ACTIVITY_QUERY_ID = 'BRAIN-RECENT-ACTIVITY';
/** Per-seat USD-normalized retail revenue + ad spend (trailing window),
 *  one row per seat. Ranked by (usd_revenue + usd_spend) DESC to pick the
 *  brand's PRIMARY seat by economic activity — the real signal the
 *  registry heuristic (pickPrimarySeat) only approximated. Best-effort:
 *  when the named query isn't registered server-side (or returns nothing),
 *  selection falls back to the heuristic. */
const BRAIN_SEAT_METRICS_QUERY_ID = 'BRAIN-SEAT-METRICS';

// Phase 8 enrichment sources reuse the ALREADY-DEPLOYED CS-* named queries
// (dispatch:named, server pack + local .sql dev-fallback) rather than new
// BRAIN-* ids — no new SQL and no cross-repo prod gap (the deep mx-brand-context
// skill already runs these in prod via prefetch). Their outputs feed the pure
// enrichment computers (lib/enrichment/*) inside assembleBrain. Native binds:
// CS-06/07/08 take a single :seller_id; CS-28/29/30/31 take :seller_id_list.
const CS_CAPTURE_RATE_SC_QUERY_ID = 'CS-06';
const CS_CAPTURE_RATE_VC_QUERY_ID = 'CS-07';
const CS_CAPTURE_RATE_DAILY_QUERY_ID = 'CS-08';
const CS_SETTLEMENT_QUERY_ID = 'CS-28';
const CS_STOCKOUT_QUERY_ID = 'CS-29';
const CS_STOCKOUT_IMPACT_QUERY_ID = 'CS-30';
const CS_TYPO_CORPUS_QUERY_ID = 'CS-31';

export interface BrainFetchOptions {
  slug: string;
  /** Bypass the TTL gate (CLI --refresh / `brand brain refresh`). */
  refresh?: boolean;
  dataDirOverride?: string;
  /** Injected for tests; defaults to now. */
  now?: Date;
}

export type BrainFetchResult =
  | {
      status: 'complete';
      path: string;
      summary: BrainFetchSummary;
    }
  | { status: 'skipped_fresh'; fetched_at: string; ttl_days: number }
  | { status: 'brand_not_found'; slug: string }
  | { status: 'no_accounts'; slug: string }
  | { status: 'failed'; error: string; kind?: string };

export interface BrainFetchSummary {
  row_count: number;
  acos_target_pct: number | null;
  merchant_alias: string | null;
  used_dispatch: string;
  duration_ms: number;
  /** Distinct ASINs when a catalog source ran; null otherwise. */
  asin_count: number | null;
  /** Campaign rows when the campaign source ran; null otherwise. */
  campaign_count: number | null;
  /** Total hero ASINs cached (SC + VC); null when no hero source ran. */
  hero_asin_count: number | null;
  /** True when the recent-activity baseline (DHC-01) cached ok. */
  has_recent_activity: boolean;
  /** True when the capture-rate calibration section (CS-06/07/08 + CS-28)
   *  produced usable signal. */
  has_capture_rate: boolean;
  /** Detected stockout windows (CS-29) when the source ran; null otherwise. */
  stockout_count: number | null;
  /** Detected brand-term typo clusters (CS-31) when brand_terms existed and the
   *  source ran; null otherwise (e.g. a pre-cold-start brand). */
  brand_typo_count: number | null;
  /** Non-fatal source failures (seller failing is fatal and surfaces as
   *  status 'failed' instead). Names: catalog_sc | catalog_vc | campaign |
   *  hero_sc | hero_vc | recent_activity | capture_rate | stockout |
   *  brand_typos. */
  failed_sources: string[];
  /** Sub-brand label-lens record; null for an unbound brand (no lens).
   *  See lib/binding/lens.ts. */
  label_lens: LensSummary | null;
  /** Loud, human-readable lens warnings: the §11 never-silently-account-wide
   *  mechanism (account-wide sources named; a lens that matched ZERO catalog
   *  rows; label sides missing from the binding). Empty for unbound brands. */
  lens_warnings: string[];
}

/**
 * Shape of `.brain-status.json`. The chat surface treats any file with
 * status 'fetching' older than ~5 minutes as abandoned (a crashed
 * background process) and suggests a manual retry.
 */
export interface BrainStatusFile {
  status: 'fetching' | 'complete' | 'failed';
  slug: string;
  started_at: string;
  finished_at?: string;
  summary?: BrainFetchSummary;
  error?: string;
}

/**
 * Choose the brand's PRIMARY seat from its registry accounts — the seat whose
 * seller row supplies the brain's seller scalars (acos_target, monthly_budget,
 * merchant_alias, marketplace, activation). A brand has many seats (one per
 * marketplace × platform: Seller Central vs Vendor Central); picking the wrong
 * one corrupts every seller scalar (e.g. rendering a brand's near-dormant VC
 * seat instead of the US SC seat carrying its actual monthly volume).
 *
 * FALLBACK HEURISTIC, tuned for MixShift's predominantly-US-3P brand base:
 * prefer the active US Seller-Central seat. The truest signal — per-seat
 * economic activity — now lives in pickPrimarySeatByMetrics (ranks seats by
 * USD-normalized revenue + spend from BRAIN-SEAT-METRICS), which supersedes
 * this when it has data. This function is what decides the primary seat only
 * when that metrics query returns no usable signal (not registered
 * server-side, failed, or no recent revenue/spend). It is intentionally
 * registry-only and biased (SC isn't always primary; US isn't always home) —
 * see the 1P-heavy fleet in brain.test.ts, whose US-VC seat dwarfs its dormant
 * US-SC seat: there the metrics pick is right and this heuristic is the safety net.
 *
 * Ranking:
 *   1. Restrict to `ads_active` seats; if none, fall back to `is_active`; if
 *      still none, consider all accounts.
 *   2. Sort the candidates by, in order:
 *        a. account_type rank — SC(0) < VC(1) < DSP(2) < unknown(3)
 *        b. marketplace rank  — 'United States'(0) < everything else(1)
 *        c. seller_id ascending (stable tiebreak)
 *   3. Return candidates[0].seller_id.
 *
 * Returns null when the brand has no accounts.
 */
export function pickPrimarySeat(accounts: IndexAccount[]): number | null {
  if (accounts.length === 0) return null;

  const candidates =
    accounts.filter((a) => a.ads_active).length > 0
      ? accounts.filter((a) => a.ads_active)
      : accounts.filter((a) => a.is_active).length > 0
        ? accounts.filter((a) => a.is_active)
        : accounts;

  const accountTypeRank: Record<IndexAccount['account_type'], number> = {
    SC: 0,
    VC: 1,
    DSP: 2,
    unknown: 3,
  };
  const marketplaceRank = (m: string | null): number =>
    m === 'United States' ? 0 : 1;

  const sorted = [...candidates].sort((a, b) => {
    const byType = accountTypeRank[a.account_type] - accountTypeRank[b.account_type];
    if (byType !== 0) return byType;
    const byMarket = marketplaceRank(a.marketplace) - marketplaceRank(b.marketplace);
    if (byMarket !== 0) return byMarket;
    return a.seller_id - b.seller_id;
  });

  return sorted[0]!.seller_id;
}

/** One BRAIN-SEAT-METRICS row: a seat's trailing-window USD-normalized
 *  retail revenue + ad spend. Values arrive untyped from the wire. */
export type SeatMetricRow = Record<string, unknown>;

/**
 * Choose the brand's PRIMARY seat by ECONOMIC ACTIVITY — the real signal
 * the registry heuristic (pickPrimarySeat) only approximated. Ranks the
 * brand's seats by per-seat USD-normalized (retail revenue + ad spend),
 * high→low, from the BRAIN-SEAT-METRICS rows, and returns the top seat's
 * seller_id.
 *
 * This is the PREFERRED selector; pickPrimarySeat is the documented
 * fallback for when the named query isn't registered server-side or
 * returns nothing.
 *
 * Returns null — so the caller falls back to the heuristic — when:
 *   - no metric rows were returned, OR
 *   - no row carries a seller_id that matches one of the brand's accounts
 *     (defensive: only registry-known seats are eligible), OR
 *   - every eligible seat scores zero (a brand with no recent economic
 *     activity carries no economic signal; the SC/US heuristic is the
 *     better tiebreak there than an arbitrary zero-row pick).
 *
 * Ties (equal revenue+spend) break deterministically by ascending
 * seller_id, matching pickPrimarySeat's stable tiebreak.
 */
export function pickPrimarySeatByMetrics(
  metricRows: SeatMetricRow[],
  accounts: IndexAccount[],
): number | null {
  if (metricRows.length === 0 || accounts.length === 0) return null;
  const known = new Set(accounts.map((a) => a.seller_id));

  let best: { sellerId: number; score: number } | null = null;
  for (const row of metricRows) {
    const sellerId = toFiniteNumber(row.seller_id);
    if (sellerId === null || !known.has(sellerId)) continue;
    const score =
      (toFiniteNumber(row.usd_revenue) ?? 0) + (toFiniteNumber(row.usd_spend) ?? 0);
    if (
      best === null ||
      score > best.score ||
      (score === best.score && sellerId < best.sellerId)
    ) {
      best = { sellerId, score };
    }
  }

  // No eligible row, or the leader has no economic activity → no signal.
  if (best === null || best.score <= 0) return null;
  return best.sellerId;
}

/** Coerce a wire value (number | numeric string | null) to a finite
 *  number, or null. Local to selection; assembly has its own copy. */
function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `resolveBinding` fixed its OWN never-throws contract (mx-legacy-auth-
 * subbrand finding F4), but this call site gets its own guard too: a
 * binding-resolution failure must never break the automatic brain-populate
 * pipeline for ANY brand. Failure is treated as unbound (the conservative
 * choice — an unbound brand's fetch is the well-tested, unchanged path) plus
 * a loud console warning, never a crash.
 */
async function safeResolveBinding(
  slug: string,
  dataDirOverride: string | undefined,
): Promise<BindingBlock | null> {
  try {
    return await resolveBinding(slug, dataDirOverride);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[brain] could not resolve ${slug}'s sub-brand binding (${message}); ` +
        'treating as unbound for this fetch rather than failing the run.',
    );
    return null;
  }
}

/** Assemble the loud lens warnings for a fetch summary (design §11: never
 *  silently account-wide; never silently empty-under-lens). */
function buildLensWarnings(args: {
  slug: string;
  lensSummary: LensSummary | null;
  lensDecisions: readonly LensDecision[];
  catalogAsinCount: number | null;
  campaignCount: number | null;
}): string[] {
  const { slug, lensSummary, lensDecisions, catalogAsinCount, campaignCount } = args;
  if (!lensSummary) return [];
  const warnings: string[] = [];
  const notice = renderLensNotice(lensSummary, slug);
  if (notice) warnings.push(notice);

  // Zero-row (label-typo) detection fires whenever a filter was SENT, not
  // only when the gateway confirmed it — see lensFilterWasSent. Gating on
  // 'applied' alone made this detector dark on every deploy that predates
  // the applied_params echo, which is precisely when a mistyped label
  // silently yields an empty sub-brand.
  const catalogSent = lensDecisions.find(
    (d) =>
      lensFilterWasSent(d.outcome) &&
      (d.query_id === 'BRAIN-CATALOG-SC' || d.query_id === 'BRAIN-CATALOG-VC'),
  );
  if (catalogSent && (catalogAsinCount ?? 0) === 0) {
    warnings.push(
      `The retail label filter matched ZERO catalog rows for "${slug}". ` +
        `${zeroRowConfidence(catalogSent.outcome)} the binding's retail label value may not ` +
        'match the warehouse verbatim (labels are matched exactly, never fuzzily). Verify it ' +
        'against `mixshift brand discover` before trusting any retail numbers for this sub-brand.',
    );
  }
  const campaignSent = lensDecisions.find(
    (d) => lensFilterWasSent(d.outcome) && d.query_id === 'BRAIN-CAMPAIGN',
  );
  if (campaignSent && (campaignCount ?? 0) === 0) {
    warnings.push(
      `The ads label filter matched ZERO campaigns for "${slug}". ` +
        `${zeroRowConfidence(campaignSent.outcome)} either this sub-brand truly has no labeled ` +
        "campaigns, or the binding's ads label value does not match `campaign.Brand` verbatim. " +
        'The coverage report distinguishes the two.',
    );
  }
  return warnings;
}

export async function fetchBrandBrain(
  opts: BrainFetchOptions,
): Promise<BrainFetchResult> {
  const now = opts.now ?? new Date();
  const t0 = Date.now();
  const { slug, dataDirOverride } = opts;

  // 1. Resolve the brand to its seller scope via the registry.
  const { index } = await readIndex(dataDirOverride);
  const brand = index.brands.find((b) => b.slug === slug);
  if (!brand) {
    return { status: 'brand_not_found', slug };
  }
  const sellerIds = brand.accounts.map((a) => a.seller_id);
  if (sellerIds.length === 0) {
    return { status: 'no_accounts', slug };
  }

  // Registry heuristic for the primary seat (SC>VC, US-first). Kept as the
  // FALLBACK: it's used only when the per-seat economic ranking
  // (BRAIN-SEAT-METRICS, below) returns no usable signal — e.g. the named
  // query isn't registered server-side yet, or the brand has no recent
  // revenue/spend. The metrics pick, when present, supersedes it.
  const heuristicSeatId = pickPrimarySeat(brand.accounts);

  // 2. TTL gate. A fresh seller source is a no-op unless forced.
  const existing = await loadBrain(slug, dataDirOverride);
  const previousObservations = existing.ok
    ? existing.brain.observations
    : undefined;
  if (!opts.refresh && existing.ok) {
    const fetchedAt = existing.brain.sources.seller?.fetched_at;
    if (fetchedAt && withinTtl(fetchedAt, now)) {
      void track(
        {
          event_name: EventName.BrainFetchSkipped,
          payload: { brand: slug, fetched_at: fetchedAt, ttl_days: BRAIN_TTL_DAYS },
        },
        dataDirOverride,
      );
      return {
        status: 'skipped_fresh',
        fetched_at: fetchedAt,
        ttl_days: BRAIN_TTL_DAYS,
      };
    }
  }

  // Sub-brand label lens (design §2.1/§11): a bound brand's catalog and
  // campaign sources run label-scoped; everything else in this fetch is
  // structurally account-wide and gets RECORDED as such rather than silently
  // read as the sub-brand's. Unbound brands send nothing (unchanged).
  //
  // Resolved AFTER the freshness gate (F4): a skipped-fresh fetch returns
  // above without ever touching context.yaml for this. Guarded here too
  // (belt-and-suspenders on top of resolve.ts's own try/catch, F4): a
  // binding-resolution failure must never take down the automatic
  // brain-populate pipeline for ANY brand, bound or not.
  const binding = await safeResolveBinding(slug, dataDirOverride);
  const lensDecisions: LensDecision[] = [];
  const withLens = (
    queryId: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> => {
    const lens = lensFor(queryId, binding);
    if (!lens) return params;
    lensDecisions.push(lens.decision);
    return Object.keys(lens.params).length > 0 ? { ...params, ...lens.params } : params;
  };

  // 3. Fetch + assemble + persist, mirroring progress to the status file.
  await writeBrainStatus(
    { status: 'fetching', slug, started_at: now.toISOString() },
    dataDirOverride,
  );
  await track(
    {
      event_name: EventName.BrainFetchStarted,
      payload: {
        brand: slug,
        account_count: sellerIds.length,
        refresh: !!opts.refresh,
      },
    },
    dataDirOverride,
  );

  // Source scoping by account type:
  // seller covers every seat; catalog splits SC vs VC; campaign covers
  // all seats (SC, VC, DSP all carry campaign rows; 'unknown' is
  // included so registries discovered before the DSP mapping landed
  // degrade gracefully).
  const scIds = brand.accounts
    .filter((a) => a.account_type === 'SC')
    .map((a) => a.seller_id);
  const vcIds = brand.accounts
    .filter((a) => a.account_type === 'VC')
    .map((a) => a.seller_id);
  // Phase 8 capture-rate seat scoping. CS-06/07/08 bind a SINGLE :seller_id
  // (per-account attribution math), so pick a representative seat per channel:
  // the heuristic primary when it's that channel, else the channel's first seat.
  // (The metric-ranked primary isn't known until after the fetch below; the
  // heuristic seat is a fine representative for attribution calibration.)
  const pickChannelSeat = (ids: number[]): number | null =>
    heuristicSeatId != null && ids.includes(heuristicSeatId)
      ? heuristicSeatId
      : (ids[0] ?? null);
  const scPrimary = pickChannelSeat(scIds);
  const vcPrimary = pickChannelSeat(vcIds);
  // Tier-3 brand_terms (+ competitor_brands) for the typo detector. Best-effort
  // read of context.yaml — the brain's only Tier-3 touch, kept in the I/O layer
  // so assembleBrain stays pure. Absent for a brand-new brand → typo section
  // no-ops. (A future server-side brain has no context.yaml; the typo section
  // there populates only on a client-side refresh.)
  const brandTermsInput = await readBrandTermsInput(slug, dataDirOverride);

  type SourceOutcome =
    | {
        ok: true;
        rows: RawSellerRow[];
        usedDispatch: string;
        /** dispatch:named only, on success: sorted param names the gateway
         *  actually bound (mx-legacy-auth PR #107) — the label lens's
         *  reconciliation evidence. Undefined for other dispatch paths or
         *  an older gateway deploy. */
        appliedParams?: string[];
      }
    | { ok: false; error: string; kind?: string };

  const runSource = async (
    queryId: string,
    params: Record<string, unknown>,
  ): Promise<SourceOutcome> => {
    try {
      const result = await runDispatched<RawSellerRow>(queryId, {
        // Caller supplies the query's native bind params. BRAIN-* sources pass
        // { seller_ids } (routed to the request's top-level seller scope); the
        // reused CS-* enrichment queries pass their own binds ({ seller_id } or
        // { seller_id_list }), exactly as the prefetch runner does — so the
        // already-deployed server-side query pack resolves them unchanged.
        params,
        dataDirOverride,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: result.failure.friendly,
          kind: result.failure.kind,
        };
      }
      return {
        ok: true,
        rows: result.rows,
        usedDispatch: result.usedDispatch,
        appliedParams: result.appliedParams,
      };
    } catch (err) {
      const message =
        err instanceof MissingParamsError
          ? `${err.message} (local dev fallback SQL is missing a bind param)`
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, error: message };
    }
  };

  const [
    sellerOut,
    scOut,
    vcOut,
    campaignOut,
    heroScOut,
    heroVcOut,
    recentOut,
    seatMetricsOut,
    settlementOut,
    captureScOut,
    captureVcOut,
    captureDailyOut,
    stockoutOut,
    stockoutImpactOut,
    typoOut,
  ] = await Promise.all([
    runSource(BRAIN_SELLER_QUERY_ID, withLens(BRAIN_SELLER_QUERY_ID, { seller_ids: sellerIds })),
    scIds.length > 0
      ? runSource(BRAIN_CATALOG_SC_QUERY_ID, withLens(BRAIN_CATALOG_SC_QUERY_ID, { seller_ids: scIds }))
      : Promise.resolve(null),
    vcIds.length > 0
      ? runSource(BRAIN_CATALOG_VC_QUERY_ID, withLens(BRAIN_CATALOG_VC_QUERY_ID, { seller_ids: vcIds }))
      : Promise.resolve(null),
    runSource(BRAIN_CAMPAIGN_QUERY_ID, withLens(BRAIN_CAMPAIGN_QUERY_ID, { seller_ids: sellerIds })),
    scIds.length > 0
      ? runSource(BRAIN_HERO_SC_QUERY_ID, withLens(BRAIN_HERO_SC_QUERY_ID, { seller_ids: scIds }))
      : Promise.resolve(null),
    vcIds.length > 0
      ? runSource(BRAIN_HERO_VC_QUERY_ID, withLens(BRAIN_HERO_VC_QUERY_ID, { seller_ids: vcIds }))
      : Promise.resolve(null),
    // Brand-level: every seller's ad rows roll into one baseline.
    runSource(BRAIN_RECENT_ACTIVITY_QUERY_ID, withLens(BRAIN_RECENT_ACTIVITY_QUERY_ID, { seller_ids: sellerIds })),
    // Brand-level: per-seat revenue+spend for primary-seat selection.
    // Best-effort and SELECTION-ONLY — not folded into a brain section,
    // so a failure isn't even a "failed source"; it just means the
    // heuristic decides the primary seat.
    runSource(BRAIN_SEAT_METRICS_QUERY_ID, withLens(BRAIN_SEAT_METRICS_QUERY_ID, { seller_ids: sellerIds })),
    // Phase 8 enrichment (reused CS-* named queries, native binds). All
    // best-effort: a failure just omits that section. Settlement (CS-28) spans
    // all seats; capture-rate scalars (CS-06/07/08) use a representative per-
    // channel seat; stockout (CS-29) + CS-30 are SC-FBA-scoped (CS-30's
    // rows are currently unused by assembly since the stockout
    // impacted-revenue field was removed; the fetch stays pending a
    // rigorous lost-sales replacement); the typo corpus (CS-31) spans
    // all seats.
    runSource(CS_SETTLEMENT_QUERY_ID, withLens(CS_SETTLEMENT_QUERY_ID, { seller_id_list: sellerIds })),
    scPrimary != null
      ? runSource(CS_CAPTURE_RATE_SC_QUERY_ID, withLens(CS_CAPTURE_RATE_SC_QUERY_ID, { seller_id: scPrimary }))
      : Promise.resolve(null),
    vcPrimary != null
      ? runSource(CS_CAPTURE_RATE_VC_QUERY_ID, withLens(CS_CAPTURE_RATE_VC_QUERY_ID, { seller_id: vcPrimary }))
      : Promise.resolve(null),
    scPrimary != null
      ? runSource(CS_CAPTURE_RATE_DAILY_QUERY_ID, withLens(CS_CAPTURE_RATE_DAILY_QUERY_ID, { seller_id: scPrimary }))
      : Promise.resolve(null),
    scIds.length > 0
      ? runSource(CS_STOCKOUT_QUERY_ID, withLens(CS_STOCKOUT_QUERY_ID, { seller_id_list: scIds }))
      : Promise.resolve(null),
    scIds.length > 0
      ? runSource(CS_STOCKOUT_IMPACT_QUERY_ID, withLens(CS_STOCKOUT_IMPACT_QUERY_ID, { seller_id_list: scIds }))
      : Promise.resolve(null),
    runSource(CS_TYPO_CORPUS_QUERY_ID, withLens(CS_TYPO_CORPUS_QUERY_ID, { seller_id_list: sellerIds })),
  ]);

  // Primary seat: prefer the per-seat economic ranking; fall back to the
  // registry heuristic when the metrics query gave no usable signal (not
  // registered server-side, failed, or no recent revenue/spend).
  const metricSeatId = seatMetricsOut.ok
    ? pickPrimarySeatByMetrics(seatMetricsOut.rows, brand.accounts)
    : null;
  const primarySeatId = metricSeatId ?? heuristicSeatId;

  // Seller is the spine: identity failure is fatal. Catalog/campaign/hero/
  // activity failures are partial — the brain is still written with
  // whatever succeeded, and the failures are reported, not swallowed.
  if (!sellerOut.ok) {
    return await failFetch(opts, now, sellerOut.error, sellerOut.kind);
  }
  const failedSources: string[] = [];
  if (scOut && !scOut.ok) failedSources.push('catalog_sc');
  if (vcOut && !vcOut.ok) failedSources.push('catalog_vc');
  if (campaignOut && !campaignOut.ok) failedSources.push('campaign');
  if (heroScOut && !heroScOut.ok) failedSources.push('hero_sc');
  if (heroVcOut && !heroVcOut.ok) failedSources.push('hero_vc');
  if (!recentOut.ok) failedSources.push('recent_activity');
  // Phase 8 enrichment (non-fatal; a failure omits the section). Report the
  // canonical source per family: settlement (CS-28) drives capture_rate, CS-29
  // drives stockout, CS-31 drives brand_typos.
  if (settlementOut && !settlementOut.ok) failedSources.push('capture_rate');
  if (stockoutOut && !stockoutOut.ok) failedSources.push('stockout');
  if (typoOut && !typoOut.ok) failedSources.push('brand_typos');

  // Reconcile the label lens's placeholder decisions from EVIDENCE, now that
  // every source has settled (the central fix: a decision is resolved after
  // the query returns, never before — see lib/binding/lens.ts). Only the
  // three label-aware sources this fetch actually calls need an outcome
  // entry; the rest of `lensDecisions` are already-final structural
  // decisions (account_wide / missing_label_value) that reconciliation
  // leaves untouched.
  const toLensOutcome = (out: SourceOutcome | null): QueryLensOutcome =>
    out === null ? { status: 'failed' } : out.ok ? { status: 'ok', appliedParams: out.appliedParams } : { status: 'failed' };
  const lensOutcomeByQueryId = new Map<string, QueryLensOutcome>([
    [BRAIN_CATALOG_SC_QUERY_ID, toLensOutcome(scOut)],
    [BRAIN_CATALOG_VC_QUERY_ID, toLensOutcome(vcOut)],
    [BRAIN_CAMPAIGN_QUERY_ID, toLensOutcome(campaignOut)],
  ]);
  const reconciledLensDecisions = reconcileLensDecisions(lensDecisions, lensOutcomeByQueryId);

  const sourceInput = async (
    queryId: string,
    out: SourceOutcome | null,
  ): Promise<SourceInput<RawSellerRow> | undefined> => {
    if (!out || !out.ok) return undefined;
    const entry = await getQueryEntry(queryId);
    return { rows: out.rows, sproc: entry.sproc ?? queryId };
  };

  // Assemble + persist + auto-publish. saveBrain creates its own parent
  // client dir (clients/<slug>/) before the atomic temp-write+rename, so a
  // brand keyed but never set up on disk writes cleanly. This whole tail is
  // guarded: any unexpected failure here (a rename racing a removed dir, a
  // permission/space error, an assembly throw) is turned into a clean handled
  // `failed` result via failFetch — it must NEVER escape as an unhandled
  // exception that crashes the process (event plugin.crashed). Atomic-write
  // semantics inside saveBrain are unchanged.
  try {
    const sellerEntry = await getQueryEntry(BRAIN_SELLER_QUERY_ID);
    const brain: BrandBrain = assembleBrain({
      brandSlug: slug,
      sellerRows: sellerOut.rows,
      sellerSproc: sellerEntry.sproc ?? BRAIN_SELLER_QUERY_ID,
      primarySellerId: primarySeatId,
      generator: `plugin@${getPluginVersion()}`,
      now,
      previousObservations,
      catalogSc: await sourceInput(BRAIN_CATALOG_SC_QUERY_ID, scOut),
      catalogVc: await sourceInput(BRAIN_CATALOG_VC_QUERY_ID, vcOut),
      campaign: await sourceInput(BRAIN_CAMPAIGN_QUERY_ID, campaignOut),
      heroSc: await sourceInput(BRAIN_HERO_SC_QUERY_ID, heroScOut),
      heroVc: await sourceInput(BRAIN_HERO_VC_QUERY_ID, heroVcOut),
      recentActivity: await sourceInput(BRAIN_RECENT_ACTIVITY_QUERY_ID, recentOut),
      // Phase 8 enrichment sources. sourceInput's SourceInput<RawSellerRow> is
      // assignable to the typed SourceInput<CSxxRow> params (the computer row
      // types are all-optional/unknown), so the existing helper is reused.
      settlement: await sourceInput(CS_SETTLEMENT_QUERY_ID, settlementOut),
      captureRateSc: await sourceInput(CS_CAPTURE_RATE_SC_QUERY_ID, captureScOut),
      captureRateVc: await sourceInput(CS_CAPTURE_RATE_VC_QUERY_ID, captureVcOut),
      captureRateDaily: await sourceInput(
        CS_CAPTURE_RATE_DAILY_QUERY_ID,
        captureDailyOut,
      ),
      stockout: await sourceInput(CS_STOCKOUT_QUERY_ID, stockoutOut),
      stockoutImpact: await sourceInput(
        CS_STOCKOUT_IMPACT_QUERY_ID,
        stockoutImpactOut,
      ),
      brandTypos: await sourceInput(CS_TYPO_CORPUS_QUERY_ID, typoOut),
      brandTermsInput,
    });
    // Stamp the lens record INTO the brain document (additive optional field;
    // old readers strip it on read, writers preserve unknown keys — the same
    // forward-tolerance contract as every other schema addition this epic
    // made). The brain is where sub_brands pre-fill and downstream sections
    // get read from, so the scoping record has to travel WITH the data.
    const lensSummary = binding ? summarizeLens(reconciledLensDecisions) : null;
    if (lensSummary) {
      brain.label_lens = lensSummary;
    }
    const { path } = await saveBrain(brain, dataDirOverride);

    // Auto-publish the freshly-saved brain to the org store, detached from the
    // fetch's return summary (best-effort, bounded, non-throwing — the local
    // saveBrain above is the durable result).
    await pushAfterWrite(slug, { dataDirOverride });

    const summary: BrainFetchSummary = {
      row_count: sellerOut.rows.length,
      acos_target_pct: brain.seller?.acos_target_pct ?? null,
      merchant_alias: brain.seller?.merchant_alias ?? null,
      used_dispatch: sellerOut.usedDispatch,
      duration_ms: Date.now() - t0,
      asin_count: brain.catalog?.asin_count ?? null,
      campaign_count: brain.campaign_structure?.campaign_count ?? null,
      hero_asin_count: brain.catalog?.top_asins
        ? (brain.catalog.top_asins.sc?.length ?? 0) +
          (brain.catalog.top_asins.vc?.length ?? 0)
        : null,
      has_recent_activity: brain.recent_activity !== undefined,
      has_capture_rate: brain.capture_rate_calibration !== undefined,
      stockout_count: brain.stockouts?.length ?? null,
      brand_typo_count: brain.brand_term_typos?.length ?? null,
      failed_sources: failedSources,
      label_lens: lensSummary,
      lens_warnings: buildLensWarnings({
        slug,
        lensSummary,
        lensDecisions: reconciledLensDecisions,
        catalogAsinCount: brain.catalog?.asin_count ?? null,
        campaignCount: brain.campaign_structure?.campaign_count ?? null,
      }),
    };
    await writeBrainStatus(
      {
        status: 'complete',
        slug,
        started_at: now.toISOString(),
        finished_at: new Date().toISOString(),
        summary,
      },
      dataDirOverride,
    );
    await track(
      {
        event_name: EventName.BrainFetchCompleted,
        outcome: 'ok',
        duration_ms: summary.duration_ms,
        row_count: summary.row_count,
        payload: {
          brand: slug,
          used_dispatch: summary.used_dispatch,
          has_acos_target: summary.acos_target_pct !== null,
          asin_count: summary.asin_count,
          campaign_count: summary.campaign_count,
          hero_asin_count: summary.hero_asin_count,
          has_recent_activity: summary.has_recent_activity,
          failed_sources: failedSources,
          // Which selector chose the primary seat: 'metrics' (per-seat
          // revenue+spend ranking) or 'heuristic' (registry fallback).
          primary_seat_source: metricSeatId !== null ? 'metrics' : 'heuristic',
          primary_seat_id: primarySeatId,
        },
      },
      dataDirOverride,
    );

    return { status: 'complete', path, summary };
  } catch (err) {
    // Persist/assemble failed unexpectedly. Surface it as a clean handled
    // failure (status file + BrainFetchFailed telemetry) instead of letting
    // the exception crash the CLI. Carry the OS error code as the kind when we
    // have one (e.g. ENOENT, EACCES) so telemetry can bucket write failures.
    const message = err instanceof Error ? err.message : String(err);
    const kind =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'brain_persist_failed';
    return await failFetch(opts, now, message, kind);
  }
}

async function failFetch(
  opts: BrainFetchOptions,
  startedAt: Date,
  error: string,
  kind?: string,
): Promise<BrainFetchResult> {
  // The failure handler MUST NOT itself throw. writeBrainStatus writes into the
  // SAME client dir that just failed, so under ENOSPC/EACCES (disk full /
  // permission) the status write can throw again — and that throw would escape
  // fetchBrandBrain's catch and still fire plugin.crashed, defeating the fix.
  // Swallow a status-write failure (best-effort log) and still return a clean
  // `failed` result. The BrainFetchFailed telemetry below is the durable signal
  // (track() is itself guaranteed non-throwing).
  try {
    await writeBrainStatus(
      {
        status: 'failed',
        slug: opts.slug,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        error,
      },
      opts.dataDirOverride,
    );
  } catch (statusErr) {
    const detail =
      statusErr instanceof Error ? statusErr.message : String(statusErr);
    console.error(
      `[brain] could not write .brain-status.json for ${opts.slug} (${detail}); reporting failure without it`,
    );
  }
  await track(
    {
      event_name: EventName.BrainFetchFailed,
      outcome: 'failed',
      error_class: kind,
      payload: { brand: opts.slug, message: error.slice(0, 500) },
    },
    opts.dataDirOverride,
  );
  return { status: 'failed', error, kind };
}

async function writeBrainStatus(
  status: BrainStatusFile,
  dataDirOverride?: string,
): Promise<void> {
  const path = brainStatusPath(status.slug, dataDirOverride);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(status, null, 2), 'utf-8');
  await rename(tmp, path);
}

/**
 * Best-effort read of the brand's Tier-3 brand_terms (+ negation.competitor_brands)
 * for the typo detector. Returns undefined when context.yaml is absent or carries
 * no brand_terms (a brand-new brand whose cold-start hasn't run) — the typo
 * section then no-ops cleanly. (Gating mirrors the retired cold-start enrich
 * step: typo detection needs Tier-3 brand_terms canonicals to match against.)
 */
async function readBrandTermsInput(
  slug: string,
  dataDirOverride?: string,
): Promise<
  { brand_terms: BrandTermsBlock; competitor_brands?: string[] } | undefined
> {
  try {
    const raw = await readFile(contextPath(slug, dataDirOverride), 'utf-8');
    const parsed = parseYaml(raw) as {
      brand_terms?: BrandTermsBlock;
      negation?: { competitor_brands?: string[] };
    } | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.brand_terms) {
      return undefined;
    }
    return {
      brand_terms: parsed.brand_terms,
      competitor_brands: parsed.negation?.competitor_brands,
    };
  } catch {
    return undefined;
  }
}

function withinTtl(fetchedAtIso: string, now: Date): boolean {
  const fetched = new Date(fetchedAtIso).getTime();
  if (Number.isNaN(fetched)) return false;
  const ageMs = now.getTime() - fetched;
  return ageMs >= 0 && ageMs < BRAIN_TTL_DAYS * 24 * 60 * 60 * 1000;
}
