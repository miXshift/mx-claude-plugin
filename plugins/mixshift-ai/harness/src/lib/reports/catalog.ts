/**
 * Load the Amazon SP-API report catalog from
 * `plugins/mixshift-ai/shared/reports/catalog.yaml`.
 *
 * The catalog is the plugin-side description of *which* reports exist, what
 * each is for, and how to call/parse it. It is deliberately exhaustive: it
 * lists every report type with NO exclusions. We do not pre-filter on guesses
 * about what's restricted or unavailable for a given tenant — that's the
 * service's job, enforced reactively at fetch time and surfaced to the caller
 * as a typed failure `kind` (see lib/amazon/reports.ts). The catalog's role is
 * purely descriptive: titles, purpose, who it applies to (seller/vendor),
 * document format, window rules, reportOptions hints, warehouse-coverage tag,
 * and parse hints.
 *
 * Walks up from this module's location to find the plugin root (same pattern
 * as lib/data/tables-catalog.ts). Falls back gracefully to an empty list if
 * the file is missing, so a partial checkout never hard-crashes the CLI.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/** Which merchant kind a report type is valid for. Mirrors MerchantView's
 *  merchantType ('Seller' | 'Vendor') but lowercased + a `both` convenience
 *  for the report types that exist on either side. */
export type ReportAppliesTo = 'seller' | 'vendor' | 'both';

/** Wire/document format of the retrieved bytes. Flat-file reports are TSV
 *  (sometimes with a UTF-8 BOM); vendor + Brand Analytics reports are JSON.
 *  The service returns bytes as-is; this tells the caller how to parse them. */
export type ReportDocumentFormat = 'tsv' | 'json';

/** How the report type treats the dataStartTime/dataEndTime window:
 *   - required:  Amazon rejects the request without a window.
 *   - optional:  a window narrows the result but is not mandatory.
 *   - forbidden: Amazon rejects the request *with* a window (snapshot reports
 *                that always return "current state").
 */
export type ReportWindowRule = 'required' | 'optional' | 'forbidden';

/** Whether MixShift's warehouse already holds equivalent data. A hint for the
 *  skill to mention "you may already have this in the warehouse" — never a
 *  gate. `have` = warehouse has it; `partial` = some overlap / different grain
 *  or freshness; `none` = warehouse does not hold this. */
export type WarehouseCoverage = 'have' | 'partial' | 'none';

/** A single reportOptions knob hint. reportOptions are report-type-specific
 *  and passed through to Amazon untouched. */
export interface ReportOptionHint {
  key: string;
  example?: string;
  note?: string;
}

export interface ReportCatalogEntry {
  /** Amazon report type enum, used verbatim on the wire (e.g.
   *  GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL). */
  reportType: string;
  /** Short human title for menus / CLI listings. */
  title: string;
  /** One-line description of what the report contains and what it's good for. */
  purpose: string;
  appliesTo: ReportAppliesTo;
  documentFormat: ReportDocumentFormat;
  window: ReportWindowRule;
  /** Free-text rules on the window (max span, lag, granularity). */
  windowNotes?: string;
  warehouseCoverage: WarehouseCoverage;
  /** Display grouping, e.g. "Orders", "FBA Inventory", "Brand Analytics". */
  group?: string;
  /** reportOptions knobs the caller may set. */
  reportOptions: ReportOptionHint[];
  /** How to read the bytes once retrieved (header row, BOM, JSON shape, ...). */
  parseHints?: string;
  /** Optional free-text caveats (deprecations, regional limits, PII variants). */
  notes?: string;
}

interface ReportOptionHintRaw {
  key?: string;
  example?: string;
  note?: string;
}

interface ReportCatalogEntryRaw {
  report_type?: string;
  title?: string;
  purpose?: string;
  applies_to?: string;
  document_format?: string;
  window?: string;
  window_notes?: string;
  warehouse_coverage?: string;
  group?: string;
  report_options?: ReportOptionHintRaw[];
  parse_hints?: string;
  notes?: string;
}

interface ReportCatalogFile {
  schema_version?: number;
  last_updated?: string;
  reports?: ReportCatalogEntryRaw[];
}

/**
 * Load and normalize the full report catalog. Returns [] if the file is
 * missing (never throws on ENOENT). Entries missing a `report_type` are
 * skipped — that field is the wire key and meaningless without it.
 */
export async function loadReportCatalog(
  overridePath?: string,
): Promise<ReportCatalogEntry[]> {
  const candidates = overridePath ? [overridePath] : candidatePaths();
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = parseYaml(raw) as ReportCatalogFile;
      if (!parsed?.reports) continue;
      return parsed.reports
        .filter((r): r is ReportCatalogEntryRaw => !!r && typeof r.report_type === 'string')
        .map(normalize);
    } catch (err) {
      if (isFileNotFoundError(err)) continue;
      throw err;
    }
  }
  return [];
}

/**
 * Look up a single catalog entry by its exact Amazon report type enum.
 * Case-sensitive — the enum is sent verbatim, so we match it verbatim.
 */
export async function findReportType(
  reportType: string,
  overridePath?: string,
): Promise<ReportCatalogEntry | null> {
  const all = await loadReportCatalog(overridePath);
  return all.find((r) => r.reportType === reportType) ?? null;
}

function normalize(raw: ReportCatalogEntryRaw): ReportCatalogEntry {
  return {
    reportType: raw.report_type as string,
    title: raw.title ?? (raw.report_type as string),
    purpose: raw.purpose ?? '',
    appliesTo: normalizeAppliesTo(raw.applies_to),
    documentFormat: raw.document_format === 'json' ? 'json' : 'tsv',
    window: normalizeWindow(raw.window),
    windowNotes: raw.window_notes,
    warehouseCoverage: normalizeCoverage(raw.warehouse_coverage),
    group: raw.group,
    reportOptions: normalizeOptions(raw.report_options),
    parseHints: raw.parse_hints,
    notes: raw.notes,
  };
}

function normalizeAppliesTo(v: string | undefined): ReportAppliesTo {
  return v === 'seller' || v === 'vendor' ? v : 'both';
}

function normalizeWindow(v: string | undefined): ReportWindowRule {
  return v === 'required' || v === 'forbidden' ? v : 'optional';
}

function normalizeCoverage(v: string | undefined): WarehouseCoverage {
  return v === 'have' || v === 'partial' ? v : 'none';
}

function normalizeOptions(v: ReportOptionHintRaw[] | undefined): ReportOptionHint[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((o): o is ReportOptionHintRaw => !!o && typeof o.key === 'string')
    .map((o) => ({ key: o.key as string, example: o.example, note: o.note }));
}

function candidatePaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  let dir = here;
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, 'shared', 'reports', 'catalog.yaml'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
