/**
 * `mixshift forecast budget ...`: a person's own monthly sponsored-ads budget for a
 * forecast, entered from any surface into the gateway's forecasting state (the one
 * home the forecasting app and the computed forecast both read; D-090, D-096).
 *
 * Command shape:
 *   forecast budget show  --scope <scope_id>
 *   forecast budget set   --scope <scope_id> --set YYYY-MM=amount [--set ...] [--note text] [--dry-run]
 *   forecast budget clear --scope <scope_id> --month YYYY-MM [--month ...] [--dry-run]
 *
 *   forecast sub-brand list   [--seller <id>]
 *   forecast sub-brand add    --seller <id> --name <name> --item-label <label> [...] [--campaign-label <label> ...] [--item-group] [--dry-run]
 *   forecast sub-brand remove --scope <sub-brand scope_id> [--apply]
 *
 * `--scope` is the `scope_id` of a forecast answer (`mixshift intelligence run
 * FCT-BASELINE-01 ...`): `src:<database>:<seller id>` for the account as a whole, or
 * `src:<database>:<seller id>:scope:<key>` for a sub-brand inside it, whose budgets
 * are its own (mx-ops#134). Budgets are sponsored ad spend
 * only, the basis the computed forecast stands on. A write changes only the budget
 * (and the note, on a month that has none); the month's other corrections are kept.
 * Re-run FCT-BASELINE-01 afterwards: its next answer stands on the budget. The
 * forecasting app reads these months once it reads MixShift's forecast store.
 *
 * Telemetry: scope id, month COUNT, outcome and failure kind only; never an amount
 * and never the note (a budget is the brand's business figure).
 */

import type { Command } from 'commander';
import {
  applyBudgetPlan,
  beyondHorizon,
  budgetRows,
  canonicalScopeId,
  isSubBrandScope,
  lastUsableMonth,
  noteProblem,
  parseBudgetEntries,
  parseMonths,
  pastMonths,
  planBudgetClear,
  planBudgetSet,
  readMonthRows,
  type BudgetFailure,
} from '../lib/forecast/budget.js';
import { track, EventName } from '../lib/telemetry/index.js';
import {
  applySubBrandRemoval,
  canonicalSubBrandId,
  cleanLabels,
  ensureSubBrand,
  subBrandExists,
  listSubBrands,
  nameProblem,
  planSubBrandRemoval,
  type SubBrand,
} from '../lib/forecast/sub-brand.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerForecastCommands(program: Command): void {
  const forecast = program
    .command('forecast')
    .description('Forecasting inputs you own: the monthly sponsored-ads budget a forecast stands on, and the sub-brands a forecast can be run for.');
  registerSubBrandCommands(forecast);
  const budget = forecast
    .command('budget')
    .description(
      "Show, set or clear the monthly sponsored-ads budget of an account's forecast, or of a sub-brand's. " +
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
        process.stdout.write(`\nNo budget entered for ${scopeId}: the forecast estimates spend from ${isSubBrandScope(scopeId) ? "the sub-brand's" : "the account's"} history.\n`);
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
    .option('--note <text>', 'a note on each month that has none (e.g. where the budget came from); an existing note is kept')
    .option('--dry-run', 'show what would be saved, without saving')
    .action(async (opts: { scope: string; set: string[]; note?: string; dryRun?: boolean }, cmd: Command) => {
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
      const now = new Date();
      const months = entries.map((e) => e.month);
      const past = pastMonths(months, now);
      if (past.length > 0) {
        return badInput(new Error(`${past.join(', ')} ${past.length === 1 ? 'is' : 'are'} already closed; a budget there cannot change the forecast. Enter the month in progress or later.`), !!root.json);
      }
      const far = beyondHorizon(months, now);
      if (far.length > 0) {
        return badInput(new Error(`${far.join(', ')} ${far.length === 1 ? 'is' : 'are'} past the furthest month a forecast reaches (${lastUsableMonth(now)}); enter months up to then.`), !!root.json);
      }
      // An empty --note means no note (the stored one, if any, is kept).
      const note = opts.note?.trim() || undefined;
      const problem = note === undefined ? null : noteProblem(note);
      if (problem) return badInput(new Error(`--note: ${problem}.`), !!root.json);
      // A budget on a sub-brand nobody defined would be rows no forecast ever reads.
      if (isSubBrandScope(scopeId)) {
        const defined = await subBrandExists(scopeId, { dataDirOverride: root.dataDir });
        if (!defined.ok) return fail('set', scopeId, defined, startedAt, root, entries.length);
        if (!defined.exists) {
          return badInput(new Error(`${scopeId} is not a defined sub-brand. Define it with \`mixshift forecast sub-brand add\`, or use the scope_id from its forecast answer.`), !!root.json);
        }
      }
      const r = await applyBudgetPlan(scopeId, (rows) => planBudgetSet(scopeId, rows, entries, note), {
        dataDirOverride: root.dataDir,
        dryRun: opts.dryRun === true,
      });
      if (!r.ok) return fail('set', scopeId, r, startedAt, root, entries.length);
      if (opts.dryRun) {
        const changes = r.plan.writes.map((w) => ({ month: w.key.slice(-10, -3), from: r.current.get(w.key) ?? null, to: (w.doc?.adBudget as { value?: number } | undefined)?.value ?? null }));
        if (root.json) return writeJson({ ok: true, dry_run: true, scope_id: scopeId, changes, unchanged: r.plan.unchanged, notes_kept: r.plan.notesKept });
        process.stdout.write(`\nWould save for ${scopeId} (nothing saved):\n\n`);
        for (const c of changes) process.stdout.write(`  ${c.month}  ${c.from === null ? 'estimate' : formatAmount(c.from)} -> ${formatAmount(c.to ?? 0)}\n`);
        if (r.plan.unchanged.length) process.stdout.write(`\nAlready holding that budget: ${r.plan.unchanged.join(', ')}\n`);
        if (r.plan.notesKept.length) process.stdout.write(`Existing notes kept on: ${r.plan.notesKept.join(', ')}\n`);
        return;
      }
      await track(
        {
          event_name: EventName.ForecastBudgetSet,
          outcome: 'ok',
          duration_ms: Date.now() - startedAt,
          payload: { scope_id: scopeId, months: entries.length, written: r.written, unchanged: r.plan.unchanged.length, notes_kept: r.plan.notesKept.length },
        },
        root.dataDir,
      );
      if (root.json) {
        return writeJson({
          ok: true,
          scope_id: scopeId,
          written: r.written,
          unchanged: r.plan.unchanged,
          notes_kept: r.plan.notesKept,
          budgets: entries.map((e) => ({ month: e.month, sponsored_budget: e.amount })),
        });
      }
      process.stdout.write(`\n✓ Budget saved for ${scopeId}${r.plan.unchanged.length ? ` (${r.plan.unchanged.join(', ')} already held that budget)` : ''}:\n\n`);
      for (const e of entries) process.stdout.write(`  ${e.month}  ${formatAmount(e.amount)}\n`);
      if (r.plan.notesKept.length) process.stdout.write(`\nThe existing note was kept on ${r.plan.notesKept.join(', ')}.\n`);
      process.stdout.write('\nThe next computed forecast (FCT-BASELINE-01) uses these months as planned spend, within the horizon it is run for.\n');
    });

  budget
    .command('clear')
    .description("Remove the budget for one or more months; the forecast goes back to estimating that month's spend.")
    .requiredOption('--scope <scope_id>', 'the forecast scope, e.g. src:<database>:<seller id>')
    .requiredOption('--month <YYYY-MM>', 'a month to clear; repeat per month', collect, [])
    .option('--dry-run', 'show what would be cleared, without clearing')
    .action(async (opts: { scope: string; month: string[]; dryRun?: boolean }, cmd: Command) => {
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
      const r = await applyBudgetPlan(scopeId, (rows) => planBudgetClear(scopeId, rows, months), { dataDirOverride: root.dataDir, dryRun: opts.dryRun === true });
      if (!r.ok) return fail('clear', scopeId, r, startedAt, root, months.length);
      if (opts.dryRun) {
        const clearing = r.plan.writes.map((w) => ({ month: w.key.slice(-10, -3), from: r.current.get(w.key) ?? null }));
        if (root.json) return writeJson({ ok: true, dry_run: true, scope_id: scopeId, clearing, not_set: r.plan.notSet });
        process.stdout.write(`\nWould clear for ${scopeId} (nothing cleared): ${clearing.map((c) => `${c.month} (${formatAmount(c.from ?? 0)})`).join(', ') || 'nothing'}\n`);
        return;
      }
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
  badInput(
    new Error(
      isSubBrandScope(raw)
        ? `"${raw}" is not a sub-brand scope this service keeps: the key after :scope: is 4 to 32 lowercase letters and digits. Use the scope_id from the forecast answer or from \`mixshift forecast sub-brand list\`.`
        : `"${raw}" is not a forecast scope. Use the scope_id from the forecast answer, e.g. src:<database>:<seller id> (or ...:scope:<key> for a sub-brand).`,
    ),
    json,
  );
  return null;
}

// ------------------------------------------------------------ sub-brands

function registerSubBrandCommands(forecast: Command): void {
  const sub = forecast
    .command('sub-brand')
    .description(
      'The sub-brands and item groups of an account: one brand inside a seller account, named by its product and campaign labels, ' +
        'that a forecast can be run for on its own (FCT-READINESS-01 / FCT-BASELINE-01 with scopeKey).',
    );

  sub
    .command('list')
    .description("List an account's sub-brands (or every one in your database, without --seller).")
    .option('--seller <id>', 'the seller id (legacy seller id) of the account')
    .action(async (opts: { seller?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const seller = opts.seller === undefined ? null : sellerOrFail(opts.seller, !!root.json);
      if (seller === undefined) return;
      const r = await listSubBrands(seller, { dataDirOverride: root.dataDir });
      if (!r.ok) return subBrandFail('list', null, seller, r, startedAt, root);
      await track(
        { event_name: EventName.ForecastSubBrandListed, outcome: 'ok', duration_ms: Date.now() - startedAt, payload: { seller, count: r.subBrands.length, skipped: r.skipped } },
        root.dataDir,
      );
      if (root.json) return writeJson({ ok: true, merchant_id: r.merchantId, sub_brands: r.subBrands.map(subBrandJson), skipped: r.skipped });
      if (r.subBrands.length === 0) {
        process.stdout.write(`\nNo sub-brands defined${seller === null ? '' : ` for seller ${seller}`}.\n`);
        return;
      }
      process.stdout.write(`\nSub-brands${seller === null ? '' : ` of seller ${seller}`}:\n\n`);
      for (const s of r.subBrands) process.stdout.write(`  ${s.scopeId}  ${s.name}  ${describeLabels(s)}\n`);
      if (r.skipped) process.stdout.write(`\n${r.skipped} stored definition(s) could not be read and are not listed.\n`);
    });

  sub
    .command('add')
    .description(
      'Define a sub-brand of an account by its labels. If one with exactly these labels exists, it is reused, not duplicated. ' +
        'Labels are compared as the warehouse compares them (case-insensitive).',
    )
    .requiredOption('--seller <id>', 'the seller id (legacy seller id) of the account the brand sits inside')
    .requiredOption('--name <name>', 'what to call it (shown in the forecasting app)')
    .requiredOption('--item-label <label>', "a product label: the brand on Seller Central items, the custom brand on Vendor Central items (or the item group with --item-group); repeat per label", collect, [])
    .option('--campaign-label <label>', 'a campaign label (the brand or item group on campaigns); repeat per label. Without one the sub-brand has no ad spend and cannot be forecast', collect, [])
    .option('--item-group', 'an item group (ItemGroup labels) rather than a sub-brand (Brand labels)')
    .option('--dry-run', 'show what would be defined, without defining it')
    .action(async (opts: { seller: string; name: string; itemLabel: string[]; campaignLabel: string[]; itemGroup?: boolean; dryRun?: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const seller = sellerOrFail(opts.seller, !!root.json);
      if (seller === undefined || seller === null) return;
      const problem = nameProblem(opts.name);
      if (problem) return badInput(new Error(`--name: ${problem}.`), !!root.json);
      let itemValues: string[];
      let campaignValues: string[];
      try {
        itemValues = cleanLabels(opts.itemLabel, '--item-label');
        campaignValues = cleanLabels(opts.campaignLabel, '--campaign-label');
      } catch (err) {
        return badInput(err, !!root.json);
      }
      if (itemValues.length === 0) return badInput(new Error('--item-label: at least one product label; a sub-brand with none holds no sales.'), !!root.json);
      const kind = opts.itemGroup ? 'item_group' : 'sub_brand';
      const r = await ensureSubBrand({ legacySellerId: seller, kind, name: opts.name, itemValues, campaignValues }, { dataDirOverride: root.dataDir, dryRun: opts.dryRun === true });
      if (!r.ok) return subBrandFail('add', null, seller, r, startedAt, root);
      const noAds = campaignValues.length === 0 ? 'It names no campaign label, so it has no ad spend and a forecast cannot train on it.' : null;
      if (opts.dryRun && r.subBrand === null) {
        if (root.json) return writeJson({ ok: true, dry_run: true, would_define: { seller, kind, name: opts.name.trim(), item_values: itemValues, campaign_values: campaignValues }, warning: noAds });
        process.stdout.write(`\nWould define for seller ${seller} (nothing saved): ${opts.name.trim()}  ${describeLabels({ kind, itemValues, campaignValues })}\n`);
        if (noAds) process.stdout.write(`\n${noAds}\n`);
        return;
      }
      const s = r.subBrand!;
      if (!opts.dryRun) {
        await track(
          {
            event_name: EventName.ForecastSubBrandDefined,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: { scope_id: s.scopeId, seller, kind, created: r.created, item_values: itemValues.length, campaign_values: campaignValues.length },
          },
          root.dataDir,
        );
      }
      if (root.json) return writeJson({ ok: true, created: r.created, sub_brand: subBrandJson(s), ...(noAds ? { warning: noAds } : {}) });
      process.stdout.write(
        r.created
          ? `\n✓ Defined ${s.name}: ${s.scopeId}\n  ${describeLabels(s)}\n`
          : `\nAlready defined with these labels: ${s.scopeId} (${s.name}). Reusing it.\n`,
      );
      if (noAds) process.stdout.write(`\n${noAds}\n`);
      process.stdout.write(`\nForecast it with scopeKey "${s.scopeKey}" on FCT-READINESS-01 and FCT-BASELINE-01 (merchant {legacySellerId: ${seller}}).\n`);
    });

  sub
    .command('remove')
    .description(
      'Remove a sub-brand: its definition, its budgets and its settings. Shows what would go; --apply removes it. ' +
        'A forecast the forecasting app published for it stays until it is withdrawn in the app.',
    )
    .requiredOption('--scope <scope_id>', 'the sub-brand scope, src:<database>:<seller id>:scope:<key>')
    .option('--apply', 'remove it (without this, nothing is removed)')
    .action(async (opts: { scope: string; apply?: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const scopeId = canonicalSubBrandId(opts.scope);
      if (!scopeId) return badInput(new Error(`"${opts.scope}" is not a sub-brand scope (src:<database>:<seller id>:scope:<key>).`), !!root.json);
      const planned = await planSubBrandRemoval(scopeId, { dataDirOverride: root.dataDir });
      if (!planned.ok) return subBrandFail('remove', scopeId, null, planned, startedAt, root);
      const p = planned.plan;
      const what = { definition: p.definition, months: p.months, settings: p.settings };
      if (!opts.apply) {
        if (root.json) return writeJson({ ok: true, dry_run: true, scope_id: scopeId, would_remove: what });
        if (p.writes.length === 0) {
          process.stdout.write(`\nNothing is stored under ${scopeId}.\n`);
          return;
        }
        process.stdout.write(`\nWould remove ${scopeId} (nothing removed): ${p.definition ? 'its definition' : 'no definition'}, ${p.months} month row(s), ${p.settings ? 'its settings' : 'no settings'}. Re-run with --apply.\n`);
        process.stdout.write('A forecast the forecasting app published for it is not removed; withdraw it in the app.\n');
        return;
      }
      const r = await applySubBrandRemoval(p, { dataDirOverride: root.dataDir });
      if (!r.ok) return subBrandFail('remove', scopeId, null, r, startedAt, root);
      await track(
        { event_name: EventName.ForecastSubBrandRemoved, outcome: 'ok', duration_ms: Date.now() - startedAt, payload: { scope_id: scopeId, deleted: r.deleted, months: p.months } },
        root.dataDir,
      );
      if (root.json) return writeJson({ ok: true, scope_id: scopeId, removed: what, deleted: r.deleted, published_forecast: 'kept; withdraw it in the forecasting app' });
      process.stdout.write(r.deleted === 0 ? `\nNothing was stored under ${scopeId}.\n` : `\n✓ Removed ${scopeId} (${r.deleted} stored document(s)).\n`);
      process.stdout.write('A forecast the forecasting app published for it is not removed; withdraw it in the app.\n');
    });
}

function subBrandJson(s: SubBrand) {
  return { scope_id: s.scopeId, scope_key: s.scopeKey, merchant_id: s.merchantId, kind: s.kind, name: s.name, item_values: s.itemValues, campaign_values: s.campaignValues, version: s.version };
}

function describeLabels(s: { kind: string; itemValues: readonly string[]; campaignValues: readonly string[] }): string {
  const what = s.kind === 'item_group' ? 'item group' : 'brand';
  return `products with ${what} label ${s.itemValues.map((v) => `"${v}"`).join(' or ') || '(none)'}; campaigns with ${what} label ${s.campaignValues.map((v) => `"${v}"`).join(' or ') || '(none)'}`;
}

/** A seller id, or undefined with the error already written. */
function sellerOrFail(raw: string, json: boolean): number | undefined {
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && /^\d+$/.test(raw.trim())) return n;
  badInput(new Error(`--seller: "${raw}" is not a seller id (the account's legacy seller id, a whole number).`), json);
  return undefined;
}

async function subBrandFail(op: string, scopeId: string | null, seller: number | null, f: BudgetFailure, startedAt: number, root: RootOptions): Promise<void> {
  await track(
    {
      event_name: EventName.ForecastSubBrandFailed,
      outcome: 'failed',
      duration_ms: Date.now() - startedAt,
      payload: { op, scope_id: scopeId, seller, failure_kind: f.kind, http_status: f.httpStatus ?? null, ...(f.unrecognizedKind ? { unrecognized_kind: f.unrecognizedKind } : {}) },
    },
    root.dataDir,
  );
  if (root.json) writeJson({ ok: false, kind: f.kind, message: f.friendly, http_status: f.httpStatus ?? null });
  else process.stderr.write(`\n✗ (${f.kind}) ${f.friendly}\n`);
  process.exitCode = exitCodeFor(f);
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
    case 'unavailable':
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
