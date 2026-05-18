/**
 * `mixshift prefetch --brand <slug> --skill <id> [--date <yyyy-mm-dd>]`
 *
 * Runs the SQL batches declared in `skills/<id>/skill.manifest.yaml`
 * against the warehouse and writes the data artifacts under
 * `~/.mixshift/clients/<brand>/runs/<skill>/<date>/`.
 *
 * Outputs (chat-friendly text by default, JSON when `--json` is set):
 *   - The artifact directory path
 *   - Per-query status (ok / failed / missing_params)
 *   - Total duration
 */

import type { Command } from 'commander';
import { runPrefetch, type PrefetchResult } from '../lib/prefetch/runner.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface PrefetchCommandOptions {
  brand: string;
  skill: string;
  date: string;
  param?: string[];
}

export function registerPrefetchCommand(program: Command): void {
  program
    .command('prefetch')
    .description(
      'Run a skill\'s SQL batches against the warehouse and write data artifacts.',
    )
    .requiredOption('--brand <slug>', 'brand slug (must be onboarded)')
    .requiredOption('--skill <skill-id>', 'skill ID (subdirectory under skills/)')
    .option('--date <yyyy-mm-dd>', 'run date (default: today)', todayISO())
    .option(
      '--param <name=value>',
      'override a standard param (repeatable). Values are JSON-parsed if ' +
        'possible — pass `--param lookback_days=7` for an int.',
      collectParam,
      [] as string[],
    )
    .action(async (opts: PrefetchCommandOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const paramOverrides = parseParamOverrides(opts.param ?? []);
        const result = await runPrefetch({
          brand: opts.brand,
          skill: opts.skill,
          runDate: opts.date,
          dataDirOverride: root.dataDir,
          paramOverrides,
        });
        renderResult(result, !!root.json);
        process.exitCode = exitCodeFor(result);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`error: ${message}\n`);
        }
        process.exitCode = 1;
        return;
      }
    });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function collectParam(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

function parseParamOverrides(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(
        `--param expects name=value, got "${pair}". Example: --param lookback_days=7`,
      );
    }
    const name = pair.slice(0, eq);
    const rawVal = pair.slice(eq + 1);
    // Try JSON first so `--param lookback_days=7` becomes int 7, then
    // `--param seller_id_list=[1,2,3]` becomes a number array. Fall back
    // to raw string.
    try {
      out[name] = JSON.parse(rawVal);
    } catch {
      out[name] = rawVal;
    }
  }
  return out;
}

function renderResult(result: PrefetchResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const okCount = result.queries.filter((q) => q.status === 'ok').length;
  const failedCount = result.queries.filter((q) => q.status === 'failed').length;
  const deferredCount = result.queries.filter((q) => q.status === 'deferred').length;

  const countsLine =
    `${okCount} ok` +
    (failedCount > 0 ? `, ${failedCount} failed` : '') +
    (deferredCount > 0 ? `, ${deferredCount} deferred` : '');

  process.stdout.write(
    `\n✓ Prefetch complete — ${result.skill_id} for ${result.brand_slug} (${result.run_date})\n` +
      `  - queries: ${countsLine}\n` +
      `  - duration: ${result.total_duration_ms} ms\n` +
      `  - data.json: ${result.artifact_paths.data_json_path}\n` +
      `  - data.md:   ${result.artifact_paths.data_md_path}\n`,
  );

  // List failed queries explicitly — skill needs to know what's broken
  // before composing the report.
  const failures = result.queries.filter((q) => q.status === 'failed');
  if (failures.length > 0) {
    process.stdout.write('\n  Failed queries:\n');
    for (const f of failures) {
      process.stdout.write(`    ✗ ${f.id}: ${f.error ?? 'unknown'}\n`);
    }
  }

  // List deferred queries — these aren't broken, they need the skill model
  // to supply cross-query / conditional params on a follow-up call.
  const deferrals = result.queries.filter((q) => q.status === 'deferred');
  if (deferrals.length > 0) {
    process.stdout.write('\n  Deferred queries (skill provides params on follow-up):\n');
    for (const d of deferrals) {
      const missing = d.missing_params?.join(', ') ?? '(unknown)';
      process.stdout.write(`    ⊘ ${d.id}: needs ${missing}\n`);
    }
  }
  process.stdout.write('\n');
}

function exitCodeFor(result: PrefetchResult): number {
  // 0 = all queries succeeded (deferred queries are not failures)
  // 2 = at least one real query failed (artifacts still written for inspection)
  // Deferred-only runs exit 0 since the skill knows how to handle them.
  return result.partial_failure ? 2 : 0;
}
