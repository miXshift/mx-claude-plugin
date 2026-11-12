/**
 * Command-level tests for the labels WRITE commands (`mixshift labels preview | commit | undo | sets |
 * set | cancel | field-name`), run through the REAL client against a mocked gateway (a stubbed fetch and
 * a stubbed sign-in). What they pin:
 *
 *   - the flag-to-request mapping for every way to choose a selection, and local refusals that send nothing;
 *   - the no-commit-without-confirmation guarantee: no request that writes is ever made without --commit;
 *   - the approval hash is kept on this machine, never printed in the human output, and used by commit;
 *   - a commit that did not fully apply exits 17 with every per-item result, whatever the mix;
 *   - every error kind the service can answer, with its exit code and its next step;
 *   - the CSV file's row-numbered errors and the 1,000-row cap;
 *   - telemetry that carries counts, the change set id and the outcome, never a label value, an id or the hash.
 *
 * Made-up account, ids and values throughout: this repo is public.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerLabelsCommands } from './labels.js';
import { registerLabelsWriteCommands } from './labels-write.js';
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
// A mocked gateway
// ---------------------------------------------------------------------------

type Reply = { status: number; body: unknown };
interface Seen {
  method: string;
  url: URL;
  body: Record<string, unknown> | undefined;
}
let gateway: (req: Seen) => Reply;
const seen: Seen[] = [];
const fetchMock = vi.fn(async (u: unknown, init?: RequestInit) => {
  const req: Seen = { method: init?.method ?? 'GET', url: new URL(String(u)), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined };
  seen.push(req);
  const r = gateway(req);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
});

const ACCOUNT = '12345';
const SET_ID = '11111111-2222-4333-8444-555555555555';
const SET_ID_2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const HASH = 'ab'.repeat(32);
const SECRET_VALUE = 'Zebra Crossing Line';
const SECRET_ID = 'B0EXAMPLE01';

const fail = (status: number, kind: string, friendly: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { ok: false, kind, friendly, ...extra } });

const NOT_ENABLED_OFF = fail(403, 'not_enabled', 'Label changes are turned off on MixShift right now, so nothing can be previewed or committed. Reading labels still works. Nothing was changed.', { reason: 'writes_off' });
const NOT_ON = fail(403, 'not_enabled', 'Label changes are not turned on for this account yet: its labels are still being copied from the Data Manager and checked (state: observing). Nothing was changed.', { reason: 'tenant_not_on', state: 'observing' });

/** A change set as the service describes it. */
const view = (over: Record<string, unknown> = {}) => ({
  ok: true,
  state: 'on',
  change_set_id: SET_ID,
  kind: 'set',
  status: 'preview',
  scope: 'region',
  created_at: '2026-11-12T10:00:00.000000Z',
  expires_at: '2026-11-13T10:00:00.000000Z',
  committed_at: null,
  approval_hash: HASH,
  can_commit: true,
  accounts: [
    { account: 12345, identities: 3, to_change: 2, unchanged: 1, merchant_type: 'Seller', marketplace_id: 1 },
    { account: 12346, identities: 3, to_change: 3, unchanged: 0, merchant_type: 'Seller', marketplace_id: 2 },
  ],
  totals: { identities: 6, to_change: 5, unchanged: 1, fields_to_change: 6 },
  dropped: { identities: 1, accounts: 1, reasons: { not_seen: 1, account_not_accessible: 1 }, details: [{ account: 12345, reason: 'not_seen', identities: 1 }, { account: 12347, reason: 'account_not_accessible' }] },
  warnings: [{ kind: 'similar_value_in_use', message: 'Item Group "zebra crossing line" differs only in capitals from "Zebra Crossing Line", which 4 items already use; reports will group them separately.' }],
  sample: [
    { account: 12345, entity: 'item', id: SECRET_ID, field: 'item_group', before: null, after: SECRET_VALUE },
    { account: 12345, entity: 'item', id: 'B0EXAMPLE02', field: 'item_group', before: 'Old Line', after: null },
  ],
  preview_actor: 'a.person@example.test',
  surface: 'http',
  next_step: 'Show the person these counts.',
  ...over,
});

const counts = (over: Record<string, number> = {}) => ({ identities: 6, applied: 5, unchanged: 1, stale: 0, refused: 0, fields_changed: 6, ...over });
const commitBody = (over: Record<string, unknown> = {}) => ({
  ok: true,
  state: 'on',
  change_set_id: SET_ID,
  status: 'committed',
  already_committed: false,
  counts: counts(),
  accounts: [
    { account: 12345, applied: 2, unchanged: 1, stale: 0, refused: 0 },
    { account: 12346, applied: 3, unchanged: 0, stale: 0, refused: 0 },
  ],
  needs_attention: [],
  needs_attention_truncated: false,
  applied_sample: [{ account: 12345, entity: 'item', id: SECRET_ID, result: 'applied' }],
  sync: { state: 'pending', note: 'The new values are saved in your MixShift label store and every label read shows them now, marked pending.' },
  scope: 'region',
  friendly: 'Done. 5 of 6 changed.',
  ...over,
});
const staleRows = [
  { account: 12345, entity: 'item', id: 'B0EXAMPLE03', result: 'stale', stale_fields: ['item_group'] },
  { account: 12346, entity: 'item', id: 'B0EXAMPLE04', result: 'refused', reason: 'account_not_accessible' },
];

let stdout = '';
let stderr = '';
let tmp: string;

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', 'emit machine-readable JSON to stdout', false).option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR').option('--surface <surface>', 'telemetry host flag');
  registerLabelsCommands(program);
  registerLabelsWriteCommands(program);
  return program;
}

/** Run a command with this test's own data dir (where the approvals are kept). */
async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', '--data-dir', tmp, ...args]);
}

function lastLineJson(): Record<string, unknown> {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  return JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
}

const lastTrack = () => vi.mocked(track).mock.calls.at(-1)![0] as { event_name: string; outcome?: string; error_class?: string; payload: Record<string, unknown> };
const pendingFile = (id = SET_ID) => join(tmp, 'labels', 'pending', `${id}.json`);
const writesSeen = () => seen.filter((r) => r.method !== 'GET');
const everythingTracked = () => JSON.stringify(vi.mocked(track).mock.calls);

beforeEach(async () => {
  stdout = '';
  stderr = '';
  seen.length = 0;
  process.exitCode = undefined;
  tmp = await mkdtemp(join(tmpdir(), 'labels-write-test-'));
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

/** Preview something so an approval is kept on this machine. */
async function previewOnce(): Promise<void> {
  gateway = () => ({ status: 200, body: view() });
  await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', `item_group=${SECRET_VALUE}`);
  stdout = '';
  stderr = '';
  seen.length = 0;
  vi.mocked(track).mockClear();
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

describe('labels preview', () => {
  it('by ids: sends the frozen request, prints the summary, keeps the approval, never prints the hash', async () => {
    gateway = () => ({ status: 200, body: view() });
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', 'b0example01, B0EXAMPLE01,b0example02', '--set', `item_group=${SECRET_VALUE}`, '--clear', 'tag_1');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url.pathname).toBe('/api/labels/changes/preview');
    expect(seen[0]!.body).toEqual({
      account: 12345,
      entity: 'item',
      selection: { ids: ['B0EXAMPLE01', 'B0EXAMPLE02'] },
      set: { item_group: SECRET_VALUE, tag_1: null },
    });
    expect(process.exitCode).toBeUndefined();
    // The summary: id, counts, accounts reached, what was left out and why, warnings, a before and after sample, the expiry.
    expect(stderr).toContain('Preview: nothing has been changed.');
    expect(stdout).toContain(`**Change set ${SET_ID}** (preview, nothing changed yet)`);
    expect(stdout).toContain('- scope: region, reaching 2 accounts');
    expect(stdout).toContain('- expires: 2026-11-13T10:00:00.000000Z');
    expect(stdout).toContain('- would change: 5 of 6 items (6 fields); 1 already has these values');
    expect(stdout).toContain('| 12345 | 1 | 3 | 2 | 1 |');
    expect(stdout).toContain('account 12345: 1 item MixShift has not read yet');
    expect(stdout).toContain('account 12347: not an account you can use');
    expect(stdout).toContain('differs only in capitals');
    expect(stdout).toContain(`| 12345 | ${SECRET_ID} | item_group | (never set) | ${SECRET_VALUE} |`);
    expect(stdout).toContain('| 12345 | B0EXAMPLE02 | item_group | Old Line | (cleared) |');
    // The next step is the commit command, with the flag, and a reminder to get a yes first.
    expect(stderr).toContain(`mixshift labels commit ${SET_ID} --commit`);
    expect(stderr).toContain('get their yes');
    // The person never has to see or retype the hash.
    expect(stdout + stderr).not.toContain(HASH);
    const kept = JSON.parse(await readFile(pendingFile(), 'utf8')) as Record<string, unknown>;
    expect(kept).toMatchObject({ change_set_id: SET_ID, approval_hash: HASH, account: 12345, scope: 'region', expires_at: '2026-11-13T10:00:00.000000Z' });
    // The kept record holds no label value and no id.
    const text = await readFile(pendingFile(), 'utf8');
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(SECRET_ID);
    expect(lastTrack()).toMatchObject({
      event_name: 'labels.called',
      outcome: 'ok',
      payload: { kind: 'preview', mode: 'ids', account: 12345, entity: 'item', change_sets: 1, identities: 6, to_change: 5, unchanged: 1, dropped: 1, warnings: 1, committable: true, change_set_ids: [SET_ID] },
    });
  });

  it('--json is one object on the last line: the approval hash, the commit command, committed:false', async () => {
    gateway = () => ({ status: 200, body: view() });
    await run('--json', 'labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme Home', '--scope', 'marketplace');
    expect(seen[0]!.body).toMatchObject({ scope: 'marketplace', set: { brand: 'Acme Home' } });
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const out = lastLineJson() as { status: string; committed: boolean; count: number; change_sets: Array<Record<string, unknown>> };
    expect(out).toMatchObject({ status: 'ok', committed: false, count: 1 });
    expect(out.change_sets[0]).toMatchObject({ change_set_id: SET_ID, approval_hash: HASH, commit_command: `mixshift labels commit ${SET_ID} --commit`, approval_saved: true, can_commit: true });
    expect(out.change_sets[0]).not.toHaveProperty('ok');
  });

  it('attributes the change to the skill and model named in the environment, and omits them otherwise', async () => {
    gateway = () => ({ status: 200, body: view() });
    vi.stubEnv('MIXSHIFT_SKILL_ID', 'mx-example-skill');
    vi.stubEnv('MIXSHIFT_MODEL_ID', 'example-model');
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme');
    expect(seen[0]!.body).toMatchObject({ skill_id: 'mx-example-skill', model_id: 'example-model' });
    vi.unstubAllEnvs();
    seen.length = 0;
    vi.stubEnv('MIXSHIFT_SKILL_ID', '');
    vi.stubEnv('MIXSHIFT_MODEL_ID', '');
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme');
    expect(seen[0]!.body).not.toHaveProperty('skill_id');
    expect(seen[0]!.body).not.toHaveProperty('model_id');
    vi.unstubAllEnvs();
  });

  it('by --where, --rename, an ids file and campaigns: each maps to its own request', async () => {
    gateway = () => ({ status: 200, body: view() });
    await run('labels', 'preview', '--account', ACCOUNT, '--where', 'item_group=Old Line', '--set', 'item_group=New Line', '--scope', 'all');
    expect(seen[0]!.body).toEqual({ account: 12345, entity: 'item', selection: { filter: { field: 'item_group', value: 'Old Line' } }, set: { item_group: 'New Line' }, scope: 'all' });

    seen.length = 0;
    await run('labels', 'preview', '--account', ACCOUNT, '--rename', 'tag_2', '--from', 'Old Tag', '--to', ' New Tag ');
    expect(seen[0]!.body).toEqual({ account: 12345, entity: 'item', selection: { rename: { field: 'tag_2', from: 'Old Tag', to: 'New Tag' } } });

    seen.length = 0;
    const idsFile = join(tmp, 'ids.txt');
    await writeFile(idsFile, 'b0example01\nB0EXAMPLE02 b0example03\n');
    await run('labels', 'preview', '--account', ACCOUNT, '--ids-file', idsFile, '--clear', 'brand');
    expect(seen[0]!.body).toMatchObject({ selection: { ids: ['B0EXAMPLE01', 'B0EXAMPLE02', 'B0EXAMPLE03'] }, set: { brand: null } });

    seen.length = 0;
    await run('labels', 'preview', '--account', ACCOUNT, '--entity', 'campaign', '--ids', '111222333, 444', '--set', 'manager=Alex');
    expect(seen[0]!.body).toMatchObject({ entity: 'campaign', selection: { ids: ['111222333', '444'] }, set: { manager: 'Alex' } });
    expect(seen[0]!.body).not.toHaveProperty('scope');
  });

  it('a preview that cannot be committed yet says why, and offers no commit command', async () => {
    gateway = () => ({ status: 200, body: view({ state: 'observing', can_commit: false, blocked_by: 'tenant_not_on' }) });
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme');
    expect(stdout).toContain('cannot be committed yet');
    expect(stderr).toContain('not turned on for this account yet');
    expect(stderr).not.toContain('--commit');
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses bad input before any request: selection modes, fields, values, ids, scope, rename', async () => {
    const f = join(tmp, 'empty-ids.txt');
    await writeFile(f, ' , ');
    const bad = [
      ['labels', 'preview', '--account', ACCOUNT],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--where', 'brand=x', '--set', 'brand=y'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--ids-file', f, '--set', 'brand=y'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids-file', f, '--set', 'brand=y'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'nope=1'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=   '],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=a', '--clear', 'brand'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=a', '--set', 'brand=b'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'manager=Alex'],
      ['labels', 'preview', '--account', ACCOUNT, '--entity', 'campaign', '--ids', SECRET_ID, '--set', 'brand=y'],
      ['labels', 'preview', '--account', ACCOUNT, '--entity', 'campaign', '--ids', '1', '--set', 'brand=y', '--scope', 'region'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=y', '--scope', 'world'],
      ['labels', 'preview', '--account', 'abc', '--ids', SECRET_ID, '--set', 'brand=y'],
      ['labels', 'preview', '--account', ACCOUNT, '--where', 'brand', '--set', 'brand=y'],
      ['labels', 'preview', '--account', ACCOUNT, '--rename', 'brand', '--from', 'a'],
      ['labels', 'preview', '--account', ACCOUNT, '--rename', 'brand', '--from', 'a', '--to', 'a'],
      ['labels', 'preview', '--account', ACCOUNT, '--rename', 'brand', '--from', 'a', '--to', 'b', '--set', 'brand=c'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=y', '--from', 'a'],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', `tag_1=${'x'.repeat(251)}`],
      ['labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=line\nbreak'],
    ];
    for (const args of bad) {
      process.exitCode = undefined;
      await run(...args);
      expect(process.exitCode, args.join(' ')).toBe(1);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    stdout = '';
    await run('--json', 'labels', 'preview', '--account', 'abc');
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'invalid_input' });
  });

  it('refuses more ids than one change set holds, and says how to split', async () => {
    const ids = Array.from({ length: 1001 }, (_v, i) => `B0X${String(i).padStart(7, '0')}`).join(',');
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', ids, '--set', 'brand=Acme');
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('1001 ids, and one change set holds at most 1000');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// preview --file
// ---------------------------------------------------------------------------

describe('labels preview --file', () => {
  const csv = (...lines: string[]) => lines.join('\n') + '\n';

  it('makes one change set per distinct combination of values and keeps each approval', async () => {
    const file = join(tmp, 'changes.csv');
    await writeFile(
      file,
      csv('asin,item_group,tag_1', 'b0example01,Water Bottles,Spring', 'B0EXAMPLE02,Water Bottles,Spring', 'B0EXAMPLE03,Water Bottles,<clear>', 'B0EXAMPLE04,,Spring', '"B0EXAMPLE05","Cups, Large",'),
    );
    let n = 0;
    gateway = () => ({ status: 200, body: view({ change_set_id: [SET_ID, SET_ID_2, '99999999-8888-4777-8666-555555555555', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'][n++] }) });
    await run('labels', 'preview', '--account', ACCOUNT, '--file', file);
    expect(seen.map((r) => r.body)).toEqual([
      { account: 12345, entity: 'item', selection: { ids: ['B0EXAMPLE01', 'B0EXAMPLE02'] }, set: { item_group: 'Water Bottles', tag_1: 'Spring' } },
      { account: 12345, entity: 'item', selection: { ids: ['B0EXAMPLE03'] }, set: { item_group: 'Water Bottles', tag_1: null } },
      { account: 12345, entity: 'item', selection: { ids: ['B0EXAMPLE04'] }, set: { tag_1: 'Spring' } },
      { account: 12345, entity: 'item', selection: { ids: ['B0EXAMPLE05'] }, set: { item_group: 'Cups, Large' } },
    ]);
    expect(stderr).toContain('Change set 1 of 4: nothing has been changed.');
    expect(stderr).toContain('Change set 4 of 4: nothing has been changed.');
    expect(await readdir(join(tmp, 'labels', 'pending'))).toHaveLength(4);
    expect(stderr).toContain('This file made 4 change sets, one for each different combination of values. Each is committed (and undone) separately:');
    expect(stderr).toContain(`  ${SET_ID_2}`);
    expect(lastTrack().payload).toMatchObject({ mode: 'file', rows: 5, change_sets: 4 });
  });

  it('reports every problem with its line number, sends nothing, and exits 1', async () => {
    const file = join(tmp, 'bad.csv');
    await writeFile(
      file,
      csv(
        'asin,item_group,nope,item_group',
        'B0EXAMPLE01,Line,x,y', // fine row (header is the problem)
      ),
    );
    await run('labels', 'preview', '--account', ACCOUNT, '--file', file);
    expect(stderr).toContain('Line 1: "nope" is not a label field of items');
    expect(stderr).toContain('Line 1: the column item_group appears twice.');
    expect(process.exitCode).toBe(1);

    stderr = '';
    process.exitCode = undefined;
    const rows = join(tmp, 'rows.csv');
    await writeFile(rows, csv('asin,item_group,tag_1', 'B0EXAMPLE01,Line,', 'B0EXAMPLE02,,', 'B0EXAMPLE01,Other,', 'B0EXAMPLE03,Line', 'B0EXAMPLE04,a\tb,', `B0EXAMPLE05,${'x'.repeat(251)},`));
    await run('labels', 'preview', '--account', ACCOUNT, '--file', rows);
    expect(stderr).toContain('Line 3: every label cell is empty');
    expect(stderr).toContain('Line 4: this id already appears on line 2.');
    expect(stderr).toContain('Line 5: 2 cells, but the header has 3.');
    expect(stderr).toContain('Line 6, item_group: a label is plain text on one line');
    expect(stderr).toContain('Line 7, item_group: the value is longer than the 250 characters item_group holds');
    expect(process.exitCode).toBe(1);

    stdout = '';
    await run('--json', 'labels', 'preview', '--account', ACCOUNT, '--file', rows);
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'invalid_input' });
    expect((lastLineJson().errors as string[]).length).toBe(5);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a cell that starts with = + - or @ with its line (a file only; --set is left as the service treats it)', async () => {
    const file = join(tmp, 'formula.csv');
    await writeFile(file, csv('asin,brand,tag_1', 'B0EXAMPLE01,=SUM(A1),', 'B0EXAMPLE02,Acme,-20% promo', 'B0EXAMPLE03,+1,@x', 'B0EXAMPLE04,Fine,'));
    await run('labels', 'preview', '--account', ACCOUNT, '--file', file);
    expect(stderr).toContain('Line 2, brand: a value in a file cannot start with = + - or @');
    expect(stderr).toContain('Line 3, tag_1:');
    expect(stderr).toContain('Line 4, brand:');
    expect(stderr).toContain('Line 4, tag_1:');
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();

    gateway = () => ({ status: 200, body: view() });
    process.exitCode = undefined;
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'tag_1=-20% promo');
    expect(seen[0]!.body).toMatchObject({ set: { tag_1: '-20% promo' } });
  });

  it('caps the file at the change set size with a message that says how to split it', async () => {
    const lines = ['asin,brand', ...Array.from({ length: 1001 }, (_v, i) => `B0X${String(i).padStart(7, '0')},Acme`)];
    const file = join(tmp, 'big.csv');
    await writeFile(file, csv(...lines));
    await run('labels', 'preview', '--account', ACCOUNT, '--file', file);
    expect(stderr).toContain('The file has 1001 rows, and one change set holds at most 1000');
    expect(stderr).toContain('Split it into files of at most 1000 rows');
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a campaign file takes campaign_id and refuses an ASIN-shaped id; a UTF-16 file is refused plainly', async () => {
    const file = join(tmp, 'campaigns.csv');
    await writeFile(file, csv('campaign_id,manager', '111222333,Alex', 'B0EXAMPLE01,Jo'));
    await run('labels', 'preview', '--account', ACCOUNT, '--entity', 'campaign', '--file', file);
    expect(stderr).toContain('Line 3: a campaign id is the Amazon campaign id: 1 to 20 digits.');
    expect(process.exitCode).toBe(1);

    stderr = '';
    const utf16 = join(tmp, 'utf16.csv');
    await writeFile(utf16, Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x73, 0x00]));
    await run('labels', 'preview', '--account', ACCOUNT, '--file', utf16);
    expect(stderr).toContain('UTF-16');
    expect(stderr).toContain('--file');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a group that fails after earlier ones were made lists the earlier ones and exits with the failure', async () => {
    const file = join(tmp, 'two.csv');
    await writeFile(file, csv('asin,brand', 'B0EXAMPLE01,Acme', 'B0EXAMPLE02,Zed'));
    let n = 0;
    gateway = () => (n++ === 0 ? { status: 200, body: view() } : fail(429, 'too_many_open_previews', 'You have 25 open previews (the limit is 25). Commit or cancel some.', { open: 25, cap: 25 }));
    await run('--json', 'labels', 'preview', '--account', ACCOUNT, '--file', file);
    const out = lastLineJson() as { status: string; failure_kind: string; change_sets: Array<{ change_set_id: string }>; failed_group: number; groups: number };
    expect(out).toMatchObject({ status: 'error', failure_kind: 'too_many_open_previews', failed_group: 2, groups: 2 });
    expect(out.change_sets.map((c) => c.change_set_id)).toEqual([SET_ID]);
    expect(process.exitCode).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// commit: the confirmation guarantee
// ---------------------------------------------------------------------------

describe('labels commit: nothing is written without --commit', () => {
  it('without --commit it reads the change set back and sends no write', async () => {
    await previewOnce();
    gateway = (req) => {
      if (req.method !== 'GET') throw new Error(`a write was sent: ${req.method} ${req.url.pathname}`);
      return { status: 200, body: view() };
    };
    await run('labels', 'commit', SET_ID);
    expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([`GET /api/labels/changes/sets/${SET_ID}`]);
    expect(writesSeen()).toHaveLength(0);
    expect(stderr).toContain('NOT COMMITTED (no --commit): nothing has been changed.');
    expect(stderr).toContain(`mixshift labels commit ${SET_ID} --commit`);
    expect(process.exitCode).toBeUndefined();
    expect(lastTrack()).toMatchObject({ outcome: 'ok', payload: { kind: 'commit', dry_run: true, committed: false, approval_available: true } });

    stdout = '';
    await run('--json', 'labels', 'commit', SET_ID);
    expect(lastLineJson()).toMatchObject({ status: 'ok', committed: false, dry_run: true, approval_available: true });
    expect(writesSeen()).toHaveLength(0);
  });

  it('a preview, a set read, a cancel-free listing and an undo never POST to a commit route', async () => {
    gateway = (req) => {
      if (req.url.pathname.endsWith('/commit')) throw new Error('a commit was sent');
      if (req.url.pathname.endsWith('/undo')) return { status: 200, body: view({ kind: 'undo' }) };
      if (req.url.pathname.endsWith('/sets')) return { status: 200, body: { ok: true, state: 'on', account: 12345, change_sets: [], has_more: false, next_before: null, limit: 20 } };
      return { status: 200, body: view() };
    };
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme');
    await run('labels', 'set', SET_ID);
    await run('labels', 'sets', '--account', ACCOUNT);
    await run('labels', 'undo', SET_ID);
    await run('labels', 'commit', SET_ID);
    expect(seen.filter((r) => r.url.pathname.endsWith('/commit'))).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('field-name without --commit sends nothing at all; with --commit it sends the PUT or the DELETE', async () => {
    await run('labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2', '--name', 'Pattern ID');
    await run('labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2', '--remove');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr).toContain('NOT SENT (no --commit)');
    expect(stderr).toContain('would show label_2 as "Pattern ID" on account 12345');
    expect(stderr).toContain('would show label_2 under its standard name again');
    stdout = '';
    await run('--json', 'labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2', '--name', 'Pattern ID');
    expect(lastLineJson()).toMatchObject({ status: 'ok', committed: false, dry_run: true, field: 'label_2', name: 'Pattern ID' });

    gateway = (req) => ({ status: 200, body: { ok: true, state: 'on', account: 12345, entity: 'item', field: 'label_2', display_name: req.method === 'PUT' ? 'Pattern ID' : null, ...(req.method === 'DELETE' ? { removed: true } : {}), friendly: req.method === 'PUT' ? 'Item Label 2 now shows as "Pattern ID" on this account.' : 'Item Label 2 shows its standard name again on this account.' } });
    await run('labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2', '--name', ' Pattern ID ', '--commit');
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.url.pathname).toBe('/api/labels/fields/names');
    expect(seen[0]!.body).toEqual({ account: 12345, entity: 'item', field: 'label_2', name: 'Pattern ID' });
    expect(stderr).toContain('✓ Item Label 2 now shows as "Pattern ID" on this account.');
    await run('--json', 'labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2', '--remove', '--commit');
    expect(seen[1]!.method).toBe('DELETE');
    expect(Object.fromEntries(seen[1]!.url.searchParams)).toEqual({ account: '12345', entity: 'item', field: 'label_2' });
    expect(lastLineJson()).toMatchObject({ status: 'ok', committed: true, removed: true, display_name: null });
    expect(everythingTracked()).not.toContain('Pattern ID');
  });

  it('field-name refuses a bad name, a bad field, and both or neither of --name and --remove', async () => {
    const bad = [
      ['labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2'],
      ['labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2', '--name', 'x', '--remove'],
      ['labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2', '--name', '   '],
      ['labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2', '--name', 'x'.repeat(81), '--commit'],
      ['labels', 'field-name', '--account', ACCOUNT, '--field', 'label_2', '--name', 'two\nlines', '--commit'],
      ['labels', 'field-name', '--account', ACCOUNT, '--field', 'manager', '--name', 'x', '--commit'],
      ['labels', 'field-name', '--account', ACCOUNT, '--entity', 'campaign', '--field', 'nickname', '--name', 'x', '--commit'],
    ];
    for (const args of bad) {
      process.exitCode = undefined;
      await run(...args);
      expect(process.exitCode, args.join(' ')).toBe(1);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with --commit it sends the approval kept from the preview, prints the per-item result and clears the record', async () => {
    await previewOnce();
    gateway = () => ({ status: 200, body: commitBody() });
    await run('labels', 'commit', SET_ID, '--commit');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url.pathname).toBe(`/api/labels/changes/${SET_ID}/commit`);
    expect(seen[0]!.body).toMatchObject({ approval_hash: HASH });
    expect(process.exitCode).toBeUndefined();
    expect(stderr).toContain(`✓ COMMITTED ${SET_ID}: 5 of 6 changed (6 fields), 1 already had these values, 0 stale, 0 refused.`);
    expect(stderr).toContain('marked pending');
    expect(stdout).toContain('| 5 | 1 | 0 | 0 | 6 |');
    expect(stdout).toContain('| 12346 | 3 | 0 | 0 | 0 |');
    expect(stdout + stderr).not.toContain(HASH);
    await expect(readFile(pendingFile(), 'utf8')).rejects.toThrow();
    expect(lastTrack()).toMatchObject({ outcome: 'ok', payload: { kind: 'commit', committed: true, change_set_id: SET_ID, applied: 5, unchanged: 1, stale: 0, refused: 0, fields_changed: 6, approval_source: 'saved' } });
    expect(everythingTracked()).not.toContain(HASH);
    expect(everythingTracked()).not.toContain(SECRET_ID);
  });

  it('--json success: status ok, committed true, the counts and accounts, one line', async () => {
    await previewOnce();
    gateway = () => ({ status: 200, body: commitBody({ already_committed: true }) });
    await run('--json', 'labels', 'commit', SET_ID, '--commit');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(lastLineJson()).toMatchObject({ status: 'ok', committed: true, outcome: 'committed', already_committed: true, counts: { applied: 5, unchanged: 1, stale: 0, refused: 0 } });
  });

  it('--commit with no approval on this machine and an open preview: nothing is committed, exit 16; --approval-hash supplies one', async () => {
    gateway = (req) => {
      if (req.method !== 'GET') throw new Error('a write was sent');
      return { status: 200, body: view() };
    };
    await run('labels', 'commit', SET_ID, '--commit');
    expect(seen.map((r) => r.method)).toEqual(['GET']);
    expect(process.exitCode).toBe(16);
    expect(stderr).toContain('no approval for that change set');
    expect(stderr).toContain('--approval-hash');
    stdout = '';
    process.exitCode = undefined;
    await run('--json', 'labels', 'commit', SET_ID, '--commit');
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'no_approval' });
    expect(writesSeen()).toHaveLength(0);

    gateway = () => ({ status: 200, body: commitBody() });
    seen.length = 0;
    process.exitCode = undefined;
    await run('labels', 'commit', SET_ID, '--commit', '--approval-hash', HASH.toUpperCase());
    expect(seen[0]!.body).toMatchObject({ approval_hash: HASH });
    expect(process.exitCode).toBeUndefined();
    expect(lastTrack().payload).toMatchObject({ approval_source: 'flag' });
  });

  it.each([
    ['committed', 0, 'already committed', {}],
    ['partial', 17, 'only partly applied', { needs_attention: staleRows }],
    ['stale', 17, 'every item had changed since the preview', {}],
    ['failed', 17, 'nothing was applied', {}],
    ['cancelled', 16, 'was cancelled', {}],
    ['expired', 16, 'expired', {}],
  ])('re-running a commit on a %s change set (no record here) reports its real status, exit %s, and sends no write', async (status, exit, words, extra) => {
    gateway = () => ({ status: 200, body: view({ status, can_commit: false, approval_hash: undefined, committed_at: '2026-11-12T11:00:00.000000Z', ...extra }) });
    await run('labels', 'commit', SET_ID, '--commit');
    expect(writesSeen()).toHaveLength(0);
    expect(stderr).toContain(words);
    expect(stderr).not.toContain('no approval');
    expect(process.exitCode ?? 0).toBe(exit);
    stdout = '';
    await run('--json', 'labels', 'commit', SET_ID, '--commit');
    expect(lastLineJson()).toMatchObject({ committed: false, sent: false });
    expect(lastLineJson().status).toBe(exit === 0 ? 'ok' : 'error');
  });

  it('a preview past its expiry with no record reads as expired (exit 16)', async () => {
    gateway = () => ({ status: 200, body: view({ expires_at: '2020-01-01T00:00:00.000000Z' }) });
    await run('labels', 'commit', SET_ID, '--commit');
    expect(process.exitCode).toBe(16);
    expect(stderr).toContain('expired');
    expect(writesSeen()).toHaveLength(0);
  });

  it('--json of a set read and of the dry-run commit never repeats the approval hash; the preview does', async () => {
    await previewOnce();
    gateway = () => ({ status: 200, body: view() });
    await run('--json', 'labels', 'set', SET_ID);
    expect(stdout).not.toContain(HASH);
    expect(lastLineJson()).toMatchObject({ status: 'ok' });
    stdout = '';
    await run('--json', 'labels', 'commit', SET_ID);
    expect(stdout).not.toContain(HASH);
    expect(lastLineJson()).toMatchObject({ approval_available: true });
    stdout = '';
    await run('--json', 'labels', 'cancel', SET_ID);
    expect(stdout).not.toContain(HASH);
    stdout = '';
    await run('--json', 'labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme');
    expect(stdout).toContain(HASH);
  });

  it('refuses a malformed change set id or approval hash before any request', async () => {
    await run('labels', 'commit', 'not-an-id', '--commit');
    await run('labels', 'commit', SET_ID, '--commit', '--approval-hash', 'abc');
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// commit: honest results
// ---------------------------------------------------------------------------

describe('labels commit: results are never success with hidden skips', () => {
  it('partially applied: exit 17, every stale and refused item listed, status error in --json', async () => {
    await previewOnce();
    const body = commitBody({ status: 'partial', counts: counts({ applied: 3, stale: 1, refused: 1, unchanged: 1 }), needs_attention: staleRows });
    gateway = () => ({ status: 409, body: { ...body, ok: false, kind: 'partially_applied', friendly: 'Some were changed and some were not. 3 of 6 changed, 1 stale, 1 refused.' } });
    await run('labels', 'commit', SET_ID, '--commit');
    expect(process.exitCode).toBe(17);
    expect(stderr).toContain('PARTLY COMMITTED');
    expect(stderr).toContain('Some were changed and some were not.');
    expect(stdout).toContain('| 12345 | B0EXAMPLE03 | stale | - | item_group |');
    expect(stdout).toContain('| 12346 | B0EXAMPLE04 | refused | account_not_accessible | - |');
    expect(stdout).toContain('| 3 | 1 | 1 | 1 | 6 |');
    expect(stderr).toContain('preview the change again');
    // A final answer: the approval is spent.
    await expect(readFile(pendingFile(), 'utf8')).rejects.toThrow();
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: 'partially_applied', payload: { kind: 'commit', committed: true, applied: 3, stale: 1, refused: 1 } });

    await previewOnce();
    gateway = () => ({ status: 409, body: { ...body, ok: false, kind: 'partially_applied', friendly: 'Some were changed and some were not.' } });
    await run('--json', 'labels', 'commit', SET_ID, '--commit');
    const out = lastLineJson() as { status: string; failure_kind: string; needs_attention: unknown[]; counts: Record<string, number> };
    expect(out).toMatchObject({ status: 'error', failure_kind: 'partially_applied', http_status: 409, counts: { applied: 3, stale: 1, refused: 1 } });
    expect(out.needs_attention).toHaveLength(2);
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });

  it.each([
    ['stale', 'NOTHING COMMITTED (all stale)', 'Nothing was changed: every item had been changed by someone else since the preview.'],
    ['failed', 'NOTHING COMMITTED', 'Nothing was changed.'],
  ])('%s: exit 17 and the items that need attention', async (kind, banner, friendly) => {
    await previewOnce();
    gateway = () => ({ status: kind === 'stale' ? 409 : 422, body: { ...commitBody({ status: kind, counts: counts({ applied: 0, unchanged: 0, stale: 2, refused: 0, fields_changed: 0 }), needs_attention: staleRows }), ok: false, kind, friendly } });
    await run('labels', 'commit', SET_ID, '--commit');
    expect(process.exitCode).toBe(17);
    expect(stderr).toContain(banner);
    expect(stdout).toContain('B0EXAMPLE03');
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: kind });
  });

  it('a success envelope that still counts stale or refused items is not shown as success', async () => {
    await previewOnce();
    gateway = () => ({ status: 200, body: commitBody({ counts: counts({ applied: 4, stale: 1, refused: 1 }), needs_attention: staleRows }) });
    await run('--json', 'labels', 'commit', SET_ID, '--commit');
    expect(process.exitCode).toBe(17);
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'partially_applied' });
  });

  it('truncated needs-attention lists say so', async () => {
    await previewOnce();
    const many = Array.from({ length: 60 }, (_v, i) => ({ account: 12345, entity: 'item', id: `B0S${String(i).padStart(7, '0')}`, result: 'stale', stale_fields: ['brand'] }));
    gateway = () => ({ status: 409, body: { ...commitBody({ status: 'partial', counts: counts({ stale: 60 }), needs_attention: many, needs_attention_truncated: true }), ok: false, kind: 'partially_applied', friendly: 'Some were changed.' } });
    await run('labels', 'commit', SET_ID, '--commit');
    expect(stdout).toContain('...and 10 more here (all of them are in --json).');
    expect(stdout).toContain('The service lists the first 200 that need attention; there are more.');
    expect(process.exitCode).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// Every error the service can answer
// ---------------------------------------------------------------------------

describe('failures: every kind, its exit code and what to do next', () => {
  const cases: Array<[string, number, string, Record<string, unknown> | undefined, number, string | undefined]> = [
    // kind, http status, friendly, extra body, exit code, a fragment of the next step
    ['approval_mismatch', 409, 'The approval hash does not match this change set. Nothing was changed.', undefined, 16, 'Preview the change again'],
    ['change_set_expired', 409, 'This preview expired (a preview is good for 24 hours). Nothing was changed. Preview the change again.', { expires_at: '2026-11-13T10:00:00.000000Z' }, 16, 'Preview the change again'],
    ['change_set_cancelled', 409, 'This change set was cancelled, so it cannot be committed. Preview the change again.', undefined, 16, 'Preview the change again'],
    ['commit_retry', 409, 'The commit hit a database conflict, so nothing was written and the change set is still a preview. Commit it again.', { retryable: true }, 10, `Run the same command again: \`mixshift labels commit ${SET_ID} --commit\``],
    ['commit_in_flight', 409, 'This change set is being committed right now. Read it again in a moment.', { retryable: true }, 10, 'Run the same command again'],
    ['commit_too_large', 422, 'This change set is too large to commit in one step. Do not retry it as it is.', { cap: 1000 }, 15, 'Split the change into smaller change sets (at most 1000 each)'],
    ['change_set_not_found', 404, 'No such change set for this account.', undefined, 7, 'mixshift labels sets --account'],
    ['account_not_accessible', 403, 'This change set reaches an account you can no longer use (12347). Nothing was changed.', { accounts: [12347] }, 7, undefined],
    ['not_enabled', 403, NOT_ENABLED_OFF.body ? (NOT_ENABLED_OFF.body as { friendly: string }).friendly : '', { reason: 'writes_off' }, 6, undefined],
    ['insufficient_scope', 403, 'x', undefined, 11, undefined],
    ['not_available', 503, 'Labels could not be checked right now. Try again in a minute. Committing the same change set again is safe: a change set that was committed answers what it stored and writes nothing more.', { retryable: true }, 1, undefined],
    ['internal', 500, 'Labels service error. Try again.', undefined, 1, undefined],
  ];

  it.each(cases)('commit: %s', async (kind, status, friendly, extra, exit, step) => {
    await previewOnce();
    gateway = () => fail(status, kind, friendly, extra);
    await run('labels', 'commit', SET_ID, '--commit');
    expect(process.exitCode).toBe(exit);
    if (kind === 'not_enabled') expect(stderr).toBe(`${friendly}\n`);
    else if (kind === 'insufficient_scope') expect(stderr).toContain('This sign-in cannot change labels.');
    else expect(stderr).toContain(friendly);
    if (step) expect(stderr).toContain(step);
    expect(stderr).not.toContain('Error:'); // no stack
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: kind, payload: { kind: 'commit', committed: true, http_status: status } });

    stdout = '';
    await run('--json', 'labels', 'commit', SET_ID, '--commit', '--approval-hash', HASH);
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: kind, http_status: status });
    if (extra?.retryable) expect(lastLineJson()).toMatchObject({ retryable: true });
  });

  it('a retryable commit keeps the approval so the same command can run again; an expired or cancelled one clears it', async () => {
    await previewOnce();
    gateway = () => fail(409, 'commit_retry', 'Commit it again.', { retryable: true });
    await run('labels', 'commit', SET_ID, '--commit');
    expect(await readFile(pendingFile(), 'utf8')).toContain(HASH);
    gateway = () => ({ status: 200, body: commitBody() });
    process.exitCode = undefined;
    await run('labels', 'commit', SET_ID, '--commit');
    expect(process.exitCode).toBeUndefined();

    await previewOnce();
    gateway = () => fail(409, 'change_set_expired', 'This preview expired.');
    await run('labels', 'commit', SET_ID, '--commit');
    await expect(readFile(pendingFile(), 'utf8')).rejects.toThrow();
  });

  it('writes switched off and tenant not on read as one plain sentence, with the reason in --json', async () => {
    gateway = () => NOT_ENABLED_OFF;
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme');
    expect(stderr).toBe(`${(NOT_ENABLED_OFF.body as { friendly: string }).friendly}\n`);
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(6);
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: 'not_enabled', payload: { kind: 'preview', http_status: 403, reason: 'writes_off' } });

    gateway = () => NOT_ON;
    await run('--json', 'labels', 'commit', SET_ID, '--commit', '--approval-hash', HASH);
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'not_enabled', reason: 'tenant_not_on', state: 'observing' });
  });

  it('a lost answer on a commit says the commit may have gone through, and that repeating it is safe', async () => {
    await previewOnce();
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('socket hang up');
    });
    await run('labels', 'commit', SET_ID, '--commit');
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('The answer was lost, so the commit may or may not have gone through.');
    expect(stderr).toContain(`mixshift labels set ${SET_ID}`);
    expect(stderr).toContain('committing the same change set again is safe');
  });

  it.each([
    ['invalid_value', 422, 15, 'tag_1: The value is longer than the 250 characters this field holds.'],
    ['scope_not_supported', 422, 15, undefined],
    ['empty_selection', 422, 15, undefined],
    ['too_many_entities', 422, 15, undefined],
    ['too_many_open_previews', 429, 15, 'mixshift labels cancel'],
    ['account_not_accessible', 403, 7, undefined],
    ['not_found', 404, 7, 'mixshift amazon merchants'],
    ['bad_params', 400, 15, undefined],
    ['insufficient_scope', 403, 11, undefined],
    ['not_available', 503, 1, undefined],
  ])('preview: %s (HTTP %s) exits %s', async (kind, status, exit, fragment) => {
    const issues = kind === 'invalid_value' ? { issues: [{ field: 'tag_1', code: 'too_long', message: 'The value is longer than the 250 characters this field holds.' }] } : {};
    gateway = () => fail(status, kind, `A sentence for ${kind}.`, issues);
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme');
    expect(process.exitCode).toBe(exit);
    if (kind !== 'insufficient_scope') expect(stderr).toContain(`A sentence for ${kind}.`);
    if (fragment) expect(stderr).toContain(fragment);
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: kind });
  });

  it('too many entities names the cap of 1,000 and says to split (the service sentence, then the next step)', async () => {
    gateway = () => fail(422, 'too_many_entities', 'This change reaches 1500 items or campaigns, and one change set holds at most 1000. Split it into several changes of at most 1000 each (preview and commit each one), or narrow the selection.', { entities: 1500, cap: 1000 });
    await run('--json', 'labels', 'preview', '--account', ACCOUNT, '--where', 'brand=Acme', '--set', 'brand=Zed');
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'too_many_entities', http_status: 422 });
    expect(lastLineJson().message).toContain('at most 1000');
    expect(process.exitCode).toBe(15);
  });

  it('insufficient_scope prints the gateway sentence when it sends one, and a plain one when it does not', async () => {
    gateway = () => fail(403, 'insufficient_scope', 'This credential lacks the labels:write permission. Ask your org admin to grant it.', { required_scopes: ['labels:write'] });
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme');
    expect(stderr).toContain('lacks the labels:write permission');
    expect(stderr).not.toContain('This sign-in cannot change labels.');
    expect(process.exitCode).toBe(11);
  });

  it('too_many_entities on --where advises labels search plus --ids-file, not a bare "split"', async () => {
    gateway = () => fail(422, 'too_many_entities', 'This change reaches 1500 items or campaigns, and one change set holds at most 1000.', { entities: 1500, cap: 1000 });
    await run('labels', 'preview', '--account', ACCOUNT, '--where', 'brand=Acme', '--set', 'brand=Zed');
    expect(stderr).toContain('mixshift labels search --account <id> --field <key> --value <text>');
    expect(stderr).toContain('--ids-file');
    stderr = '';
    await run('labels', 'preview', '--account', ACCOUNT, '--rename', 'brand', '--from', 'Acme', '--to', 'Zed');
    expect(stderr).not.toContain('labels search');
  });

  it('an unknown kind keeps the status mapping and is recorded as unrecognized', async () => {
    gateway = () => fail(409, 'something_new', 'A brand new sentence from the service.');
    await run('--json', 'labels', 'commit', SET_ID, '--commit', '--approval-hash', HASH);
    expect(lastLineJson()).toMatchObject({ status: 'error', failure_kind: 'unknown', unrecognized_kind: 'something_new', message: 'A brand new sentence from the service.' });
    expect(lastTrack().payload).toMatchObject({ unrecognized_kind: 'something_new' });
  });

  it('never prints the bearer token, in any output or telemetry', async () => {
    gateway = () => NOT_ENABLED_OFF;
    await run('labels', 'preview', '--account', ACCOUNT, '--ids', SECRET_ID, '--set', 'brand=Acme');
    await previewOnce();
    expect(stdout + stderr + everythingTracked()).not.toContain('tok-secret-123');
    for (const c of fetchMock.mock.calls) expect((c[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-secret-123' });
  });
});

// ---------------------------------------------------------------------------
// undo, sets, set, cancel
// ---------------------------------------------------------------------------

describe('labels undo, sets, set, cancel', () => {
  it('undo creates a NEW preview, keeps its approval, and committing it is the same commit command', async () => {
    gateway = (req) => ({ status: 200, body: view({ change_set_id: SET_ID_2, kind: 'undo', undoes: SET_ID, ...(req.url.pathname.endsWith('/commit') ? {} : {}) }) });
    await run('labels', 'undo', SET_ID);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url.pathname).toBe(`/api/labels/changes/sets/${SET_ID}/undo`);
    expect(stderr).toContain('Undo preview: nothing has been changed.');
    expect(stdout).toContain(`undoing ${SET_ID}`);
    expect(stderr).toContain(`mixshift labels commit ${SET_ID_2} --commit`);
    expect(JSON.parse(await readFile(pendingFile(SET_ID_2), 'utf8'))).toMatchObject({ change_set_id: SET_ID_2, approval_hash: HASH });
    expect(lastTrack().payload).toMatchObject({ kind: 'undo', undoes: SET_ID, change_set_id: SET_ID_2 });

    gateway = () => ({ status: 200, body: commitBody({ change_set_id: SET_ID_2 }) });
    seen.length = 0;
    await run('labels', 'commit', SET_ID_2, '--commit');
    expect(seen[0]!.url.pathname).toBe(`/api/labels/changes/${SET_ID_2}/commit`);
  });

  it('undo of a change set with nothing to undo is refused with exit 15', async () => {
    gateway = () => fail(422, 'nothing_to_undo', 'This change set is cancelled: it changed nothing, so there is nothing to undo.', { status: 'cancelled' });
    await run('labels', 'undo', SET_ID);
    expect(process.exitCode).toBe(15);
    expect(stderr).toContain('nothing to undo');
  });

  it('sets lists newest first, pages with --before, and --all follows the pages', async () => {
    const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      change_set_id: id,
      kind: 'set',
      status,
      scope: 'region',
      accounts: [12345],
      totals: { identities: 6, to_change: 5, unchanged: 1, fields_to_change: 6 },
      commit: null,
      preview_actor: 'a.person@example.test',
      commit_actor: null,
      surface: 'http',
      undoes: null,
      created_at: '2026-11-12T10:00:00.000000Z',
      expires_at: '2026-11-13T10:00:00.000000Z',
      committed_at: null,
      ...extra,
    });
    gateway = (req) =>
      req.url.searchParams.get('before')
        ? { status: 200, body: { ok: true, state: 'on', account: 12345, change_sets: [row(SET_ID_2, 'cancelled')], has_more: false, next_before: null, limit: 1 } }
        : { status: 200, body: { ok: true, state: 'on', account: 12345, change_sets: [row(SET_ID, 'committed', { commit: counts({ stale: 1 }), commit_actor: 'b.person@example.test' })], has_more: true, next_before: '2026-11-12T10:00:00.000000Z', limit: 1 } };
    await run('labels', 'sets', '--account', ACCOUNT, '--limit', '1');
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({ account: '12345', limit: '1' });
    expect(stdout).toContain(`| ${SET_ID} | set | committed | region | 5 of 6 (1 stale, 0 refused) | b.person@example.test |`);
    expect(stdout).toContain('More change sets: add --before 2026-11-12T10:00:00.000000Z');

    seen.length = 0;
    stdout = '';
    await run('--json', 'labels', 'sets', '--account', ACCOUNT, '--limit', '1', '--all');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.url.searchParams.get('before')).toBe('2026-11-12T10:00:00.000000Z');
    expect(lastLineJson()).toMatchObject({ status: 'ok', count: 2, pages: 2, has_more: false, next_before: null });

    process.exitCode = undefined;
    await run('labels', 'sets', '--account', ACCOUNT, '--before', 'yesterday');
    await run('labels', 'sets', '--account', ACCOUNT, '--limit', '500');
    expect(process.exitCode).toBe(1);
  });

  it('set shows a committed change set with what happened to each item that was not changed', async () => {
    gateway = () => ({
      status: 200,
      body: view({ status: 'partial', committed_at: '2026-11-12T11:00:00.000000Z', commit_actor: 'b.person@example.test', approval_hash: undefined, can_commit: false, commit: counts({ applied: 3, stale: 1, refused: 1 }), needs_attention: staleRows }),
    });
    await run('labels', 'set', SET_ID);
    expect(seen[0]!.method).toBe('GET');
    expect(stdout).toContain('(partial)');
    expect(stdout).toContain('- committed: 2026-11-12T11:00:00.000000Z by b.person@example.test');
    expect(stdout).toContain('- result: 3 changed, 1 already had these values, 1 stale, 1 refused');
    expect(stdout).toContain('| 12345 | B0EXAMPLE03 | stale | - | item_group |');
    expect(stdout).not.toContain('expires:');
    expect(process.exitCode).toBeUndefined();

    gateway = () => fail(404, 'change_set_not_found', 'No such change set for this account.');
    await run('labels', 'set', SET_ID);
    expect(process.exitCode).toBe(7);
  });

  it('cancel drops the preview and its kept approval; a committed set cannot be cancelled', async () => {
    await previewOnce();
    // Without --commit: the set is shown, nothing is cancelled.
    gateway = (req) => {
      if (req.method !== 'GET') throw new Error('a write was sent');
      return { status: 200, body: view() };
    };
    await run('labels', 'cancel', SET_ID);
    expect(writesSeen()).toHaveLength(0);
    expect(stderr).toContain('NOT CANCELLED (no --commit)');
    expect(stderr).toContain(`mixshift labels cancel ${SET_ID} --commit`);
    expect(await readFile(pendingFile(), 'utf8')).toContain(HASH);
    seen.length = 0;
    stderr = '';
    gateway = () => ({ status: 200, body: { ok: true, state: 'on', change_set_id: SET_ID, status: 'cancelled', friendly: 'Cancelled. Nothing was changed.' } });
    await run('labels', 'cancel', SET_ID, '--commit');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url.pathname).toBe(`/api/labels/changes/sets/${SET_ID}/cancel`);
    expect(stderr).toContain('✓ Cancelled. Nothing was changed.');
    await expect(readFile(pendingFile(), 'utf8')).rejects.toThrow();

    gateway = () => fail(409, 'not_cancellable', 'This change set is committed, so it cannot be cancelled. Only a preview can be.', { status: 'committed' });
    await run('labels', 'cancel', SET_ID, '--commit');
    expect(process.exitCode).toBe(15);
    expect(stderr).toContain('Only a preview can be.');
  });

  it('refuses a malformed change set id for set, cancel and undo before any request', async () => {
    for (const sub of ['set', 'cancel', 'undo']) {
      process.exitCode = undefined;
      await run('labels', sub, '123');
      expect(process.exitCode, sub).toBe(1);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
