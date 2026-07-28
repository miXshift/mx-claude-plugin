import { describe, expect, it, vi } from 'vitest';
import { loadCatalog } from '../prefetch/sql-library.js';
import { checkNamedPackCompat } from './named-pack-check.js';

async function namedIds(): Promise<string[]> {
  const catalog = await loadCatalog();
  return catalog.queries
    .filter((query) => query.dispatch === 'named')
    .map((query) => query.id)
    .sort();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('checkNamedPackCompat', () => {
  it('uses the public well-known manifest without an Authorization header', async () => {
    const ids = await namedIds();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        schema_version: 1,
        ids,
        revisions: Object.fromEntries(ids.map((id) => [id, 'abc12345'])),
      }),
    );

    const result = await checkNamedPackCompat({
      apiBase: 'https://mcp.test',
      fetchImpl,
    });

    expect(result.checked).toBe(true);
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://mcp.test/.well-known/mixshift-query-pack',
      expect.objectContaining({ headers: expect.not.objectContaining({ Authorization: expect.anything() }) }),
    );
  });

  it('falls back to the authenticated legacy endpoint while the public route deploys', async () => {
    const ids = await namedIds();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: 'Not found' }))
      .mockResolvedValueOnce(jsonResponse(200, { ids, revisions: {} }));

    const result = await checkNamedPackCompat({
      apiBase: 'https://mcp.test/',
      accessToken: 'test-token',
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://mcp.test/api/named-query/ids',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('fails closed when the public manifest schema is unsupported', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        schema_version: 2,
        ids: await namedIds(),
        revisions: {},
      }),
    );

    const result = await checkNamedPackCompat({
      apiBase: 'https://mcp.test',
      fetchImpl,
    });

    expect(result).toMatchObject({
      checked: false,
      ok: true,
      reason: expect.stringContaining('unsupported schema_version'),
    });
  });

  it('reports every catalog id missing from the deployed manifest', async () => {
    const ids = await namedIds();
    const missingId = ids[0]!;
    const deployedIds = ids.slice(1);
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        schema_version: 1,
        ids: deployedIds,
        revisions: Object.fromEntries(deployedIds.map((id) => [id, 'abc12345'])),
      }),
    );

    const result = await checkNamedPackCompat({
      apiBase: 'https://mcp.test',
      fetchImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      ok: false,
      missing: [missingId],
      total: ids.length,
    });
  });
});
