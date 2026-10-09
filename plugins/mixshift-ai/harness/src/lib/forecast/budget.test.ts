import { describe, it, expect, vi } from 'vitest';
import {
  BUDGET_REASON,
  applyBudgetPlan,
  beyondHorizon,
  budgetOf,
  budgetRows,
  canonicalScopeId,
  isSubBrandScope,
  noteProblem,
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
    // A sub-brand is the app's: refused, with its own sentence (the computed forecast never serves one).
    expect(canonicalScopeId(' src:fake_db:42:scope:outdoor ')).toBeNull();
    expect(isSubBrandScope(' src:fake_db:42:scope:outdoor ')).toBe(true);
    expect(isSubBrandScope('src:fake_db:42')).toBe(false);
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
    // Commas only as thousands separators: a decimal comma would read a hundred times too large.
    for (const bad of ['50,00', '1,2,3', '1,,000', '50000,5']) expect(() => parseBudgetEntries([`2026-10=${bad}`])).toThrow(/not an amount/);
    expect(parseBudgetEntries(['2026-10=1,250,000.25'])).toEqual([{ month: '2026-10', amount: 1250000.25 }]);
    expect(() => parseBudgetEntries(['2026-10=2000000000'])).toThrow(/larger than any monthly budget/);
    const many = Array.from({ length: 25 }, (_, i) => `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}=1`);
    expect(() => parseBudgetEntries(many)).toThrow(/At most 24/);
    expect(() => parseMonths(['2026-1'])).toThrow(/not a month/);
  });

  it('a closed month is past; the month in progress is not (UTC); past twelve months ahead no forecast reaches', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(pastMonths(['2026-09', '2026-10', '2026-11'], now)).toEqual(['2026-09']);
    expect(beyondHorizon(['2027-10', '2027-11'], now)).toEqual(['2027-11']);
  });

  it('a note is plain text: new lines yes, control, direction and zero-width characters no', () => {
    expect(noteProblem('from the 2026 budget sheet\nrevised in Q3')).toBeNull();
    expect(noteProblem('x'.repeat(2001))).toMatch(/2000/);
    for (const bad of ['tab\there', 'bell\u0007', 'rtl\u202ehidden', 'zero\u200bwidth', 'c1\u0085']) expect(noteProblem(bad)).toMatch(/plain text/);
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
    const doc = writes[0]!.doc!;
    expect(doc.adBudget).toEqual({ mode: 'replace', value: 50000 });
    expect(doc.sales).toEqual({ mode: 'replace', value: 713105, sourceObserved: 698220 });
    expect(doc.units).toEqual({ mode: 'replace', value: 900, sourceObserved: 880 });
    expect(doc.status).toBe('final');
    expect(doc.note).toBe('stockout week 2');
    for (const stamped of ['version', 'updatedAt', 'actor']) expect(doc).not.toHaveProperty(stamped);
  });

  it("a note lands only on a month that has none; an existing note (it explains another correction) is kept and reported", () => {
    const stored = rowsOf(
      storedRow('2026-10', { adBudget: { mode: 'replace', value: 50000 } }),
      storedRow('2026-11'),
      storedRow('2026-12', { note: null }),
    );
    const same = planBudgetSet(SCOPE, stored, [{ month: '2026-10', amount: 50000 }]);
    expect(same).toEqual({ writes: [], unchanged: ['2026-10'], notesKept: [] });
    const noted = planBudgetSet(
      SCOPE,
      stored,
      [
        { month: '2026-10', amount: 50000 },
        { month: '2026-11', amount: 40000 },
        { month: '2026-12', amount: 45000 },
        { month: '2027-01', amount: 30000 },
      ],
      '2026 budget sheet',
    );
    expect(noted.writes.map((w) => [w.key.slice(-10), w.doc!.note])).toEqual([
      ['2026-11-01', 'stockout week 2'],
      ['2026-12-01', '2026 budget sheet'],
      ['2027-01-01', '2026 budget sheet'],
    ]);
    // October already held the budget; its stored note stays, so nothing to write.
    expect(noted.unchanged).toEqual(['2026-10']);
    expect(noted.notesKept).toEqual(['2026-10', '2026-11']);
  });

  it('keeps any field the app stores on the budget that this build does not know', () => {
    const { writes } = planBudgetSet(SCOPE, rowsOf(storedRow('2026-10', { adBudget: { mode: 'inherit', value: null, plannedBy: 'plan-7' } })), [{ month: '2026-10', amount: 1 }]);
    expect(writes[0]!.doc!.adBudget).toEqual({ mode: 'replace', value: 1, plannedBy: 'plan-7' });
  });

  it('clear takes the budget back to inherit and keeps the rest; a month with no budget is reported, not written', () => {
    const stored = rowsOf(storedRow('2026-10', { adBudget: { mode: 'replace', value: 50000 } }), storedRow('2026-11'));
    const { writes, notSet } = planBudgetClear(SCOPE, stored, ['2026-10', '2026-11', '2026-12']);
    expect(notSet).toEqual(['2026-11', '2026-12']);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.doc!.adBudget).toEqual({ mode: 'inherit', value: null });
    expect(writes[0]!.doc!.sales).toEqual({ mode: 'replace', value: 713105, sourceObserved: 698220 });
  });

  it('clear removes a row that held only the budget, rather than leaving an empty row', () => {
    const budgetOnly = planBudgetSet(SCOPE, rowsOf(), [{ month: '2026-10', amount: 50000 }]).writes[0]!;
    const stored = rowsOf({ key: budgetOnly.key, version: 1, doc: { ...budgetOnly.doc!, version: 1, updatedAt: 't', actor: 'a@b.example' } });
    expect(planBudgetClear(SCOPE, stored, ['2026-10']).writes).toEqual([{ key: budgetOnly.key, expected_version: 1, doc: null }]);
    // A field this build does not know keeps the row.
    const unknown = rowsOf({ key: budgetOnly.key, version: 1, doc: { ...budgetOnly.doc!, appOnly: true } });
    expect(planBudgetClear(SCOPE, unknown, ['2026-10']).writes[0]!.doc).not.toBeNull();
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
  it("reads only this scope's own month rows: a sub-brand's rows under the same prefix are ignored", async () => {
    const sub = { ...storedRow('2026-10', { adBudget: { mode: 'replace', value: 5000 } }), key: `fb:override:${SCOPE}:scope:outdoor:2026-10-01` };
    const { opts } = gateway(() => ({ status: 200, json: { ok: true, docs: [storedRow('2026-10'), sub], next_after: null } }));
    const r = await readMonthRows(SCOPE, opts);
    expect(r.ok && [...r.rows.keys()]).toEqual([monthKey(SCOPE, '2026-10')]);
  });

  it('a retry stops, writing nothing, when the budget itself changed meanwhile (someone saved one in the app)', async () => {
    let gets = 0;
    let posts = 0;
    const { opts } = gateway((method) => {
      if (method === 'GET') {
        gets += 1;
        return { status: 200, json: { ok: true, docs: [storedRow('2026-10', gets === 1 ? {} : { adBudget: { mode: 'replace', value: 61000 } }, gets === 1 ? 3 : 4)], next_after: null } };
      }
      posts += 1;
      return { status: 409, json: { ok: false, kind: 'conflict', conflicts: [] } };
    });
    const r = await applyBudgetPlan(SCOPE, (rows) => planBudgetSet(SCOPE, rows, [{ month: '2026-10', amount: 50000 }]), opts);
    expect(posts).toBe(1);
    expect(r).toMatchObject({ ok: false, kind: 'conflict', friendly: expect.stringMatching(/2026-10 was changed .*now 61,000.*nothing was written/) });
  });

  it('a dry run reads and plans, and never writes', async () => {
    const { calls, opts } = gateway(() => ({ status: 200, json: { ok: true, docs: [storedRow('2026-10', { adBudget: { mode: 'replace', value: 1000 } })], next_after: null } }));
    const r = await applyBudgetPlan(SCOPE, (rows) => planBudgetSet(SCOPE, rows, [{ month: '2026-10', amount: 50000 }]), { ...opts, dryRun: true });
    expect(r).toMatchObject({ ok: true, written: 0 });
    expect(r.ok && r.plan.writes).toHaveLength(1);
    expect(r.ok && r.current.get(monthKey(SCOPE, '2026-10'))).toBe(1000);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('a home-login lookup the gateway could not make is retryable, not unknown', async () => {
    const { opts } = gateway(() => ({ status: 503, json: { ok: false, kind: 'unavailable', friendly: "The database's home login could not be checked. Try again." } }));
    expect(await readMonthRows(SCOPE, opts)).toMatchObject({ kind: 'unavailable' });
  });
});
