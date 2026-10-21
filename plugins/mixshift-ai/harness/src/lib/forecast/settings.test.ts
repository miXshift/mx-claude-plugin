import { describe, it, expect, vi } from 'vitest';
import { SETTINGS_REASON, accountKey, applySettings, parseOnOff, planSettings, readAccountSettings, settingsOf } from './settings.js';

const SCOPE = 'src:fake_db:42';
const KEY = accountKey(SCOPE);

function gateway(handler: (method: string, url: URL, body: any) => { status: number; json: unknown }) {
  const calls: Array<{ method: string; url: URL; body: any }> = [];
  const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, body });
    const r = handler(String(init.method), url, body);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json } as unknown as Response;
  });
  const opts = { apiBaseOverride: 'https://gw.example', tokenProvider: vi.fn(async () => 't'), fetchImpl: fetchImpl as unknown as typeof fetch };
  return { calls, opts };
}

const record = (settings: Record<string, unknown>, version = 3) => ({
  key: KEY,
  kind: 'account',
  scope_id: SCOPE,
  version,
  updated_at: '2026-10-21T00:00:00.000Z',
  doc: { id: SCOPE, displayName: 'Northwind US', currency: { code: 'USD' }, settings },
});

describe('inputs', () => {
  it('on/off and their spellings; anything else names the flag', () => {
    expect(parseOnOff('on', '--include-dsp')).toBe(true);
    expect(parseOnOff('OFF', '--include-dsp')).toBe(false);
    expect(parseOnOff('true', '--x')).toBe(true);
    expect(parseOnOff('0', '--x')).toBe(false);
    expect(() => parseOnOff('maybe', '--include-dsp')).toThrow('--include-dsp takes on or off (got "maybe")');
  });

  it('reads only known boolean settings from under settings', () => {
    expect(settingsOf({ settings: { includeDspSpend: true, treatMissingAdSpendAsZero: false, other: true } })).toEqual({ includeDspSpend: true, treatMissingAdSpendAsZero: false });
    expect(settingsOf({ includeDspSpend: true })).toEqual({});
    expect(settingsOf({ settings: { includeDspSpend: 'on' } })).toEqual({});
    expect(settingsOf(null)).toEqual({});
  });

  it('plans only the names that change, at the stored version; nothing to write when all hold', () => {
    const account = { version: 3, settings: { includeDspSpend: false }, exists: true };
    const p = planSettings(SCOPE, account, { includeDspSpend: true, treatMissingAdSpendAsZero: false });
    expect(p.changed).toEqual(['includeDspSpend', 'treatMissingAdSpendAsZero']);
    expect(p.writes).toEqual([{ key: KEY, expected_version: 3, doc: { settings: { includeDspSpend: true, treatMissingAdSpendAsZero: false } } }]);
    const same = planSettings(SCOPE, account, { includeDspSpend: false });
    expect(same).toEqual({ changed: [], unchanged: ['includeDspSpend'], writes: [] });
  });
});

describe('against the gateway', () => {
  it('reads the exact account record by prefix (a sub-brand record under the same prefix is not it)', async () => {
    const { calls, opts } = gateway(() => ({ status: 200, json: { ok: true, docs: [{ ...record({ includeDspSpend: true }), key: `${KEY}:scope:outdoor` }, record({ includeDspSpend: false, treatMissingAdSpendAsZero: true }, 7)] } }));
    const r = await readAccountSettings(SCOPE, opts);
    expect(r).toEqual({ ok: true, account: { version: 7, settings: { includeDspSpend: false, treatMissingAdSpendAsZero: true }, exists: true } });
    expect(calls[0]!.url.pathname).toBe('/api/app-state/forecasting/docs');
    expect(calls[0]!.url.searchParams.get('prefix')).toBe(KEY);
  });

  it('no record yet reads as version 0 with no settings, and the first write creates it', async () => {
    let wrote: any = null;
    const { opts } = gateway((method, _url, body) => {
      if (method === 'GET') return { status: 200, json: { ok: true, docs: [] } };
      wrote = body;
      return { status: 200, json: { ok: true, results: [{ key: KEY, version: 1, changed: true }] } };
    });
    const r = await applySettings(SCOPE, { includeDspSpend: true }, opts);
    expect(r).toEqual({ ok: true, before: {}, after: { includeDspSpend: true }, changed: ['includeDspSpend'], unchanged: [], version: 1, written: true });
    expect(wrote).toEqual({ writes: [{ key: KEY, expected_version: 0, doc: { settings: { includeDspSpend: true } } }], reason: SETTINGS_REASON });
  });

  it('a dry run reads and plans but never writes; a no-op writes nothing either', async () => {
    const { calls, opts } = gateway(() => ({ status: 200, json: { ok: true, docs: [record({ includeDspSpend: true })] } }));
    const dry = await applySettings(SCOPE, { includeDspSpend: false }, { ...opts, dryRun: true });
    expect(dry).toMatchObject({ ok: true, changed: ['includeDspSpend'], written: false, version: 3, after: { includeDspSpend: false } });
    const same = await applySettings(SCOPE, { includeDspSpend: true }, opts);
    expect(same).toMatchObject({ ok: true, changed: [], unchanged: ['includeDspSpend'], written: false });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('on a conflict it reads again and re-plans once, then gives up with the conflict', async () => {
    let version = 3;
    let posts = 0;
    const { opts } = gateway((method, _url, body) => {
      if (method === 'GET') return { status: 200, json: { ok: true, docs: [record({ includeDspSpend: false }, version)] } };
      posts += 1;
      if (body.writes[0].expected_version !== version) return { status: 409, json: { ok: false, kind: 'conflict', message: 'version mismatch' } };
      version += 1;
      return { status: 200, json: { ok: true, results: [{ key: KEY, version, changed: true }] } };
    });
    // First attempt races a save in the app: the read said 3, the write finds 4.
    const original = opts.fetchImpl;
    let first = true;
    opts.fetchImpl = (async (input: string, init: RequestInit) => {
      if (String(init.method) === 'POST' && first) {
        first = false;
        version = 4;
      }
      return (original as any)(input, init);
    }) as unknown as typeof fetch;
    const r = await applySettings(SCOPE, { includeDspSpend: true }, opts);
    expect(r).toMatchObject({ ok: true, written: true, version: 5, changed: ['includeDspSpend'] });
    expect(posts).toBe(2);
  });

  it('a refused write is the gateway failure, in its own kind', async () => {
    const { opts } = gateway((method) => (method === 'GET' ? { status: 200, json: { ok: true, docs: [] } } : { status: 403, json: { ok: false, kind: 'insufficient_scope', message: 'corrections:write needed' } }));
    const r = await applySettings(SCOPE, { treatMissingAdSpendAsZero: true }, opts);
    expect(r).toMatchObject({ ok: false, kind: 'insufficient_scope' });
  });
});
