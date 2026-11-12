/**
 * Command-level tests for `mixshift labels ...`, run through the REAL client
 * against a mocked gateway (a stubbed fetch and a stubbed sign-in): the
 * flag-to-request mapping, the --json shape and its last-line rule, exit codes,
 * the not-turned-on sentence, paging, id batching, never-seen vs blank vs
 * cleared, and telemetry that carries counts and outcome but never a label
 * value, an id, or the answer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALL_CAP, MAX_IDS, describeRow, normalizeIds, parseSince, registerLabelsCommands, renderChanges, renderRows } from './labels.js';
import { track } from '../lib/telemetry/index.js';

vi.mock('../lib/auth/credentials.js', () => ({
  loadCredentials: vi.fn(async () => ({ credentials: { datahub: { api_base: 'https://svc.test' } } })),
  getValidAccessToken: vi.fn(async () => 'tok-secret-123'),
}));

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

// ---------------------------------------------------------------------------
// A mocked gateway. Made-up account, ids and values throughout: this repo is public.
// ---------------------------------------------------------------------------

type Reply = { status: number; body: unknown };
let gateway: (url: URL, init: RequestInit) => Reply;
const fetchMock = vi.fn(async (u: unknown, init?: RequestInit) => {
  const r = gateway(new URL(String(u)), init ?? {});
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
});

const ACCOUNT = '12345';
const SECRET_VALUE = 'Zebra Crossing Line';
const NOT_ENABLED: Reply = { status: 403, body: { ok: false, kind: 'not_enabled', friendly: 'Labels are not turned on for your account yet. Your MixShift contact can turn them on.' } };

const label = (value: string, sync: 'synced' | 'pending' | 'failed' = 'synced') => ({ value, sync, updated_at: '2026-11-10T00:00:00.000Z' });

const STATE_OBSERVING = {
  ok: true,
  state: 'observing',
  backfilled_at: '2026-11-01T10:00:00.000Z',
  last_run: { mode: 'reconcile', status: 'completed', started_at: '2026-11-12T10:00:00.000Z', finished_at: '2026-11-12T10:01:00.000Z', complete: true, duration_ms: 60000, counts: { accounts: 3, rows_read: 900 } },
  last_completed_at: '2026-11-12T10:01:00.000Z',
  running: false,
  freshness: { typical_lag_minutes: 15, note: 'The store is a copy kept current from the Data Manager.' },
};

const fieldsBody = (entity: string) => ({
  ok: true,
  state: 'observing',
  account: 12345,
  merchant_type: 'Seller',
  entity,
  fields: [
    { key: 'item_group', label: 'Item Group', display_name: 'Product Line', legacy_column: 'ItemGroup', max_length: 250, length_unit: 'chars', items_labeled: 2, distinct_values: 2, values: [{ value: SECRET_VALUE, count: 2 }], values_truncated: false },
    { key: 'tag_1', label: 'Tag 1', display_name: null, legacy_column: 'Tag1', max_length: 250, length_unit: 'chars', items_labeled: 900, distinct_values: 900, values: [{ value: 'T1', count: 3 }], values_truncated: true },
  ],
  values_limit: { max_values: 500, max_characters: 200000, order: 'count descending, then value' },
  values_as_of: '2026-11-12T10:00:00.000Z',
});

/** One page of `n` items starting at `from`, with `next` as the next cursor. */
const itemsPage = (rows: Array<{ id: string; labels?: Record<string, unknown>; status?: string }>, next: string | null, entity = 'item') => ({
  ok: true,
  state: 'observing',
  account: 12345,
  merchant_type: 'Seller',
  entity,
  fields: ['item_group', 'brand', 'tag_1'],
  [entity === 'item' ? 'items' : 'campaigns']: rows.map((r) => ({ id: r.id, status: r.status ?? 'seen', labels: r.labels ?? {} })),
  next,
  next_cursor: next,
  has_more: next !== null,
  limit: 50,
});

let stdout = '';
let stderr = '';
let tmp: string;

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR')
    // The real root program owns --surface (telemetry host, cli.ts); declared here so a labels
    // option can never collide with it without this suite noticing.
    .option('--surface <surface>', 'telemetry host flag');
  registerLabelsCommands(program);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', ...args]);
}

/** The last non-empty stdout line, parsed: the contract a parent that reads the last line relies on. */
function lastLineJson(): Record<string, unknown> {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  return JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
}

const calls = (): URL[] => fetchMock.mock.calls.map((c) => new URL(String(c[0])));
const lastTrack = () =>
  vi.mocked(track).mock.calls.at(-1)![0] as { event_name: string; outcome?: string; error_class?: string; payload: Record<string, unknown> };

beforeEach(async () => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  tmp = await mkdtemp(join(tmpdir(), 'labels-test-'));
  vi.stubGlobal('fetch', fetchMock);
  gateway = () => {
    throw new Error('unexpected gateway call');
  };
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  vi.mocked(track).mockClear();
  process.exitCode = undefined;
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('labels state', () => {
  it('prints the state, freshness and last run; --json is one object on the last stdout line', async () => {
    gateway = () => ({ status: 200, body: STATE_OBSERVING });
    await run('labels', 'state');
    expect(stdout).toContain('**Labels: on, observing');
    expect(stdout).toContain('- first full copy finished: 2026-11-01T10:00:00.000Z');
    expect(stdout).toContain('counts: accounts 3, rows read 900');
    expect(process.exitCode).toBeUndefined();
    expect(calls()[0].pathname).toBe('/api/labels/state');

    stdout = '';
    await run('--json', 'labels', 'state');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(lastLineJson()).toMatchObject({ status: 'ok', state: 'observing', running: false });
    expect(lastLineJson()).not.toHaveProperty('ok');
    expect(lastTrack()).toMatchObject({ event_name: 'labels.called', outcome: 'ok', payload: { kind: 'state', service_state: 'observing' } });
  });

  it('an off tenant is an answer with a plain line, not an error', async () => {
    gateway = () => ({ status: 200, body: { ok: true, state: 'off', backfilled_at: null, last_run: null, last_completed_at: null, running: false, freshness: { note: 'Labels are not turned on for this account; nothing is stored yet.' } } });
    await run('labels', 'state');
    expect(stdout).toContain('**Labels: not turned on yet**');
    expect(stdout).toContain('Your MixShift contact can turn labels on');
    expect(process.exitCode).toBeUndefined();
  });

  it('not_enabled from the service renders as one plain sentence on stderr, exit 6, no stack', async () => {
    gateway = () => NOT_ENABLED;
    await run('labels', 'fields', '--account', ACCOUNT);
    expect(stderr).toBe('Labels are not turned on for your account yet. Your MixShift contact can turn them on.\n');
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(6);
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: 'not_enabled', payload: { kind: 'fields', http_status: 403 } });
  });
});

describe('failures and input checks', () => {
  it('--json not_enabled: one error object on the last line, failure_kind and the same sentence', async () => {
    gateway = () => NOT_ENABLED;
    await run('--json', 'labels', 'search', '--account', ACCOUNT);
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'not_enabled', http_status: 403, message: 'Labels are not turned on for your account yet. Your MixShift contact can turn them on.' });
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(process.exitCode).toBe(6);
  });

  it('an account this login cannot see (not_found, 404) is exit 7 with the service sentence', async () => {
    gateway = () => ({ status: 404, body: { ok: false, kind: 'not_found', friendly: 'No such account for this login.' } });
    await run('labels', 'drift', '--account', '999');
    expect(stderr).toContain('✗ No such account for this login.');
    expect(stderr).toContain('mixshift amazon merchants');
    expect(process.exitCode).toBe(7);
    await run('--json', 'labels', 'drift', '--account', '999');
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'not_found', http_status: 404 });
  });

  it('refuses a bad --account, --entity, --limit, --since and id inputs before any call', async () => {
    const bad = [
      ['labels', 'fields', '--account', 'abc'],
      ['labels', 'fields', '--account', '012'],
      ['labels', 'fields', '--account', ACCOUNT, '--entity', 'brand'],
      ['labels', 'search', '--account', ACCOUNT, '--limit', '500'],
      ['labels', 'search', '--account', ACCOUNT, '--limit', '0'],
      ['labels', 'search', '--account', ACCOUNT, '--field', 'brand'],
      ['labels', 'search', '--account', ACCOUNT, '--value', 'x'],
      ['labels', 'changes', '--account', ACCOUNT, '--since', 'yesterday'],
      ['labels', 'changes', '--account', ACCOUNT, '--since', '2026-11-12T08:30:00+02:00'],
      ['labels', 'changes', '--account', ACCOUNT, '--since', '2026-11-12', '--cursor', 'C'],
      ['labels', 'get', '--account', ACCOUNT],
      ['labels', 'get', '--account', ACCOUNT, '--ids', 'B0EXAMPLE01', '--ids-file', join(tmp, 'none.txt')],
      ['labels', 'get', '--account', ACCOUNT, '--ids-file', join(tmp, 'missing.txt')],
      ['labels', 'get', '--account', ACCOUNT, '--ids', ' , ,'],
      ['labels', 'get', '--account', ACCOUNT, '--entity', 'campaign', '--ids', 'B0EXAMPLE01'],
    ];
    for (const args of bad) {
      process.exitCode = undefined;
      await run(...args);
      expect(process.exitCode, args.join(' ')).toBe(1);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    stdout = '';
    await run('--json', 'labels', 'fields', '--account', 'abc');
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'invalid_input' });
  });

  it('a server bad_params is exit 15 and names the parameter', async () => {
    gateway = () => ({ status: 400, body: { ok: false, kind: 'bad_params', friendly: 'The items labels have no field "nope".' } });
    await run('--json', 'labels', 'search', '--account', ACCOUNT, '--field', 'nope', '--value', 'x');
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'bad_params', http_status: 400 });
    expect(process.exitCode).toBe(15);
  });

  it('never prints the bearer token, in any output or telemetry', async () => {
    gateway = () => NOT_ENABLED;
    await run('labels', 'state');
    await run('--json', 'labels', 'state');
    gateway = () => ({ status: 200, body: STATE_OBSERVING });
    await run('labels', 'state');
    expect(stdout + stderr + JSON.stringify(vi.mocked(track).mock.calls)).not.toContain('tok-secret-123');
    for (const c of fetchMock.mock.calls) expect((c[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-secret-123' });
  });
});

describe('labels fields', () => {
  it('without --entity reads both, prints a table per entity with display name, counts and top values', async () => {
    gateway = (url) => ({ status: 200, body: fieldsBody(url.searchParams.get('entity') as string) });
    await run('labels', 'fields', '--account', ACCOUNT);
    expect(calls().map((u) => u.searchParams.get('entity'))).toEqual(['item', 'campaign']);
    expect(calls()[0].searchParams.get('account')).toBe(ACCOUNT);
    expect(stdout).toContain('**Seller items: 2 label fields**');
    expect(stdout).toContain('**Campaigns: 2 label fields**');
    expect(stdout).toContain(`| item_group | Product Line (Item Group) | 250 chars | 2 | 2 | ${SECRET_VALUE} (2) |`);
    expect(stdout).toContain('| tag_1 | Tag 1 | 250 chars | 900 | 900+ | T1 (3) |');
    expect(stdout).toContain('Value lists are cut to the most used for: tag_1');
    expect(stdout).toContain('Values in use as of 2026-11-12T10:00:00.000Z');
    expect(stderr).toContain('up to 15 minutes later');
  });

  it('--entity campaign makes one call; --json keys the answers by entity and tracks counts only', async () => {
    gateway = (url) => ({ status: 200, body: fieldsBody(url.searchParams.get('entity') as string) });
    await run('--json', 'labels', 'fields', '--account', ACCOUNT, '--entity', 'campaign');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const out = lastLineJson() as { entities: Record<string, { fields: unknown[] }>; account: number };
    expect(Object.keys(out.entities)).toEqual(['campaign']);
    expect(out.account).toBe(12345);
    expect(out.entities.campaign.fields).toHaveLength(2);
    expect(lastTrack().payload).toMatchObject({ kind: 'fields', entity: 'campaign', fields: 2, account: 12345 });
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain(SECRET_VALUE);
  });
});

describe('labels get', () => {
  const lookup = (rows: Record<string, unknown>[]) => ({ ok: true, state: 'observing', account: 12345, merchant_type: 'Seller', entity: 'item', fields: ['item_group', 'brand', 'tag_1'], results: rows, unseen: rows.filter((r) => r.status === 'unseen').map((r) => r.id) });

  it('tells never seen, blank, labeled and a pending clear apart, in the table and in --json', async () => {
    const rows = [
      { id: 'B0LABELED01', status: 'seen', labels: { item_group: label(SECRET_VALUE), tag_1: label('Spring', 'pending') } },
      { id: 'B0BLANK0001', status: 'seen', labels: {} },
      { id: 'B0CLEARED01', status: 'seen', labels: { brand: label('', 'pending') } },
      { id: 'B0NEVER0001', status: 'unseen', labels: {} },
    ];
    gateway = (_u, init) => ({ status: 200, body: lookup(rows.filter((r) => (JSON.parse(String(init.body)).ids as string[]).map((x) => x.toUpperCase()).includes(r.id as string))) });
    await run('labels', 'get', '--account', ACCOUNT, '--ids', 'b0labeled01, B0BLANK0001,B0CLEARED01,B0NEVER0001');
    expect(stderr).toContain('✓ 4 item id(s): 2 labeled, 1 blank, 1 never seen');
    expect(stdout).toContain('| id | status | item_group | brand | tag_1 |');
    expect(stdout).toContain(`| B0LABELED01 | labeled | ${SECRET_VALUE} | - | Spring [pending] |`);
    expect(stdout).toContain('| B0BLANK0001 | blank | - | - | - |');
    expect(stdout).toContain('| B0CLEARED01 | labeled | - | (cleared) [pending] | - |');
    expect(stdout).toContain('| B0NEVER0001 | never seen | - | - | - |');
    expect(stdout).toContain('never seen: the service has not read this id yet.');

    stdout = '';
    await run('--json', 'labels', 'get', '--account', ACCOUNT, '--ids', 'B0LABELED01,B0BLANK0001,B0CLEARED01,B0NEVER0001');
    const out = lastLineJson() as { counts: Record<string, number>; unseen: string[]; results: Array<{ id: string; label_state: string; labels: Record<string, { cleared?: boolean }> }> };
    expect(out.counts).toEqual({ never_seen: 1, blank: 1, labeled: 2 });
    expect(out.unseen).toEqual(['B0NEVER0001']);
    expect(out.results.map((r) => r.label_state)).toEqual(['labeled', 'blank', 'labeled', 'never_seen']);
    expect(out.results[2].labels.brand.cleared).toBe(true);
    expect(out.results[0].labels.item_group.cleared).toBeUndefined();
    expect(stdout.trim().split('\n')).toHaveLength(1);
    // Telemetry: counts only. No id, no label value.
    const t = JSON.stringify(vi.mocked(track).mock.calls);
    expect(lastTrack().payload).toMatchObject({ kind: 'get', entity: 'item', requested: 4, batches: 1, unseen: 1, blank: 1, labeled: 2 });
    expect(t).not.toMatch(/B0LABELED01|B0NEVER0001|Zebra|Spring/);
  });

  it('batches 1,201 ids from --ids-file (commas, spaces and new lines) into three calls of 500, 500 and 201', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `B0EX${String(i).padStart(6, '0')}`);
    const file = join(tmp, 'ids.txt');
    await writeFile(file, ids.slice(0, 600).join('\n') + '\n' + ids.slice(600, 900).join(', ') + '\n' + ids.slice(900).join(' ') + '\n');
    gateway = (_u, init) => ({ status: 200, body: lookup((JSON.parse(String(init.body)).ids as string[]).map((id) => ({ id, status: 'seen', labels: {} }))) });
    await run('--json', 'labels', 'get', '--account', ACCOUNT, '--ids-file', file);
    const sizes = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).ids.length);
    expect(sizes).toEqual([500, 500, 201]);
    expect(calls().every((u) => u.pathname === '/api/labels/items/lookup')).toBe(true);
    const out = lastLineJson() as { requested: number; batches: number; counts: Record<string, number>; results: unknown[] };
    expect(out).toMatchObject({ requested: 1201, batches: 3 });
    expect(out.results).toHaveLength(1201);
    expect(out.counts.blank).toBe(1201);
    expect(lastTrack().payload).toMatchObject({ requested: 1201, batches: 3 });
  });

  it('campaigns go to the campaigns lookup with the ids as strings', async () => {
    gateway = (_u, init) => ({ status: 200, body: { ...lookup((JSON.parse(String(init.body)).ids as string[]).map((id) => ({ id, status: 'seen', labels: { objective: label('Example') } }))), entity: 'campaign', fields: ['objective'] } });
    await run('labels', 'get', '--account', ACCOUNT, '--entity', 'campaign', '--ids', '111222333,444555666');
    expect(calls()[0].pathname).toBe('/api/labels/campaigns/lookup');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ account: 12345, ids: ['111222333', '444555666'] });
    expect(stdout).toContain('| id | status | objective |');
  });

  it('a failing batch fails the command (exit 1 for a retryable not_available) and prints no partial table', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `B0EX${String(i).padStart(6, '0')}`).join(',');
    let n = 0;
    gateway = (_u, init) => (++n === 1 ? { status: 200, body: lookup((JSON.parse(String(init.body)).ids as string[]).map((id) => ({ id, status: 'seen', labels: {} }))) } : { status: 503, body: { ok: false, kind: 'not_available', friendly: 'Labels could not be checked right now. Try again in a minute.', retryable: true } });
    await run('labels', 'get', '--account', ACCOUNT, '--ids', ids);
    expect(stdout).toBe('');
    expect(stderr).toContain('Labels could not be checked right now');
    expect(process.exitCode).toBe(1);
    expect(lastTrack().payload).toMatchObject({ kind_failed: 'not_available', retryable: true, requested: 600 });
  });
});

describe('labels search', () => {
  const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, labels: { item_group: label(SECRET_VALUE) } }));

  it('first page: default limit 50, filter in the query, a next-cursor line, and telemetry without the value or ids', async () => {
    gateway = () => ({ status: 200, body: itemsPage(rows('B0PAGE', 2), 'CURSOR-2') });
    await run('labels', 'search', '--account', ACCOUNT, '--field', 'item_group', '--value', SECRET_VALUE);
    const q = Object.fromEntries(calls()[0].searchParams);
    expect(calls()[0].pathname).toBe('/api/labels/items');
    expect(q).toEqual({ account: ACCOUNT, field: 'item_group', value: SECRET_VALUE, limit: '50' });
    expect(stderr).toContain('✓ 2 item(s) matching the filter');
    expect(stdout).toContain('| B0PAGE0 | labeled | Zebra Crossing Line |');
    expect(stdout).toContain('More rows: add --cursor CURSOR-2 (or use --all).');
    expect(lastTrack().payload).toMatchObject({ kind: 'search', entity: 'item', has_filter: true, all: false, rows: 2, pages: 1, has_more: true });
    const t = JSON.stringify(vi.mocked(track).mock.calls);
    expect(t).not.toMatch(/Zebra|B0PAGE|CURSOR-2/);
  });

  it('--cursor and --limit reach the service; --json carries next_cursor and has_more', async () => {
    gateway = () => ({ status: 200, body: itemsPage(rows('B0PAGE', 1), null) });
    await run('--json', 'labels', 'search', '--account', ACCOUNT, '--limit', '7', '--cursor', 'CURSOR-2');
    expect(Object.fromEntries(calls()[0].searchParams)).toEqual({ account: ACCOUNT, cursor: 'CURSOR-2', limit: '7' });
    expect(lastLineJson()).toMatchObject({ status: 'ok', count: 1, has_more: false, truncated: false, next_cursor: null });
  });

  it('campaigns: --entity campaign uses the campaigns path and reads its rows', async () => {
    gateway = () => ({ status: 200, body: itemsPage([{ id: '111', labels: { objective: label('Example') } }], null, 'campaign') });
    await run('--json', 'labels', 'search', '--account', ACCOUNT, '--entity', 'campaign');
    expect(calls()[0].pathname).toBe('/api/labels/campaigns');
    expect((lastLineJson() as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('--all follows the cursors to the end (page size 200) and says how many pages', async () => {
    const pages: Record<string, unknown> = {
      '': itemsPage(rows('A', 200), 'P2'),
      P2: itemsPage(rows('B', 200), 'P3'),
      P3: itemsPage(rows('C', 5), null),
    };
    gateway = (url) => ({ status: 200, body: pages[url.searchParams.get('cursor') ?? ''] });
    await run('--json', 'labels', 'search', '--account', ACCOUNT, '--all');
    expect(calls().map((u) => u.searchParams.get('limit'))).toEqual(['200', '200', '200']);
    expect(calls().map((u) => u.searchParams.get('cursor'))).toEqual([null, 'P2', 'P3']);
    expect(lastLineJson()).toMatchObject({ count: 405, pages: 3, has_more: false, truncated: false, next_cursor: null });
  });

  it(`--all stops at the ${ALL_CAP}-row cap, says so, and gives the cursor to continue`, async () => {
    let n = 0;
    gateway = () => ({ status: 200, body: itemsPage(rows(`P${n}-`, 200), `NEXT-${++n}`) });
    await run('labels', 'search', '--account', ACCOUNT, '--all');
    expect(fetchMock).toHaveBeenCalledTimes(ALL_CAP / 200);
    expect(stdout).toContain(`Stopped after ${ALL_CAP} rows (the --all cap is ${ALL_CAP}); there are more. Continue with --cursor NEXT-10`);
    expect(lastTrack().payload).toMatchObject({ all: true, rows: ALL_CAP, pages: 10, truncated: true });

    stdout = '';
    n = 0;
    await run('--json', 'labels', 'search', '--account', ACCOUNT, '--all');
    expect(lastLineJson()).toMatchObject({ count: ALL_CAP, truncated: true, has_more: true, next_cursor: 'NEXT-10' });
  });

  it('--all that hits a failing page fails the whole command rather than returning a short list', async () => {
    let n = 0;
    gateway = () => (++n === 1 ? { status: 200, body: itemsPage(rows('A', 3), 'P2') } : { status: 503, body: { ok: false, kind: 'not_available', friendly: 'Labels could not be checked right now. Try again in a minute.', retryable: true } });
    await run('--json', 'labels', 'search', '--account', ACCOUNT, '--all');
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'not_available', retryable: true });
    expect(process.exitCode).toBe(1);
  });
});

describe('labels drift', () => {
  const drift = (next: string | null) => ({
    ok: true,
    state: 'observing',
    account: 12345,
    merchant_type: 'Seller',
    drift: [{ entity: 'item', id: 'B0DRIFT0001', field: 'brand', legacy_values: ['Example A', ''], picked_value: 'Example A', store_value: null, first_seen_at: '2026-11-10T00:00:00.000Z', last_seen_at: '2026-11-12T00:00:00.000Z' }],
    next,
    next_cursor: next,
    has_more: next !== null,
    limit: 50,
  });

  it('renders each disagreement with blank and no-row spelled out; --json carries the rows', async () => {
    gateway = () => ({ status: 200, body: drift(null) });
    await run('labels', 'drift', '--account', ACCOUNT);
    expect(calls()[0].pathname).toBe('/api/labels/drift');
    expect(calls()[0].searchParams.get('entity')).toBeNull();
    expect(stdout).toContain('| item | B0DRIFT0001 | brand | Example A / (blank) | Example A | (no row) | 2026-11-12T00:00:00.000Z |');
    stdout = '';
    await run('--json', 'labels', 'drift', '--account', ACCOUNT, '--entity', 'item');
    expect(calls()[1].searchParams.get('entity')).toBe('item');
    expect(lastLineJson()).toMatchObject({ status: 'ok', count: 1, has_more: false });
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toMatch(/B0DRIFT|Example A/);
  });

  it('an account with no drift says so', async () => {
    gateway = () => ({ status: 200, body: { ...drift(null), drift: [] } });
    await run('labels', 'drift', '--account', ACCOUNT);
    expect(stdout).toContain('no drift');
  });
});

describe('labels changes', () => {
  const change = (id: string, before: string | null, after: string | null) => ({ id, entity: 'item', entity_id: 'B0CHANGE001', field: 'tag_1', before, after, result: 'applied', source: 'dash', actor: null, time: '2026-11-12T09:00:00.123456Z', change_set_id: null, undoes: null });
  const feed = (rows: unknown[], hasMore: boolean, next = 'POS-1') => ({ ok: true, state: 'observing', account: 12345, merchant_type: 'Seller', changes: rows, position: {}, next_cursor: next, has_more: hasMore, limit: 50, as_of: '2026-11-12T10:00:00.000Z', settle_seconds: 120 });

  it('shows never set, a value and cleared; a bare --since date means 00:00:00 UTC; prints the poll cursor', async () => {
    gateway = () => ({ status: 200, body: feed([change('c1', null, 'Spring'), change('c2', 'Spring', ''), change('c3', '', 'Summer')], false) });
    await run('labels', 'changes', '--account', ACCOUNT, '--since', '2026-11-12', '--limit', '10');
    expect(Object.fromEntries(calls()[0].searchParams)).toEqual({ account: ACCOUNT, since: '2026-11-12T00:00:00Z', limit: '10' });
    expect(stdout).toContain('| 2026-11-12T09:00:00.123456Z | item | B0CHANGE001 | tag_1 | (never set) | Spring | Data Manager | - |');
    expect(stdout).toContain('| Spring | (cleared) |');
    expect(stdout).toContain('| (blank) | Summer |');
    expect(stdout).toContain('Up to date. To poll for newer changes later, pass --cursor POS-1');
    expect(lastTrack().payload).toMatchObject({ kind: 'changes', has_since: true, rows: 3 });
  });

  it('--cursor continues a feed and sends no since; --json says has_more and carries the cursor', async () => {
    gateway = () => ({ status: 200, body: feed([change('c1', null, 'Spring')], true, 'POS-2') });
    await run('--json', 'labels', 'changes', '--account', ACCOUNT, '--cursor', 'POS-1');
    expect(Object.fromEntries(calls()[0].searchParams)).toEqual({ account: ACCOUNT, cursor: 'POS-1', limit: '50' });
    expect(lastLineJson()).toMatchObject({ status: 'ok', count: 1, has_more: true, next_cursor: 'POS-2', settle_seconds: 120, as_of: '2026-11-12T10:00:00.000Z' });
  });

  it('--all follows has_more, sending the cursor and never the since after the first page', async () => {
    const seq = [feed([change('c1', null, 'A')], true, 'POS-2'), feed([change('c2', 'A', 'B')], false, 'POS-3')];
    gateway = () => ({ status: 200, body: seq.shift() });
    await run('--json', 'labels', 'changes', '--account', ACCOUNT, '--since', '2026-11-01T00:00:00Z', '--all');
    expect(calls().map((u) => u.searchParams.get('since'))).toEqual(['2026-11-01T00:00:00Z', null]);
    expect(calls().map((u) => u.searchParams.get('cursor'))).toEqual([null, 'POS-2']);
    expect(lastLineJson()).toMatchObject({ count: 2, pages: 2, has_more: false, truncated: false, next_cursor: 'POS-3' });
  });

  it('parseSince takes a UTC time or a date and refuses anything it would have to guess', () => {
    expect(parseSince('2026-11-12T08:30:00Z')).toBe('2026-11-12T08:30:00Z');
    expect(parseSince('2026-11-12T08:30:00.5Z')).toBe('2026-11-12T08:30:00.5Z');
    expect(parseSince('2026-11-12')).toBe('2026-11-12T00:00:00Z');
    for (const v of ['2026-11-12T08:30:00', '2026-11-12T08:30:00+02:00', '2026-02-30', '2026-13-01', 'now', '']) expect(parseSince(v), v).toBeNull();
  });

  it('renderChanges handles an empty window', () => {
    expect(renderChanges([])).toContain('no changes in this window');
  });
});

describe('output rules', () => {
  it('in --json mode every command puts exactly one compact line on stdout and its notes on stderr', async () => {
    gateway = (url) => {
      const p = url.pathname;
      if (p === '/api/labels/state') return { status: 200, body: STATE_OBSERVING };
      if (p === '/api/labels/fields') return { status: 200, body: fieldsBody('item') };
      if (p === '/api/labels/items') return { status: 200, body: itemsPage([{ id: 'B0ONE', labels: {} }], null) };
      if (p === '/api/labels/items/lookup') return { status: 200, body: { ok: true, state: 'observing', account: 12345, merchant_type: 'Seller', entity: 'item', fields: [], results: [{ id: 'B0ONE', status: 'unseen', labels: {} }], unseen: ['B0ONE'] } };
      if (p === '/api/labels/drift') return { status: 200, body: { ok: true, state: 'observing', account: 12345, merchant_type: 'Seller', drift: [], next: null, next_cursor: null, has_more: false, limit: 50 } };
      return { status: 200, body: { ok: true, state: 'observing', account: 12345, merchant_type: 'Seller', changes: [], position: null, next_cursor: 'P', has_more: false, limit: 50 } };
    };
    const cmds = [
      ['labels', 'state'],
      ['labels', 'fields', '--account', ACCOUNT, '--entity', 'item'],
      ['labels', 'get', '--account', ACCOUNT, '--ids', 'B0ONE'],
      ['labels', 'search', '--account', ACCOUNT],
      ['labels', 'drift', '--account', ACCOUNT],
      ['labels', 'changes', '--account', ACCOUNT],
    ];
    for (const c of cmds) {
      stdout = '';
      stderr = '';
      await run('--json', ...c);
      const lines = stdout.split('\n');
      expect(lines.length, c.join(' ')).toBe(2); // one line and the trailing newline
      expect(lines[0]).not.toContain('\n');
      expect(JSON.parse(lines[0]).status).toBe('ok');
      expect(stdout.trim()).toBe(lines[0]);
    }
  });

  it('table cells make a pipe or a newline in a label harmless and cut very long values', () => {
    const md = renderRows([describeRow({ id: 'B0PIPE0001', status: 'seen', labels: { tag_1: label('a|b\nc ' + 'x'.repeat(80)) } })], ['tag_1']);
    const row = md.split('\n').find((l) => l.startsWith('| B0PIPE0001'))!;
    expect(row.split('|').length).toBe(5); // leading, id, status, tag, trailing: no stray pipes
    expect(row).toContain('a/b c ');
    expect(row).toContain('…');
  });

  it('an empty result says so', () => {
    expect(renderRows([], ['tag_1'])).toBe('_(none)_');
  });
});

describe('review fixes (#268)', () => {
  const lookupAll = (init: RequestInit) => ({
    status: 200,
    body: { ok: true, state: 'observing', account: 12345, merchant_type: 'Seller', entity: 'item', fields: [], results: (JSON.parse(String(init.body)).ids as string[]).map((id) => ({ id, status: 'seen', labels: {} })), unseen: [] },
  });

  it('search --json puts the rows under one stable key, rows, for items and campaigns, with entity in the envelope', async () => {
    gateway = (url) => ({ status: 200, body: url.pathname === '/api/labels/items' ? itemsPage([{ id: 'B0ONE' }], null) : itemsPage([{ id: '111' }], null, 'campaign') });
    await run('--json', 'labels', 'search', '--account', ACCOUNT);
    expect(lastLineJson()).toMatchObject({ entity: 'item', rows: [{ id: 'B0ONE' }] });
    expect(lastLineJson()).not.toHaveProperty('items');
    stdout = '';
    await run('--json', 'labels', 'search', '--account', ACCOUNT, '--entity', 'campaign');
    expect(lastLineJson()).toMatchObject({ entity: 'campaign', rows: [{ id: '111' }] });
    expect(lastLineJson()).not.toHaveProperty('campaigns');
  });

  it('an ids file saved as UTF-16 (a byte-order mark, either order, or NUL bytes) fails plainly before any call', async () => {
    const utf16le = join(tmp, 'le.txt');
    await writeFile(utf16le, Buffer.from('﻿B0EXAMPLE01\r\nB0EXAMPLE02\r\n', 'utf16le'));
    const utf16be = join(tmp, 'be.txt');
    await writeFile(utf16be, Buffer.from([0xfe, 0xff, 0x00, 0x42, 0x00, 0x30]));
    const nul = join(tmp, 'nul.txt');
    await writeFile(nul, Buffer.from([0x42, 0x00, 0x30, 0x00, 0x45]));
    for (const f of [utf16le, utf16be, nul]) {
      process.exitCode = undefined;
      stderr = '';
      await run('labels', 'get', '--account', ACCOUNT, '--ids-file', f);
      expect(stderr, f).toContain('Save it as UTF-8');
      expect(process.exitCode, f).toBe(1);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    stdout = '';
    await run('--json', 'labels', 'get', '--account', ACCOUNT, '--ids-file', utf16le);
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'invalid_input' });
  });

  it('a UTF-8 file with a byte-order mark works: the mark never sticks to the first id', async () => {
    const f = join(tmp, 'bom.txt');
    await writeFile(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('b0example01\r\nB0EXAMPLE02\r\n', 'utf8')]));
    gateway = (_u, init) => lookupAll(init);
    await run('--json', 'labels', 'get', '--account', ACCOUNT, '--ids-file', f);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).ids).toEqual(['B0EXAMPLE01', 'B0EXAMPLE02']);
    expect(process.exitCode).toBeUndefined();
  });

  it(`more than ${MAX_IDS} ids in one run is refused with a clear message before any call; exactly ${MAX_IDS} goes through`, async () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `B0EX${String(i).padStart(7, '0')}`).join(',');
    await run('labels', 'get', '--account', ACCOUNT, '--ids', make(MAX_IDS + 1));
    expect(stderr).toContain(`That is ${MAX_IDS + 1} ids; one run takes at most ${MAX_IDS}`);
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    process.exitCode = undefined;
    gateway = (_u, init) => lookupAll(init);
    await run('--json', 'labels', 'get', '--account', ACCOUNT, '--ids', make(MAX_IDS));
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(lastLineJson()).toMatchObject({ requested: MAX_IDS, batches: 20 });
  });

  it('item ids are trimmed and upper-cased before repeats are dropped, so a repeat cannot straddle a batch boundary; campaign ids stay as given', async () => {
    expect(normalizeIds(' b0x ,B0X\nb0y', 'item')).toEqual(['B0X', 'B0Y']);
    expect(normalizeIds('0123,0123, 456', 'campaign')).toEqual(['0123', '456']);
    // 500 distinct ids, then the first again in lower case: one call of 500, not two.
    const ids = Array.from({ length: 500 }, (_, i) => `B0EX${String(i).padStart(6, '0')}`);
    gateway = (_u, init) => lookupAll(init);
    await run('--json', 'labels', 'get', '--account', ACCOUNT, '--ids', [...ids, ids[0].toLowerCase()].join(','));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastLineJson()).toMatchObject({ requested: 500, batches: 1 });
  });

  it('changes show the source in plain words in the table, and the raw value in --json', async () => {
    const change = (id: string, source: string) => ({ id, entity: 'item', entity_id: 'B0CHANGE001', field: 'tag_1', before: null, after: 'A', result: 'applied', source, actor: null, time: '2026-11-12T09:00:00Z' });
    gateway = () => ({ status: 200, body: { ok: true, state: 'observing', account: 12345, merchant_type: 'Seller', changes: [change('1', 'service'), change('2', 'dash'), change('3', 'backfill'), change('4', 'inherit'), change('5', 'other')], position: {}, next_cursor: 'P', has_more: false, limit: 50 } });
    await run('labels', 'changes', '--account', ACCOUNT);
    for (const [word, raw] of [['MixShift', 'service'], ['Data Manager', 'dash'], ['first import', 'backfill'], ['carried over', 'inherit']]) {
      expect(stdout, word).toContain(`| ${word} |`);
      expect(stdout, raw).not.toContain(`| ${raw} |`);
    }
    expect(stdout).toContain('| other |');
    stdout = '';
    await run('--json', 'labels', 'changes', '--account', ACCOUNT);
    expect((lastLineJson() as { changes: Array<{ source: string }> }).changes.map((c) => c.source)).toEqual(['service', 'dash', 'backfill', 'inherit', 'other']);
  });

  it('the service freshness note is shown verbatim, even when it says Dash', async () => {
    gateway = () => ({ status: 200, body: { ...STATE_OBSERVING, freshness: { typical_lag_minutes: 15, note: 'The store is a copy kept current from Dash.' } } });
    await run('labels', 'state');
    expect(stdout).toContain('The store is a copy kept current from Dash.');
  });

  it('a repeated cursor under --all ends the run instead of spinning, and says there is more', async () => {
    gateway = () => ({ status: 200, body: itemsPage([{ id: 'B0A' }, { id: 'B0B' }], 'SAME') });
    await run('--json', 'labels', 'search', '--account', ACCOUNT, '--all');
    expect(fetchMock).toHaveBeenCalledTimes(2); // the first page, then the page behind SAME, which hands back SAME again
    expect(lastLineJson()).toMatchObject({ truncated: true, has_more: true, next_cursor: 'SAME', pages: 2 });
    stdout = '';
    await run('labels', 'search', '--account', ACCOUNT, '--all');
    expect(stdout).toContain('Continue with --cursor SAME');
    expect(stdout).not.toContain('--all cap');
  });

  it('account_limited with no friendly text still gets the plain sentence and exit 11', async () => {
    gateway = () => ({ status: 403, body: { ok: false, kind: 'account_limited' } });
    await run('labels', 'drift', '--account', ACCOUNT);
    expect(stderr).toContain('✗ This credential is limited to other accounts, so it cannot read labels.');
    expect(process.exitCode).toBe(11);
    stdout = '';
    await run('--json', 'labels', 'drift', '--account', ACCOUNT);
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'account_limited', http_status: 403 });
  });
});
