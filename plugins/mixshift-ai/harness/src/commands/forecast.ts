/**
 * `mixshift forecast budget ...`: a person's own monthly sponsored-ads budget for a
 * forecast, entered from any surface into the gateway's forecasting state (the one
 * home the forecasting app and the computed forecast both read; D-090, D-096).
 *
 * Command shape:
 *   forecast budget show  --scope <scope_id>
 *   forecast budget set   --scope <scope_id> --set YYYY-MM=amount [--set ...] [--note text]
 *   forecast budget clear --scope <scope_id> --month YYYY-MM [--month ...]
 *
 * `--scope` is the `scope_id` of a forecast answer (`mixshift intelligence run
 * FCT-BASELINE-01 ...`), e.g. `src:<database>:<seller id>`. Budgets are sponsored ad
 * spend only, the basis the computed forecast stands on. A write changes only the
 * budget (and the note when one is given); the month's other corrections are kept.
 * Re-run FCT-BASELINE-01 afterwards: its next answer stands on the budget.
 *
 * Telemetry: scope id, month COUNT, outcome and failure kind only; never an amount
 * and never the note (a budget is the brand's business figure).
 */

import type { Command } from 'commander';
import {
  applyBudgetPlan,
  budgetRows,
  canonicalScopeId,
  parseBudgetEntries,
  parseMonths,
  pastMonths,
  planBudgetClear,
  planBudgetSet,
  readMonthRows,
  type BudgetFailure,
} from '../lib/forecast/budget.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

const NOTE_MAX = 2000;

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerForecastCommands(program: Command): void {
  const forecast = program
    .command('forecast')
    .description('Forecasting inputs you own: the monthly sponsored-ads budget a forecast stands on.');
  const budget = forecast
    .command('budget')
    .description(
      "Show, set or clear an account's monthly sponsored-ads budget for its forecast. " +
        'The scope is the scope_id of a forecast answer (FCT-BASELINE-01).',
    );

  budget
    .command('show')
    .description('List the months that have a budget entered.')
    .requiredOption('--scope <scope_id>', 'the forecast scope, e.g. src:<database>:<seller id>')
    .action(async (opts: { scope: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const scopeId = scopeOrFail(opts.scope, !!root.json);
      if (!scopeId) return;
      const read = await readMonthRows(scopeId, { dataDirOverride: root.dataDir });
      if (!read.ok) return fail('show', scopeId, read, startedAt, root);
      const rows = budgetRows(read.rows);
      await track(
        { event_name: EventName.ForecastBudgetShown, outcome: 'ok', duration_ms: Date.now() - startedAt, payload: { scope_id: scopeId, months: rows.length } },
        root.dataDir,
      );
      if (root.json) return writeJson({ ok: true, scope_id: scopeId, budgets: rows });
      if (rows.length === 0) {
        process.stdout.write(`\nNo budget entered for ${scopeId}: the forecast estimates spend from the account's history.\n`);
        return;
      }
      process.stdout.write(`\nSponsored-ads budgets for ${scopeId}:\n\n`);
      for (const r of rows) {
        process.stdout.write(`  ${r.month}  ${formatAmount(r.sponsored_budget)}${r.note ? `  (${r.note})` : ''}\n`);
      }
    });

  budget
    .command('set')
    .description('Enter the sponsored-ads budget for one or more months (one save: all months or none).')
    .requiredOption('--scope <scope_id>', 'the forecast scope, e.g. src:<database>:<seller id>')
    .requiredOption('--set <YYYY-MM=amount>', 'a month and its sponsored budget; repeat per month', collect, [])
    .option('--note <text>', 'a note saved on each month (e.g. where the budget came from)')
    .action(async (opts: { scope: string; set: string[]; note?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const scopeId = scopeOrFail(opts.scope, !!root.json);
      if (!scopeId) return;
      let entries;
      try {
        entries = parseBudgetEntries(opts.set);
      } catch (err) {
        return badInput(err, !!root.json);
      }
      const past = pastMonths(entries.map((e) => e.month), new Date());
      if (past.length > 0) {
        return badInput(new Error(`${past.join(', ')} ${past.length === 1 ? 'is' : 'are'} already closed; a budget there cannot change the forecast. Enter the month in progress or later.`), !!root.json);
      }
      const note = opts.note?.trim();
      if (note !== undefined && (note.length > NOTE_MAX || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(note))) {
        return badInput(new Error(`--note must be plain text of at most ${NOTE_MAX} characters.`), !!root.json);
      }
      const r = await applyBudgetPlan(scopeId, (rows) => planBudgetSet(scopeId, rows, entries, note === '' ? undefined : note), {
        dataDirOverride: root.dataDir,
      });
      if (!r.ok) return fail('set', scopeId, r, startedAt, root, entries.length);
      await track(
        {
          event_name: EventName.ForecastBudgetSet,
          outcome: 'ok',
          duration_ms: Date.now() - startedAt,
          payload: { scope_id: scopeId, months: entries.length, written: r.written, unchanged: r.plan.unchanged.length },
        },
        root.dataDir,
      );
      if (root.json) {
        return writeJson({
          ok: true,
          scope_id: scopeId,
          written: r.written,
          unchanged: r.plan.unchanged,
          budgets: entries.map((e) => ({ month: e.month, sponsored_budget: e.amount })),
        });
      }
      process.stdout.write(`\n✓ Budget saved for ${scopeId}${r.plan.unchanged.length ? ` (${r.plan.unchanged.join(', ')} already held that budget)` : ''}:\n\n`);
      for (const e of entries) process.stdout.write(`  ${e.month}  ${formatAmount(e.amount)}\n`);
      process.stdout.write('\nThe next forecast run (FCT-BASELINE-01) stands on these months; the forecasting app shows them too.\n');
    });

  budget
    .command('clear')
    .description("Remove the budget for one or more months; the forecast goes back to estimating that month's spend.")
    .requiredOption('--scope <scope_id>', 'the forecast scope, e.g. src:<database>:<seller id>')
    .requiredOption('--month <YYYY-MM>', 'a month to clear; repeat per month', collect, [])
    .action(async (opts: { scope: string; month: string[] }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const scopeId = scopeOrFail(opts.scope, !!root.json);
      if (!scopeId) return;
      let months;
      try {
        months = parseMonths(opts.month);
      } catch (err) {
        return badInput(err, !!root.json);
      }
      const r = await applyBudgetPlan(scopeId, (rows) => planBudgetClear(scopeId, rows, months), { dataDirOverride: root.dataDir });
      if (!r.ok) return fail('clear', scopeId, r, startedAt, root, months.length);
      await track(
        {
          event_name: EventName.ForecastBudgetCleared,
          outcome: 'ok',
          duration_ms: Date.now() - startedAt,
          payload: { scope_id: scopeId, months: months.length, written: r.written, not_set: r.plan.notSet.length },
        },
        root.dataDir,
      );
      if (root.json) return writeJson({ ok: true, scope_id: scopeId, cleared: r.written, not_set: r.plan.notSet });
      process.stdout.write(
        `\n✓ ${r.written} month(s) cleared for ${scopeId}` + (r.plan.notSet.length ? `; no budget was entered for ${r.plan.notSet.join(', ')}` : '') + '.\n',
      );
    });
}

function scopeOrFail(raw: string, json: boolean): string | null {
  const scopeId = canonicalScopeId(raw);
  if (scopeId) return scopeId;
  badInput(new Error(`"${raw}" is not a forecast scope. Use the scope_id from the forecast answer, e.g. src:<database>:<seller id>.`), json);
  return null;
}

function formatAmount(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function badInput(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) writeJson({ ok: false, kind: 'bad_input', message });
  else process.stderr.write(`\n✗ ${message}\n`);
  process.exitCode = 4;
}

/** Exit codes in the same spirit as the intelligence command's table. */
function exitCodeFor(f: BudgetFailure): number {
  switch (f.kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2;
    case 'bad_params':
    case 'too_large':
      return 4;
    case 'scope_not_yours':
    case 'merchant_not_connected':
      return 5;
    case 'conflict':
    case 'throttled':
      return 8;
    case 'insufficient_scope':
      return 12;
    case 'state_home_elsewhere':
      return 13;
    default:
      return 1;
  }
}

async function fail(
  op: 'show' | 'set' | 'clear',
  scopeId: string,
  f: BudgetFailure,
  startedAt: number,
  root: RootOptions,
  months?: number,
): Promise<void> {
  await track(
    {
      event_name: EventName.ForecastBudgetFailed,
      outcome: 'failed',
      duration_ms: Date.now() - startedAt,
      error_class: f.kind,
      payload: {
        op,
        scope_id: scopeId,
        ...(months !== undefined ? { months } : {}),
        failure_kind: f.kind,
        ...(f.httpStatus ? { http_status: f.httpStatus } : {}),
        ...(f.unrecognizedKind ? { unrecognized_kind: f.unrecognizedKind } : {}),
      },
    },
    root.dataDir,
  );
  if (root.json) writeJson({ ok: false, kind: f.kind, message: f.friendly, http_status: f.httpStatus, unrecognized_kind: f.unrecognizedKind });
  else process.stderr.write(`\n✗ (${f.kind}) ${f.friendly}\n`);
  process.exitCode = exitCodeFor(f);
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
