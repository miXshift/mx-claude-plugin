import type { Command } from 'commander';
import { resolve as resolvePath } from 'node:path';
import { loadTablesCatalog, describeTable } from '../lib/data/tables-catalog.js';
import { sampleTable } from '../lib/data/sample.js';
import { exportTable } from '../lib/data/export.js';
import { runQuery } from '../lib/data/query-runner.js';
import { rowsToCsv } from '../lib/output/csv.js';
import { outputDir } from '../lib/paths/resolve.js';
import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerDataCommands(program: Command): void {
  const data = program
    .command('data')
    .description('Query, sample, and export warehouse data (read-only)');

  // ---------------------------------------------------------------------
  // list-tables
  // ---------------------------------------------------------------------
  data
    .command('list-tables')
    .description('List queryable tables with descriptions')
    .option('--category <cat>', 'filter by category: ad_metrics | ops_revenue | dimensional | inventory')
    .action(async (opts: { category?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const all = await loadTablesCatalog();
        const tables = opts.category ? all.filter((t) => t.category === opts.category) : all;
        if (root.json) {
          process.stdout.write(JSON.stringify({ status: 'ok', tables }, null, 2) + '\n');
        } else {
          process.stderr.write(renderTableList(tables) + '\n');
        }
      } catch (err) {
        emitError(err, !!root.json);
      }
    });

  // ---------------------------------------------------------------------
  // describe
  // ---------------------------------------------------------------------
  data
    .command('describe <table>')
    .description('Show description + scoping hints for one table')
    .action(async (table: string, _opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const meta = await describeTable(table);
        if (!meta) {
          throw new Error(
            `Table "${table}" is not in the curated catalog. ` +
              `Run \`mixshift data list-tables\` to see what's documented.`,
          );
        }
        if (root.json) {
          process.stdout.write(JSON.stringify({ status: 'ok', table: meta }, null, 2) + '\n');
        } else {
          process.stderr.write(renderTableDetail(meta) + '\n');
        }
      } catch (err) {
        emitError(err, !!root.json);
      }
    });

  // ---------------------------------------------------------------------
  // sample
  // ---------------------------------------------------------------------
  data
    .command('sample')
    .description('Preview rows from a table')
    .requiredOption('--table <name>', 'table name')
    .option('--seller-id <id>', 'scope to a single seller (required for time-series tables)', parseInt10)
    .option('--limit <n>', 'row limit', parseInt10, 10)
    .action(
      async (
        opts: { table: string; sellerId?: number; limit: number },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const result = await sampleTable({
            table: opts.table,
            sellerId: opts.sellerId,
            limit: opts.limit,
            dataDirOverride: root.dataDir,
          });
          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: result.query_result.ok ? 'ok' : 'error',
                  table: opts.table,
                  seller_id: opts.sellerId,
                  limit: opts.limit,
                  display_sql: result.display_sql,
                  ...(result.query_result.ok
                    ? {
                        row_count: result.query_result.rowCount,
                        rows: result.query_result.rows,
                      }
                    : {
                        failure_kind: result.query_result.kind,
                        table_name: result.query_result.table_name,
                        message: result.query_result.friendly,
                      }),
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            if (!result.query_result.ok) {
              process.stderr.write(`\n✗ ${result.query_result.friendly}\n`);
              process.exitCode = handleAccessDeniedExit(result.query_result.kind);
              return;
            }
            process.stderr.write(
              `\n✓ ${result.query_result.rowCount} rows from \`${opts.table}\`` +
                (opts.sellerId !== undefined ? ` (seller ${opts.sellerId})` : '') +
                `\n  ${result.display_sql}\n\n`,
            );
            process.stdout.write(renderRowsAsMarkdown(result.query_result.rows) + '\n');
          }
        } catch (err) {
          emitError(err, !!root.json);
        }
      },
    );

  // ---------------------------------------------------------------------
  // export
  // ---------------------------------------------------------------------
  data
    .command('export')
    .description('Bulk export a table (or filtered subset) to CSV')
    .requiredOption('--table <name>', 'table name')
    .option('--seller-id <id>', 'scope to a single seller', parseInt10)
    .option('--start <YYYY-MM-DD>', 'inclusive start date (uses table date_column)')
    .option('--end <YYYY-MM-DD>', 'inclusive end date')
    .option('--out <path>', 'output CSV file path (default ~/.mixshift/output/<table>-<date>.csv)')
    .option('--max-rows <n>', 'cap row count', parseInt10)
    .action(
      async (
        opts: {
          table: string;
          sellerId?: number;
          start?: string;
          end?: string;
          out?: string;
          maxRows?: number;
        },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const outPath = resolvePath(
            opts.out ??
              `${outputDir(root.dataDir)}/${opts.table}-${todayISO()}.csv`,
          );

          const result = await exportTable({
            table: opts.table,
            sellerId: opts.sellerId,
            startDate: opts.start,
            endDate: opts.end,
            outPath,
            maxRows: opts.maxRows,
            dataDirOverride: root.dataDir,
          });

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: result.query_result.ok ? 'ok' : 'error',
                  out_path: result.out_path,
                  rows_written: result.rows_written,
                  duration_ms: result.duration_ms,
                  display_sql: result.display_sql,
                  ...(result.query_result.ok
                    ? {}
                    : {
                        failure_kind: result.query_result.kind,
                        table_name: result.query_result.table_name,
                        message: result.query_result.friendly,
                      }),
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            if (!result.query_result.ok) {
              process.stderr.write(`\n✗ ${result.query_result.friendly}\n`);
              process.exitCode = handleAccessDeniedExit(result.query_result.kind);
              return;
            }
            process.stderr.write(
              `\n✓ Exported ${result.rows_written} rows to ${result.out_path}\n` +
                `  duration: ${result.duration_ms}ms\n` +
                `  query:    ${result.display_sql}\n`,
            );
          }
        } catch (err) {
          emitError(err, !!root.json);
        }
      },
    );

  // ---------------------------------------------------------------------
  // query (power-user passthrough — read-only creds make this safe)
  // ---------------------------------------------------------------------
  data
    .command('query')
    .description(
      'Run a custom SQL query (read-only creds enforce SELECT). ' +
        'Use --out to write large results to CSV.',
    )
    .requiredOption('--sql <sql>', 'the SQL to run')
    .option('--out <path>', 'write results to CSV instead of stdout')
    .action(
      async (opts: { sql: string; out?: string }, cmd: Command) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const result = await runQuery(opts.sql, [], {
            dataDirOverride: root.dataDir,
          });

          if (!result.ok) {
            if (root.json) {
              process.stdout.write(
                JSON.stringify(
                  {
                    status: 'error',
                    failure_kind: result.kind,
                    table_name: result.table_name,
                    message: result.friendly,
                  },
                  null,
                  2,
                ) + '\n',
              );
            } else {
              process.stderr.write(`\n✗ ${result.friendly}\n`);
            }
            process.exitCode = handleAccessDeniedExit(result.kind);
            return;
          }

          if (opts.out) {
            const columns = result.rows.length > 0
              ? Object.keys(result.rows[0]!).map((n) => ({ name: n }))
              : [];
            const csv = rowsToCsv(result.rows as Array<Record<string, unknown>>, columns);
            await mkdir(dirname(opts.out), { recursive: true });
            await writeFile(opts.out, csv, 'utf-8');
          }

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: 'ok',
                  row_count: result.rowCount,
                  duration_ms: result.durationMs,
                  ...(opts.out ? { out_path: opts.out } : { rows: result.rows }),
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stderr.write(
              `\n✓ ${result.rowCount} rows (${result.durationMs}ms)\n`,
            );
            if (opts.out) {
              process.stderr.write(`  written to ${opts.out}\n`);
            } else {
              process.stdout.write(
                renderRowsAsMarkdown(result.rows as Array<Record<string, unknown>>) + '\n',
              );
            }
          }
        } catch (err) {
          emitError(err, !!root.json);
        }
      },
    );
}

// -----------------------------------------------------------------------
// Rendering helpers
// -----------------------------------------------------------------------

function renderTableList(
  tables: Array<{
    name: string;
    description: string;
    category: string;
    time_series: boolean;
    requires_seller_id: boolean;
  }>,
): string {
  if (tables.length === 0) {
    return '\nNo tables in catalog. Check shared/data-tables.yaml.\n';
  }
  // Group tables by category, preserving insertion order within each group.
  const order = ['ad_metrics', 'ops_revenue', 'inventory', 'dimensional', 'other'];
  const byCategory = new Map<string, typeof tables>();
  for (const t of tables) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }
  const sortedCategories = [
    ...order.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !order.includes(c)),
  ];

  const lines: string[] = [];
  for (const cat of sortedCategories) {
    lines.push('');
    lines.push(`## ${cat}`);
    for (const t of byCategory.get(cat)!) {
      const scoping = [
        t.requires_seller_id ? 'needs --seller-id' : '',
        t.time_series ? 'time-series' : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`- \`${t.name}\`  —  ${t.description}` + (scoping ? `  *(${scoping})*` : ''));
    }
  }
  return lines.join('\n');
}

function renderTableDetail(t: {
  name: string;
  description: string;
  category: string;
  time_series: boolean;
  requires_seller_id: boolean;
  account_types?: string[];
  date_column?: string;
}): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`# \`${t.name}\``);
  lines.push('');
  lines.push(t.description);
  lines.push('');
  lines.push(`- **category**: ${t.category}`);
  lines.push(`- **time-series**: ${t.time_series ? 'yes' : 'no'}`);
  lines.push(`- **seller-id filter required**: ${t.requires_seller_id ? 'yes' : 'no'}`);
  if (t.date_column) lines.push(`- **date column**: \`${t.date_column}\``);
  if (t.account_types && t.account_types.length > 0) {
    lines.push(`- **account types**: ${t.account_types.join(', ')}`);
  }
  return lines.join('\n');
}

function renderRowsAsMarkdown(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '_(no rows)_';
  const columns = Object.keys(rows[0]!);
  const headerRow = '| ' + columns.join(' | ') + ' |';
  const sepRow = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const dataRows = rows.map(
    (r) => '| ' + columns.map((c) => formatCellForMd(r[c])).join(' | ') + ' |',
  );
  return [headerRow, sepRow, ...dataRows].join('\n');
}

function formatCellForMd(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const d = v;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const s = String(v);
  return s.replace(/\|/g, '\\|');
}

function handleAccessDeniedExit(kind: string): number {
  // Distinct exit code for table-access-denied so the skill can surface
  // a webhook offer to the user.
  if (kind === 'access_denied_table') return 4;
  return 1;
}

function emitError(err: unknown, json: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    process.stdout.write(
      JSON.stringify({ status: 'error', message }, null, 2) + '\n',
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(1);
}

function parseInt10(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Expected integer, got "${v}"`);
  return n;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
