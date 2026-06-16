/**
 * Command-level tests for `mixshift amazon pricing ...` option wiring.
 *
 * Regression guard: --skus / --asins were once declared with requiredOption,
 * so Commander rejected any invocation that supplied only the --skus-file /
 * --asins-file variant ("required option '--skus <list>' not specified")
 * before the action ever ran — the file flags were unusable. Both item-list
 * flags must stay plain options; validation belongs to the action-level
 * guards (loadItemList's "not both" and the "No SKUs/ASINs supplied" checks),
 * which these tests pin down too.
 *
 * The SP-API client functions are mocked (no network, no credentials);
 * commander parsing, the action handlers, and loadItemList run for real.
 * Telemetry's track() is stubbed so nothing touches the data dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerAmazonPricingCommands } from './amazon-pricing.js';
import {
  getFeaturedOfferExpectedPriceBatch,
  getCompetitiveSummaryBatch,
  type PricingRunResult,
  type FoepResponseItem,
  type CompetitiveSummaryResponseItem,
} from '../lib/amazon/pricing.js';

vi.mock('../lib/amazon/pricing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/amazon/pricing.js')>();
  return {
    ...actual, // keep isReportFailure / exitCodeForKind real
    getFeaturedOfferExpectedPriceBatch: vi.fn(),
    startFeaturedOfferExpectedPriceBatch: vi.fn(),
    getCompetitiveSummaryBatch: vi.fn(),
    startCompetitiveSummaryBatch: vi.fn(),
    pollPricingRun: vi.fn(),
    getPricingRunResult: vi.fn(),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual, // keep EventName real
    track: vi.fn(async () => {}),
  };
});

function okRun<T>(items: number): PricingRunResult<T> {
  return {
    ok: true,
    runId: 'run-test',
    status: 'DONE',
    itemsTotal: items,
    itemsCompleted: items,
    itemsSucceeded: items,
    itemsFailed: 0,
    completedAt: '2026-06-10T00:00:00Z',
    errorDetail: null,
    operationClass: 'pricing_test',
    reportType: 'test',
    responses: [],
  };
}

/** Mirror the cli.ts wiring the pricing group hangs off in production. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw CommanderError instead of process.exit
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  const amazon = program.command('amazon');
  registerAmazonPricingCommands(amazon);
  return program;
}

async function runPricing(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', 'amazon', 'pricing', ...args]);
}

let tmpDir: string;
let stderrChunks: string[];
let exitCodeBefore: typeof process.exitCode;

beforeEach(async () => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
  stderrChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });
  tmpDir = await mkdtemp(join(tmpdir(), 'mx-pricing-cmd-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(tmpDir, { recursive: true, force: true });
});

const stderrText = (): string => stderrChunks.join('');

// ---------------------------------------------------------------------------
// FOEP: --skus / --skus-file
// ---------------------------------------------------------------------------

describe('foep-batch item-list flags', () => {
  it('accepts --skus-file alone and loads SKUs from the file', async () => {
    const file = join(tmpDir, 'skus.txt');
    await writeFile(file, 'SKU-1\r\nSKU-2\n# a comment\n\n  SKU-3  \n', 'utf8');
    vi.mocked(getFeaturedOfferExpectedPriceBatch).mockResolvedValue(okRun<FoepResponseItem>(3));

    await runPricing('get-featured-offer-expected-price-batch', '--skus-file', file);

    expect(getFeaturedOfferExpectedPriceBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getFeaturedOfferExpectedPriceBatch).mock.calls[0][0]).toMatchObject({
      skus: ['SKU-1', 'SKU-2', 'SKU-3'],
    });
    expect(stderrText()).toBe('');
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('rejects --skus combined with --skus-file via the runtime guard', async () => {
    const file = join(tmpDir, 'skus.txt');
    await writeFile(file, 'SKU-9\n', 'utf8');

    await runPricing('foep-batch', '--skus', 'SKU-1', '--skus-file', file);

    expect(getFeaturedOfferExpectedPriceBatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('not both');
  });

  it('fails through the action guard when neither --skus nor --skus-file is given', async () => {
    // Before the fix this never reached the action: Commander aborted parsing
    // with "required option '--skus <list>' not specified" (a CommanderError
    // under exitOverride, which would reject this parseAsync call).
    await runPricing('get-featured-offer-expected-price-batch');

    expect(getFeaturedOfferExpectedPriceBatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('No SKUs supplied');
  });
});

// ---------------------------------------------------------------------------
// Competitive Summary: --asins / --asins-file
// ---------------------------------------------------------------------------

describe('cs-batch item-list flags', () => {
  it('accepts --asins-file alone and loads ASINs from the file', async () => {
    const file = join(tmpDir, 'asins.txt');
    await writeFile(file, 'B0EXAMPLE01\n# header comment\nB0EXAMPLE02\n\n', 'utf8');
    vi.mocked(getCompetitiveSummaryBatch).mockResolvedValue(
      okRun<CompetitiveSummaryResponseItem>(2),
    );

    await runPricing('cs-batch', '--asins-file', file);

    expect(getCompetitiveSummaryBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getCompetitiveSummaryBatch).mock.calls[0][0]).toMatchObject({
      asins: ['B0EXAMPLE01', 'B0EXAMPLE02'],
    });
    expect(stderrText()).toBe('');
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('rejects --asins combined with --asins-file via the runtime guard', async () => {
    const file = join(tmpDir, 'asins.txt');
    await writeFile(file, 'B0EXAMPLE01\n', 'utf8');

    await runPricing('get-competitive-summary-batch', '--asins', 'B0EXAMPLE09', '--asins-file', file);

    expect(getCompetitiveSummaryBatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('not both');
  });

  it('fails through the action guard when neither --asins nor --asins-file is given', async () => {
    await runPricing('get-competitive-summary-batch');

    expect(getCompetitiveSummaryBatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('No ASINs supplied');
  });
});
