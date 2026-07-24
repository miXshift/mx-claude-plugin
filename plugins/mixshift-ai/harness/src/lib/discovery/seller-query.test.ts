/**
 * Regression test for BUG-003.
 *
 * `discoverSellers()` used to call the mysql-only `query()` from
 * ../sql/connection.js, so brand discovery threw "No MySQL credentials
 * configured" on a token (datahub) session — even though `data query`
 * worked there. The fix routes discovery through `runQuery`
 * (../data/query-runner.js), which resolves datahub > service > mysql.
 *
 * This file proves the datahub path works end to end: with only a datahub
 * creds block on disk and POST /api/query mocked, discoverSellers returns
 * normalized rows (no MySQL-creds throw), and a server failure envelope
 * surfaces its friendly message.
 *
 * Mirrors the datahub-mock idiom in ../data/query-runner.test.ts
 * (mkdtemp temp dir; saveDatahub; freshDatahubFixture; jsonResponse;
 * vi.stubGlobal('fetch', ...); _refreshState.inFlight reset; temp-dir
 * cleanup + vi.unstubAllGlobals()).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverSellers } from './seller-query.js';
import { saveDatahub, _refreshState } from '../auth/credentials.js';
import type { DatahubCreds } from '../auth/schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-seller-query-test-'));
  _refreshState.inFlight = null;
});

afterEach(async () => {
  // Windows occasionally holds file handles longer than the test
  // teardown; one retry is sufficient for the flaky-rmdir ENOTEMPTY
  // pattern we see when datahub creds were written + read in the same
  // test. Swallow the second-try error if it lingers.
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Datahub path works (the BUG-003 fix): no "No MySQL credentials" throw
// ---------------------------------------------------------------------------

describe('discoverSellers :: datahub (token) session', () => {
  it('returns normalized rows from the /api/query gateway', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        rows: [rawSellerRow()],
        rowCount: 1,
        durationMs: 5,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const rows = await discoverSellers({
      dataDirOverride: testDir,
      includeInactive: true,
    });

    // One normalized SellerRow — proves the token/datahub path was taken
    // (a mysql-only path would have thrown "No MySQL credentials").
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.seller_id).toBe(71);
    expect(row.seller_name).toBe('Test Brand');
    expect(row.account_type).toBe('SC');
    // Derived flags: row has is_active=1, no lost-access / hide flags, has_mws=1
    expect(row.ads_active).toBe(true);
    expect(row.retail_active).toBe(true);

    // Routed through POST /api/query (datahub gateway), not a mysql connect.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://mcp.mixshift.io/api/query');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${creds.access_token}`,
    });
  });

  it('throws the friendly message on a server failure envelope', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: false,
        kind: 'access_denied_table',
        table_name: 'seller',
        message: 'denied',
        friendly: 'no SELECT on seller',
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      discoverSellers({ dataDirOverride: testDir, includeInactive: true }),
    ).rejects.toThrow('no SELECT on seller');
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshDatahubFixture(): DatahubCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: 'eyJfresh.token',
    refresh_token: 'r'.repeat(48),
    expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    user_id: '3',
    email: 'amazon+clients@example.com',
    person_label: 'someone@example.com',
    device_label: 'laptop-sam',
    client_id: 'mx-claude-plugin',
  };
}

/** One row matching the RawSellerRow shape DISCOVERY_SQL aliases to. */
function rawSellerRow() {
  return {
    seller_id: 71,
    seller_name: 'Test Brand',
    amazon_seller_id: 'A123',
    merchant_alias: 'Test',
    merchant_type: 'Seller',
    marketplace: 'US',
    region: 'NA',
    agency_name: null,
    acos_target: 0.3,
    is_active: 1,
    is_deleted: 0,
    ad_lost_access: 0,
    hide_from_ads: 0,
    hide_from_mws: 0,
    has_mws: 1,
    ba_lost_access: 0,
    finance_lost_access: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-02',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
