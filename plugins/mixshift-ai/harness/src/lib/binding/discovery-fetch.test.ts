/**
 * Fetch-layer tests for `fetchLabelDiscovery` — the link between a single
 * dropped gateway query and the promotion flow's abort.
 *
 * WHY THIS FILE EXISTS (mx-ops#6): a customer ran
 * `brand promote` twice, 42 seconds apart, and got different ad campaign
 * counts. Gateway metering proved only THREE of the four sbd-* queries ever
 * arrived in each run — one was dropped client-side (`host_unreachable`)
 * under the 4-way `Promise.all` burst in fetchLabelDiscovery. Run 1 lost
 * sbd-04 (invisible in the output); run 2 lost sbd-02 (visible as "no
 * campaigns yet").
 *
 * discovery.test.ts covers the pure assemble/classify helpers but had ZERO
 * coverage of fetchLabelDiscovery itself, so the error-propagation chain
 * that is supposed to make this fail loudly was never exercised. These
 * tests pin each link: a failed query must record an error, that error must
 * make the whole result not-ok, and classifyFetchOutcome must call it
 * 'partial' (NOT 'ok') so the command layer aborts instead of rendering a
 * confident plan built on a missing side.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../data/query-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/query-runner.js')>();
  return { ...actual, runNamedQuery: vi.fn() };
});

vi.mock('../discovery/seller-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/seller-query.js')>();
  return { ...actual, discoverSellers: vi.fn() };
});

import {
  fetchLabelDiscovery,
  classifyFetchOutcome,
  SBD_QUERY_COUNT,
  DISCOVERY_FETCH_CONCURRENCY,
} from './discovery.js';
import { runNamedQuery } from '../data/query-runner.js';
import { discoverSellers } from '../discovery/seller-query.js';

const mockedRunNamedQuery = runNamedQuery as unknown as ReturnType<typeof vi.fn>;
const mockedDiscoverSellers = discoverSellers as unknown as ReturnType<typeof vi.fn>;

const SELLER_ID = 'A1EXAMPLE23456';

const SELLER_ROW = {
  seller_id: 1,
  seller_name: 'Acme Agency',
  amazon_seller_id: SELLER_ID,
  merchant_alias: null,
  account_type: 'SC' as const,
  marketplace: 'United States',
  region: 'NA',
  agency_name: null,
  acos_target: null,
  ads_active: true,
  retail_active: true,
  is_active: true,
  has_mws: true,
};

/** A successful gateway response carrying rows. */
function ok(rows: unknown[]) {
  return { ok: true as const, rows, rowCount: rows.length, durationMs: 12 };
}

/** The exact failure shape runNamedQuery returns when undici's connect
 *  timeout fires — see query-runner.ts's DatahubNetworkError branch. This
 *  is what the customer actually hit, twice. */
function hostUnreachable() {
  return {
    ok: false as const,
    kind: 'host_unreachable' as const,
    message: 'fetch failed',
    friendly:
      'The MixShift auth service is unreachable. Check your network or try again in a minute.',
    durationMs: 10_544,
  };
}

const RETAIL_ROW = {
  SellerID: 1,
  source: 'mws_items.Brand',
  label: 'Forager Pantry',
  asin_count: 70,
  row_count: 70,
};
const ADS_ROW = { SellerID: 1, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: 5 };
const MATCH_ROW = {
  label: 'Forager Pantry',
  retail_asins: 70,
  ads_campaigns: 5,
  has_retail: 1,
  has_ads: 1,
};

const RETAIL_ECON_ROW = {
  SellerID: 1,
  source: 'mws_items.Brand',
  label: 'Forager Pantry',
  revenue_365d: '250000.00',
  revenue_90d: '70000.00',
  units_365d: '4100',
  last_order_at: '2026-08-18 00:00:00',
  sku_count: '70',
};
const ADS_ECON_ROW = {
  SellerID: 1,
  source: 'campaign.Brand',
  label: 'Forager Pantry',
  spend_365d: '40000.00',
  spend_90d: '11000.00',
  ad_sales_365d: '180000.00',
  last_spend_at: '2026-08-18 00:00:00',
  campaigns_with_spend: '5',
};

/** Drive the concurrent calls by query id, so a test can fail exactly one of
 *  them the way the wire did. Covers all seven: the four discovery entries
 *  plus the economics trio. */
function respondPerQuery(failing: string | null) {
  mockedRunNamedQuery.mockImplementation((id: string) => {
    if (id === failing) return Promise.resolve(hostUnreachable());
    if (id === 'sbd-01') return Promise.resolve(ok([RETAIL_ROW]));
    if (id === 'sbd-02') return Promise.resolve(ok([ADS_ROW]));
    if (id === 'sbd-03') return Promise.resolve(ok([]));
    if (id === 'sbd-04') return Promise.resolve(ok([MATCH_ROW]));
    if (id === 'sbd-05') return Promise.resolve(ok([RETAIL_ECON_ROW]));
    if (id === 'sbd-06') return Promise.resolve(ok([ADS_ECON_ROW]));
    if (id === 'sbd-07') return Promise.resolve(ok([]));
    throw new Error(`unexpected query id ${id}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedDiscoverSellers.mockResolvedValue([SELLER_ROW]);
});

describe('fetchLabelDiscovery — one dropped query must not pass as success', () => {
  it('records an error and reports not-ok when the ads query drops', async () => {
    respondPerQuery('sbd-02');
    const result = await fetchLabelDiscovery(SELLER_ID);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.query_id).toBe('sbd-02');
    // The retail side is fully intact — which is exactly why this was so
    // easy to miss: the plan looked complete apart from the ads column.
    expect(result.retailRows).toHaveLength(1);
    expect(result.adsRows).toHaveLength(0);
  });

  it('classifies a single dropped query as partial, never ok', async () => {
    respondPerQuery('sbd-02');
    const result = await fetchLabelDiscovery(SELLER_ID);
    expect(classifyFetchOutcome(result)).toBe('partial');
  });

  it('holds for the match query too — the drop that leaves no visible trace', async () => {
    respondPerQuery('sbd-04');
    const result = await fetchLabelDiscovery(SELLER_ID);

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.query_id).toBe('sbd-04');
    expect(classifyFetchOutcome(result)).toBe('partial');
    // Both visible sides look perfectly healthy here.
    expect(result.retailRows).toHaveLength(1);
    expect(result.adsRows).toHaveLength(1);
  });

  it('still reports ok when every query succeeds', async () => {
    respondPerQuery(null);
    const result = await fetchLabelDiscovery(SELLER_ID);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(classifyFetchOutcome(result)).toBe('ok');
    // Economics rides the same fetch and must arrive coerced, not raw.
    expect(result.retailEconRows[0]?.revenue_365d).toBe(250000);
  });

  it('classifies every query failing as error, not partial', async () => {
    mockedRunNamedQuery.mockResolvedValue(hostUnreachable());
    const result = await fetchLabelDiscovery(SELLER_ID);
    expect(classifyFetchOutcome(result)).toBe('error');
  });

  it('SBD_QUERY_COUNT matches the real fan-out (all-failed must not read as partial)', async () => {
    // If the constant drifts BELOW the number of queries actually issued, an
    // all-failed run classifies as 'partial' and the command renders an empty
    // plan instead of erroring. Pin them to each other rather than trusting
    // the two to be edited together.
    mockedRunNamedQuery.mockResolvedValue(hostUnreachable());
    const result = await fetchLabelDiscovery(SELLER_ID);
    expect(result.errors).toHaveLength(SBD_QUERY_COUNT);
    expect(mockedRunNamedQuery).toHaveBeenCalledTimes(SBD_QUERY_COUNT);
  });

  // mx-ops#6 red team round 2, the merge blocker. Raising SBD_QUERY_COUNT
  // 4 -> 7 (needed for the economics trio) meant the count alone no longer
  // detected "every query that feeds the report died": 4 failures out of a
  // threshold of 7 read as 'partial', both fail-loud guards key on 'error'
  // so neither fired, and classifyShape turned a zero-row report into a
  // confident proposal at exit 0. Strictly worse than before this branch.
  it('calls a total failure of the four REPORT-BEARING queries an error, not partial', async () => {
    mockedRunNamedQuery.mockImplementation((id: string) => {
      // The economics trio succeeds. It contributes nothing to the coverage
      // report, so it must not be able to mask the four that do.
      if (id === 'sbd-05') return Promise.resolve(ok([RETAIL_ECON_ROW]));
      if (id === 'sbd-06') return Promise.resolve(ok([ADS_ECON_ROW]));
      if (id === 'sbd-07') return Promise.resolve(ok([]));
      return Promise.resolve(hostUnreachable());
    });
    const result = await fetchLabelDiscovery(SELLER_ID);
    expect(result.errors.map((e) => e.query_id).sort()).toEqual([
      'sbd-01', 'sbd-02', 'sbd-03', 'sbd-04',
    ]);
    // 4 failures against a threshold of 7 — the count says 'partial'.
    expect(result.errors).toHaveLength(4);
    expect(result.errors.length >= SBD_QUERY_COUNT).toBe(false);
    // ...and the classifier must still say 'error'.
    expect(classifyFetchOutcome(result)).toBe('error');
  });

  it('still calls a single report-query failure partial, not error', async () => {
    // The guard above must not over-fire: losing one side is exactly the
    // 'incomplete, not fabricated' case the command surfaces rather than
    // aborting on.
    respondPerQuery('sbd-02');
    const result = await fetchLabelDiscovery(SELLER_ID);
    expect(classifyFetchOutcome(result)).toBe('partial');
  });

  it('bounds how many queries are in flight at once', async () => {
    // A wide burst opens a connection per request and is what pushed one
    // past the connect timeout in the first place. Adding the economics trio
    // took this call from four queries to seven, so the fan-out has to stay
    // bounded or the fix that motivated it gets undone.
    let inFlight = 0;
    let peak = 0;
    mockedRunNamedQuery.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok([]);
    });

    await fetchLabelDiscovery(SELLER_ID);

    expect(peak).toBeLessThanOrEqual(DISCOVERY_FETCH_CONCURRENCY);
    expect(peak, 'should still overlap, not serialize').toBeGreaterThan(1);
  });
});

describe('fetchLabelDiscovery — a genuinely empty ads side is not an error', () => {
  /**
   * The counterpart to the tests above, and the reason this distinction has
   * to be drawn at the FETCH layer rather than by inspecting row counts
   * downstream: an account with no labelled campaigns legitimately returns
   * zero ads rows. That is a real answer and must stay `ok`, so "no
   * campaigns yet" remains sayable when it is actually true. Only a
   * transport failure may block the plan.
   */
  it('treats an empty-but-successful ads response as ok', async () => {
    mockedRunNamedQuery.mockImplementation((id: string) => {
      if (id === 'sbd-02') return Promise.resolve(ok([]));
      if (id === 'sbd-01') return Promise.resolve(ok([RETAIL_ROW]));
      if (id === 'sbd-03') return Promise.resolve(ok([]));
      return Promise.resolve(ok([MATCH_ROW]));
    });

    const result = await fetchLabelDiscovery(SELLER_ID);
    expect(result.ok).toBe(true);
    expect(result.adsRows).toHaveLength(0);
    expect(classifyFetchOutcome(result)).toBe('ok');
  });
});
