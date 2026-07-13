/**
 * `mixshift data asin-titles` — resolve ASINs to their product Title + Brand.
 *
 * The one shared ASIN→title lookup for the whole plugin. Every surface that
 * shows a bare ASIN (asin-target-negation, data-explore ASIN pulls, the Ads
 * product-ad lists) enriches through this one code path so the canonical
 * "latest listing row per ASIN" rule lives in exactly one place.
 *
 * Source: `mws_items` (Seller Central catalog). That table is ONE ROW PER SKU,
 * so a single ASIN commonly has many rows; picking a title means picking ONE
 * row per ASIN — the latest by `dtUpdatedOn`, tie-broken on `ID`. A bare
 * `MAX(dtUpdatedOn)` equality is NOT enough: batch refreshes stamp many rows
 * with the same `dtUpdatedOn`, so we take `MAX(ID)` among the newest-timestamp
 * rows (see tables.yaml `mws_items` notes + the `mws_items` memory).
 *
 * `mws_items` only holds LISTED SKUs. ASINs that are legitimately absent (e.g.
 * from Brand Analytics catalog reports) come back in `missing` — the caller
 * (or the model) resolves those live via mx-amazon-retail `catalog.search_items`
 * (Catalog Items API). Absent titles are NEVER an error here.
 */

import { runQuery, type DataQueryFailureKind } from './query-runner.js';

export interface AsinTitle {
  asin: string;
  title: string | null;
  brand: string | null;
  /** Where the title came from. Only 'mws_items' today; kept for the VC / catalog-API extensions. */
  source: 'mws_items';
}

export interface ResolveAsinTitlesOptions {
  sellerId: number;
  asins: string[];
  dataDirOverride?: string;
}

export type ResolveAsinTitlesResult =
  | {
      ok: true;
      /** One entry per ASIN that resolved to a listing row. */
      titles: AsinTitle[];
      /** Requested ASINs with no row in mws_items — resolve live via catalog.search_items. */
      missing: string[];
      durationMs: number;
    }
  | {
      ok: false;
      /** Preserved from the underlying query failure so the caller can route
       *  exit codes (e.g. access_denied -> exit 4) the same way the other data
       *  subcommands do. Guard failures (over-cap) use 'unknown'. */
      kind: DataQueryFailureKind;
      table_name?: string;
      message: string;
      friendly: string;
      durationMs: number;
    };

/** Upper bound on ASINs per call — keeps the IN-list (and the gateway payload) sane. */
const MAX_ASINS = 1000;

/**
 * Normalize the requested ASIN list: trim, upper-case (ASINs are
 * case-insensitive but stored upper), drop blanks, de-dupe while preserving
 * first-seen order. Does NOT reject non-B0 shapes — the warehouse is the
 * source of truth for what exists, not a client-side regex.
 */
export function normalizeAsins(asins: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (!Array.isArray(asins)) return out;
  for (const raw of asins) {
    const a = String(raw ?? '').trim().toUpperCase();
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

export async function resolveAsinTitles(
  opts: ResolveAsinTitlesOptions,
): Promise<ResolveAsinTitlesResult> {
  const t0 = Date.now();
  const asins = normalizeAsins(opts?.asins);

  if (asins.length === 0) {
    return { ok: true, titles: [], missing: [], durationMs: Date.now() - t0 };
  }
  if (asins.length > MAX_ASINS) {
    const message = `Too many ASINs (${asins.length}); the limit is ${MAX_ASINS} per call.`;
    return {
      ok: false,
      kind: 'unknown',
      message,
      friendly: `${message} Batch your ASINs into groups of ${MAX_ASINS} or fewer.`,
      durationMs: Date.now() - t0,
    };
  }

  // One placeholder per ASIN, used twice: once in the inner "latest timestamp
  // per ASIN" derived table, once in the middle "max ID at that timestamp"
  // scan. No window functions — the warehouse SQL library avoids them, and the
  // derived-table form works across MySQL versions.
  //
  // Pick exactly one row per ASIN via an explicit JOIN to a derived max-
  // timestamp table (NOT a `(ASIN, dtUpdatedOn) IN (SELECT ...)` row-constructor
  // subquery — MySQL often can't optimize those and falls back to a dependent
  // subquery / full scan; the JOIN lets it use a (SellerID, ASIN, ...) index).
  const placeholders = asins.map(() => '?').join(', ');
  const sql = `
    SELECT m.ASIN AS asin, m.ItemName AS title, m.Brand AS brand
    FROM mws_items m
    JOIN (
      SELECT t.ASIN, MAX(t.ID) AS pick_id
      FROM mws_items t
      JOIN (
        SELECT ASIN, MAX(dtUpdatedOn) AS max_dt
        FROM mws_items
        WHERE SellerID = ?
          AND ASIN IN (${placeholders})
        GROUP BY ASIN
      ) mx ON mx.ASIN = t.ASIN AND mx.max_dt = t.dtUpdatedOn
      WHERE t.SellerID = ?
        AND t.ASIN IN (${placeholders})
      GROUP BY t.ASIN
    ) pick ON m.ID = pick.pick_id`;

  const params: unknown[] = [opts.sellerId, ...asins, opts.sellerId, ...asins];

  const result = await runQuery<{ asin: string; title: string | null; brand: string | null }>(
    sql,
    params,
    { dataDirOverride: opts.dataDirOverride },
  );

  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind,
      table_name: result.table_name,
      message: result.message,
      friendly: result.friendly,
      durationMs: Date.now() - t0,
    };
  }

  const titles: AsinTitle[] = result.rows.map((r) => ({
    asin: String(r.asin).toUpperCase(),
    title: r.title ?? null,
    brand: r.brand ?? null,
    source: 'mws_items',
  }));

  const found = new Set(titles.map((t) => t.asin));
  const missing = asins.filter((a) => !found.has(a));

  return { ok: true, titles, missing, durationMs: Date.now() - t0 };
}
