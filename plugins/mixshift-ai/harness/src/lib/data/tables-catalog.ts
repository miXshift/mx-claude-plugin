/**
 * Load the curated table metadata from
 * `plugins/mixshift-ai/shared/data-tables.yaml`.
 *
 * Walks up from this module's location to find the plugin root (same
 * pattern as lib/defaults/load.ts). Falls back gracefully if the file is
 * missing.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export interface TableMetadata {
  name: string;
  description: string;
  category: 'ad_metrics' | 'ops_revenue' | 'dimensional' | 'inventory' | 'other';
  account_types?: ('SC' | 'VC')[];
  time_series: boolean;
  requires_seller_id: boolean;
  date_column?: string;
}

interface TableMetadataRaw {
  description?: string;
  category?: string;
  account_types?: string[];
  time_series?: boolean;
  requires_seller_id?: boolean;
  date_column?: string;
}

interface DataTablesFile {
  tables: Record<string, TableMetadataRaw>;
}

export async function loadTablesCatalog(
  overridePath?: string,
): Promise<TableMetadata[]> {
  const candidates = overridePath ? [overridePath] : candidatePaths();
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = parseYaml(raw) as DataTablesFile;
      if (!parsed?.tables) continue;
      return Object.entries(parsed.tables).map(([name, meta]) =>
        normalize(name, meta),
      );
    } catch (err) {
      if (isFileNotFoundError(err)) continue;
      throw err;
    }
  }
  return [];
}

export async function describeTable(
  tableName: string,
  overridePath?: string,
): Promise<TableMetadata | null> {
  const all = await loadTablesCatalog(overridePath);
  return all.find((t) => t.name === tableName) ?? null;
}

function normalize(name: string, raw: TableMetadataRaw): TableMetadata {
  return {
    name,
    description: raw.description ?? '',
    category: (raw.category as TableMetadata['category']) ?? 'other',
    account_types: raw.account_types as ('SC' | 'VC')[] | undefined,
    time_series: !!raw.time_series,
    requires_seller_id: !!raw.requires_seller_id,
    date_column: raw.date_column,
  };
}

function candidatePaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  let dir = here;
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, 'shared', 'data-tables.yaml'));
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
