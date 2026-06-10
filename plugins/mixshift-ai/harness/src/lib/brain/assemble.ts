/**
 * Pure assembly: warehouse rows in, Brand Brain document out.
 *
 * No filesystem, no network, no environment reads. This function is the
 * piece that moves server-side verbatim at the P2 promotion (the brain
 * service runs the same assembly on cron); keeping it pure is what makes
 * that move a transport swap instead of a rewrite. I/O lives in
 * lib/brain/fetch.ts (client transport, P1).
 */

import { createHash } from 'node:crypto';
import {
  BRAIN_SCHEMA_VERSION,
  type BrandBrain,
  type BrainSeller,
  type BrainSourceMeta,
} from './schema.js';

/** Raw row shape as returned by sp_brain_seller_fetch (or the local dev
 *  fallback SQL). Values arrive untyped from the wire; normalization is
 *  defensive. */
export type RawSellerRow = Record<string, unknown>;

export interface AssembleBrainInput {
  brandSlug: string;
  sellerRows: RawSellerRow[];
  /** Which procedure/query produced sellerRows (provenance). */
  sellerSproc: string;
  /** e.g. `plugin@0.5.21`. P2 passes `brain-service@x.y`. */
  generator: string;
  /** Injected for determinism in tests; defaults to now. */
  now?: Date;
  /** Carried forward from the previous document so a re-fetch never
   *  drops accumulated S3 observations. */
  previousObservations?: BrandBrain['observations'];
}

/**
 * Assemble the first-slice document (seller source only). Later slices
 * extend the input with catalog/campaign rows and add their sections;
 * the envelope shape stays stable.
 */
export function assembleBrain(input: AssembleBrainInput): BrandBrain {
  const now = input.now ?? new Date();
  const seller = assembleSellerSection(input.sellerRows);
  const sellerMeta: BrainSourceMeta = {
    sproc: input.sellerSproc,
    fetched_at: now.toISOString(),
    row_count: input.sellerRows.length,
    source_hash: hashRows(input.sellerRows),
  };

  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    brand_slug: input.brandSlug,
    generated_at: now.toISOString(),
    generator: input.generator,
    sources: { seller: sellerMeta },
    seller,
    observations: input.previousObservations ?? {},
  };
}

/**
 * Lift the seller section from the fetched rows. Multi-marketplace
 * brands return one row per seller id; scalar fields lift from the
 * PRIMARY row: the first row with a non-null ACOSTarget, else the first
 * row. Per-account detail lives in the registry (index.yaml), not here.
 *
 * Exported for unit tests.
 */
export function assembleSellerSection(rows: RawSellerRow[]): BrainSeller {
  const primary =
    rows.find((r) => toNumber(r.ACOSTarget) !== null) ?? rows[0] ?? {};

  return {
    merchant_alias: toTrimmedString(primary.MerchantAlias),
    storefront_name: toTrimmedString(primary.Name),
    acos_target_pct: toNumber(primary.ACOSTarget),
    monthly_budget: toNumber(primary.MonthlyBudget),
    marketplace: toTrimmedString(primary.MarketPlaceName),
    merchant_region: toTrimmedString(primary.MerchantRegion),
    agency_name: toTrimmedString(primary.AgencyName),
    default_currency_code: toTrimmedString(primary.DefaultCurrencyCode),
    i_brand_report_enabled: toBool(primary.iBrandReportEnabled),
    i_running_initial_pull: toBool(primary.iRunningInitialPull),
    data_freshness: {
      ads_latest: toIso(primary.dtLatestRecordDate),
      retail_latest: toIso(primary.dtMWSLatestRecordDate),
    },
    activated: {
      ads: toIso(primary.dtActivatedOn),
      retail: toIso(primary.dtMwsActivatedOn),
    },
    primary_seller_id: toNumber(primary.ID),
  };
}

/**
 * Deterministic content hash of the normalized rows. Used as the source
 * etag: identical warehouse data hashes identically across fetches, so
 * "did anything change" is one string compare (and at P2, a conditional
 * GET).
 */
export function hashRows(rows: RawSellerRow[]): string {
  const canonical = JSON.stringify(
    rows.map((r) =>
      Object.keys(r)
        .sort()
        .map((k) => [k, normalizeForHash(r[k])]),
    ),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

function normalizeForHash(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  return v ?? null;
}

// ---------------------------------------------------------------------------
// Defensive coercion. Warehouse values arrive as numbers, numeric strings,
// Date objects, ISO strings, 0/1 tinyints, or NULL depending on driver and
// transport (mysql2 direct vs datahub JSON). Assembly must never throw on a
// sparse or oddly-typed row.
// ---------------------------------------------------------------------------

function toTrimmedString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  const n = toNumber(v);
  if (n === null) return null;
  return n !== 0;
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
