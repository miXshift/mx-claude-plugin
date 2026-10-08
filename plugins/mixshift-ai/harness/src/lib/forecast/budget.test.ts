import { describe, it, expect, vi } from 'vitest';
import {
  BUDGET_REASON,
  applyBudgetPlan,
  budgetOf,
  budgetRows,
  canonicalScopeId,
  monthKey,
  parseBudgetEntries,
  parseMonths,
  pastMonths,
  planBudgetClear,
  planBudgetSet,
  readMonthRows,
  type StoredMonthRow,
} from './budget.js';

const SCOPE = 'src:fake_db:42';

/**
 * A stored month row exactly as the gateway's docs endpoint returns it
 * (mx-legacy-auth src/routes/app-state.ts + src/app-state/forecasting.ts on main,
 * 2026-10-08): the app's month row with the gateway's stamps (version, updatedAt,
 * actor) inside the doc, and the row version beside it.
 */
function storedRow(month: string, over: Record<string, unknown> = {}, version = 3): StoredMonthRow {
  return {
    key: monthKey(SCOPE, month),
    version,
    updated_at: '2026-10-01T10:00:00.000Z',
    updated_by: 'planner@brand.example',
    doc: {
      scopeId: SCOPE,
      month: `${month}-01`,
      sales: { mode: 'replace', value: 713105, sourceObserved: 698220 },
      adSpend: { mode: 'inherit', value: null, sourceObserved: null },
      adBudget: { mode: 'inherit', value: null },
      status: 'final',
      note: 'stockout week 2',
      version,
      updatedAt: '2026-10-01T10:00:00.000Z',
      actor: 'planner@brand.example',
      ...over,
    },
  };
}

const rowsOf = (...rows: StoredMonthRow[]) => new Map(rows.map((r) => [r.key, r]));

describe('inputs', () => {
  it('canonicalises the scope id the way the gateway stores it, and refuses anything else', () => {
    expect(canonicalScopeId('src:Fake_DB:042')).toBe('src:fake_db:42');
    expect(canonicalScopeId(' src:fake_db:42:scope:outdoor ')).toBe('src:fake_db:42:scope:outdoor');
    for (const bad of ['fake_db:42', 'src:fake db:42', 'src:fake_db:', 'fb:override:src:x:1:2026-10-01']) {
      expect(canonicalScopeId(bad)).toBeNull();
    }
  });

  it('parses YYYY-MM=amount with $ and commas; a repeated month keeps its last amount; months sorted', () => {
    expect(parseBudgetEntries(['2026-11=40,000', '2026-10=$50,000', '2026-10=50000.5'])).toEqual([
      { month: '2026-10', amount: 50000.5 },
      { month: '2026-11', amount: 40000 },
    ]);
  });

  it('refuses a missing =, a bad month, a negative or non-numeric amount, and too many months', () => {
    expect(() => parseBudgetEntries([])).toThrow(/at least one month/);
    expect(() => parseBudgetEntries(['2026-10'])).toThrow(/YYYY-MM=amount/);
    expect(() => parseBudgetEntries(['2026-13=1'])).toThrow(/not a month/);
    expect(() => parseBudgetEntries(['2026-10=-5'])).toThrow(/not an amount/);
    expect(() => parseBudgetEntries(['2026-10=lots'])).toThrow(/not an amount/);
    expect(() => parseBudgetEntries(['2026-10=1.234'])).toThrow(/not an amount/);
    const many = Array.from({ length: 25 }, (_, i) => `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}=1`);
    expect(() => parseBudgetEntries(many)).toThrow(/At most 24/);
    expect(() => parseMonths(['2026-1'])).toThrow(/not a month/);
  });

  it('a closed month is past; the month in progress is not (UTC)', () => {
    expect(pastMonths(['2026-09', '2026-10', '2026-11'], new Date('2026-10-08T12:00:00Z'))).toEqual(['2026-09']);
  });
});

describe('planning', () => {
  it('a new month becomes a full month row with only the budget set', () => {
    const { writes, unchanged } = planBudgetSet(SCOPE, rowsOf(), [{ month: '2026-10', amount: 50000 }]);
    expect(unchanged).toEqual([]);
    expect(writes).toEqual([
      {
        key: 'fb:override:src:fake_db:42:2026-10-01',
        expected_version: 0,
        doc: {
          scopeId: SCOPE,
          month: '2026-10-01',
          sales: { mode: 'inherit', value: null, sourceObserved: null },
          adSpend: { mode: 'inherit', value: null, sourceObserved: null },
          adBudget: { mode: 'replace', value: 50000 },
          status: 'auto',
          note: null,
        },
      },
    ]);
  });

  it("an existing month keeps every other correction, its note, and the version it was read at; the gateway's stamps are not sent back", () => {
    const { writes } = planBudgetSet(SCOPE, rowsOf(storedRow('2026-10', { units: { mode: 'replace', value: 900, sourceObserved: 880 } })), [
      { month: '2026-10', amount: 50000 },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.expected_version).toBe(3);
    const doc = writes[0]!.doc;
    expect(doc.adBudget).toEqual({ mode: 'replace', value: 50000 });
    expect(doc.sales).toEqual({ mode: 'replace', value: 713105, sourceObserved: 698220 });
    expect(doc.units).toEqual({ mode: 'replace', value: 900, sourceObserved: 880 });
    expect(doc.status).toBe('final');
    expect(doc.note).toBe('stockout week 2');
    for (const stamped of ['version', 'updatedAt', 'actor']) expect(doc).not.toHaveProperty(stamped);
  });

  it('a note replaces the stored note; a month already holding the budget and note is left out', () => {
    const stored = rowsOf(storedRow('2026-10', { adBudget: { mode: 'replace', value: 50000 } }), storedRow('2026-11'));
    const same = planBudgetSet(SCOPE, stored, [{ month: '2026-10', amount: 50000 }]);
    expect(same).toEqual({ writes: [], unchanged: ['2026-10'] });
    const noted = planBudgetSet(SCOPE, stored, [{ month: '2026-10', amount: 50000 }, { month: '2026-11', amount: 40000 }], '2026 budget sheet');
    expect(noted.writes.map((w) => [w.key.slice(-10), w.doc.note])).toEqual([
      ['2026-10-01', '2026 budget sheet'],
      ['2026-11-01', '2026 budget sheet'],
    ]);
  });

  it('clear takes the budget back to inherit and keeps the rest; a month with no budget is reported, not written', () => {
    const stored = rowsOf(storedRow('2026-10', { adBudget: { mode: 'replace', value: 50000 } }), storedRow('2026-11'));
    const { writes, notSet } = planBudgetClear(SCOPE, stored, ['2026-10', '2026-11', '2026-12']);
    expect(notSet).toEqual(['2026-11', '2026-12']);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.doc.adBudget).toEqual({ mode: 'inherit', value: null });
    expect(writes[0]!.doc.sales).toEqual({ mode: 'replace', value: 713105, sourceObserved: 698220 });
  });

  it('budgetRows lists only months with a budget, in month order; a suppressed budget is not a budget', () => {
    const stored = rowsOf(
      storedRow('2026-12', { adBudget: { mode: 'replace', value: 45000 } }),
      storedRow('2026-10', { adBudget: { mode: 'replace', value: 50000 }, note: null }),
      storedRow('2026-11', { adBudget: { mode: 'suppress', value: null } }),
    );
    expect(budgetRows(stored).map((r) => [r.month, r.sponsored_budget, r.note])).toEqual([
      ['2026-10', 50000, null],
      ['2026-12', 45000, 'stockout week 2'],
    ]);
    expect(budgetOf({ adBudget: { mode: 'suppress', value: 5 } })).toBeNull();
  });
});

describe('transport', () => {
  function gateway(handler: (method: string, url: URL, body: any) => { status: number; json: unknown }) {
    const calls: Array<{ method: string; url: URL; body: any; auth: string }> = [];
    const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: String(init.method), url, body, auth: String((init.headers as Record<string, string>).Authorization) });
      const r = handler(String(init.method), url, body);
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json } as unknown as Response;
    });
    const opts = { apiBaseOverride: 'https://gw.example', tokenProvider: vi.fn(async (force?: boolean) => (force ? 'fresh' : 'stale')), fetchImpl: fetchImpl as unknown as typeof fetch };
    return { calls, opts };
  }

  it('reads every page of the scope, then writes one batch with the change-log reason', async () => {
    let wrote: any = null;
    const { calls, opts } = gateway((method, url, body) => {
      if (method === 'GET') {
        const after = url.searchParams.get('after');
        return after
          ? { status: 200, json: { ok: true, docs: [storedRow('2026-11')], next_after: null } }
          : { status: 200, json: { ok: true, docs: [storedRow('2026-10')], next_after: monthKey(SCOPE, '2026-10') } };
      }
      wrote = body;
      return { status: 200, json: { ok: true, results: body.writes.map((w: { key: string }) => ({ key: w.key, version: 4, changed: true })) } };
    });
    const r = await applyBudgetPlan(SCOPE, (rows) => planBudgetSet(SCOPE, rows, [{ month: '2026-10', amount: 50000 }, { month: '2026-12', amount: 45000 }]), opts);
    expect(r).toMatchObject({ ok: true, written: 2 });
    expect(calls[0]!.url.searchParams.get('prefix')).toBe('fb:override:src:fake_db:42:');
    expect(calls[1]!.url.searchParams.get('after')).toBe(monthKey(SCOPE, '2026-10'));
    expect(calls[2]!.url.pathname).toBe('/api/app-state/forecasting/batch');
    expect(wrote.reason).toBe(BUDGET_REASON);
    expect(wrote).not.toHaveProperty('on_behalf_of');
    expect(wrote.writes.map((w: { expected_version: number }) => w.expected_version)).toEqual([3, 0]);
  });

  it('a conflict re-reads and re-plans once from the fresh row, then gives up with nothing written', async () => {
    let posts = 0;
    let version = 3;
    const { opts } = gateway((method) => {
      if (method === 'GET') return { status: 200, json: { ok: true, docs: [storedRow('2026-10', {}, version)], next_after: null } };
      posts += 1;
      version += 1; // someone saved meanwhile
      return { status: 409, json: { ok: false, kind: 'conflict', friendly: 'stale', conflicts: [] } };
    });
    const r = await applyBudgetPlan(SCOPE, (rows) => planBudgetSet(SCOPE, rows, [{ month: '2026-10', amount: 1 }]), opts);
    expect(posts).toBe(2);
    expect(r).toMatchObject({ ok: false, kind: 'conflict' });
  });

  it('a mid-session 401 refreshes the token once and retries', async () => {
    const { calls, opts } = gateway((_m, _u) => (calls.length === 1 ? { status: 401, json: { ok: false } } : { status: 200, json: { ok: true, docs: [], next_after: null } }));
    const r = await readMonthRows(SCOPE, opts);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it("maps the gateway's kinds, keeps its sentence, and flags a kind this build does not know", async () => {
    const answer = (status: number, json: unknown) => gateway(() => ({ status, json })).opts;
    expect(await readMonthRows(SCOPE, answer(409, { ok: false, kind: 'state_home_elsewhere', friendly: 'lives under another login' }))).toMatchObject({
      kind: 'state_home_elsewhere',
      friendly: 'lives under another login',
    });
    expect(await readMonthRows(SCOPE, answer(403, { ok: false, kind: 'insufficient_scope' }))).toMatchObject({ kind: 'insufficient_scope', friendly: expect.stringMatching(/Sign in again/) });
    expect(await readMonthRows(SCOPE, answer(418, { ok: false, kind: 'teapot' }))).toMatchObject({ kind: 'unknown', unrecognizedKind: 'teapot' });
    const net = { apiBaseOverride: 'https://gw.example', tokenProvider: async () => 't', fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch };
    expect(await readMonthRows(SCOPE, net)).toMatchObject({ kind: 'host_unreachable' });
  });
});
