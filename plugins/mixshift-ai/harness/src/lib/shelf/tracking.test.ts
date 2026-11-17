import { describe, it, expect, vi } from 'vitest';
import { exitCodeForShelfKind, type ShelfClientOptions } from './client.js';
import { parseSet, shelfTrackingDelete, shelfTrackingGet, shelfTrackingList, shelfTrackingPatch, shelfTrackingPut } from './tracking.js';

// Inject api_base + token + fetch so the suite never touches disk.
function injected(fetchImpl: ShelfClientOptions['fetchImpl']): ShelfClientOptions {
  return { apiBaseOverride: 'https://svc.test', tokenProvider: async () => 'tok', fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const call = (f: ReturnType<typeof vi.fn>, i = 0) => {
  const [url, init] = f.mock.calls[i] as [string, RequestInit];
  return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
};

// Made-up values: this repo is public.
const SET = {
  id: 'trail-snacks',
  retailer: 'amazon',
  country: 'us',
  keywords: ['trail mix', 'nut mix'],
  zips: ['10001', '60601'],
  surfaces: ['desktop', 'mobile'],
  asins: ['B000000001'],
  pages: 1,
  cadence: 'daily',
  enabled: true,
  note: 'Example snack terms',
  calls_per_day: 8,
  last_run_date: '2026-11-16',
  last_run_at: '2026-11-16T10:04:00.000Z',
  last_run_summary: { calls: 8, ok: 8, failed: 0, stale: 0, exhausted: 0, stopped_reason: null },
  updated_at: '2026-11-15T18:00:00.000Z',
  updated_by: 'person@example.com',
};

describe('shelf tracking client: request shapes', () => {
  it('list: GET /api/shelf/tracking, parsed with the projection, allowance, can_edit and limits', async () => {
    const f = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: true, sets: [SET, { bogus: true }], projected_calls_per_month: 248, allowance: 2000, can_edit: true, limits: { max_keywords: 50, max_zips: 10, max_pages: 5, max_asins: 100, max_calls_per_day_per_set: 200 } }),
    );
    const r = await shelfTrackingList(injected(f));
    expect(call(f)).toMatchObject({ url: 'https://svc.test/api/shelf/tracking', method: 'GET', body: undefined });
    expect(call(f).headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(r).toMatchObject({ ok: true, projected_calls_per_month: 248, allowance: 2000, can_edit: true, limits: { max_asins: 100, max_calls_per_day_per_set: 200 } });
    if (!r.ok) throw new Error('expected ok');
    expect(r.sets).toHaveLength(1); // the shapeless row is dropped, not a crash
    expect(r.sets[0]).toEqual(SET);
  });

  it('show: GET /api/shelf/tracking/:id with the id encoded', async () => {
    const f = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, set: SET }));
    const r = await shelfTrackingGet('trail-snacks', injected(f));
    expect(call(f)).toMatchObject({ url: 'https://svc.test/api/shelf/tracking/trail-snacks', method: 'GET' });
    expect(r).toEqual({ ok: true, set: SET });
  });

  it('create/replace: PUT with only the fields given (no empty lists, no undefined)', async () => {
    const f = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, set: SET, projected_calls_per_month: 248, allowance: 2000 }));
    const r = await shelfTrackingPut('trail-snacks', { keywords: ['trail mix'], zips: ['10001'], surfaces: [], asins: undefined, pages: 2 }, injected(f));
    expect(call(f)).toMatchObject({ url: 'https://svc.test/api/shelf/tracking/trail-snacks', method: 'PUT', body: { keywords: ['trail mix'], zips: ['10001'], pages: 2 } });
    expect(call(f).headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(r).toMatchObject({ ok: true, projected_calls_per_month: 248, allowance: 2000, set: { id: 'trail-snacks', calls_per_day: 8 } });
  });

  it('edit: PATCH with the add/remove lists and enabled', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, set: SET, projected_calls_per_month: 248, allowance: 2000 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, set: { ...SET, enabled: false }, projected_calls_per_month: 0, allowance: 2000 }));
    await shelfTrackingPatch('trail-snacks', { add_keywords: ['granola'], add_asins: [], remove_keywords: undefined }, injected(f));
    expect(call(f)).toMatchObject({ method: 'PATCH', body: { add_keywords: ['granola'] } });
    const paused = await shelfTrackingPatch('trail-snacks', { enabled: false }, injected(f));
    expect(call(f, 1).body).toEqual({ enabled: false });
    expect(paused).toMatchObject({ ok: true, set: { enabled: false }, projected_calls_per_month: 0 });
  });

  it('delete: DELETE, ok only', async () => {
    const f = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    expect(await shelfTrackingDelete('trail-snacks', injected(f))).toEqual({ ok: true });
    expect(call(f)).toMatchObject({ url: 'https://svc.test/api/shelf/tracking/trail-snacks', method: 'DELETE', body: undefined });
  });

  it('a write answer without its set is an unknown failure, not a crash', async () => {
    const f = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    expect(await shelfTrackingPatch('trail-snacks', { enabled: true }, injected(f))).toMatchObject({ ok: false, kind: 'unknown', httpStatus: 200 });
  });

  it('parseSet fills calls_per_day from the counts when absent and keeps only known views', () => {
    const s = parseSet({ ...SET, calls_per_day: undefined, surfaces: ['desktop', 'tablet'], pages: 2 });
    expect(s).toMatchObject({ surfaces: ['desktop'], calls_per_day: 2 * 2 * 1 * 2 });
    expect(parseSet({ keywords: [] })).toBeNull();
  });
});

describe('shelf tracking client: refusals', () => {
  it('the role refusal (forbidden, 403) keeps the service line; exit 11', async () => {
    const f = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, { ok: false, kind: 'forbidden', friendly: 'Only an owner, admin or manager of your organization can change rank tracking.', source: 'account', retryable: false }),
    );
    const r = await shelfTrackingPatch('trail-snacks', { add_keywords: ['granola'] }, injected(f));
    expect(r).toMatchObject({ ok: false, kind: 'forbidden', httpStatus: 403, friendly: 'Only an owner, admin or manager of your organization can change rank tracking.', source: 'account', retryable: false });
    expect(exitCodeForShelfKind('forbidden')).toBe(11);
  });

  it('the allowance refusal (402) carries the projection, the allowance and how to ask for more; exit 10', async () => {
    const f = vi.fn().mockResolvedValueOnce(
      // GW-144's envelope: 2 keywords x 2 zips a day x 31 = 124, over an allowance of 100.
      jsonResponse(402, { ok: false, kind: 'tracking_over_allowance', friendly: 'This change would bring your rank tracking to 124 shelf requests a month (calls a day x 31), over your organization\'s monthly allowance of 100.', projected_calls_per_month: 124, allowance: 100, request_more: 'To track more, say "request more shelf requests".', source: 'account', retryable: false }),
    );
    const r = await shelfTrackingPut('trail-snacks', { keywords: ['trail mix'], zips: ['10001'] }, injected(f));
    expect(r).toMatchObject({ ok: false, kind: 'tracking_over_allowance', projectedCallsPerMonth: 124, allowance: 100, requestMore: 'To track more, say "request more shelf requests".', httpStatus: 402 });
    expect(exitCodeForShelfKind('tracking_over_allowance')).toBe(10);
  });

  it('forbidden carries its reason: role, or identity_not_verified (a shared team login)', async () => {
    const f = vi
      .fn()
      // The service's exact lines (its TRACKING_FORBIDDEN and TRACKING_IDENTITY_NOT_VERIFIED).
      .mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'forbidden', reason: 'role', friendly: 'Only an owner, admin or manager of your organization can change rank tracking. Ask one of them, or ask MixShift.', source: 'account', retryable: false }))
      .mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'forbidden', reason: 'identity_not_verified', friendly: 'To change rank tracking, sign in to MixShift as yourself with your own Google or Microsoft work account, or ask MixShift. The shared team login cannot change tracking.', source: 'account', retryable: false }));
    expect(await shelfTrackingPatch('trail-snacks', { enabled: false }, injected(f))).toMatchObject({ kind: 'forbidden', reason: 'role', friendly: 'Only an owner, admin or manager of your organization can change rank tracking. Ask one of them, or ask MixShift.' });
    expect(await shelfTrackingDelete('trail-snacks', injected(f))).toMatchObject({ kind: 'forbidden', reason: 'identity_not_verified', friendly: 'To change rank tracking, sign in to MixShift as yourself with your own Google or Microsoft work account, or ask MixShift. The shared team login cannot change tracking.' });
  });

  it('an unrecognized 403 is the role refusal on a write only; on a read it stays what it was', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'role_required', friendly: 'Ask an admin.' }))
      .mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'role_required', friendly: 'Ask an admin.' }))
      .mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'role_required', friendly: 'Ask an admin.' }));
    expect(await shelfTrackingList(injected(f))).toMatchObject({ kind: 'unknown', unrecognizedKind: 'role_required' });
    expect(await shelfTrackingGet('trail-snacks', injected(f))).toMatchObject({ kind: 'unknown', unrecognizedKind: 'role_required' });
    expect(await shelfTrackingPut('trail-snacks', { keywords: ['trail mix'], zips: ['10001'] }, injected(f))).toMatchObject({ kind: 'forbidden', unrecognizedKind: 'role_required' });
  });

  it('read by shape when the service names them otherwise: a 403 on a write is the role refusal, a projection is the allowance refusal', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'role_required', friendly: 'Ask an admin.' }))
      .mockResolvedValueOnce(jsonResponse(402, { ok: false, kind: 'shelf_allowance_exhausted', friendly: 'Too much.', projected_calls_per_month: 2500, allowance: 2000 }))
      .mockResolvedValueOnce(jsonResponse(409, { ok: false, kind: 'over_budget', projected_calls_per_month: 2500, allowance: 2000 }));
    expect(await shelfTrackingPatch('trail-snacks', { enabled: true }, injected(f))).toMatchObject({ kind: 'forbidden', unrecognizedKind: 'role_required', friendly: 'Ask an admin.' });
    expect(await shelfTrackingPatch('trail-snacks', { enabled: true }, injected(f))).toMatchObject({ kind: 'tracking_over_allowance', friendly: 'Too much.' });
    const defaulted = await shelfTrackingPatch('trail-snacks', { enabled: true }, injected(f));
    expect(defaulted).toMatchObject({ kind: 'tracking_over_allowance', unrecognizedKind: 'over_budget', projectedCallsPerMonth: 2500 });
    expect((defaulted as { friendly: string }).friendly).toContain('past its monthly shelf allowance');
  });

  it('the routes missing on the service (the exact "No such shelf endpoint." line) are tracking_unavailable, exit 6, on every call; other 404s keep their kind', async () => {
    const NO_ENDPOINT = { ok: false, kind: 'not_found', friendly: 'No such shelf endpoint.', source: 'request', retryable: false };
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, NO_ENDPOINT))
      .mockResolvedValueOnce(jsonResponse(404, NO_ENDPOINT))
      .mockResolvedValueOnce(jsonResponse(404, NO_ENDPOINT))
      .mockResolvedValueOnce(jsonResponse(404, NO_ENDPOINT))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(404, { ok: false, kind: 'not_found' }));
    const unavailable = { ok: false, kind: 'tracking_unavailable', httpStatus: 404, friendly: 'Rank tracking is not available on the MixShift service yet, so nothing was read or changed.' };
    expect(await shelfTrackingList(injected(f))).toMatchObject(unavailable);
    expect(await shelfTrackingGet('trail-snacks', injected(f))).toMatchObject(unavailable);
    expect(await shelfTrackingPatch('trail-snacks', { enabled: true }, injected(f))).toMatchObject(unavailable);
    expect(await shelfTrackingDelete('trail-snacks', injected(f))).toMatchObject(unavailable);
    // No envelope at all, or a bare not_found on a PUT: not the service's line, so not read as the routes missing.
    expect(await shelfTrackingList(injected(f))).toMatchObject({ kind: 'unknown', httpStatus: 404 });
    // A PUT creates, so a bare not_found there is never "no such set" either: it keeps its kind and the default line.
    expect(await shelfTrackingPut('trail-snacks', { keywords: ['trail mix'], zips: ['10001'] }, injected(f))).toMatchObject({ kind: 'not_found', httpStatus: 404 });
    expect(exitCodeForShelfKind('tracking_unavailable')).toBe(6);
  });

  it('no such set: the service line is kept; a bare 404 names the set, not a missing endpoint', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { ok: false, kind: 'not_found', friendly: 'Your organization has no rank tracking set with that id.' }))
      .mockResolvedValueOnce(jsonResponse(404, { ok: false, kind: 'not_found' }));
    expect(await shelfTrackingGet('trail-snacks', injected(f))).toMatchObject({ kind: 'not_found', friendly: 'Your organization has no rank tracking set with that id.' });
    const bare = await shelfTrackingDelete('trail-snacks', injected(f));
    expect(bare).toMatchObject({ kind: 'not_found', httpStatus: 404 });
    expect((bare as { friendly: string }).friendly).toContain('There is no tracking set "trail-snacks"');
  });

  it('the per-set cap is invalid_request carrying calls_per_day and max_calls_per_day_per_set; exit 15', async () => {
    // GW-142's envelope: 50 keywords x 2 zips x 2 views x 2 pages = 400; friendly and message are the same line.
    const reason = 'keywords x zips x surfaces x pages is 400 calls a day; the limit is 200. Split it into more sets or trim it.';
    const f = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, { ok: false, kind: 'invalid_request', friendly: reason, message: reason, source: 'request', retryable: false, calls_per_day: 400, max_calls_per_day_per_set: 200 }),
    );
    const r = await shelfTrackingPatch('trail-snacks', { add_keywords: ['granola'] }, injected(f));
    expect(r).toMatchObject({ ok: false, kind: 'invalid_request', friendly: reason, callsPerDay: 400, maxCallsPerDayPerSet: 200, httpStatus: 400 });
    expect(exitCodeForShelfKind('invalid_request')).toBe(15);
  });

  it('zip_unavailable on a write carries the zips that are off the list', async () => {
    const f = vi.fn().mockResolvedValueOnce(jsonResponse(400, { ok: false, kind: 'zip_unavailable', friendly: 'A zip in the set is not available.', country: 'us', available_count: 300, unavailable: ['99999'] }));
    expect(await shelfTrackingPut('trail-snacks', { keywords: ['trail mix'], zips: ['99999'] }, injected(f))).toMatchObject({ kind: 'zip_unavailable', availableCount: 300, unavailableZips: ['99999'] });
  });
});
