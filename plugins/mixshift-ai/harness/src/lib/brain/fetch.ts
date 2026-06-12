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

import { writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runDispatched, MissingParamsError } from '../data/dispatch.js';
import { getQueryEntry } from '../prefetch/sql-library.js';
import { readIndex } from '../clients/index.js';
import { brainStatusPath } from '../paths/resolve.js';
import { getPluginVersion } from '../plugin-version.js';
import { track, EventName } from '../telemetry/index.js';
import {
  assembleBrain,
  type RawSellerRow,
  type SourceInput,
} from './assemble.js';
import { loadBrain, saveBrain } from './read.js';
import type { BrandBrain } from './schema.js';

/** Seller-source TTL: re-fetches inside this window are no-ops unless
 *  forced. 30 days per internal/BACKGROUND-DISCOVERY.md. */
export const BRAIN_TTL_DAYS = 30;

const BRAIN_SELLER_QUERY_ID = 'BRAIN-SELLER';
const BRAIN_CATALOG_SC_QUERY_ID = 'BRAIN-CATALOG-SC';
const BRAIN_CATALOG_VC_QUERY_ID = 'BRAIN-CATALOG-VC';
const BRAIN_CAMPAIGN_QUERY_ID = 'BRAIN-CAMPAIGN';

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
  /** Non-fatal source failures (seller failing is fatal and surfaces as
   *  status 'failed' instead). Names: catalog_sc | catalog_vc | campaign. */
  failed_sources: string[];
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

  // Source scoping by account type (internal/BACKGROUND-DISCOVERY.md):
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

  type SourceOutcome =
    | { ok: true; rows: RawSellerRow[]; usedDispatch: string }
    | { ok: false; error: string; kind?: string };

  const runSource = async (
    queryId: string,
    ids: number[],
  ): Promise<SourceOutcome> => {
    try {
      const result = await runDispatched<RawSellerRow>(queryId, {
        // seller_ids inside params serves BOTH backends: the sproc path
        // routes it to the second CALL argument; the local dev fallback
        // substitutes :seller_ids in the SQL text.
        params: { seller_ids: ids },
        dataDirOverride,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: result.failure.friendly,
          kind: result.failure.kind,
        };
      }
      return { ok: true, rows: result.rows, usedDispatch: result.usedDispatch };
    } catch (err) {
      const message =
        err instanceof MissingParamsError
          ? `${err.message} (local dev fallback SQL must reference :seller_ids)`
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, error: message };
    }
  };

  const [sellerOut, scOut, vcOut, campaignOut] = await Promise.all([
    runSource(BRAIN_SELLER_QUERY_ID, sellerIds),
    scIds.length > 0
      ? runSource(BRAIN_CATALOG_SC_QUERY_ID, scIds)
      : Promise.resolve(null),
    vcIds.length > 0
      ? runSource(BRAIN_CATALOG_VC_QUERY_ID, vcIds)
      : Promise.resolve(null),
    runSource(BRAIN_CAMPAIGN_QUERY_ID, sellerIds),
  ]);

  // Seller is the spine: identity failure is fatal. Catalog/campaign
  // failures are partial — the brain is still written with whatever
  // succeeded, and the failures are reported, not swallowed.
  if (!sellerOut.ok) {
    return await failFetch(opts, now, sellerOut.error, sellerOut.kind);
  }
  const failedSources: string[] = [];
  if (scOut && !scOut.ok) failedSources.push('catalog_sc');
  if (vcOut && !vcOut.ok) failedSources.push('catalog_vc');
  if (campaignOut && !campaignOut.ok) failedSources.push('campaign');

  const sourceInput = async (
    queryId: string,
    out: SourceOutcome | null,
  ): Promise<SourceInput<RawSellerRow> | undefined> => {
    if (!out || !out.ok) return undefined;
    const entry = await getQueryEntry(queryId);
    return { rows: out.rows, sproc: entry.sproc ?? queryId };
  };

  const sellerEntry = await getQueryEntry(BRAIN_SELLER_QUERY_ID);
  const brain: BrandBrain = assembleBrain({
    brandSlug: slug,
    sellerRows: sellerOut.rows,
    sellerSproc: sellerEntry.sproc ?? BRAIN_SELLER_QUERY_ID,
    generator: `plugin@${getPluginVersion()}`,
    now,
    previousObservations,
    catalogSc: await sourceInput(BRAIN_CATALOG_SC_QUERY_ID, scOut),
    catalogVc: await sourceInput(BRAIN_CATALOG_VC_QUERY_ID, vcOut),
    campaign: await sourceInput(BRAIN_CAMPAIGN_QUERY_ID, campaignOut),
  });
  const { path } = await saveBrain(brain, dataDirOverride);

  const summary: BrainFetchSummary = {
    row_count: sellerOut.rows.length,
    acos_target_pct: brain.seller?.acos_target_pct ?? null,
    merchant_alias: brain.seller?.merchant_alias ?? null,
    used_dispatch: sellerOut.usedDispatch,
    duration_ms: Date.now() - t0,
    asin_count: brain.catalog?.asin_count ?? null,
    campaign_count: brain.campaign_structure?.campaign_count ?? null,
    failed_sources: failedSources,
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
        failed_sources: failedSources,
      },
    },
    dataDirOverride,
  );

  return { status: 'complete', path, summary };
}

async function failFetch(
  opts: BrainFetchOptions,
  startedAt: Date,
  error: string,
  kind?: string,
): Promise<BrainFetchResult> {
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

function withinTtl(fetchedAtIso: string, now: Date): boolean {
  const fetched = new Date(fetchedAtIso).getTime();
  if (Number.isNaN(fetched)) return false;
  const ageMs = now.getTime() - fetched;
  return ageMs >= 0 && ageMs < BRAIN_TTL_DAYS * 24 * 60 * 60 * 1000;
}
