/**
 * Load the shared SQL library: `shared/sql-library/catalog.yaml` +
 * the `.sql` files it references.
 *
 * The catalog is read once per process and cached. Skills reference
 * queries by canonical ID (DHC-01, RSC-01, etc.) — the prefetch runner
 * pulls the SQL body from the file the catalog points at.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { pluginPath } from './plugin-root.js';
import { parse as parseYaml } from 'yaml';
import { formatZodError } from '../profile/format-error.js';

const queryEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  purpose: z.string().min(1),
  consumers: z.array(z.string()).default([]),
  tier: z.number().int().min(1).max(3).default(1),
  notes: z.string().optional(),
});

const catalogSchema = z.object({
  schema_version: z.literal(1),
  last_updated: z.string().optional(),
  queries: z.array(queryEntrySchema).min(1),
});

export type QueryEntry = z.infer<typeof queryEntrySchema>;
export type Catalog = z.infer<typeof catalogSchema>;

let catalogCache: Catalog | undefined;

export async function loadCatalog(): Promise<Catalog> {
  if (catalogCache) return catalogCache;
  const path = pluginPath('shared', 'sql-library', 'catalog.yaml');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      throw new Error(
        `SQL library catalog not found at ${path}. ` +
          `Plugin may be misinstalled — re-install via /plugin marketplace.`,
      );
    }
    throw err;
  }
  const parsed = parseYaml(raw);
  const result = catalogSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      formatZodError(result.error, `SQL library catalog at ${path} is invalid`),
    );
  }
  catalogCache = result.data;
  return result.data;
}

/** Reset the catalog cache (tests). */
export function resetCatalogCache(): void {
  catalogCache = undefined;
}

export async function getQueryEntry(id: string): Promise<QueryEntry> {
  const cat = await loadCatalog();
  const entry = cat.queries.find((q) => q.id === id);
  if (!entry) {
    throw new Error(
      `SQL library has no entry for "${id}". ` +
        `Known IDs: ${cat.queries
          .slice(0, 8)
          .map((q) => q.id)
          .join(', ')}... (${cat.queries.length} total)`,
    );
  }
  return entry;
}

/**
 * Read the .sql file body for a catalog entry. Strips the leading
 * comment header (lines starting with --) so the SQL we pass to mysql2
 * is just the executable statement.
 *
 * We keep the comment as a separate `header` field — callers may want
 * to log it for debugging.
 */
export async function readQuerySql(
  id: string,
): Promise<{ id: string; sql: string; header: string }> {
  const entry = await getQueryEntry(id);
  const path = pluginPath('shared', 'sql-library', entry.file);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      throw new Error(
        `SQL library catalog references ${entry.file} (for query ${id}), ` +
          `but the file is not at ${path}. Plugin may be incomplete.`,
      );
    }
    throw err;
  }

  // Split header (consecutive leading lines starting with --) from body.
  const lines = raw.split(/\r?\n/);
  let headerEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('--') || line.trim() === '') {
      headerEnd = i + 1;
    } else {
      break;
    }
  }
  const header = lines.slice(0, headerEnd).join('\n');
  const sql = lines.slice(headerEnd).join('\n').trim();
  return { id, sql, header };
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
