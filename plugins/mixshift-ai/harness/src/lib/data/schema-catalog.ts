/**
 * Offline column catalog for the pre-send column check (`column-check.ts`).
 *
 * Merges two files the plugin already ships:
 *   - `shared/tables.yaml`       the full column dump per table (the source
 *                                of truth for which names exist);
 *   - `shared/data-tables.yaml`  the curated catalog `data describe` reads,
 *                                for the per-role column hints (`spend`,
 *                                `sales`, `units`, `asin`, ...) and the
 *                                written gotchas.
 *
 * Only tables present in `tables.yaml` carry a column list; a table that is
 * only curated (no dump) is absent from the result, and the check sends the
 * query unchanged for it. Loaded once per process and cached, so the check
 * costs one YAML parse on the first query and a map lookup after.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export interface SchemaTable {
  /** Table name as spelled in the dump (lowercase in the warehouse). */
  name: string;
  /** Column names in dump order, in their real letter case. */
  columns: string[];
  /** Role -> real column, from the curated catalog (`spend: Cost`). */
  keyColumns: Record<string, string>;
  /** The curated catalog's "before you name a column" lines, verbatim. */
  gotchas: string[];
}

/** Keyed by lowercased table name. */
export type SchemaCatalog = Map<string, SchemaTable>;

interface TablesDump {
  tables?: Record<string, { columns?: Array<{ name?: unknown }> }>;
}
interface CuratedFile {
  tables?: Record<string, { key_columns?: Record<string, unknown>; gotchas?: unknown[] }>;
}

let cached: Promise<SchemaCatalog> | null = null;
let loaded: SchemaCatalog | null = null;
let loadedDir: string | null = null;
let hydrating: Promise<void> | null = null;

/**
 * Load (once) and return the catalog with its column lists. Never throws: a
 * missing or unreadable file yields an empty catalog, which makes every
 * check a no-op. The curated hints (`keyColumns`, `gotchas`) start empty and
 * are filled by `hydrateSchemaHints`, so the per-query cost is the column
 * scan alone and the general YAML parse of the curated file is paid only
 * when a hint is about to be shown. `overrideDir` points at a directory
 * holding the YAML files (tests); an override is not cached.
 */
export function loadSchemaCatalog(overrideDir?: string): Promise<SchemaCatalog> {
  if (overrideDir) return readCatalog([overrideDir]).then((r) => r.catalog);
  if (!cached) {
    cached = readCatalog(candidateDirs()).then((r) => {
      loaded = r.catalog;
      loadedDir = r.dir;
      return r.catalog;
    });
  }
  return cached;
}

/**
 * Fill `keyColumns` and `gotchas` on the cached catalog from the curated
 * `data-tables.yaml` (once). Idempotent, never throws; a missing curated
 * file leaves the hints empty. `overrideCatalog` + `overrideDir` serve tests.
 */
export function hydrateSchemaHints(overrideCatalog?: SchemaCatalog, overrideDir?: string): Promise<void> {
  if (overrideCatalog && overrideDir) return fillHints(overrideCatalog, overrideDir);
  if (!hydrating) {
    hydrating = loadSchemaCatalog().then((cat) => (loadedDir ? fillHints(cat, loadedDir) : undefined));
  }
  return hydrating;
}

/** The catalog if `loadSchemaCatalog` has completed in this process, else null.
 *  Lets a synchronous message builder (the post-failure guidance) use it. */
export function loadedSchemaCatalog(): SchemaCatalog | null {
  return loaded;
}

/** Test hook: forget the cached catalog. */
export function _resetSchemaCatalogCache(): void {
  cached = null;
  loaded = null;
  loadedDir = null;
  hydrating = null;
}

async function readCatalog(dirs: string[]): Promise<{ catalog: SchemaCatalog; dir: string | null }> {
  const out: SchemaCatalog = new Map();
  for (const dir of dirs) {
    const dumpText = await readText(join(dir, 'tables.yaml'));
    if (dumpText === null) continue;
    const tables = parseDumpColumns(dumpText);
    if (tables.size === 0) continue;
    for (const [name, columns] of tables) {
      if (columns.length === 0) continue;
      out.set(name.toLowerCase(), { name, columns, keyColumns: {}, gotchas: [] });
    }
    return { catalog: out, dir };
  }
  return { catalog: out, dir: null };
}

async function fillHints(catalog: SchemaCatalog, dir: string): Promise<void> {
  const curated = (await readYaml<CuratedFile>(join(dir, 'data-tables.yaml')))?.tables ?? {};
  for (const [name, cur] of Object.entries(curated)) {
    const table = catalog.get(name.toLowerCase());
    if (!table || !cur) continue;
    const keyColumns: Record<string, string> = {};
    for (const [role, col] of Object.entries(cur.key_columns ?? {})) {
      if (typeof col === 'string') keyColumns[role.toLowerCase()] = col;
    }
    table.keyColumns = keyColumns;
    table.gotchas = (cur.gotchas ?? []).filter((g): g is string => typeof g === 'string');
  }
}

/**
 * Column lists from the dump text. The dump is machine-generated in one fixed
 * shape (`  <table>:` / `    columns:` / `      - { name: X, type: "..." }`),
 * which a line scan reads in under a millisecond; the general YAML parser
 * takes about 70 ms on it, more than this check is allowed to add to a
 * query. The scan is tried first and the YAML parser is the fallback for a
 * dump written in any other shape, so a regenerated file keeps working.
 */
export function parseDumpColumns(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0 || line.startsWith('#')) continue;
    const table = /^  ([A-Za-z0-9_$]+):\s*$/.exec(line);
    if (table) {
      current = [];
      out.set(table[1]!, current);
      continue;
    }
    if (!current) continue;
    // A YAML emitter quotes names it must (`"Y"`, `"No"`, a name with a space).
    const col = /^\s+-\s+\{\s*name:\s*(?:"([^"]*)"|'([^']*)'|([^,}\s]+))/.exec(line);
    if (col) current.push((col[1] ?? col[2] ?? col[3])!);
  }
  // The generated shape always lists columns under every table; a table with
  // none means the file is in another shape, so hand it to the general parser.
  if (out.size > 0 && [...out.values()].every((cols) => cols.length > 0)) return out;
  out.clear();
  try {
    const parsed = parseYaml(text) as TablesDump;
    for (const [name, meta] of Object.entries(parsed?.tables ?? {})) {
      out.set(
        name,
        (meta.columns ?? []).map((c) => c.name).filter((n): n is string => typeof n === 'string' && n.length > 0),
      );
    }
  } catch {
    /* unreadable dump: empty catalog, every check a no-op */
  }
  return out;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function readYaml<T>(path: string): Promise<T | null> {
  try {
    return parseYaml(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Same walk as lib/data/tables-catalog.ts: `<ancestor>/shared/`. */
function candidateDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs: string[] = [];
  let dir = here;
  for (let i = 0; i < 8; i++) {
    dirs.push(join(dir, 'shared'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}
