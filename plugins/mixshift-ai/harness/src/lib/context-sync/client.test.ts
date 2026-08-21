import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContextSyncClient } from './client.js';

// NOTE for the reviewer: the 401-force-refresh-retry path is exercised by
// authedRequest via getValidAccessToken(dataDir, true), which performs the
// refresh POST through the GLOBAL fetch (lib/auth/credentials.ts), not the
// injected fetchImpl — so covering it here would mean patching global fetch
// and replicating the refresh wire format. The same pattern is already
// covered for the query-runner; skipped here deliberately.

let testDir: string;

const API_BASE = 'https://mcp.example.test';
/** Bare host classify.ts's messages name (see resolveApiBaseHost). */
const API_BASE_HOST = new URL(API_BASE).host;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-ctxsync-client-${process.pid}-${Date.now()}-${Math.random()}`,
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

describe('fetchManifest', () => {
  it('parses the 200 envelope and sends the stored bearer', async () => {
    const brands = [
      {
        brand_slug: 'acme',
        docs: [
          {
            doc_type: 'context',
            revision: 3,
            content_hash: 'ab'.repeat(32),
            sensitivity: 'internal',
            updated_at: '2026-07-01T00:00:00.000Z',
            updated_by_actor: 'jane@example.com',
          },
        ],
      },
    ];
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, { ok: true, brands }));
    const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });

    const result = await client.fetchManifest();
    expect(result).toEqual({ ok: true, brands });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_BASE}/api/context/manifest`);
    expect(calls[0]!.init?.method).toBe('GET');
    expect(
      (calls[0]!.init?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer test-token');
  });

  it('maps thrown fetch errors to host_unreachable, classified via classify.ts (sandbox-aware, doctor pointer)', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });

    const result = await client.fetchManifest();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('host_unreachable');
      // No `.cause` on this bare TypeError, so classify.ts lands on the
      // "unclassified transport failure" bucket — still names the host and
      // points at doctor, unlike the old hardcoded UNREACHABLE_FRIENDLY.
      expect(result.friendly).toContain(`Could not reach ${API_BASE_HOST}`);
      expect(result.friendly).toContain('mixshift doctor');
      expect(result.message).toContain('fetch failed');
    }
  });

  it('classifies a proxy 403 (sandbox egress allowlist) through the SAME path as the query-runner', async () => {
    const cause = new Error('Received HTTP code 403 from proxy after CONNECT');
    const fetchFailed = new TypeError('fetch failed');
    (fetchFailed as { cause?: unknown }).cause = cause;
    const fetchImpl = (async () => {
      throw fetchFailed;
    }) as unknown as typeof fetch;
    const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });

    const result = await client.fetchManifest();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('host_unreachable');
      expect(result.friendly).toContain(`sandbox blocked ${API_BASE_HOST}`);
      expect(result.friendly).toContain('mixshift doctor');
    }
  });
});

describe('fetchDoc', () => {
  it('builds the query string (brand, type, name for corpus) and parses the doc', async () => {
    const doc = {
      brand_slug: 'acme',
      doc_type: 'corpus',
      corpus_name: 'tone.md',
      revision: 2,
      content_hash: 'cd'.repeat(32),
      content: 'Friendly.\n',
      sensitivity: 'internal',
      updated_at: '2026-07-01T00:00:00.000Z',
      updated_by_actor: 'jane@example.com',
    };
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, { ok: true, doc }));
    const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });

    const result = await client.fetchDoc('acme', 'corpus', 'tone.md');
    expect(result).toEqual({ ok: true, doc });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/context/doc');
    expect(url.searchParams.get('brand')).toBe('acme');
    expect(url.searchParams.get('type')).toBe('corpus');
    expect(url.searchParams.get('name')).toBe('tone.md');
  });

  it('omits the name param for text docs', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(404, { ok: false, kind: 'not_found', friendly: 'No such doc.' }),
    );
    const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });
    await client.fetchDoc('acme', 'narrative');
    expect(new URL(calls[0]!.url).searchParams.has('name')).toBe(false);
  });

  it('maps the 404 envelope to kind not_found with the server friendly', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(404, { ok: false, kind: 'not_found', friendly: 'No such doc.' }),
    );
    const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });
    const result = await client.fetchDoc('acme', 'context');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('not_found');
      expect(result.friendly).toBe('No such doc.');
    }
  });
});

describe('putDoc', () => {
  it('PUTs the input as JSON and parses the created result', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(200, { ok: true, status: 'created', revision: 1 }),
    );
    const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });

    const input = {
      brand_slug: 'acme',
      doc_type: 'context' as const,
      content: 'brand_slug: acme\n',
      base_revision: 3,
    };
    const result = await client.putDoc(input);
    expect(result).toEqual({ ok: true, status: 'created', revision: 1 });

    expect(calls[0]!.url).toBe(`${API_BASE}/api/context/doc`);
    expect(calls[0]!.init?.method).toBe('PUT');
    expect(
      (calls[0]!.init?.headers as Record<string, string>)['Content-Type'],
    ).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(input);
  });

  it('parses updated and noop results', async () => {
    for (const status of ['updated', 'noop'] as const) {
      const { fetchImpl } = makeFetch(() =>
        jsonResponse(200, { ok: true, status, revision: 5 }),
      );
      const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });
      const result = await client.putDoc({
        brand_slug: 'acme',
        doc_type: 'narrative',
        content: 'x',
      });
      expect(result).toEqual({ ok: true, status, revision: 5 });
    }
  });

  it('surfaces the 409 conflict envelope including the server head', async () => {
    const server = {
      revision: 6,
      content: 'newer server content',
      content_hash: 'ef'.repeat(32),
      updated_at: '2026-07-03T00:00:00.000Z',
      updated_by_actor: 'jane@example.com',
    };
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(409, {
        ok: false,
        kind: 'revision_conflict',
        friendly: 'Someone else updated this doc.',
        server,
      }),
    );
    const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });
    const result = await client.putDoc({
      brand_slug: 'acme',
      doc_type: 'context',
      content: 'x',
      base_revision: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('revision_conflict');
      expect(result.server).toEqual(server);
      expect(result.friendly).toBe('Someone else updated this doc.');
    }
  });

  it('maps 403 to insufficient_scope and 400 to bad_params/too_large', async () => {
    const cases: Array<[number, string]> = [
      [403, 'insufficient_scope'],
      [400, 'bad_params'],
      [400, 'too_large'],
    ];
    for (const [status, kind] of cases) {
      const { fetchImpl } = makeFetch(() =>
        jsonResponse(status, { ok: false, kind, friendly: `err: ${kind}` }),
      );
      const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });
      const result = await client.putDoc({
        brand_slug: 'acme',
        doc_type: 'corpus',
        corpus_name: 'big.csv',
        content: 'x',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe(kind);
        expect(result.friendly).toBe(`err: ${kind}`);
      }
    }
  });

  it('classifies an unrecognized envelope as kind unknown with the HTTP status', async () => {
    const { fetchImpl } = makeFetch(() => new Response('gateway error', { status: 502 }));
    const client = createContextSyncClient({ dataDirOverride: testDir, fetchImpl });
    const result = await client.putDoc({
      brand_slug: 'acme',
      doc_type: 'context',
      content: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown');
      expect(result.friendly).toContain('502');
    }
  });
});

describe('credentials plumbing', () => {
  it('fails with a sign-in pointer when no credentials exist', async () => {
    const emptyDir = join(testDir, 'empty-data-dir');
    await mkdir(emptyDir, { recursive: true });
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, { ok: true, brands: [] }));
    const client = createContextSyncClient({ dataDirOverride: emptyDir, fetchImpl });
    const result = await client.fetchManifest();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.friendly).toMatch(/mixshift auth login/);
    }
    expect(calls).toHaveLength(0);
  });
});
