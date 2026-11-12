/**
 * `mixshift labels ...` — read the labels you put on your items (ASINs) and
 * Amazon campaigns, through the MixShift service (lib/labels/client.ts).
 *
 * Command shape:
 *   labels state                                         is it on, and how fresh is the copy
 *   labels fields --account <id> [--entity item|campaign]    the fields, and the values in use
 *   labels get --account <id> (--ids a,b,c | --ids-file <path>) [--entity ...]
 *   labels search --account <id> [--entity ...] [--field <key> --value <text>]
 *                 [--limit n] [--cursor c] [--all]
 *   labels drift --account <id> [--entity ...] [--limit n] [--cursor c] [--all]
 *   labels changes --account <id> [--since <UTC time>] [--limit n] [--cursor c] [--all]
 *   (all take --json)
 *
 * `--account` is the legacy seller id (one merchant in one marketplace): the
 * `legacySellerId` that `mixshift amazon merchants` lists.
 *
 * Reads only and free; nothing here can change a label. A label is shown as it
 * stands in MixShift, which while the service is "observing" is a copy kept
 * current from the Data Manager about every 15 minutes.
 *
 * Output contract: `--json` prints ONE compact JSON object on one line, last
 * on stdout, and nothing else on stdout (human notes go to stderr), so a
 * parent that reads the last stdout line gets the whole answer. Handlers set
 * process.exitCode and return (never process.exit). Telemetry captures the call
 * kind, entity, counts and outcome; it never carries a label value, a field
 * value filter, an id or the answer.
 */

import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  LABEL_ENTITIES,
  LOOKUP_MAX,
  PAGE_MAX,
  collectPages,
  exitCodeForLabelsKind,
  isLabelsFailure,
  labelsChanges,
  labelsDrift,
  labelsFields,
  labelsList,
  labelsLookup,
  labelsState,
  type DriftRow,
  type LabelChange,
  type LabelEntity,
  type LabelFieldInfo,
  type LabelRow,
  type LabelsChangesPage,
  type LabelsDriftPage,
  type LabelsFailure,
  type LabelsFieldsAnswer,
  type LabelsPage,
  type LabelsServiceState,
  type LabelsStateAnswer,
} from '../lib/labels/client.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

/** `--all` stops after this many rows (checked between pages) and says so. */
export const ALL_CAP = 2000;

const DEFAULT_PAGE = 50;

type CallKind = 'state' | 'fields' | 'get' | 'search' | 'drift' | 'changes';

export function registerLabelsCommands(program: Command): void {
  const labels = program
    .command('labels')
    .description(
      'Read the labels on your items (ASINs) and Amazon campaigns: Item Group, Brand, Nickname, Parent ASIN, ' +
        'Item Label 1 and 2, Tags 1 to 4, and for campaigns Manager and Objective. Reads only, and free. ' +
        'Turned on account by account: until it is on for yours, each command says so. --account is the ' +
        'legacy seller id from `mixshift amazon merchants`.',
    );

  labels
    .command('state')
    .description('Whether labels are turned on for your account, and how fresh the copy is.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const result = await labelsState({ dataDirOverride: root.dataDir });
      if (isLabelsFailure(result)) return fail(result, 'state', startedAt, root, {});
      await trackLabels('state', 'ok', startedAt, root.dataDir, { service_state: result.state, running: result.running });
      if (root.json) return writeJson({ status: 'ok', ...withoutOk(result) });
      process.stdout.write(renderState(result) + '\n');
    });

  labels
    .command('fields')
    .description('The label fields of one account for items and campaigns, with the values in use and how many carry each.')
    .requiredOption('--account <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--entity <entity>', 'item or campaign (default: both)')
    .action(async (opts: { account: string; entity?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const account = parseAccount(opts.account);
      if (!account) return badInput(accountMessage(), root);
      const entities = opts.entity === undefined ? [...LABEL_ENTITIES] : parseEntity(opts.entity);
      if (!entities) return badInput(entityMessage(), root);
      const answers: LabelsFieldsAnswer[] = [];
      for (const entity of entities) {
        const result = await labelsFields({ account, entity }, { dataDirOverride: root.dataDir });
        if (isLabelsFailure(result)) return fail(result, 'fields', startedAt, root, { account: Number(account), entity: entities.length === 1 ? entity : 'both' });
        answers.push(result);
      }
      await trackLabels('fields', 'ok', startedAt, root.dataDir, {
        account: Number(account),
        entity: entities.length === 1 ? entities[0] : 'both',
        service_state: answers[0]!.state,
        fields: answers.reduce((n, a) => n + a.fields.length, 0),
      });
      if (root.json) {
        return writeJson({
          status: 'ok',
          account: Number(account),
          state: answers[0]!.state,
          merchant_type: answers[0]!.merchant_type,
          entities: Object.fromEntries(answers.map((a) => [a.entity, withoutOk(a)])),
        });
      }
      noteFreshness(answers[0]!.state);
      process.stdout.write(answers.map(renderFields).join('\n\n') + '\n');
    });

  labels
    .command('get')
    .description('The labels of specific items (ASINs) or campaigns (Amazon campaign ids) on one account, by id. Takes any number of ids (looked up 500 at a time).')
    .requiredOption('--account <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--ids <list>', 'comma-separated ASINs (or campaign ids with --entity campaign)')
    .option('--ids-file <path>', 'a text file of ids, separated by commas, spaces or new lines')
    .option('--entity <entity>', 'item (default) or campaign')
    .action(async (opts: { account: string; ids?: string; idsFile?: string; entity?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const account = parseAccount(opts.account);
      if (!account) return badInput(accountMessage(), root);
      const parsedEntity = parseEntity(opts.entity ?? 'item');
      if (!parsedEntity || parsedEntity.length !== 1) return badInput(entityMessage(), root);
      const entity = parsedEntity[0]!;
      if ((opts.ids === undefined) === (opts.idsFile === undefined)) return badInput('Pass either --ids <a,b,c> or --ids-file <path>.', root);
      let raw: string;
      try {
        raw = opts.ids !== undefined ? opts.ids : await readFile(opts.idsFile as string, 'utf8');
      } catch (err) {
        return badInput(`Cannot read --ids-file: ${err instanceof Error ? err.message : String(err)}`, root);
      }
      const ids = [...new Set(raw.split(/[\s,]+/).filter((s) => s.length > 0))];
      if (ids.length === 0) return badInput('No ids given.', root);
      if (entity === 'campaign') {
        const bad = ids.find((id) => !/^[0-9]{1,20}$/.test(id));
        if (bad !== undefined) return badInput('A campaign id is the Amazon campaign id: 1 to 20 digits. Check --ids.', root);
      }
      const result = await labelsLookup({ account, entity, ids }, { dataDirOverride: root.dataDir });
      const base = { account: Number(account), entity };
      if (isLabelsFailure(result)) return fail(result, 'get', startedAt, root, { ...base, requested: ids.length, batches: Math.ceil(ids.length / LOOKUP_MAX) });
      const rows = result.results.map(describeRow);
      const counts = countStates(rows);
      await trackLabels('get', 'ok', startedAt, root.dataDir, { ...base, service_state: result.state, requested: ids.length, batches: result.batches, unseen: counts.never_seen, blank: counts.blank, labeled: counts.labeled });
      if (root.json) {
        return writeJson({
          status: 'ok',
          account: result.account,
          entity,
          state: result.state,
          merchant_type: result.merchant_type,
          fields: result.fields,
          requested: ids.length,
          batches: result.batches,
          counts,
          unseen: result.unseen,
          results: rows,
        });
      }
      process.stderr.write(`\n✓ ${ids.length} ${entity === 'item' ? 'item' : 'campaign'} id(s): ${counts.labeled} labeled, ${counts.blank} blank, ${counts.never_seen} never seen\n`);
      noteFreshness(result.state);
      process.stdout.write(renderRows(rows, result.fields) + '\n');
    });

  labels
    .command('search')
    .description('List the items or campaigns of one account with their labels, a page at a time. With --field and --value, only those whose field equals that exact value (take it from `labels fields`).')
    .requiredOption('--account <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--entity <entity>', 'item (default) or campaign')
    .option('--field <key>', 'a field key from `labels fields` (for example item_group); needs --value')
    .option('--value <text>', 'the exact value to match, case and spacing included; needs --field')
    .option('--limit <n>', `rows a page, 1 to ${PAGE_MAX} (default ${DEFAULT_PAGE})`)
    .option('--cursor <cursor>', 'continue from the next_cursor of a previous page of the same search')
    .option('--all', `follow every page, up to ${ALL_CAP} rows; says when it stopped and how to continue`)
    .action(async (opts: { account: string; entity?: string; field?: string; value?: string; limit?: string; cursor?: string; all?: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const account = parseAccount(opts.account);
      if (!account) return badInput(accountMessage(), root);
      const parsedEntity = parseEntity(opts.entity ?? 'item');
      if (!parsedEntity || parsedEntity.length !== 1) return badInput(entityMessage(), root);
      const entity = parsedEntity[0]!;
      if ((opts.field === undefined) !== (opts.value === undefined)) return badInput('Pass --field and --value together, or neither.', root);
      if (opts.value !== undefined && opts.value.length === 0) return badInput('--value must not be empty.', root);
      const limit = parseLimit(opts.limit, opts.all ? PAGE_MAX : DEFAULT_PAGE);
      if (limit === null) return badInput(limitMessage(), root);
      const filter = opts.field !== undefined ? { field: opts.field, value: opts.value as string } : {};
      const base = { account: Number(account), entity, has_filter: opts.field !== undefined, all: !!opts.all };
      const fetchPage = (cursor: string | undefined) => labelsList({ account, entity, ...filter, ...(cursor !== undefined ? { cursor } : {}), limit }, { dataDirOverride: root.dataDir });
      const paged = await collectPages<LabelRow, LabelsPage>(fetchPage, { cap: opts.all ? ALL_CAP : 1, ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) });
      if (isLabelsFailure(paged)) return fail(paged, 'search', startedAt, root, base);
      const rows = paged.rows.map(describeRow);
      const counts = countStates(rows);
      const more = paged.first.has_more && (opts.all ? paged.truncated : true);
      const nextCursor = opts.all ? (paged.truncated ? paged.next_cursor : null) : paged.first.next_cursor;
      await trackLabels('search', 'ok', startedAt, root.dataDir, { ...base, service_state: paged.first.state, rows: rows.length, pages: paged.pages, truncated: opts.all ? paged.truncated : false, has_more: more });
      if (root.json) {
        return writeJson({
          status: 'ok',
          account: paged.first.account,
          entity,
          state: paged.first.state,
          merchant_type: paged.first.merchant_type,
          fields: paged.first.fields,
          count: rows.length,
          pages: paged.pages,
          counts,
          has_more: more,
          truncated: opts.all ? paged.truncated : false,
          next_cursor: nextCursor,
          items: rows,
        });
      }
      process.stderr.write(`\n✓ ${rows.length} ${entity === 'item' ? 'item' : 'campaign'}(s)${opts.all ? ` over ${paged.pages} page(s)` : ''}${opts.field !== undefined ? ' matching the filter' : ''}\n`);
      noteFreshness(paged.first.state);
      process.stdout.write(renderRows(rows, paged.first.fields) + '\n');
      if (opts.all && paged.truncated) {
        process.stdout.write(`\nStopped after ${rows.length} rows (the --all cap is ${ALL_CAP}); there are more. Continue with --cursor ${nextCursor}\n`);
      } else if (!opts.all && more) {
        process.stdout.write(`\nMore rows: add --cursor ${nextCursor} (or use --all).\n`);
      }
    });

  labels
    .command('drift')
    .description('Items and campaigns whose Data Manager rows disagree with each other on a label (for example a new SKU that inherited another marketplace\'s value), with the values each holds.')
    .requiredOption('--account <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--entity <entity>', 'item or campaign (default: both)')
    .option('--limit <n>', `rows a page, 1 to ${PAGE_MAX} (default ${DEFAULT_PAGE})`)
    .option('--cursor <cursor>', 'continue from the next_cursor of a previous page')
    .option('--all', `follow every page, up to ${ALL_CAP} rows; says when it stopped and how to continue`)
    .action(async (opts: { account: string; entity?: string; limit?: string; cursor?: string; all?: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const account = parseAccount(opts.account);
      if (!account) return badInput(accountMessage(), root);
      const parsedEntity = opts.entity === undefined ? undefined : parseEntity(opts.entity);
      if (parsedEntity === null || (parsedEntity !== undefined && parsedEntity.length !== 1)) return badInput(entityMessage(), root);
      const entity = parsedEntity?.[0];
      const limit = parseLimit(opts.limit, opts.all ? PAGE_MAX : DEFAULT_PAGE);
      if (limit === null) return badInput(limitMessage(), root);
      const base = { account: Number(account), entity: entity ?? 'both', all: !!opts.all };
      const fetchPage = (cursor: string | undefined) => labelsDrift({ account, ...(entity ? { entity } : {}), ...(cursor !== undefined ? { cursor } : {}), limit }, { dataDirOverride: root.dataDir });
      const paged = await collectPages<DriftRow, LabelsDriftPage>(fetchPage, { cap: opts.all ? ALL_CAP : 1, ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) });
      if (isLabelsFailure(paged)) return fail(paged, 'drift', startedAt, root, base);
      const more = paged.first.has_more && (opts.all ? paged.truncated : true);
      const nextCursor = opts.all ? (paged.truncated ? paged.next_cursor : null) : paged.first.next_cursor;
      await trackLabels('drift', 'ok', startedAt, root.dataDir, { ...base, service_state: paged.first.state, rows: paged.rows.length, pages: paged.pages, truncated: opts.all ? paged.truncated : false, has_more: more });
      if (root.json) {
        return writeJson({
          status: 'ok',
          account: paged.first.account,
          state: paged.first.state,
          merchant_type: paged.first.merchant_type,
          count: paged.rows.length,
          pages: paged.pages,
          has_more: more,
          truncated: opts.all ? paged.truncated : false,
          next_cursor: nextCursor,
          drift: paged.rows,
        });
      }
      process.stderr.write(`\n✓ ${paged.rows.length} item(s) or campaign(s) whose rows disagree${opts.all ? ` over ${paged.pages} page(s)` : ''}\n`);
      noteFreshness(paged.first.state);
      process.stdout.write(renderDrift(paged.rows) + '\n');
      if (opts.all && paged.truncated) {
        process.stdout.write(`\nStopped after ${paged.rows.length} rows (the --all cap is ${ALL_CAP}); there are more. Continue with --cursor ${nextCursor}\n`);
      } else if (!opts.all && more) {
        process.stdout.write(`\nMore rows: add --cursor ${nextCursor} (or use --all).\n`);
      }
    });

  labels
    .command('changes')
    .description('What changed in an account\'s labels, as a forward feed, oldest first: the field, what it was before, what it is now, where the change came from and when. Changes show after a two-minute settle delay.')
    .requiredOption('--account <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--since <time>', 'start of the feed, a UTC time like 2026-11-12T08:30:00Z or a date like 2026-11-12 (inclusive); default: from the beginning')
    .option('--limit <n>', `rows a page, 1 to ${PAGE_MAX} (default ${DEFAULT_PAGE})`)
    .option('--cursor <cursor>', 'continue a feed from the next_cursor of a previous page (not with --since)')
    .option('--all', `follow every page, up to ${ALL_CAP} rows; says when it stopped and how to continue`)
    .action(async (opts: { account: string; since?: string; limit?: string; cursor?: string; all?: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const account = parseAccount(opts.account);
      if (!account) return badInput(accountMessage(), root);
      const limit = parseLimit(opts.limit, opts.all ? PAGE_MAX : DEFAULT_PAGE);
      if (limit === null) return badInput(limitMessage(), root);
      if (opts.since !== undefined && opts.cursor !== undefined) return badInput('Pass --since to start a feed, or --cursor to continue one, not both.', root);
      let since: string | undefined;
      if (opts.since !== undefined) {
        since = parseSince(opts.since) ?? undefined;
        if (since === undefined) return badInput('--since must be a UTC time like 2026-11-12T08:30:00Z, or a date like 2026-11-12.', root);
      }
      const base = { account: Number(account), has_since: since !== undefined, all: !!opts.all };
      const fetchPage = (cursor: string | undefined) =>
        labelsChanges({ account, ...(cursor === undefined && since !== undefined ? { since } : {}), ...(cursor !== undefined ? { cursor } : {}), limit }, { dataDirOverride: root.dataDir });
      const paged = await collectPages<LabelChange, LabelsChangesPage>(fetchPage, { cap: opts.all ? ALL_CAP : 1, ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) });
      if (isLabelsFailure(paged)) return fail(paged, 'changes', startedAt, root, base);
      const last = paged.next_cursor;
      await trackLabels('changes', 'ok', startedAt, root.dataDir, { ...base, service_state: paged.first.state, rows: paged.rows.length, pages: paged.pages, truncated: opts.all ? paged.truncated : false });
      if (root.json) {
        return writeJson({
          status: 'ok',
          account: paged.first.account,
          state: paged.first.state,
          merchant_type: paged.first.merchant_type,
          count: paged.rows.length,
          pages: paged.pages,
          has_more: opts.all ? paged.truncated : paged.first.has_more,
          truncated: opts.all ? paged.truncated : false,
          next_cursor: last,
          ...(paged.first.as_of !== undefined ? { as_of: paged.first.as_of } : {}),
          ...(paged.first.settle_seconds !== undefined ? { settle_seconds: paged.first.settle_seconds } : {}),
          changes: paged.rows,
        });
      }
      process.stderr.write(`\n✓ ${paged.rows.length} change(s)${opts.all ? ` over ${paged.pages} page(s)` : ''}\n`);
      noteFreshness(paged.first.state);
      process.stdout.write(renderChanges(paged.rows) + '\n');
      if (opts.all ? paged.truncated : paged.first.has_more) {
        process.stdout.write(`\nMore changes: continue with --cursor ${last}\n`);
      } else if (last !== null) {
        process.stdout.write(`\nUp to date. To poll for newer changes later, pass --cursor ${last}\n`);
      }
    });
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The legacy seller id: digits, no leading zero (the service refuses anything else). */
export function parseAccount(raw: string): string | null {
  const v = raw.trim();
  return /^[1-9][0-9]{0,15}$/.test(v) ? v : null;
}

/** The one entity named, as a list of one; null when it is neither item nor campaign. */
function parseEntity(raw: string): LabelEntity[] | null {
  const v = raw.trim().toLowerCase();
  return (LABEL_ENTITIES as readonly string[]).includes(v) ? [v as LabelEntity] : null;
}

function parseLimit(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,4}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= PAGE_MAX ? n : null;
}

/** A UTC time as the service takes it; a bare date means 00:00:00 UTC. Anything with another zone is refused, not guessed. */
export function parseSince(raw: string): string | null {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return isRealTime(`${v}T00:00:00Z`) ? `${v}T00:00:00Z` : null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v)) return isRealTime(v) ? v : null;
  return null;
}

function isRealTime(v: string): boolean {
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v.slice(0, 10);
}

const accountMessage = () => '--account must be the legacy seller id (digits). Run `mixshift amazon merchants` for the ids you can use (legacySellerId).';
const entityMessage = () => `--entity must be one of ${LABEL_ENTITIES.join(' or ')}.`;
const limitMessage = () => `--limit must be a whole number from 1 to ${PAGE_MAX}.`;

// ---------------------------------------------------------------------------
// Rows: never seen, blank, labeled (and cleared)
// ---------------------------------------------------------------------------

/**
 * The three states a lookup can tell apart. `never_seen`: the service has not
 * read this id yet. `blank`: it knows the id and no label is set. `labeled`:
 * at least one label is set (or a clear is still on its way to the Data
 * Manager, flagged `cleared` on that label).
 */
export type LabelState = 'never_seen' | 'blank' | 'labeled';

export interface DescribedRow {
  id: string;
  status: 'seen' | 'unseen';
  label_state: LabelState;
  labels: Record<string, { value: string; sync: string; updated_at: string; cleared?: true }>;
}

export function describeRow(row: LabelRow): DescribedRow {
  const labels: DescribedRow['labels'] = {};
  for (const [key, v] of Object.entries(row.labels ?? {})) labels[key] = { ...v, ...(v.value === '' ? { cleared: true as const } : {}) };
  const labelState: LabelState = row.status === 'unseen' ? 'never_seen' : Object.keys(labels).length === 0 ? 'blank' : 'labeled';
  return { id: row.id, status: row.status, label_state: labelState, labels };
}

function countStates(rows: readonly DescribedRow[]): Record<LabelState, number> {
  const c: Record<LabelState, number> = { never_seen: 0, blank: 0, labeled: 0 };
  for (const r of rows) c[r.label_state] += 1;
  return c;
}

// ---------------------------------------------------------------------------
// Failure and output plumbing
// ---------------------------------------------------------------------------

function writeJson(obj: unknown): void {
  // One compact object on one line, last on stdout: a parent that reads the last line gets all of it.
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function withoutOk<T extends { ok: true }>(a: T): Omit<T, 'ok'> {
  const { ok: _ok, ...rest } = a;
  return rest;
}

function badInput(message: string, root: RootOptions): void {
  if (root.json) writeJson({ status: 'error', failure_kind: 'invalid_input', message });
  else process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

async function fail(failure: LabelsFailure, kind: CallKind, startedAt: number, root: RootOptions, base: Record<string, unknown>): Promise<void> {
  await trackLabels(kind, 'failed', startedAt, root.dataDir, {
    ...base,
    kind_failed: failure.kind,
    ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
    ...(failure.unrecognizedKind ? { unrecognized_kind: failure.unrecognizedKind } : {}),
    ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
  });
  if (root.json) {
    writeJson({
      status: 'error',
      failure_kind: failure.kind,
      message: failure.friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      retryable: failure.retryable,
      invalid_params: failure.invalidParams,
      unrecognized_kind: failure.unrecognizedKind,
    });
  } else if (failure.kind === 'not_enabled') {
    // Not a fault: the service is being turned on account by account. One plain sentence.
    process.stderr.write(`${failure.friendly}\n`);
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.message && failure.message !== failure.friendly) process.stderr.write(`  ${failure.message}\n`);
    if (failure.kind === 'not_found') process.stderr.write('  Run `mixshift amazon merchants` for the account ids you can use (the legacySellerId).\n');
  }
  process.exitCode = exitCodeForLabelsKind(failure.kind);
}

async function trackLabels(kind: CallKind, outcome: 'ok' | 'failed', startedAt: number, dataDir: string | undefined, payload: Record<string, unknown>): Promise<void> {
  await track(
    {
      event_name: EventName.LabelsCalled,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(outcome === 'failed' && typeof payload.kind_failed === 'string' ? { error_class: payload.kind_failed } : {}),
      payload: { kind, ...payload },
    },
    dataDir,
  );
}

function noteFreshness(state: LabelsServiceState): void {
  if (state === 'observing') {
    process.stderr.write('  (labels are a copy kept current from the Data Manager about every 15 minutes, so a label edited there can show here up to 15 minutes later)\n');
  }
}

// ---------------------------------------------------------------------------
// Rendering (chat markdown; --json carries the full envelope)
// ---------------------------------------------------------------------------

const MAX_CELL = 40;

function cell(s: string | null | undefined, max = MAX_CELL): string {
  if (s === null || s === undefined || s === '') return '-';
  const one = s.replace(/\s+/g, ' ').replace(/\|/g, '/');
  const points = Array.from(one);
  return points.length > max ? points.slice(0, max - 1).join('') + '…' : one;
}

const blank = (v: string | null | undefined, none = '(blank)'): string => (v === null || v === undefined ? none : v === '' ? '(blank)' : cell(v));

export function renderState(s: LabelsStateAnswer): string {
  const L: string[] = [];
  const word =
    s.state === 'off' ? 'not turned on yet' : s.state === 'observing' ? 'on, observing (a copy kept current from the Data Manager)' : 'on';
  L.push(`**Labels: ${word}**`, '');
  if (s.freshness.note) L.push(s.freshness.note, '');
  L.push(`- state: ${s.state}`);
  if (s.state !== 'off') {
    L.push(`- first full copy finished: ${s.backfilled_at ?? 'not yet'}`);
    L.push(`- last refresh completed: ${s.last_completed_at ?? 'none yet'}`);
    if (s.last_run) {
      const r = s.last_run;
      L.push(`- latest run: ${r.mode ?? '?'} ${r.status ?? '?'}${r.finished_at ? `, finished ${r.finished_at}` : ''}${r.complete === false ? ' (incomplete)' : ''}`);
      const counts = Object.entries(r.counts ?? {});
      if (counts.length > 0) L.push(`  counts: ${counts.map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}`);
    }
    L.push(`- refreshing now: ${s.running ? 'yes' : 'no'}`);
  } else {
    L.push('- Your MixShift contact can turn labels on for your account.');
  }
  return L.join('\n');
}

export function renderFields(a: LabelsFieldsAnswer): string {
  const L: string[] = [];
  L.push(`**${a.entity === 'item' ? `${a.merchant_type ? a.merchant_type + ' items' : 'Items'}` : 'Campaigns'}: ${a.fields.length} label fields**`, '');
  L.push('| key | name | max length | labeled | distinct values | most used values |', '|---|---|---|---|---|---|');
  for (const f of a.fields) L.push(renderFieldRow(f));
  const cut = a.fields.filter((f) => f.values_truncated);
  if (cut.length > 0) L.push('', `Value lists are cut to the most used for: ${cut.map((f) => f.key).join(', ')} (the full list stays in --json up to ${a.values_limit?.max_values ?? 500} values a field).`);
  if (a.values_as_of) L.push('', `Values in use as of ${a.values_as_of} (kept up to a minute).`);
  return L.join('\n');
}

function renderFieldRow(f: LabelFieldInfo): string {
  const name = f.display_name ? `${f.display_name} (${f.label})` : f.label;
  const top = f.values.slice(0, 5).map((v) => `${cell(v.value, 24)} (${v.count})`).join('; ');
  return `| ${f.key} | ${cell(name)} | ${f.max_length} ${f.length_unit} | ${f.items_labeled} | ${f.distinct_values}${f.values_truncated ? '+' : ''} | ${top || '-'} |`;
}

/**
 * One row per id; a column per label field that any row carries. The status
 * column says never seen, blank or labeled; a label shows its sync state when
 * it has not reached the Data Manager yet, and a clear that has not shows as
 * `(cleared)`.
 */
export function renderRows(rows: readonly DescribedRow[], fields: readonly string[]): string {
  if (rows.length === 0) return '_(none)_';
  const used = fields.filter((k) => rows.some((r) => r.labels[k] !== undefined));
  const cols = ['id', 'status', ...used];
  const L: string[] = [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`];
  for (const r of rows) {
    const status = r.label_state === 'never_seen' ? 'never seen' : r.label_state;
    const cells = used.map((k) => {
      const v = r.labels[k];
      if (!v) return '-';
      const text = v.cleared ? '(cleared)' : cell(v.value);
      return v.sync === 'synced' ? text : `${text} [${v.sync}]`;
    });
    L.push(`| ${[cell(r.id, 24), status, ...cells].join(' | ')} |`);
  }
  L.push('', 'never seen: the service has not read this id yet. blank: known, no label set (a clear that has reached the Data Manager also reads blank). [pending] or [failed]: the change has not reached the Data Manager yet.');
  return L.join('\n');
}

export function renderDrift(rows: readonly DriftRow[]): string {
  if (rows.length === 0) return '_(no drift: every row agrees)_';
  const L = ['| entity | id | field | values in the Data Manager rows | the Data Manager picks | MixShift holds | last seen |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    L.push(`| ${r.entity} | ${cell(r.id, 24)} | ${r.field} | ${r.legacy_values.map((v) => blank(v)).join(' / ')} | ${blank(r.picked_value)} | ${blank(r.store_value, '(no row)')} | ${r.last_seen_at} |`);
  }
  return L.join('\n');
}

export function renderChanges(rows: readonly LabelChange[]): string {
  if (rows.length === 0) return '_(no changes in this window)_';
  const L = ['| time | entity | id | field | before | after | source | by |', '|---|---|---|---|---|---|---|---|'];
  for (const c of rows) {
    const before = c.before === null ? '(never set)' : blank(c.before);
    const after = c.after === null || c.after === '' ? '(cleared)' : cell(c.after);
    L.push(`| ${c.time} | ${c.entity} | ${cell(c.entity_id, 24)} | ${c.field} | ${before} | ${after} | ${c.source} | ${cell(c.actor)} |`);
  }
  L.push('', 'before (never set): the field had no value. after (cleared): the value was removed.');
  return L.join('\n');
}
