/**
 * `mixshift forecast budget show|set|clear` end to end: the real command, the real
 * planning and transport, a stubbed fetch standing in for the gateway's
 * /api/app-state/forecasting endpoints (shapes as served on main, 2026-10-08).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { registerForecastCommands } from './forecast.js';
import { track, EventName } from '../lib/telemetry/index.js';
import { monthKey } from '../lib/forecast/budget.js';

vi.mock('../lib/auth/credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auth/credentials.js')>();
  return {
    ...actual,
    loadCredentials: vi.fn(async () => ({ credentials: { datahub: { api_base: 'https://gw.example' } } })),
    getValidAccessToken: vi.fn(async () => 'token'),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

const SCOPE = 'src:fake_db:42';
type Row = { key: string; version: number; doc: Record<string, unknown> };
let rows: Map<string, Row>;
/** Sub-brand definitions the fake gateway holds, keyed by scope id. */
let defs: Map<string, Record<string, unknown>>;
let refuseCreate: { status: number; kind: string } | null;
let posts: Array<{ writes: Array<{ key: string; expected_version: number; doc: Record<string, unknown> }>; reason?: string }>;
let stdout: string[];
let stderr: string[];
let exitBefore: typeof process.exitCode;

function fakeGateway() {
  return vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const reply = (status: number, json: unknown) => ({ status, ok: status < 300, json: async () => json }) as unknown as Response;
    if (init.method === 'GET' && url.pathname === '/api/app-state/forecasting/scopes') {
      const seller = url.searchParams.get('legacy_seller_id');
      const list = [...defs.values()].filter((d) => seller === null || String(d.merchantId).endsWith(`:${seller}`));
      return reply(200, { ok: true, ...(seller ? { merchant_id: `src:fake_db:${seller}` } : {}), definitions: list.map((d) => ({ ...d, scopeId: d.id, version: 1 })), skipped: 0 });
    }
    if (init.method === 'POST' && url.pathname === '/api/app-state/forecasting/scopes') {
      if (refuseCreate) return reply(refuseCreate.status, { ok: false, kind: refuseCreate.kind, friendly: 'Merchant 999 is not connected to this account.' });
      const { create } = JSON.parse(String(init.body));
      const id = `src:fake_db:${create.legacySellerId}:scope:k${String(defs.size + 1).padStart(7, '0')}`;
      const definition = { id, merchantId: `src:fake_db:${create.legacySellerId}`, kind: create.kind, name: create.name, itemValues: create.itemValues, campaignValues: create.campaignValues, createdAt: 'now', updatedAt: 'now' };
      defs.set(id, definition);
      rows.set(`fb:scope_def:${id}`, { key: `fb:scope_def:${id}`, version: 1, doc: definition });
      return reply(200, { ok: true, definition, version: 1 });
    }
    if (init.method === 'GET' && url.pathname === '/api/app-state/forecasting/doc') {
      const row = rows.get(url.searchParams.get('key')!);
      return row ? reply(200, { ok: true, ...row }) : reply(404, { ok: false, kind: 'not_found', friendly: 'No document is stored under this key.' });
    }
    if (init.method === 'GET' && url.pathname === '/api/app-state/forecasting/docs') {
      const prefix = url.searchParams.get('prefix')!;
      const docs = [...rows.values()].filter((r) => r.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
      return reply(200, { ok: true, docs, next_after: null });
    }
    if (init.method === 'POST' && url.pathname === '/api/app-state/forecasting/batch') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      for (const w of body.writes) {
        const actual = rows.get(w.key)?.version ?? 0;
        if (actual !== w.expected_version) return reply(409, { ok: false, kind: 'conflict', conflicts: [{ key: w.key, expected: w.expected_version, actual }] });
      }
      const results = body.writes.map((w: Row & { expected_version: number }) => {
        if (w.doc === null) {
          rows.delete(w.key);
          if (w.key.startsWith('fb:scope_def:')) defs.delete(w.key.slice('fb:scope_def:'.length));
          return { key: w.key, version: null, changed: true };
        }
        const version = w.expected_version + 1;
        rows.set(w.key, { key: w.key, version, doc: { ...w.doc, version, actor: 'sam@example.com' } });
        return { key: w.key, version, changed: true };
      });
      return reply(200, { ok: true, results });
    }
    return reply(404, { ok: false, kind: 'not_found' });
  });
}

async function runForecast(json: boolean, group: string, ...args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', '', false).option('--data-dir <path>', '');
  registerForecastCommands(program);
  await program.parseAsync(['node', 'mixshift', ...(json ? ['--json'] : []), 'forecast', group, ...args]);
}
const run = (json: boolean, ...args: string[]) => runForecast(json, 'budget', ...args);
const runSub = (json: boolean, ...args: string[]) => runForecast(json, 'sub-brand', ...args);

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map();
  defs = new Map();
  refuseCreate = null;
  posts = [];
  stdout = [];
  stderr = [];
  exitBefore = process.exitCode;
  process.exitCode = undefined;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
  vi.stubGlobal('fetch', fakeGateway());
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (stdout.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (stderr.push(String(c)), true));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = exitBefore;
});

describe('forecast budget', () => {
  it('set writes one batch of month rows, show lists them, clear takes one back to the estimate', async () => {
    rows.set(monthKey(SCOPE, '2026-11'), {
      key: monthKey(SCOPE, '2026-11'),
      version: 2,
      doc: { scopeId: SCOPE, month: '2026-11-01', sales: { mode: 'replace', value: 5, sourceObserved: 4 }, adSpend: { mode: 'inherit', value: null, sourceObserved: null }, adBudget: { mode: 'inherit', value: null }, status: 'final', note: 'kept', version: 2 },
    });
    await run(true, 'set', '--scope', 'src:FAKE_DB:42', '--set', '2026-10=50,000', '--set', '2026-11=40000', '--note', '2026 budget sheet');
    expect(process.exitCode).toBeUndefined();
    const out = JSON.parse(stdout.join(''));
    expect(out).toMatchObject({ ok: true, scope_id: SCOPE, written: 2, budgets: [{ month: '2026-10', sponsored_budget: 50000 }, { month: '2026-11', sponsored_budget: 40000 }] });
    expect(posts).toHaveLength(1);
    // November's existing note explains its sales correction: kept, and said so. October is new: it takes the note.
    expect(rows.get(monthKey(SCOPE, '2026-11'))!.doc).toMatchObject({ sales: { mode: 'replace', value: 5 }, status: 'final', note: 'kept', adBudget: { mode: 'replace', value: 40000 } });
    expect(rows.get(monthKey(SCOPE, '2026-10'))!.doc.note).toBe('2026 budget sheet');
    expect(out.notes_kept).toEqual(['2026-11']);
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ event_name: EventName.ForecastBudgetSet, payload: { scope_id: SCOPE, months: 2, written: 2, unchanged: 0, notes_kept: 1 } }), undefined);
    // Telemetry never carries an amount or the note.
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toMatch(/50000|40000|budget sheet/);

    stdout = [];
    await run(true, 'show', '--scope', SCOPE);
    expect(JSON.parse(stdout.join('')).budgets.map((b: { month: string; sponsored_budget: number }) => [b.month, b.sponsored_budget])).toEqual([
      ['2026-10', 50000],
      ['2026-11', 40000],
    ]);

    stdout = [];
    await run(true, 'clear', '--scope', SCOPE, '--month', '2026-10', '--month', '2026-12');
    expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: true, cleared: 1, not_set: ['2026-12'] });
    // October held only the budget and the note this command gave it: kept as a row, since the note stays.
    expect(rows.get(monthKey(SCOPE, '2026-10'))!.doc.adBudget).toEqual({ mode: 'inherit', value: null });
  });

  it('--dry-run shows the change and saves nothing', async () => {
    await run(true, 'set', '--scope', SCOPE, '--set', '2026-10=50000', '--dry-run');
    expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: true, dry_run: true, changes: [{ month: '2026-10', from: null, to: 50000 }] });
    expect(posts).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  it('refuses a closed month, a bad scope and a bad pair before any call', async () => {
    await run(false, 'set', '--scope', SCOPE, '--set', '2026-09=1');
    expect(stderr.join('')).toMatch(/2026-09 is already closed/);
    expect(process.exitCode).toBe(4);
    process.exitCode = undefined;
    await run(false, 'set', '--scope', 'fake_db:42', '--set', '2026-10=1');
    expect(stderr.join('')).toMatch(/not a forecast scope/);
    await run(false, 'set', '--scope', SCOPE, '--set', '2026-10');
    expect(stderr.join('')).toMatch(/YYYY-MM=amount/);
    await run(false, 'set', '--scope', `${SCOPE}:scope:Out`, '--set', '2026-10=1');
    expect(stderr.join('')).toMatch(/is not a sub-brand scope this service keeps/);
    await run(false, 'set', '--scope', SCOPE, '--set', '2027-11=1');
    expect(stderr.join('')).toMatch(/2027-11 is past the furthest month a forecast reaches \(2027-10\)/);
    await run(false, 'set', '--scope', SCOPE, '--set', '2026-10=1', '--note', 'hidden‮text');
    expect(stderr.join('')).toMatch(/--note: a note is plain text/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("a gateway refusal prints the gateway's sentence, exits non-zero and is counted", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 409, ok: false, json: async () => ({ ok: false, kind: 'state_home_elsewhere', friendly: "This app's state lives under another login." }) }) as unknown as Response),
    );
    await run(false, 'set', '--scope', SCOPE, '--set', '2026-10=1');
    expect(stderr.join('')).toMatch(/\(state_home_elsewhere\) This app's state lives under another login/);
    expect(process.exitCode).toBe(13);
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ event_name: EventName.ForecastBudgetFailed, error_class: 'state_home_elsewhere' }), undefined);
  });

  it('show on a scope with no budget says the forecast estimates spend', async () => {
    await run(false, 'show', '--scope', SCOPE);
    expect(stdout.join('')).toMatch(/No budget entered for src:fake_db:42/);
  });
});

describe('forecast sub-brand (mx-ops#134)', () => {
  // stdout is reset before each JSON command, so it holds exactly one (pretty-printed) answer.
  const lastJson = () => JSON.parse(stdout.join(''));

  it('add defines one from labels, list shows it, and adding the same labels again reuses it', async () => {
    await runSub(true, 'add', '--seller', '42', '--name', 'Summit Gear', '--item-label', ' Summit ', '--item-label', 'Summit', '--campaign-label', 'summit');
    expect(lastJson()).toMatchObject({ ok: true, created: true, sub_brand: { scope_id: 'src:fake_db:42:scope:k0000001', scope_key: 'k0000001', kind: 'sub_brand', item_values: ['Summit'], campaign_values: ['summit'] } });
    stdout = [];
    await runSub(true, 'add', '--seller', '42', '--name', 'Summit again', '--item-label', 'SUMMIT', '--campaign-label', 'Summit');
    expect(lastJson()).toMatchObject({ ok: true, created: false, sub_brand: { scope_id: 'src:fake_db:42:scope:k0000001' } });
    expect(defs.size).toBe(1);
    stdout = [];
    await runSub(true, 'list', '--seller', '42');
    expect(lastJson()).toMatchObject({ ok: true, merchant_id: 'src:fake_db:42', sub_brands: [{ scope_key: 'k0000001', name: 'Summit Gear' }] });
    // Telemetry carries counts, never the name or the labels.
    const defined = vi.mocked(track).mock.calls.map(([e]) => e).filter((e) => e.event_name === EventName.ForecastSubBrandDefined);
    expect(defined.map((e) => e.payload)).toEqual([
      { scope_id: 'src:fake_db:42:scope:k0000001', seller: 42, kind: 'sub_brand', created: true, item_values: 1, campaign_values: 1 },
      { scope_id: 'src:fake_db:42:scope:k0000001', seller: 42, kind: 'sub_brand', created: false, item_values: 1, campaign_values: 1 },
    ]);
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toMatch(/Summit/);
  });

  it('refuses a bad seller, a blank name and no product label before any call; --dry-run defines nothing', async () => {
    await runSub(false, 'add', '--seller', '4x2', '--name', 'X', '--item-label', 'X');
    expect(stderr.join('')).toMatch(/--seller: "4x2" is not a seller id/);
    await runSub(false, 'add', '--seller', '42', '--name', '  ', '--item-label', 'X');
    expect(stderr.join('')).toMatch(/--name: a name is required/);
    await runSub(false, 'add', '--seller', '42', '--name', 'X', '--item-label', '  ');
    expect(stderr.join('')).toMatch(/at least one product label/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    process.exitCode = undefined;
    await runSub(false, 'add', '--seller', '42', '--name', 'Flasks', '--item-label', 'Flask', '--item-group', '--dry-run');
    expect(stdout.join('')).toMatch(/Would define for seller 42 \(nothing saved\)/);
    expect(stdout.join('')).toMatch(/no ad spend and a forecast cannot train on it/);
    expect(defs.size).toBe(0);
  });

  it('the budget of a sub-brand is its own: set writes under its scope, never the account', async () => {
    await runSub(true, 'add', '--seller', '42', '--name', 'Summit Gear', '--item-label', 'Summit', '--campaign-label', 'summit');
    const sub = 'src:fake_db:42:scope:k0000001';
    await run(true, 'set', '--scope', sub, '--set', '2026-11=5000');
    expect(posts.at(-1)!.writes.map((w) => w.key)).toEqual([monthKey(sub, '2026-11')]);
    expect(rows.has(monthKey(SCOPE, '2026-11'))).toBe(false);
  });

  it('remove shows what would go; --apply removes the definition, its months and settings in one batch', async () => {
    await runSub(true, 'add', '--seller', '42', '--name', 'Summit Gear', '--item-label', 'Summit', '--campaign-label', 'summit');
    const sub = 'src:fake_db:42:scope:k0000001';
    await run(true, 'set', '--scope', sub, '--set', '2026-11=5000', '--set', '2026-12=6000');
    rows.set(`fb:account:${sub}`, { key: `fb:account:${sub}`, version: 2, doc: { treatMissingAdSpendAsZero: true } });
    stdout = [];
    const before = posts.length;
    await runSub(true, 'remove', '--scope', sub);
    expect(lastJson()).toEqual({ ok: true, dry_run: true, scope_id: sub, would_remove: { definition: true, months: 2, settings: true } });
    expect(posts.length).toBe(before);
    stdout = [];
    await runSub(true, 'remove', '--scope', sub, '--apply');
    expect(lastJson()).toMatchObject({ ok: true, deleted: 4 });
    expect(posts.at(-1)!.writes).toEqual([
      { key: `fb:scope_def:${sub}`, expected_version: 1, doc: null },
      { key: monthKey(sub, '2026-11'), expected_version: 1, doc: null },
      { key: monthKey(sub, '2026-12'), expected_version: 1, doc: null },
      { key: `fb:account:${sub}`, expected_version: 2, doc: null },
    ]);
    expect([...rows.keys()].some((k) => k.includes(sub))).toBe(false);
    stderr = [];
    await runSub(false, 'remove', '--scope', SCOPE);
    expect(stderr.join('')).toMatch(/is not a sub-brand scope/);
  });

  it('a gateway refusal prints the gateway sentence, exits non-zero and is counted', async () => {
    refuseCreate = { status: 403, kind: 'merchant_not_connected' };
    await runSub(false, 'add', '--seller', '999', '--name', 'X', '--item-label', 'X');
    expect(stderr.join('')).toMatch(/Merchant 999 is not connected/);
    expect(process.exitCode).not.toBe(0);
    const failed = vi.mocked(track).mock.calls.map(([e]) => e).find((e) => e.event_name === EventName.ForecastSubBrandFailed);
    expect(failed?.payload).toMatchObject({ op: 'add', seller: 999, failure_kind: 'merchant_not_connected' });
  });
});
