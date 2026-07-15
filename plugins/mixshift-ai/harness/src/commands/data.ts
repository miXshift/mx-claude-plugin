import type { Command } from 'commander';
import { resolve as resolvePath } from 'node:path';
import { loadTablesCatalog, describeTable } from '../lib/data/tables-catalog.js';
import { sampleTable } from '../lib/data/sample.js';
import { exportTable } from '../lib/data/export.js';
import { streamQuery } from '../lib/data/query-runner.js';
import { resolveAsinTitles } from '../lib/data/asin-titles.js';
import { createCsvFileSink, fmtBytes, type CsvFileSink } from '../lib/output/csv-file-sink.js';
import { outputDir } from '../lib/paths/resolve.js';

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
    .option('--category <cat>', 'filter by category: ad_metrics | ops_revenue | dimensional | inventory | brand_analytics')
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
          if (opts.out) {
            await runQueryToFile(opts.sql, resolvePath(opts.out), !!root.json, root.dataDir);
          } else {
            await runQueryInlineOrTemp(opts.sql, !!root.json, root.dataDir);
          }
        } catch (err) {
          emitError(err, !!root.json);
        }
      },
    );

  // ---------------------------------------------------------------------
  // asin-titles — resolve ASINs to Title + Brand (the shared name lookup)
  // ---------------------------------------------------------------------
  data
    .command('asin-titles')
    .description(
      'Resolve ASINs to product Title + Brand from the Seller Central catalog. ' +
        'ASINs not listed in mws_items come back under "missing"; resolve those ' +
        'live via mx-amazon-retail catalog.search_items.',
    )
    .requiredOption('--seller-id <id>', 'seller to resolve against', parseInt10)
    .requiredOption('--asins <list>', 'comma-separated ASINs (e.g. B0ABC,B0XYZ)')
    .action(
      async (opts: { sellerId: number; asins: string }, cmd: Command) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const asins = opts.asins.split(',');
          const result = await resolveAsinTitles({
            sellerId: opts.sellerId,
            asins,
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

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: 'ok',
                  seller_id: opts.sellerId,
                  titles: result.titles,
                  missing: result.missing,
                  duration_ms: result.durationMs,
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stderr.write(
              `\n✓ ${result.titles.length} resolved` +
                (result.missing.length ? `, ${result.missing.length} not in catalog` : '') +
                ` (${result.durationMs}ms)\n\n`,
            );
            process.stdout.write(
              renderRowsAsMarkdown(
                result.titles as unknown as Array<Record<string, unknown>>,
              ) + '\n',
            );
            if (result.missing.length) {
              process.stderr.write(
                `\nNot in mws_items (resolve live via mx-amazon-retail catalog.search_items):\n  ` +
                  result.missing.join(', ') +
                  '\n',
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

// -----------------------------------------------------------------------
// `data query` streaming helpers
// -----------------------------------------------------------------------

/** Emit a classified query failure in the shared JSON / stderr shape. */
function emitQueryFailure(
  failure: { kind: string; table_name?: string; friendly: string },
  json: boolean,
): void {
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          status: 'error',
          failure_kind: failure.kind,
          table_name: failure.table_name,
          message: failure.friendly,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
  }
  process.exitCode = handleAccessDeniedExit(failure.kind);
}

/** Progress line writer that only fires when the row count advanced. */
function progressReporter(sink: CsvFileSink): () => void {
  let last = 0;
  return () => {
    const n = sink.rowsWritten();
    if (n > last) {
      last = n;
      process.stderr.write(`  ... ${n} rows (${fmtBytes(sink.bytesWritten())}) written\n`);
    }
  };
}

/** `data query --out <path>`: stream every page straight to the file. */
async function runQueryToFile(
  sql: string,
  outPath: string,
  json: boolean,
  dataDir?: string,
): Promise<void> {
  const sink = createCsvFileSink(outPath);
  const report = progressReporter(sink);
  const streamed = await streamQuery(sql, [], { dataDirOverride: dataDir }, async (rows) => {
    await sink.writePage(rows);
    report();
  });
  if (!streamed.ok) {
    await sink.close().catch(() => {});
    emitQueryFailure(streamed.failure!, json);
    return;
  }
  await sink.close();
  if (json) {
    process.stdout.write(
      JSON.stringify(
        { status: 'ok', row_count: streamed.rowCount, duration_ms: streamed.durationMs, out_path: outPath },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stderr.write(
      `\n✓ ${streamed.rowCount} rows (${streamed.durationMs}ms)\n  written to ${outPath}\n`,
    );
  }
}

/**
 * `data query` with no `--out`: render a small result inline, but if the
 * result is large enough to page, auto-stream it to a temp CSV and report the
 * path instead of dumping tens of thousands of rows inline or failing. We hold
 * only the first page in memory; the moment a second page arrives we flush to
 * disk and stop buffering.
 */
async function runQueryInlineOrTemp(
  sql: string,
  json: boolean,
  dataDir?: string,
): Promise<void> {
  const bufferFirst: Array<Record<string, unknown>> = [];
  // Holder object rather than a bare `let`: the sink is assigned inside the
  // streaming callback, and TS control-flow would otherwise narrow a
  // closure-assigned `let` back to `null` at the reads below.
  const state: { sink: CsvFileSink | null; tempPath: string } = { sink: null, tempPath: '' };
  let report: () => void = () => {};

  const openTemp = (): CsvFileSink => {
    state.tempPath = resolvePath(`${outputDir(dataDir)}/query-${todayISO()}-${Date.now()}.csv`);
    const s = createCsvFileSink(state.tempPath);
    report = progressReporter(s);
    return s;
  };

  const streamed = await streamQuery<Record<string, unknown>>(
    sql,
    [],
    { dataDirOverride: dataDir },
    async (rows, idx) => {
      if (idx === 0) {
        for (const r of rows) bufferFirst.push(r);
        return;
      }
      if (idx === 1) {
        state.sink = openTemp();
        await state.sink.writePage(bufferFirst);
        bufferFirst.length = 0;
      }
      await state.sink!.writePage(rows);
      report();
    },
  );

  if (!streamed.ok) {
    if (state.sink) await state.sink.close().catch(() => {});
    emitQueryFailure(streamed.failure!, json);
    return;
  }

  if (streamed.paginated) {
    // Defensive: pagination happened but everything arrived in page 0 (not
    // observed in practice) — still flush the buffer to a temp file.
    let s = state.sink;
    if (!s) {
      s = openTemp();
      await s.writePage(bufferFirst);
      bufferFirst.length = 0;
    }
    await s.close();
    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            status: 'ok',
            row_count: streamed.rowCount,
            duration_ms: streamed.durationMs,
            out_path: state.tempPath,
            streamed_to_file: true,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(
        `\n✓ ${streamed.rowCount} rows (${streamed.durationMs}ms). Result is large, so I streamed it to a CSV file:\n` +
          `  ${state.tempPath}\n` +
          `  Tip: pass --out <path> next time to choose the destination.\n`,
      );
    }
    return;
  }

  // Single-shot small result → render inline (existing behavior).
  if (json) {
    process.stdout.write(
      JSON.stringify(
        { status: 'ok', row_count: streamed.rowCount, duration_ms: streamed.durationMs, rows: bufferFirst },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stderr.write(`\n✓ ${streamed.rowCount} rows (${streamed.durationMs}ms)\n`);
    process.stdout.write(renderRowsAsMarkdown(bufferFirst) + '\n');
  }
}

function handleAccessDeniedExit(kind: string): number {
  // Distinct exit code for table-access-denied so the skill can surface
  // a webhook offer to the user.
  if (kind === 'access_denied_table') return 4;
  return 1;
}

function emitError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    process.stdout.write(
      JSON.stringify({ status: 'error', message }, null, 2) + '\n',
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}

function parseInt10(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Expected integer, got "${v}"`);
  return n;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
