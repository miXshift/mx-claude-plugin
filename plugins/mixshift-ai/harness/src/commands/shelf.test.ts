/**
 * Command-level tests for `mixshift shelf ...`: the flag-to-call mapping, the
 * --json shapes the skill reads, exit codes, the catalog, and telemetry that
 * names the call kind and outcome but never the subject or the answer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { registerShelfCommands, renderBuybox, renderOffers, renderSearch } from './shelf.js';
import { shelfBuybox, shelfOffers, shelfSearch, shelfSeller, shelfUsage, shelfZips } from '../lib/shelf/client.js';
import { SHELF_CATALOG } from '../lib/shelf/catalog.js';
import { track } from '../lib/telemetry/index.js';

vi.mock('../lib/shelf/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/shelf/client.js')>();
  return {
    ...actual,
    shelfBuybox: vi.fn(),
    shelfOffers: vi.fn(),
    shelfSearch: vi.fn(),
    shelfProduct: vi.fn(),
    shelfSeller: vi.fn(),
    shelfZips: vi.fn(),
    shelfUsage: vi.fn(),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR')
    // The real root program owns --surface (telemetry host, cli.ts); declared here so a shelf
    // option can never collide with it again without this suite noticing.
    .option('--surface <surface>', 'telemetry host flag');
  registerShelfCommands(program);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', ...args]);
}

let stdout = '';
let stderr = '';
beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const m of [shelfBuybox, shelfOffers, shelfSearch, shelfSeller, shelfZips, shelfUsage]) vi.mocked(m).mockReset();
  vi.mocked(track).mockClear();
  process.exitCode = undefined;
});

const lastTrack = () =>
  vi.mocked(track).mock.calls.at(-1)![0] as { event_name: string; outcome?: string; error_class?: string; payload: Record<string, unknown> };

// Made-up subjects: this repo is public.
const ANSWER = {
  ok: true as const,
  kind: 'buybox' as const,
  retailer: 'amazon',
  country: 'us',
  zip: '75201',
  subject: 'B0EXAMPLE01',
  observed_at: new Date(Date.now() - 90_000).toISOString(),
  source: 'shelf' as const,
  data: { price: 7.99, currency: '$', in_stock: true, stock: 8, sold_by: 'Example Seller Co', ships_from: 'Amazon', prime: true, free_shipping: true, free_delivery: 'Tuesday, October 20', fastest_delivery: 'Tomorrow, October 16', order_within: '3 hrs', seller_id: 'A1EXAMPLESELLER', delivery_to: 'Dallas 75201', promise_days_free: 5, promise_days_fastest: 1 },
};

describe('shelf buybox', () => {
  it('maps flags to the client call, prints the --json envelope, and tracks kind + outcome without the subject', async () => {
    vi.mocked(shelfBuybox).mockResolvedValueOnce(ANSWER);
    await run('--json', 'shelf', 'buybox', 'b0example01', '--zip', '75201', '--fresh', '--origin', 'demo');
    expect(shelfBuybox).toHaveBeenCalledWith({ asin: 'b0example01', zip: '75201', country: 'us', fresh: true, origin: 'demo' }, { dataDirOverride: undefined });
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ status: 'ok', kind: 'buybox', subject: 'B0EXAMPLE01', observed_at: ANSWER.observed_at, data: { price: 7.99 } });
    expect(process.exitCode).toBeUndefined();

    const t = lastTrack();
    expect(t.event_name).toBe('shelf.called');
    expect(t.outcome).toBe('ok');
    expect(t.payload).toMatchObject({ kind: 'buybox', country: 'us', has_zip: true, fresh: true, origin: 'demo' });
    expect(typeof t.payload.observed_age_s).toBe('number');
    expect(JSON.stringify(t)).not.toMatch(/B0EXAMPLE01|75201|Example Seller|7\.99/);
  });

  it('renders a readable table without --json', async () => {
    vi.mocked(shelfBuybox).mockResolvedValueOnce(ANSWER);
    await run('shelf', 'buybox', 'B0EXAMPLE01', '--zip', '75201');
    expect(stderr).toContain('buybox B0EXAMPLE01 at 75201 (us), observed');
    expect(stdout).toContain('| sold by | Example Seller Co (A1EXAMPLESELLER) |');
    expect(stdout).toContain('| fastest delivery | Tomorrow, October 16 (1 d) |');
  });

  it('a typed failure prints the friendly line, sets the exit code, and tracks the kind', async () => {
    vi.mocked(shelfBuybox).mockResolvedValueOnce({ ok: false, kind: 'shelf_allowance_exhausted', friendly: 'used up', httpStatus: 402, period: '2026-10', allowance: 2000, used: 2000, resetsAt: '2026-11-01T00:00:00.000Z', requestMore: 'Ask MixShift.', source: 'account', retryable: false });
    await run('--json', 'shelf', 'buybox', 'B0EXAMPLE01');
    expect(JSON.parse(stdout)).toMatchObject({ status: 'error', failure_kind: 'shelf_allowance_exhausted', message: 'used up', http_status: 402, period: '2026-10', resets_at: '2026-11-01T00:00:00.000Z', request_more: 'Ask MixShift.' });
    expect(process.exitCode).toBe(10);
    const t = lastTrack();
    expect(t.outcome).toBe('failed');
    expect(t.error_class).toBe('shelf_allowance_exhausted');
    expect(t.payload).toMatchObject({ kind: 'buybox', kind_failed: 'shelf_allowance_exhausted', http_status: 402, source: 'account', retryable: false });
  });

  it('the allowance wall without --json says how to ask for more', async () => {
    vi.mocked(shelfBuybox).mockResolvedValueOnce({ ok: false, kind: 'shelf_allowance_exhausted', friendly: 'used up', httpStatus: 402, period: '2026-10', allowance: 500, used: 500, resetsAt: '2026-11-01T00:00:00.000Z' });
    await run('shelf', 'buybox', 'B0EXAMPLE01');
    expect(stderr).toContain('used 500 of 500 for 2026-10; resets 2026-11-01T00:00:00.000Z');
    expect(stderr).toContain('request more shelf requests');
    expect(process.exitCode).toBe(10);
  });

  it('refuses a bad --country before any call', async () => {
    await run('--json', 'shelf', 'buybox', 'B0EXAMPLE01', '--country', 'xx');
    expect(shelfBuybox).not.toHaveBeenCalled();
    expect(JSON.parse(stdout).status).toBe('error');
    expect(process.exitCode).toBe(1);
  });
});

describe('shelf search', () => {
  const SEARCH = {
    ...ANSWER,
    kind: 'search_desktop' as const,
    subject: 'trail mix',
    data: {
      surface: 'desktop' as const,
      page: 1,
      page_size: 60,
      asin_count: 2,
      sponsored_count: 1,
      total_results: 3000,
      delivery_to: 'Dallas 75201',
      banners: [{ position: 0, brand: 'Example Brand', headline: 'Snacks for the trail' }],
      products: [
        { asin: 'B0EXAMPLE02', title: 'Example trail mix', price: '$9.99', price_num: 9.99, rank: 1, absolute_rank: 1, rating: 4.5, reviews: 1000, monthly_sales: 500, is_sponsored: true, is_prime: true, is_amazon_choice: null, is_best_seller: null, is_overall_pick: null, badge_text: null, coupon: 'Save 10%', stock_level: null, fastest_delivery: 'Tomorrow', promise_days_fastest: 1 },
        { asin: 'B0EXAMPLE01', title: 'Example nut mix', price: '$7.99', price_num: 7.99, rank: 2, absolute_rank: 2, rating: 4.4, reviews: 2500, monthly_sales: 100, is_sponsored: false, is_prime: true, is_amazon_choice: null, is_best_seller: true, is_overall_pick: null, badge_text: null, coupon: null, stock_level: 'Only 9 left in stock', fastest_delivery: 'Tomorrow', promise_days_fastest: 1 },
      ],
      categories: [],
      brands: ['Example Brand'],
      related_keywords: ['trail snacks'],
      has_more: true,
    },
  };

  it('passes surface and page, tracks page + surface + positions, and refuses page 6 locally', async () => {
    vi.mocked(shelfSearch).mockResolvedValueOnce(SEARCH);
    await run('--json', 'shelf', 'search', 'trail mix', '--view', 'mobile', '--page', '2', '--zip', '75201');
    expect(shelfSearch).toHaveBeenCalledWith({ query: 'trail mix', surface: 'mobile', page: 2, zip: '75201', country: 'us', fresh: false }, { dataDirOverride: undefined });
    expect(lastTrack().payload).toMatchObject({ kind: 'search_mobile', page: 2, has_zip: true, positions: 2 });
    expect(JSON.stringify(lastTrack())).not.toContain('trail mix');

    vi.mocked(shelfSearch).mockClear();
    await run('--json', 'shelf', 'search', 'trail mix', '--page', '6');
    expect(shelfSearch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('--view reaches the client even though the root program owns --surface (the 2026-10-20 demo-walk bug)', async () => {
    vi.mocked(shelfSearch).mockResolvedValueOnce(SEARCH);
    await run('--json', 'shelf', 'search', 'trail mix', '--zip', '10001', '--view', 'mobile', '--origin', 'demo');
    expect(vi.mocked(shelfSearch).mock.calls[0][0]).toMatchObject({ surface: 'mobile', zip: '10001', origin: 'demo' });
    expect(lastTrack().payload).toMatchObject({ kind: 'search_mobile' });
  });

  it('renders the ranked table with sponsored, badge, coupon and stock columns', () => {
    const md = renderSearch(SEARCH.data);
    expect(md).toContain('desktop page 1: 2 positions, 1 sponsored, 3000 results in all');
    expect(md).toContain('Example Brand ("Snacks for the trail")');
    expect(md).toContain('| 1 | B0EXAMPLE02 | yes | $9.99 | 4.5 | 1000 | 500 | - | Save 10% | - |');
    expect(md).toContain('| 2 | B0EXAMPLE01 |  | $7.99 | 4.4 | 2500 | 100 | Best Seller | - | Only 9 left in stock |');
    expect(md).toContain('`--page 2`');
  });
});

describe('shelf offers, seller, zips, usage, catalog', () => {
  it('offers renders the featured offer and the sorted list; seller takes no zip', async () => {
    const offers = { ...ANSWER, kind: 'offers' as const, data: { product: { ...ANSWER.data, price: '$7.99', price_num: 7.99, fba: true, conditions: null, title: 'Example', rating: 4.4, reviews: 2500 }, offers: [{ price: '$8.40', price_num: 8.4, fba: null, sold_by: 'Example Seller B', ships_from: 'Example Seller B', free_shipping: true, free_delivery: 'Wed', fastest_delivery: 'Oct 19 - 20', order_within: null, conditions: 'New', seller_id: 'A3EXAMPLESELLB', promise_days_free: 6, promise_days_fastest: 4 }], offer_count: 1 } };
    vi.mocked(shelfOffers).mockResolvedValueOnce(offers as never);
    await run('shelf', 'offers', 'B0EXAMPLE01', '--zip', '10001');
    expect(stdout).toContain('**Featured offer:** Example Seller Co at $7.99, FBA');
    expect(stdout).toContain('| 1 | $8.40 | Example Seller B | A3EXAMPLESELLB | - | New | Oct 19 - 20 (4 d) |');
    expect(lastTrack().payload).toMatchObject({ kind: 'offers', offer_count: 1 });

    vi.mocked(shelfSeller).mockResolvedValueOnce({ ...ANSWER, kind: 'seller', zip: '', subject: 'A3EXAMPLESELLB', data: { name: 'Example Seller B', rating: 4.1, rating_count: 200, description: null, details: ['Business Name: Example Seller B'], logo_url: null } } as never);
    await run('--json', 'shelf', 'seller', 'A3EXAMPLESELLB', '--country', 'uk');
    expect(shelfSeller).toHaveBeenCalledWith({ sellerId: 'A3EXAMPLESELLB', country: 'uk', fresh: false }, { dataDirOverride: undefined });
    expect(lastTrack().payload).toMatchObject({ kind: 'seller', country: 'uk', has_zip: false });
  });

  it('zips and usage are the free reads; usage renders the counter', async () => {
    vi.mocked(shelfZips).mockResolvedValueOnce({ ok: true, retailer: 'amazon', country: 'us', count: 2, zips: ['10001', '75201'] });
    await run('--json', 'shelf', 'zips');
    expect(shelfZips).toHaveBeenCalledWith('us', { dataDirOverride: undefined });
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', count: 2 });
    expect(lastTrack()).toMatchObject({ event_name: 'shelf.zips_listed', outcome: 'ok', payload: { country: 'us', count: 2 } });

    vi.mocked(shelfUsage).mockResolvedValueOnce({ ok: true, period: '2026-10', allowance: 2000, used: 27, remaining: 1973, resets_at: '2026-11-01T00:00:00.000Z', source: 'discovery_first_month' });
    await run('shelf', 'usage');
    expect(stdout).toContain('used: 27 of 2000 (1973 left)');
    expect(stdout).toContain('first-month discovery allowance');
    expect(lastTrack()).toMatchObject({ event_name: 'shelf.usage_read', payload: { allowance: 2000, used: 27 } });
  });

  it('catalog lists every call with a what-is-this and names no provider', async () => {
    await run('--json', 'shelf', 'catalog');
    const out = JSON.parse(stdout);
    expect(out.count).toBe(SHELF_CATALOG.length);
    expect(out.catalog.map((e: { id: string }) => e.id)).toEqual(['buybox', 'offers', 'search', 'product', 'seller', 'zips', 'usage']);
    for (const e of SHELF_CATALOG) {
      expect(e.explain.length).toBeGreaterThan(80);
      expect(e.cost === 'free' || e.cost === 'counts 1').toBe(true);
      expect(e.example.startsWith(`mixshift shelf ${e.id}`)).toBe(true);
    }
    expect(JSON.stringify(SHELF_CATALOG).toLowerCase()).not.toContain('asgard');

    stdout = '';
    await run('shelf', 'catalog');
    expect(stdout).toContain('### buybox (counts 1)');
    expect(stdout).toContain('### zips (free)');
    expect(stdout).toContain('demo Amazon shelf');
    expect(lastTrack().event_name).toBe('shelf.catalog_listed');
  });

  it('renderBuybox and renderOffers handle the empty cases', () => {
    expect(renderBuybox({ ...ANSWER.data, in_stock: false, price: null })).toContain('no Buy Box');
    expect(renderOffers({ product: null, offers: [], offer_count: 0 })).toContain('no other offers');
  });
});
