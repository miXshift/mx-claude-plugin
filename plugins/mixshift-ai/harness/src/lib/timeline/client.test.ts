import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createTimelineClient,
  listAllEvents,
  LIST_ALL_CAP,
  type TimelineClient,
} from './client.js';
import type { TimelineListQuery, WireTimelineEvent } from './types.js';

let testDir: string;

const API_BASE = 'https://mcp.example.test';

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-timeline-client-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(testDir, { recursive: true });
  await writeCredentials();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeCredentials(): Promise<void> {
  const authDir = join(testDir, 'auth');
  await mkdir(authDir, { recursive: true });
  await writeFile(
    join(authDir, 'credentials'),
    JSON.stringify({
      schema_version: 2,
      created_at: '2026-07-01T00:00:00.000Z',
      datahub: {
        api_base: API_BASE,
        access_token: 'test-token',
        refresh_token: 'refresh-token',
        expires_at: '2099-01-01T00:00:00.000Z',
        refresh_expires_at: '2099-01-01T00:00:00.000Z',
        user_id: 'u1',
        email: 'ops@example.com',
        person_label: 'sam@example.com',
        device_label: 'test-device',
        client_id: 'mx-claude-plugin',
      },
    }),
    'utf8',
  );
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sampleEvent(overrides: Partial<WireTimelineEvent> = {}): WireTimelineEvent {
  return {
    id: 'evt_1',
    brand_slug: 'acme',
    family: 'structural',
    kind: 'structural.price_change',
    ts: '2026-07-04T12:00:00.000Z',
    actor: 'sam@example.com',
    client_id: 'mx-claude-plugin',
    payload: { note: 'MAP change' },
    sensitivity: 'internal',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

describe('listEvents', () => {
  it('builds the query string from the filter set and parses events + cursor', async () => {
    const events = [sampleEvent()];
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(200, { ok: true, events, next_cursor: 'c2' }),
    );
    const client = createTimelineClient({ dataDirOverride: testDir, fetchImpl });

    const result = await client.listEvents({
      brand: 'acme',
      family: 'structural',
      kind: 'structural.price_change',
      since: '2026-07-01T00:00:00.000Z',
      limit: 50,
      cursor: 'c1',
    });
    expect(result).toEqual({ ok: true, events, next_cursor: 'c2' });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/timeline');
    expect(url.searchParams.get('brand')).toBe('acme');
    expect(url.searchParams.get('family')).toBe('structural');
    expect(url.searchParams.get('kind')).toBe('structural.price_change');
    expect(url.searchParams.get('since')).toBe('2026-07-01T00:00:00.000Z');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('cursor')).toBe('c1');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(
      (calls[0]!.init?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer test-token');
  });

  it('omits the query string entirely when no filters are given', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(200, { ok: true, events: [] }),
    );
    const client = createTimelineClient({ dataDirOverride: testDir, fetchImpl });
    const result = await client.listEvents();
    expect(result).toEqual({ ok: true, events: [] });
    expect(calls[0]!.url).toBe(`${API_BASE}/api/timeline`);
  });

  it('classifies thrown fetch errors as host_unreachable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = createTimelineClient({ dataDirOverride: testDir, fetchImpl });
    const result = await client.listEvents({ brand: 'acme' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('host_unreachable');
      expect(result.friendly).toMatch(/unreachable/i);
    }
  });

  it('classifies an unrecognized envelope as unknown with the HTTP status', async () => {
    const { fetchImpl } = makeFetch(() => new Response('bad gateway', { status: 502 }));
    const client = createTimelineClient({ dataDirOverride: testDir, fetchImpl });
    const result = await client.listEvents();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown');
      expect(result.friendly).toContain('502');
    }
  });
});

// ---------------------------------------------------------------------------
// postEvent
// ---------------------------------------------------------------------------

describe('postEvent', () => {
  it('POSTs the input as JSON and parses the id', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(200, { ok: true, id: 'evt_42' }),
    );
    const client = createTimelineClient({ dataDirOverride: testDir, fetchImpl });

    const input = {
      brand_slug: 'acme',
      family: 'comment' as const,
      kind: 'comment',
      payload: { note: 'watch this ASIN' },
      target_ref: 'fact:123',
    };
    const result = await client.postEvent(input);
    expect(result).toEqual({ ok: true, id: 'evt_42' });

    expect(calls[0]!.url).toBe(`${API_BASE}/api/timeline/event`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(
      (calls[0]!.init?.headers as Record<string, string>)['Content-Type'],
    ).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(input);
  });

  it('maps the reserved_kind / bad_params / too_large / insufficient_scope envelopes', async () => {
    const cases: Array<[number, string]> = [
      [400, 'reserved_kind'],
      [400, 'bad_params'],
      [400, 'too_large'],
      [403, 'insufficient_scope'],
    ];
    for (const [status, kind] of cases) {
      const { fetchImpl } = makeFetch(() =>
        jsonResponse(status, { ok: false, kind, friendly: `err: ${kind}` }),
      );
      const client = createTimelineClient({ dataDirOverride: testDir, fetchImpl });
      const result = await client.postEvent({
        brand_slug: 'acme',
        family: 'structural',
        kind: 'structural.stockout',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe(kind);
        expect(result.friendly).toBe(`err: ${kind}`);
      }
    }
  });

  it('fails with a sign-in pointer when no credentials exist', async () => {
    const emptyDir = join(testDir, 'empty-data-dir');
    await mkdir(emptyDir, { recursive: true });
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, { ok: true, id: 'x' }));
    const client = createTimelineClient({ dataDirOverride: emptyDir, fetchImpl });
    const result = await client.postEvent({
      brand_slug: 'acme',
      family: 'comment',
      kind: 'comment',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.friendly).toMatch(/mixshift auth login/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listAllEvents (cursor following)
// ---------------------------------------------------------------------------

function pagedClient(pages: WireTimelineEvent[][]): {
  client: TimelineClient;
  cursorsSeen: Array<string | undefined>;
} {
  const cursorsSeen: Array<string | undefined> = [];
  const client: TimelineClient = {
    listEvents: async (query: TimelineListQuery = {}) => {
      cursorsSeen.push(query.cursor);
      const pageIdx = query.cursor === undefined ? 0 : Number(query.cursor);
      const events = pages[pageIdx] ?? [];
      const next = pageIdx + 1 < pages.length ? String(pageIdx + 1) : undefined;
      return {
        ok: true,
        events,
        ...(next !== undefined ? { next_cursor: next } : {}),
      };
    },
    postEvent: async () => ({ ok: true, id: 'x' }),
    corroborateEvent: async () => ({
      ok: false,
      kind: 'unknown',
      message: 'unused',
      friendly: 'unused',
    }),
  };
  return { client, cursorsSeen };
}

describe('listAllEvents', () => {
  it('follows next_cursor to exhaustion and concatenates in order', async () => {
    const pages = [
      [sampleEvent({ id: 'a' }), sampleEvent({ id: 'b' })],
      [sampleEvent({ id: 'c' })],
      [sampleEvent({ id: 'd' })],
    ];
    const { client, cursorsSeen } = pagedClient(pages);
    const result = await listAllEvents(client, { brand: 'acme' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
      expect('next_cursor' in result).toBe(false);
    }
    expect(cursorsSeen).toEqual([undefined, '1', '2']);
  });

  it('stops at the cap and truncates', async () => {
    const bigPage = Array.from({ length: 4 }, (_, i) => sampleEvent({ id: `p0-${i}` }));
    const pages = [bigPage, bigPage, bigPage];
    const { client } = pagedClient(pages);
    const result = await listAllEvents(client, {}, 6);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events).toHaveLength(6);
  });

  it('exports a sane default cap', () => {
    expect(LIST_ALL_CAP).toBe(2000);
  });

  it('propagates a mid-pagination failure instead of returning a truncated list', async () => {
    let call = 0;
    const client: TimelineClient = {
      listEvents: async () => {
        call += 1;
        if (call === 1) {
          return { ok: true, events: [sampleEvent()], next_cursor: 'c2' };
        }
        return {
          ok: false,
          kind: 'host_unreachable',
          message: 'down',
          friendly: 'unreachable',
        };
      },
      postEvent: async () => ({ ok: true, id: 'x' }),
      corroborateEvent: async () => ({
        ok: false,
        kind: 'unknown',
        message: 'unused',
        friendly: 'unused',
      }),
    };
    const result = await listAllEvents(client, {});
    expect(result.ok).toBe(false);
  });

  it('breaks defensively on an empty page that still advertises a cursor', async () => {
    const client: TimelineClient = {
      listEvents: async () => ({ ok: true, events: [], next_cursor: 'again' }),
      postEvent: async () => ({ ok: true, id: 'x' }),
      corroborateEvent: async () => ({
        ok: false,
        kind: 'unknown',
        message: 'unused',
        friendly: 'unused',
      }),
    };
    const result = await listAllEvents(client, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events).toEqual([]);
  });
});
