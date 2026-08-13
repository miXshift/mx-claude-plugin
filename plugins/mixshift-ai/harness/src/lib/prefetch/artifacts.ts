/**
 * Write prefetch artifacts: `.data.json` (full machine-readable) +
 * `.data.md` (human/Claude-readable, capped).
 *
 * The 48KB cap on `.data.md` exists because Claude's context window is
 * finite and skill model output benefits from a digestible, focused
 * data summary. The full JSON is always preserved on disk for the
 * skill to query / render from.
 *
 * Default artifact layout (under `~/.mixshift/`):
 *
 *   clients/<brand>/runs/<skill>/<run-date>/
 *     ├── data.json       (full results: array of {id, rows} per query)
 *     ├── data.md         (markdown summary, ≤ 48 KB)
 *     └── context.md      (brand context snapshot the skill consumed)
 *
 * The same directory accumulates run sidecars (one JSON per run-id) at
 * the parent level, written by `mixshift sidecar write`.
 */

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDataDir } from '../paths/resolve.js';

/** Cap on the rendered `.data.md` file. Claude's prefill context is the
 * effective ceiling — 48 KB has been the historic budget that leaves
 * room for the skill prompt + reasoning. */
const DATA_MD_BYTE_CAP = 48 * 1024;

export interface QueryRunOutput<Row = Record<string, unknown>> {
  id: string;
  /** Raw rows returned by the query. */
  rows: Row[];
  /** Duration in ms. */
  duration_ms: number;
  /** Param map actually used (after substitution). For audit. */
  params: Record<string, unknown>;
  /** SQL we executed, post list-inlining. Useful for failure forensics.
   *  For dispatch:named queries this is a placeholder (the SQL is
   *  server-side) — `purpose` + `revision` carry the forensic value. */
  display_sql: string;
  /** Catalog purpose string. The human-readable stand-in for the SQL on
   *  dispatch:named queries, so artifacts stay debuggable without
   *  shipping the query text. */
  purpose?: string;
  /** dispatch:named only: the server-side entry's SQL content hash, so a
   *  surprising number is attributable to an exact query revision. */
  revision?: string;
  /** dispatch:named only, on success: sorted param names the gateway
   *  actually bound (mx-legacy-auth PR #107). Provenance for the sub-brand
   *  label lens's reconciliation (lib/binding/lens.ts) — a surprising
   *  number is auditable against what the server really filtered on.
   *  Absent for dispatch:sql/sproc and for an older gateway deploy. */
  applied_params?: string[];
}

export interface PrefetchArtifactInput {
  brand_slug: string;
  skill_id: string;
  run_date: string; // YYYY-MM-DD
  /** Per-query outputs, in batch_plan order. */
  query_outputs: QueryRunOutput[];
  /** Free-form fields the skill wants on disk (skill version, etc.). */
  meta?: Record<string, unknown>;
  /** Override `~/.mixshift/` (tests). */
  dataDirOverride?: string;
}

export interface PrefetchArtifactPaths {
  run_dir: string;
  data_json_path: string;
  data_md_path: string;
}

export async function writePrefetchArtifacts(
  input: PrefetchArtifactInput,
): Promise<PrefetchArtifactPaths> {
  const runDir = resolveRunDir(input);
  await mkdir(runDir, { recursive: true });

  const dataJsonPath = join(runDir, 'data.json');
  const dataMdPath = join(runDir, 'data.md');

  // Full machine-readable record. Atomically replace via tmp+rename so a
  // partially-written file never gets consumed by a downstream skill.
  const jsonBody = JSON.stringify(
    {
      brand_slug: input.brand_slug,
      skill_id: input.skill_id,
      run_date: input.run_date,
      generated_at_utc: new Date().toISOString(),
      meta: input.meta ?? {},
      queries: input.query_outputs.map((q) => ({
        id: q.id,
        params: q.params,
        display_sql: q.display_sql,
        ...(q.purpose ? { purpose: q.purpose } : {}),
        ...(q.revision ? { revision: q.revision } : {}),
        ...(q.applied_params ? { applied_params: q.applied_params } : {}),
        duration_ms: q.duration_ms,
        row_count: q.rows.length,
        rows: q.rows,
      })),
    },
    null,
    2,
  );
  await writeAtomic(dataJsonPath, jsonBody);

  const md = renderDataMarkdown(input);
  await writeAtomic(dataMdPath, md);

  return { run_dir: runDir, data_json_path: dataJsonPath, data_md_path: dataMdPath };
}

/**
 * Resolve `~/.mixshift/clients/<brand>/runs/<skill>/<date>/`. Exposed
 * for tests / sidecar writer which needs the parent dir.
 */
export function resolveRunDir(input: {
  brand_slug: string;
  skill_id: string;
  run_date: string;
  dataDirOverride?: string;
}): string {
  return join(
    resolveDataDir(input.dataDirOverride),
    'clients',
    input.brand_slug,
    'runs',
    input.skill_id,
    input.run_date,
  );
}

// -----------------------------------------------------------------------
// Markdown rendering
// -----------------------------------------------------------------------

/**
 * Render the prefetch results as markdown for skill consumption.
 * Per-query sections include the SQL header, params, row count, and a
 * truncated table of rows. The whole file gets capped at 48 KB — once
 * we cross that ceiling, remaining queries get a "...truncated" stub
 * instead of full row tables.
 */
function renderDataMarkdown(input: PrefetchArtifactInput): string {
  const header = [
    `# Prefetch — ${input.skill_id} — ${input.brand_slug}`,
    '',
    `- **Run date**: ${input.run_date}`,
    `- **Generated**: ${new Date().toISOString()}`,
    `- **Queries**: ${input.query_outputs.length}`,
    '',
    `> Full machine-readable results live alongside this file at \`data.json\`.`,
    '',
    '---',
    '',
  ].join('\n');

  let body = '';
  let truncated = false;

  for (const q of input.query_outputs) {
    const section = renderQuerySection(q);
    if (
      !truncated &&
      Buffer.byteLength(header + body + section, 'utf-8') <= DATA_MD_BYTE_CAP
    ) {
      body += section;
    } else {
      // Bail out — emit stub for this and remaining queries.
      truncated = true;
      body += `## ${q.id}\n\n_Row data omitted (markdown cap exceeded — see data.json)._\n\n`;
    }
  }

  if (truncated) {
    body +=
      '\n> ⚠️ Markdown output truncated at ' +
      `${(DATA_MD_BYTE_CAP / 1024).toFixed(0)} KB. ` +
      'The full row data is available in `data.json` — load that file ' +
      'directly if you need rows that did not fit here.\n';
  }

  return header + body;
}

function renderQuerySection(q: QueryRunOutput): string {
  const lines: string[] = [];
  lines.push(`## ${q.id}`);
  lines.push('');
  if (q.purpose) lines.push(`- **Purpose**: ${q.purpose}`);
  lines.push(`- **Rows**: ${q.rows.length}`);
  lines.push(`- **Duration**: ${q.duration_ms} ms`);
  if (q.revision) lines.push(`- **Query revision**: ${q.revision}`);
  if (q.applied_params) lines.push(`- **Applied params**: ${q.applied_params.join(', ')}`);
  if (Object.keys(q.params).length > 0) {
    lines.push(`- **Params**: \`${JSON.stringify(q.params)}\``);
  }
  lines.push('');
  if (q.rows.length === 0) {
    lines.push('_No rows returned._');
    lines.push('');
  } else {
    lines.push(renderRowsTable(q.rows));
  }
  lines.push('');
  return lines.join('\n');
}

function renderRowsTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Array.from(
    rows.reduce<Set<string>>((acc, r) => {
      for (const k of Object.keys(r)) acc.add(k);
      return acc;
    }, new Set()),
  );
  // Cap rows shown in markdown — JSON has the full set. 100 rows is
  // plenty for the model to read, and any aggregation in the report
  // should already be in the SQL itself.
  const ROW_LIMIT = 100;
  const shown = rows.slice(0, ROW_LIMIT);
  const out: string[] = [];
  out.push(`| ${cols.join(' | ')} |`);
  out.push(`| ${cols.map(() => '---').join(' | ')} |`);
  for (const r of shown) {
    out.push(`| ${cols.map((c) => formatCell(r[c])).join(' | ')} |`);
  }
  if (rows.length > ROW_LIMIT) {
    out.push('');
    out.push(`_…and ${rows.length - ROW_LIMIT} more rows (see data.json)._`);
  }
  return out.join('\n');
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    // Date, Buffer, etc. — best-effort. mysql2 returns DATE columns as
    // JS Date objects; format them as ISO so the markdown is stable.
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return JSON.stringify(v);
  }
  // Avoid breaking the table on pipes / newlines inside string cells.
  const s = String(v);
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// -----------------------------------------------------------------------
// Atomic file writer (mirrors clients/bootstrap.ts pattern)
// -----------------------------------------------------------------------

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, content, { encoding: 'utf-8' });
  await rename(tmpPath, path);
}
