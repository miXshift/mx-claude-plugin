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

const SCOPE = 'src:fake_db:71';
type Row = { key: string; version: number; doc: Record<string, unknown> };
let rows: Map<string, Row>;
let posts: Array<{ writes: Array<{ key: string; expected_version: number; doc: Record<string, unknown> }>; reason?: string }>;
let stdout: string[];
let stderr: string[];
let exitBefore: typeof process.exitCode;

function fakeGateway() {
  return vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const reply = (status: number, json: unknown) => ({ status, ok: status < 300, json: async () => json }) as unknown as Response;
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
        const version = w.expected_version + 1;
        rows.set(w.key, { key: w.key, version, doc: { ...w.doc, version, actor: 'sam@example.com' } });
        return { key: w.key, version, changed: true };
      });
      return reply(200, { ok: true, results });
    }
    return reply(404, { ok: false, kind: 'not_found' });
  });
}

async function run(json: boolean, ...args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', '', false).option('--data-dir <path>', '');
  registerForecastCommands(program);
  await program.parseAsync(['node', 'mixshift', ...(json ? ['--json'] : []), 'forecast', 'budget', ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map();
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
    await run(true, 'set', '--scope', 'src:FAKE_DB:71', '--set', '2026-10=84,450', '--set', '2026-11=53700', '--note', '2026 budget sheet');
    expect(process.exitCode).toBeUndefined();
    const out = JSON.parse(stdout.join(''));
    expect(out).toMatchObject({ ok: true, scope_id: SCOPE, written: 2, budgets: [{ month: '2026-10', sponsored_budget: 84450 }, { month: '2026-11', sponsored_budget: 53700 }] });
    expect(posts).toHaveLength(1);
    expect(rows.get(monthKey(SCOPE, '2026-11'))!.doc).toMatchObject({ sales: { mode: 'replace', value: 5 }, status: 'final', note: '2026 budget sheet', adBudget: { mode: 'replace', value: 53700 } });
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ event_name: EventName.ForecastBudgetSet, payload: { scope_id: SCOPE, months: 2, written: 2, unchanged: 0 } }), undefined);
    // Telemetry never carries an amount or the note.
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toMatch(/84450|53700|budget sheet/);

    stdout = [];
    await run(true, 'show', '--scope', SCOPE);
    expect(JSON.parse(stdout.join('')).budgets.map((b: { month: string; sponsored_budget: number }) => [b.month, b.sponsored_budget])).toEqual([
      ['2026-10', 84450],
      ['2026-11', 53700],
    ]);

    stdout = [];
    await run(true, 'clear', '--scope', SCOPE, '--month', '2026-10', '--month', '2026-12');
    expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: true, cleared: 1, not_set: ['2026-12'] });
    expect(rows.get(monthKey(SCOPE, '2026-10'))!.doc.adBudget).toEqual({ mode: 'inherit', value: null });
  });

  it('refuses a closed month, a bad scope and a bad pair before any call', async () => {
    await run(false, 'set', '--scope', SCOPE, '--set', '2026-09=1');
    expect(stderr.join('')).toMatch(/2026-09 is already closed/);
    expect(process.exitCode).toBe(4);
    process.exitCode = undefined;
    await run(false, 'set', '--scope', 'dashamazon:71', '--set', '2026-10=1');
    expect(stderr.join('')).toMatch(/not a forecast scope/);
    await run(false, 'set', '--scope', SCOPE, '--set', '2026-10');
    expect(stderr.join('')).toMatch(/YYYY-MM=amount/);
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
    expect(stdout.join('')).toMatch(/No budget entered for src:fake_db:71/);
  });
});
