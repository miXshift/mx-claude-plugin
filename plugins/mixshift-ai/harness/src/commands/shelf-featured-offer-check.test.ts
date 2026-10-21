/**
 * Command-level tests for `mixshift shelf featured-offer-check`: the sync path
 * (start resolves the merchant, fetches the summary, plans, spends a budget,
 * persists state; resume finishes and renders), the allowance wall pausing a
 * run, and telemetry that carries counts, never a subject.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerShelfCommands } from './shelf.js';
import { listMerchants } from '../lib/amazon/reports.js';
import { getCompetitiveSummaryBatch } from '../lib/amazon/pricing.js';
import { shelfBuybox, shelfOffers, shelfZips } from '../lib/shelf/client.js';
import { track } from '../lib/telemetry/index.js';

vi.mock('../lib/amazon/reports.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/amazon/reports.js')>();
  return { ...actual, listMerchants: vi.fn() };
});
vi.mock('../lib/amazon/pricing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/amazon/pricing.js')>();
  return { ...actual, getCompetitiveSummaryBatch: vi.fn(), startCompetitiveSummaryBatch: vi.fn(), pollPricingRun: vi.fn(), getPricingRunResult: vi.fn() };
});
vi.mock('../lib/shelf/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/shelf/client.js')>();
  return { ...actual, shelfBuybox: vi.fn(), shelfOffers: vi.fn(), shelfZips: vi.fn(), shelfUsage: vi.fn() };
});
vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', 'json', false).option('--data-dir <path>', 'data dir').option('--surface <surface>', 'telemetry host');
  registerShelfCommands(program);
  return program;
}
async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', ...args]);
}

let stdout = '';
let stderr = '';
let dir = '';
beforeEach(async () => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  dir = await fs.mkdtemp(join(tmpdir(), 'foc-'));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const m of [listMerchants, getCompetitiveSummaryBatch, shelfBuybox, shelfOffers, shelfZips]) vi.mocked(m).mockReset();
  vi.mocked(track).mockClear();
  process.exitCode = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const US = 'A1EXAMPLEUS000';
const RIVAL = 'A2EXAMPLERIVAL';
const MERCHANTS = { ok: true as const, merchants: [{ amazonSellerId: US, name: 'Example Brand', merchantType: 'Seller' as const, merchantRegion: 'NA', marketplaceId: 'ATVPDKIKX0DER', countryCode: 'US', legacySellerId: 574 }] };
const SUMMARY = {
  ok: true as const, runId: 'r1', status: 'DONE', itemsTotal: 2, itemsCompleted: 1, itemsSucceeded: 2, itemsFailed: 0, completedAt: null, errorDetail: null, operationClass: 'pricing', reportType: 'cs',
  responses: [
    { status: { statusCode: 200 }, body: { asin: 'B0EXAMPL01', featuredBuyingOptions: [{ segmentedFeaturedOffers: [{ sellerId: US, listingPrice: { amount: 7.99 }, featuredOfferSegments: [{ customerMembership: 'PRIME', segmentDetails: { glanceViewWeightPercentage: 100, sampleLocation: { postalCode: { value: '32428' } } } }] }] }] } },
    { status: { statusCode: 200 }, body: { asin: 'B0EXAMPL02', featuredBuyingOptions: [{ segmentedFeaturedOffers: [{ sellerId: RIVAL, listingPrice: { amount: 7.83 }, featuredOfferSegments: [{ customerMembership: 'PRIME', segmentDetails: { glanceViewWeightPercentage: 100, sampleLocation: { postalCode: { value: '75201' } } } }] }] }] } },
  ],
};
const buybox = (sellerId: string, price: number) => ({ ok: true as const, kind: 'buybox' as const, retailer: 'amazon', country: 'us', zip: '75201', subject: 'B0EXAMPL02', observed_at: '2026-10-21T10:00:00.000Z', source: 'shelf' as const, data: { price, currency: '$', in_stock: true, stock: 5, sold_by: sellerId === US ? 'Example Brand' : 'Example Rival', ships_from: 'Amazon', prime: true, free_shipping: true, free_delivery: null, fastest_delivery: 'Tomorrow', order_within: null, seller_id: sellerId, delivery_to: null, promise_days_free: null, promise_days_fastest: 1 } });
const offers = { ok: true as const, kind: 'offers' as const, retailer: 'amazon', country: 'us', zip: '75201', subject: 'B0EXAMPL02', observed_at: '2026-10-21T10:00:05.000Z', source: 'shelf' as const, data: { product: null, offers: [{ price: '$7.83', price_num: 7.83, fba: true, sold_by: 'Example Rival', ships_from: 'Amazon', free_shipping: true, free_delivery: null, fastest_delivery: 'Tomorrow', order_within: null, conditions: 'New', seller_id: RIVAL, promise_days_free: null, promise_days_fastest: 1 }, { price: '$7.99', price_num: 7.99, fba: true, sold_by: 'Example Brand', ships_from: 'Amazon', free_shipping: true, free_delivery: null, fastest_delivery: 'Tomorrow', order_within: null, conditions: 'New', seller_id: US, promise_days_free: null, promise_days_fastest: 1 }], offer_count: 2 } };

describe('shelf featured-offer-check', () => {
  it('start (sync) resolves the merchant, summarizes, plans the lost ASIN only, spends the budget, persists; resume renders the report', async () => {
    vi.mocked(listMerchants).mockResolvedValue(MERCHANTS as never);
    vi.mocked(getCompetitiveSummaryBatch).mockResolvedValue(SUMMARY as never);
    vi.mocked(shelfZips).mockResolvedValue({ ok: true, retailer: 'amazon', country: 'us', count: 4, zips: ['75201', '10001', '60601', '90001'] });
    vi.mocked(shelfBuybox).mockResolvedValue(buybox(RIVAL, 7.83) as never);
    vi.mocked(shelfOffers).mockResolvedValue(offers as never);

    await run('--json', 'shelf', 'featured-offer-check', 'start', '--legacy-seller-id', '574', '--asins', 'B0EXAMPL01,b0exampl02', '--budget', '2', '--out', dir);
    const first = JSON.parse(stdout);
    expect(first).toMatchObject({ status: 'ok', out_dir: dir, next: 'resume', progress: { phase: 'shelf', asins: 2, summarized: 2, flagged: 1, shelf_calls_total: 5, shelf_calls_done: 2, shelf_answers_spent: 2 } });
    expect(getCompetitiveSummaryBatch).toHaveBeenCalledWith({ legacySellerId: '574', marketplace: 'US', asins: ['B0EXAMPL01', 'B0EXAMPL02'], includedData: ['featuredBuyingOptions'] }, { dataDirOverride: undefined });
    expect(shelfBuybox).toHaveBeenCalledTimes(2);
    expect(vi.mocked(shelfBuybox).mock.calls[0]![0]).toEqual({ asin: 'B0EXAMPL02', zip: '75201', country: 'us', origin: 'featured_offer_check' });
    const state = JSON.parse(await fs.readFile(join(dir, 'state.json'), 'utf8'));
    expect(state.phase).toBe('shelf');
    expect(state.results).toHaveLength(2);

    stdout = '';
    await run('--json', 'shelf', 'featured-offer-check', 'resume', '--out', dir);
    const second = JSON.parse(stdout);
    expect(second).toMatchObject({ status: 'ok', next: null, progress: { phase: 'done', shelf_calls_done: 5, shelf_answers_spent: 5 }, report: { counts: { total: 2, held: 1, flagged: 1, price_undercut: 1 } } });
    const md = await fs.readFile(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('B0EXAMPL02');
    expect(md).toContain('lost on price');
    expect(await fs.stat(join(dir, 'report.html'))).toBeTruthy();

    const t = vi.mocked(track).mock.calls.at(-1)![0] as { event_name: string; payload: Record<string, unknown> };
    expect(t.event_name).toBe('shelf.featured_offer_check');
    expect(t.payload).toMatchObject({ phase: 'done', asins: 2, flagged: 1, shelf_answers_spent: 5, reasons: { price_undercut: 1 } });
    expect(JSON.stringify(t)).not.toMatch(/B0EXAMPLE|A1EXAMPLE|A2EXAMPLE|7\.83/);
  });

  it('pauses at the allowance wall with the request_more hint and no next; status reports it', async () => {
    vi.mocked(listMerchants).mockResolvedValue(MERCHANTS as never);
    vi.mocked(getCompetitiveSummaryBatch).mockResolvedValue(SUMMARY as never);
    vi.mocked(shelfZips).mockResolvedValue({ ok: true, retailer: 'amazon', country: 'us', count: 1, zips: ['75201'] });
    vi.mocked(shelfBuybox).mockResolvedValue({ ok: false, kind: 'shelf_allowance_exhausted', friendly: 'used up', httpStatus: 402, requestMore: 'Ask MixShift.' });

    await run('--json', 'shelf', 'featured-offer-check', 'start', '--legacy-seller-id', '574', '--asins', 'B0EXAMPL02', '--out', dir);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ next: null, blocked: { kind: 'shelf_allowance_exhausted', requestMore: 'Ask MixShift.' }, progress: { shelf_calls_done: 0 } });
    expect(process.exitCode).toBe(10);

    stdout = '';
    process.exitCode = undefined;
    await run('shelf', 'featured-offer-check', 'status', '--out', dir);
    expect(stdout).toContain('BLOCKED: used up Ask MixShift.');
  });

  it('refuses a bad ASIN and a missing merchant before any call', async () => {
    await run('--json', 'shelf', 'featured-offer-check', 'start', '--legacy-seller-id', '574', '--asins', 'nope');
    expect(JSON.parse(stdout).status).toBe('error');
    expect(listMerchants).not.toHaveBeenCalled();
    stdout = '';
    await run('--json', 'shelf', 'featured-offer-check', 'start', '--asins', 'B0EXAMPL01');
    expect(JSON.parse(stdout).message).toContain('Name the merchant');
  });
});
