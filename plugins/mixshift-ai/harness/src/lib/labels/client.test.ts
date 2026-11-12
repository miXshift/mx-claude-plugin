import { describe, it, expect, vi } from 'vitest';
import {
  LOOKUP_MAX,
  collectPages,
  exitCodeForLabelsKind,
  labelsChanges,
  labelsDrift,
  labelsFields,
  labelsList,
  labelsLookup,
  labelsState,
  type LabelsClientOptions,
  type LabelsPage,
} from './client.js';

// Inject api_base + token + fetch so the suite never touches disk or the network.
function injected(
  fetchImpl: LabelsClientOptions['fetchImpl'],
  tokenProvider: LabelsClientOptions['tokenProvider'] = async () => 'tok',
): LabelsClientOptions {
  return { apiBaseOverride: 'https://svc.test', tokenProvider, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Made-up accounts, ids and values: this repo is public.
const ACCOUNT = '12345';

const STATE = {
  ok: true,
  state: 'observing',
  backfilled_at: '2026-11-01T10:00:00.000Z',
  last_run: { mode: 'reconcile', status: 'completed', started_at: '2026-11-12T10:00:00.000Z', finished_at: '2026-11-12T10:01:00.000Z', complete: true, duration_ms: 60000, counts: { accounts: 3, drift: 2 } },
  last_completed_at: '2026-11-12T10:01:00.000Z',
  running: false,
  freshness: { typical_lag_minutes: 15, note: 'A copy kept current.' },
};

const itemsPage = (ids: string[], next: string | null) => ({
  ok: true,
  state: 'observing',
  account: 12345,
  merchant_type: 'Seller',
  entity: 'item',
  fields: ['item_group', 'brand'],
  items: ids.map((id) => ({ id, status: 'seen', labels: { item_group: { value: 'Example Group', sync: 'synced', updated_at: '2026-11-10T00:00:00.000Z' } } })),
  next,
  next_cursor: next,
  has_more: next !== null,
  limit: 2,
});

describe('state and fields', () => {
  it('state: GETs /api/labels/state with a Bearer and returns the answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, STATE));
    const r = await labelsState(injected(fetchImpl));
    expect(r).toMatchObject({ ok: true, state: 'observing', running: false, last_completed_at: '2026-11-12T10:01:00.000Z' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/labels/state');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect((init as RequestInit).body).toBeUndefined();
  });

  it('state: an off tenant is an answer, not an error', async () => {
    const off = { ok: true, state: 'off', backfilled_at: null, last_run: null, last_completed_at: null, running: false, freshness: { note: 'not on' } };
    const r = await labelsState(injected(vi.fn().mockResolvedValueOnce(jsonResponse(200, off))));
    expect(r).toMatchObject({ ok: true, state: 'off', last_run: null });
  });

  it('fields: sends account and entity and keeps the field list', async () => {
    const body = {
      ok: true,
      state: 'on',
      account: 12345,
      merchant_type: 'Seller',
      entity: 'campaign',
      fields: [{ key: 'objective', label: 'Objective', display_name: null, max_length: 200, length_unit: 'chars', items_labeled: 3, distinct_values: 2, values: [{ value: 'Example', count: 2 }], values_truncated: false }],
      values_as_of: '2026-11-12T10:00:00.000Z',
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, body));
    const r = await labelsFields({ account: ACCOUNT, entity: 'campaign' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: true, entity: 'campaign', fields: [{ key: 'objective' }], values_as_of: '2026-11-12T10:00:00.000Z' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://svc.test/api/labels/fields?account=12345&entity=campaign');
  });
});

describe('list (search)', () => {
  it('items: filter, cursor and limit go in the query string; rows come from the items key', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, itemsPage(['B0EXAMPLE01', 'B0EXAMPLE02'], 'CURSOR2')));
    const r = await labelsList({ account: ACCOUNT, entity: 'item', field: 'item_group', value: 'Example Group', cursor: 'CURSOR1', limit: 2 }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: true, entity: 'item', next_cursor: 'CURSOR2', has_more: true, limit: 2, fields: ['item_group', 'brand'] });
    if (r.ok) expect(r.rows.map((x) => x.id)).toEqual(['B0EXAMPLE01', 'B0EXAMPLE02']);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/labels/items');
    expect(Object.fromEntries(url.searchParams)).toEqual({ account: '12345', field: 'item_group', value: 'Example Group', cursor: 'CURSOR1', limit: '2' });
  });

  it('campaigns: hits the campaigns path and reads the campaigns key', async () => {
    const body = { ...itemsPage([], null), entity: 'campaign', items: undefined, campaigns: [{ id: '111', status: 'seen', labels: {} }] };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, body));
    const r = await labelsList({ account: ACCOUNT, entity: 'campaign' }, injected(fetchImpl));
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://svc.test/api/labels/campaigns?account=12345');
    expect(r).toMatchObject({ ok: true, has_more: false, next_cursor: null });
  });

  it('paging: collectPages follows next_cursor to the end and stops', async () => {
    const pages = [itemsPage(['A1', 'A2'], 'C2'), itemsPage(['A3', 'A4'], 'C3'), itemsPage(['A5'], null)];
    const fetchImpl = vi.fn(async (_u: unknown, _i?: RequestInit) => jsonResponse(200, pages.shift()));
    const r = await collectPages<{ id: string }, LabelsPage>((cursor) => labelsList({ account: ACCOUNT, entity: 'item', ...(cursor ? { cursor } : {}), limit: 2 }, injected(fetchImpl)), { cap: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    expect(r).toMatchObject({ pages: 3, truncated: false, next_cursor: null });
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('cursor')).toBe('C2');
    expect(new URL(String(fetchImpl.mock.calls[2][0])).searchParams.get('cursor')).toBe('C3');
  });

  it('paging: the cap stops it between pages, says truncated, and hands back the exact cursor to resume', async () => {
    const pages = [itemsPage(['A1', 'A2'], 'C2'), itemsPage(['A3', 'A4'], 'C3'), itemsPage(['A5', 'A6'], 'C4')];
    const fetchImpl = vi.fn(async (_u: unknown, _i?: RequestInit) => jsonResponse(200, pages.shift()));
    const r = await collectPages<{ id: string }, LabelsPage>((cursor) => labelsList({ account: ACCOUNT, entity: 'item', ...(cursor ? { cursor } : {}), limit: 2 }, injected(fetchImpl)), { cap: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(4);
    expect(r).toMatchObject({ pages: 2, truncated: true, next_cursor: 'C3' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('paging: a page that advances nothing ends the loop instead of spinning', async () => {
    const fetchImpl = vi.fn(async (_u: unknown, _i?: RequestInit) => jsonResponse(200, itemsPage([], 'SAME')));
    const r = await collectPages<{ id: string }, LabelsPage>(() => labelsList({ account: ACCOUNT, entity: 'item' }, injected(fetchImpl)), { cap: 100 });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('paging: a failing page fails the whole run (no silently short "all")', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, itemsPage(['A1'], 'C2')))
      .mockResolvedValueOnce(jsonResponse(400, { ok: false, kind: 'bad_params', friendly: 'The cursor is not valid for this request.' }));
    const r = await collectPages<{ id: string }, LabelsPage>((cursor) => labelsList({ account: ACCOUNT, entity: 'item', ...(cursor ? { cursor } : {}) }, injected(fetchImpl)), { cap: 100 });
    expect(r).toMatchObject({ ok: false, kind: 'bad_params', httpStatus: 400 });
  });
});

describe('lookup', () => {
  const lookupBody = (ids: string[]) => ({
    ok: true,
    state: 'observing',
    account: 12345,
    merchant_type: 'Seller',
    entity: 'item',
    fields: ['item_group'],
    results: ids.map((id) => (id.startsWith('NEVER') ? { id, status: 'unseen', labels: {} } : { id, status: 'seen', labels: {} })),
    unseen: ids.filter((id) => id.startsWith('NEVER')),
  });

  it('POSTs { account, ids } to the items lookup path', async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => jsonResponse(200, lookupBody(JSON.parse(String(init?.body)).ids)));
    const r = await labelsLookup({ account: ACCOUNT, entity: 'item', ids: ['B0EXAMPLE01', 'NEVER1'] }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: true, batches: 1, unseen: ['NEVER1'] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/labels/items/lookup');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ account: 12345, ids: ['B0EXAMPLE01', 'NEVER1'] });
  });

  it('campaigns use the campaigns lookup path and string ids', async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => jsonResponse(200, { ...lookupBody(JSON.parse(String(init?.body)).ids), entity: 'campaign' }));
    await labelsLookup({ account: ACCOUNT, entity: 'campaign', ids: ['111222333'] }, injected(fetchImpl));
    expect(fetchImpl.mock.calls[0][0]).toBe('https://svc.test/api/labels/campaigns/lookup');
    expect(JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)).ids).toEqual(['111222333']);
  });

  it(`more than ${LOOKUP_MAX} ids go in batches of ${LOOKUP_MAX}, in order, merged into one answer`, async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => (i === 700 ? 'NEVER-X' : `B0EX${String(i).padStart(6, '0')}`));
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => jsonResponse(200, lookupBody(JSON.parse(String(init?.body)).ids)));
    const r = await labelsLookup({ account: ACCOUNT, entity: 'item', ids }, injected(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const sizes = fetchImpl.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).ids.length);
    expect(sizes).toEqual([500, 500, 201]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batches).toBe(3);
    expect(r.results.map((x) => x.id)).toEqual(ids);
    expect(r.unseen).toEqual(['NEVER-X']);
  });

  it('exactly 500 ids is one call; repeated ids are dropped before batching', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `B0EX${String(i).padStart(6, '0')}`);
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => jsonResponse(200, lookupBody(JSON.parse(String(init?.body)).ids)));
    const r = await labelsLookup({ account: ACCOUNT, entity: 'item', ids: [...ids, ...ids] }, injected(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, batches: 1 });
  });

  it('a failing batch fails the whole lookup (a half answer would read as complete)', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `B0EX${String(i).padStart(6, '0')}`);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, lookupBody(ids.slice(0, 500))))
      .mockResolvedValueOnce(jsonResponse(503, { ok: false, kind: 'not_available', friendly: 'Labels could not be checked right now. Try again in a minute.', retryable: true }));
    const r = await labelsLookup({ account: ACCOUNT, entity: 'item', ids }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: false, kind: 'not_available', httpStatus: 503, retryable: true });
  });
});

describe('drift and changes', () => {
  it('drift: reads the drift key into rows and passes entity, cursor and limit', async () => {
    const body = {
      ok: true,
      state: 'on',
      account: 12345,
      merchant_type: 'Seller',
      drift: [{ entity: 'item', id: 'B0EXAMPLE01', field: 'brand', legacy_values: ['Example A', ''], picked_value: 'Example A', store_value: null, first_seen_at: '2026-11-10T00:00:00.000Z', last_seen_at: '2026-11-12T00:00:00.000Z' }],
      next: null,
      next_cursor: null,
      has_more: false,
      limit: 50,
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, body));
    const r = await labelsDrift({ account: ACCOUNT, entity: 'item', cursor: 'DC', limit: 50 }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: true, has_more: false, rows: [{ id: 'B0EXAMPLE01', store_value: null }] });
    expect(Object.fromEntries(new URL(String(fetchImpl.mock.calls[0][0])).searchParams)).toEqual({ account: '12345', entity: 'item', cursor: 'DC', limit: '50' });
  });

  it('changes: since goes in the query, next_cursor is kept even on the last page, as_of and settle come through', async () => {
    const body = {
      ok: true,
      state: 'observing',
      account: 12345,
      merchant_type: 'Seller',
      changes: [{ id: 'c1', entity: 'item', entity_id: 'B0EXAMPLE01', field: 'tag_1', before: null, after: 'Example', result: 'applied', source: 'dash', actor: null, time: '2026-11-12T09:00:00.123456Z' }],
      position: { time: 'x', id: 'y' },
      next_cursor: 'POS1',
      has_more: false,
      limit: 50,
      as_of: '2026-11-12T10:00:00.000Z',
      settle_seconds: 120,
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, body));
    const r = await labelsChanges({ account: ACCOUNT, since: '2026-11-12T08:30:00Z' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: true, next_cursor: 'POS1', has_more: false, as_of: '2026-11-12T10:00:00.000Z', settle_seconds: 120, rows: [{ before: null }] });
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('since')).toBe('2026-11-12T08:30:00Z');
  });
});

describe('failures', () => {
  const get = (status: number, body: unknown) => labelsState(injected(vi.fn().mockResolvedValueOnce(jsonResponse(status, body))));

  it('not_enabled keeps its kind and the service sentence (403)', async () => {
    const r = await get(403, { ok: false, kind: 'not_enabled', friendly: 'Labels are not turned on for your account yet. Your MixShift contact can turn them on.' });
    expect(r).toMatchObject({ ok: false, kind: 'not_enabled', httpStatus: 403, friendly: 'Labels are not turned on for your account yet. Your MixShift contact can turn them on.' });
    expect(exitCodeForLabelsKind('not_enabled')).toBe(6);
  });

  it('not_found (an account this login cannot see) is 404 and exit 7', async () => {
    const r = await labelsFields({ account: '999', entity: 'item' }, injected(vi.fn().mockResolvedValueOnce(jsonResponse(404, { ok: false, kind: 'not_found', friendly: 'No such account for this login.' }))));
    expect(r).toMatchObject({ ok: false, kind: 'not_found', httpStatus: 404, friendly: 'No such account for this login.' });
    expect(exitCodeForLabelsKind('not_found')).toBe(7);
  });

  it('bad_params names the parameters the service refused', async () => {
    const r = await get(400, { ok: false, kind: 'bad_params', friendly: 'Invalid request', issues: [{ path: ['limit'], message: 'limit must be a whole number from 1 to 200' }] });
    expect(r).toMatchObject({ ok: false, kind: 'bad_params', invalidParams: ['limit'] });
    expect(exitCodeForLabelsKind('bad_params')).toBe(15);
  });

  it('insufficient_scope and account_limited are their own kinds', async () => {
    expect(await get(403, { ok: false, kind: 'insufficient_scope', friendly: 'Missing scope' })).toMatchObject({ kind: 'insufficient_scope' });
    expect(await get(403, { ok: false, kind: 'account_limited', friendly: 'This credential is limited to named accounts.' })).toMatchObject({ kind: 'account_limited' });
  });

  it('a route the service lacks (kind unknown, friendly "not_found") says the service has no labels yet, not a bare word', async () => {
    const r = await get(404, { ok: false, kind: 'unknown', friendly: 'not_found' });
    expect(r).toMatchObject({ ok: false, kind: 'unknown', httpStatus: 404, friendly: 'The MixShift service does not have labels yet. Update the plugin, or try again later.' });
  });

  it('an unrecognized kind is carried as unrecognizedKind, with the status mapping where it is unambiguous', async () => {
    expect(await get(400, { ok: false, kind: 'brand_new_kind', friendly: 'Something new happened here.' })).toMatchObject({ kind: 'bad_params', unrecognizedKind: 'brand_new_kind', friendly: 'Something new happened here.' });
    expect(await get(418, { ok: false, kind: 'brand_new_kind', friendly: 'Teapot' })).toMatchObject({ kind: 'unknown', unrecognizedKind: 'brand_new_kind' });
  });

  it('a non-JSON or envelope-less error body still fails typed, with the status', async () => {
    const r = await labelsState(injected(vi.fn().mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))));
    expect(r).toMatchObject({ ok: false, kind: 'unknown', httpStatus: 502 });
    expect(await get(500, { oops: true })).toMatchObject({ ok: false, kind: 'internal', httpStatus: 500 });
  });

  it('a 200 without the envelope fields is an unrecognized shape, not a crash', async () => {
    expect(await get(200, { ok: true })).toMatchObject({ ok: false, kind: 'unknown', httpStatus: 200 });
  });

  it('a network failure is host_unreachable and retryable', async () => {
    const r = await labelsState(injected(vi.fn().mockRejectedValueOnce(new Error('ECONNRESET'))));
    expect(r).toMatchObject({ ok: false, kind: 'host_unreachable', retryable: true, message: 'ECONNRESET' });
  });

  it('a mid-session 401 refreshes once and retries; a second 401 is session_expired', async () => {
    const tokens: boolean[] = [];
    const tokenProvider = async (force?: boolean) => {
      tokens.push(!!force);
      return force ? 'fresh' : 'stale';
    };
    const ok = vi.fn().mockResolvedValueOnce(jsonResponse(401, {})).mockResolvedValueOnce(jsonResponse(200, STATE));
    expect(await labelsState(injected(ok, tokenProvider))).toMatchObject({ ok: true });
    expect(tokens).toEqual([false, true]);
    expect((ok.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer fresh' });

    const dead = vi.fn(async () => jsonResponse(401, {}));
    expect(await labelsState(injected(dead, tokenProvider))).toMatchObject({ ok: false, kind: 'session_expired', httpStatus: 401 });
  });

  it('no stored session is not_authenticated; an expired one that cannot renew is session_expired', async () => {
    const fetchImpl = vi.fn();
    const none = await labelsState(injected(fetchImpl, async () => { throw new Error('No credentials found.'); }));
    expect(none).toMatchObject({ ok: false, kind: 'not_authenticated' });
    const expired = await labelsState(injected(fetchImpl, async () => { throw new Error('refresh token expired'); }));
    expect(expired).toMatchObject({ ok: false, kind: 'session_expired' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts the token in a failure', async () => {
    const r = await get(403, { ok: false, kind: 'not_enabled', friendly: 'Labels are not turned on for your account yet.' });
    expect(JSON.stringify(r)).not.toContain('tok');
  });
});
