/**
 * Query the warehouse `seller` table for brand discovery.
 *
 * Returns one row per (seller, marketplace) the authenticated user has
 * read access to. Filtering / interpretation happens here so the
 * downstream brand-grouping module operates on a clean shape:
 *
 *   - Account type normalized to SC / VC (raw MerchantType strings vary)
 *   - ads_active and retail_active boolean flags computed from the
 *     several "lost access" / "hide" flags the warehouse keeps
 *   - Soft-deleted rows excluded
 *
 * Schema reference: shared/tables.yaml :: seller
 */

import { query } from '../sql/connection.js';
import type { MysqlCreds } from '../auth/schema.js';

export interface SellerRow {
  seller_id: number;
  seller_name: string;
  amazon_seller_id: string | null;
  merchant_alias: string | null;
  account_type: 'SC' | 'VC' | 'unknown';
  marketplace: string | null;
  region: string | null;
  agency_name: string | null;
  acos_target: number | null;
  // Derived "MixShift can actually use this" flags (factor in hide_from_*,
  // *_lost_access, finance flags — richer than the raw IsActive / isMwsUser).
  // These are what consumers should branch on for "is this account usable?"
  ads_active: boolean;
  retail_active: boolean;
  // Raw source-column flags (kept for debugging "why is this dormant" — show
  // both the raw input and the derived output). `is_active` mirrors IsActive,
  // `has_mws` mirrors isMwsUser (the SP-API access flag; column name predates
  // the MWS→SP-API rename so we keep `has_mws` for source fidelity).
  is_active: boolean;
  has_mws: boolean;
  created_at: string | null;
  updated_at: string | null;
}

interface RawSellerRow {
  seller_id: number;
  seller_name: string | null;
  amazon_seller_id: string | null;
  merchant_alias: string | null;
  merchant_type: string | null;
  marketplace: string | null;
  region: string | null;
  agency_name: string | null;
  acos_target: string | number | null;
  is_active: number | null;
  is_deleted: number | null;
  ad_lost_access: number | null;
  hide_from_ads: number | null;
  hide_from_mws: number | null;
  has_mws: number | null;
  ba_lost_access: number | null;
  finance_lost_access: number | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

// SELECT-only. The harness never writes to the warehouse.
const DISCOVERY_SQL = `
  SELECT
    ID                          AS seller_id,
    Name                        AS seller_name,
    AmazonSellerID              AS amazon_seller_id,
    MerchantAlias               AS merchant_alias,
    MerchantType                AS merchant_type,
    MarketPlaceName             AS marketplace,
    MerchantRegion              AS region,
    AgencyName                  AS agency_name,
    ACOSTarget                  AS acos_target,
    IsActive                    AS is_active,
    IsDeleted                   AS is_deleted,
    isAdLostAccess              AS ad_lost_access,
    HideFromAdvertisingPlatform AS hide_from_ads,
    HideFromMWSPlatform         AS hide_from_mws,
    isMwsUser                   AS has_mws,
    isBrandAnalyticsLostAccess  AS ba_lost_access,
    isFinanceLostAccess         AS finance_lost_access,
    dtCreatedOn                 AS created_at,
    dtUpdatedOn                 AS updated_at
  FROM seller
  WHERE IsDeleted = 0
  ORDER BY MerchantAlias, MarketPlaceName, MerchantType
`;

export interface DiscoverOptions {
  creds?: MysqlCreds;
  dataDirOverride?: string;
  /** Include rows the user can read but where ads + retail access are both lost. Default false. */
  includeInactive?: boolean;
}

/**
 * Run the discovery query against the warehouse and return normalized rows.
 *
 * One network round-trip. If the user has access to thousands of sellers
 * this still completes quickly because no joins / aggregates are involved.
 */
export async function discoverSellers(
  options: DiscoverOptions = {},
): Promise<SellerRow[]> {
  const result = await query<RawSellerRow>(DISCOVERY_SQL, [], {
    creds: options.creds,
    dataDirOverride: options.dataDirOverride,
  });

  const rows = result.rows.map(normalizeRow);
  if (options.includeInactive) return rows;
  return rows.filter((r) => r.ads_active || r.retail_active);
}

function normalizeRow(raw: RawSellerRow): SellerRow {
  return {
    seller_id: raw.seller_id,
    seller_name: raw.seller_name?.trim() || `seller-${raw.seller_id}`,
    amazon_seller_id: raw.amazon_seller_id ?? null,
    merchant_alias: raw.merchant_alias?.trim() || null,
    account_type: normalizeAccountType(raw.merchant_type),
    marketplace: raw.marketplace ?? null,
    region: raw.region ?? null,
    agency_name: raw.agency_name ?? null,
    acos_target: toNumber(raw.acos_target),
    ads_active: isAdsActive(raw),
    retail_active: isRetailActive(raw),
    is_active: raw.is_active === 1,
    has_mws: raw.has_mws === 1,
    created_at: toIso(raw.created_at),
    updated_at: toIso(raw.updated_at),
  };
}

/**
 * Map the raw `MerchantType` string to the SC/VC enum the rest of the
 * harness uses. Treats "seller" / "vendor" case-insensitively. Anything
 * unrecognized comes back as "unknown" — the consumer decides whether to
 * surface or skip.
 */
function normalizeAccountType(raw: string | null): 'SC' | 'VC' | 'unknown' {
  if (!raw) return 'unknown';
  const s = raw.trim().toLowerCase();
  if (s === 'seller' || s === 'sellercentral' || s === 'sc') return 'SC';
  if (s === 'vendor' || s === 'vendorcentral' || s === 'vc') return 'VC';
  return 'unknown';
}

/**
 * Ads is considered active when: account is enabled (IsActive=1), not
 * soft-deleted (already filtered in SQL), not lost-access on the Ads side,
 * and not hidden from the ads platform.
 */
function isAdsActive(raw: RawSellerRow): boolean {
  return (
    raw.is_active === 1 &&
    raw.ad_lost_access !== 1 &&
    raw.hide_from_ads !== 1
  );
}

/**
 * Retail (MWS / SP-API) is considered active when the seller is enabled,
 * the MWS pipeline is set up, and they haven't lost access on the
 * finance / MWS side.
 */
function isRetailActive(raw: RawSellerRow): boolean {
  return (
    raw.is_active === 1 &&
    raw.has_mws === 1 &&
    raw.hide_from_mws !== 1 &&
    raw.finance_lost_access !== 1
  );
}

function toNumber(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  // mysql2 may return a string already
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Exported for tests
export const _internal = { normalizeRow, normalizeAccountType, isAdsActive, isRetailActive };
