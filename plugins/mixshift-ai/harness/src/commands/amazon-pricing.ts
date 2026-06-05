/**
 * `mixshift amazon pricing ...` — Amazon SP-API Pricing batch surface.
 *
 * Sibling of `mixshift amazon report ...`. Same Bearer token, same envelope,
 * different SP-API domain. Two operations exposed:
 *   - get-featured-offer-expected-price-batch (FOEP, keyed by SKU)
 *   - get-competitive-summary-batch           (keyed by ASIN)
 *
 * Each runs in one of two modes:
 *   - sync (default, cap 200 items, response inline, ~3 min worst case)
 *   - async via --async (no cap, returns runId; poll separately)
 *
 * Plus run-lifecycle commands:
 *   - poll-run <runId>        progress + status
 *   - get-run-result <runId>  per-item responses
 *
 * Verbatim SP-API operation names (hyphenated for HTTP / CLI conventions).
 *
 * Privacy: telemetry captures operation + item counts + duration + outcome.
 * Never the responses payload (which carries seller pricing data).
 */

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import {
  getFeaturedOfferExpectedPriceBatch,
  startFeaturedOfferExpectedPriceBatch,
  getCompetitiveSummaryBatch,
  startCompetitiveSummaryBatch,
  pollPricingRun,
  getPricingRunResult,
  isReportFailure,
  type CompetitiveSummaryIncludedData,
  type ReportFailure,
} from '../lib/amazon/pricing.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

type Operation = 'foep_batch' | 'competitive_summary_batch';

/** Map a typed failure to a non-zero exit code so terminal scripts can react. */
function exitCodeForKind(kind: ReportFailure['kind']): number {
  switch (kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2;
    case 'reauth_required':
      return 3;
    case 'restricted_report':
      return 4;
    case 'merchant_not_found':
      return 5;
    case 'throttled':
      return 6;
    case 'host_unreachable':
      return 7;
    case 'spapi_not_configured':
      return 8;
    case 'report_fatal':
      return 9;
    case 'unknown':
    default:
      return 1;
  }
}

export function registerAmazonPricingCommands(amazon: Command): void {
  const pricing = amazon
    .command('pricing')
    .description(
      'SP-API Product Pricing batch endpoints (FOEP + Competitive Summary). ' +
        'Verbatim Amazon operation names. Sync (default) or --async.',
    );

  registerFoepCommand(pricing);
  registerCompetitiveSummaryCommand(pricing);
  registerPollRunCommand(pricing);
  registerGetRunResultCommand(pricing);
}

// ---------------------------------------------------------------------------
// FOEP
// ---------------------------------------------------------------------------

function registerFoepCommand(pricing: Command): void {
  pricing
    .command('get-featured-offer-expected-price-batch')
    .alias('foep-batch')
    .description(
      'Featured Offer Expected Price (FOEP): what your SKU would have to be priced at to win the Buy Box. ' +
        'Keyed by SKU. Sync cap 200; --async for larger jobs.',
    )
    .requiredOption(
      '--skus <list>',
      'Comma-separated SKUs (e.g. ABC-123,XYZ-7). Mutually exclusive with --skus-file.',
    )
    .option('--skus-file <path>', 'File with one SKU per line. Mutually exclusive with --skus.')
    .option('--marketplace <code>', 'Country code (US, UK, ...) or raw marketplaceId.')
    .option('--amazon-seller-id <id>', 'AmazonSellerID from `amazon merchants`.')
    .option('--legacy-seller-id <id>', 'Exact legacySellerId (seller.ID). Authoritative disambiguator.')
    .option('--async', 'Async mode: returns a runId; poll separately.')
    .action(async (opts: FoepCommandOpts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const skus = await loadItemList(opts.skus, opts.skusFile);
        if (skus.length === 0) {
          throw new Error('No SKUs supplied. Pass --skus a,b,c or --skus-file path.');
        }
        const merchantSelection = {
          ...(opts.amazonSellerId ? { amazonSellerId: opts.amazonSellerId } : {}),
          ...(opts.legacySellerId ? { legacySellerId: opts.legacySellerId } : {}),
          ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
        };
        if (opts.async) {
          const result = await startFeaturedOfferExpectedPriceBatch(
            { ...merchantSelection, skus },
            { dataDirOverride: root.dataDir },
          );
          if (isReportFailure(result)) {
            await trackFailure('foep_batch', 'async', skus.length, result, startedAt, root.dataDir);
            return emitFailure(result, !!root.json);
          }
          await track(
            {
              event_name: EventName.AmazonPricingStarted,
              outcome: 'ok',
              duration_ms: Date.now() - startedAt,
              payload: {
                operation: 'foep_batch',
                mode: 'async',
                items_count: skus.length,
                run_id: result.runId,
                legacy_seller_id: opts.legacySellerId,
              },
            },
            root.dataDir,
          );
          if (root.json) writeJson(result);
          else
            process.stdout.write(
              `\nrunId: ${result.runId}\nstatus: ${result.status}\nitems: ${result.itemsTotal}\n\n` +
                `Poll with: mixshift amazon pricing poll-run ${result.runId}\n` +
                `Get result: mixshift amazon pricing get-run-result ${result.runId}\n`,
            );
          return;
        }
        // Sync
        const result = await getFeaturedOfferExpectedPriceBatch(
          { ...merchantSelection, skus },
          { dataDirOverride: root.dataDir },
        );
        if (isReportFailure(result)) {
          await trackFailure('foep_batch', 'sync', skus.length, result, startedAt, root.dataDir);
          return emitFailure(result, !!root.json);
        }
        await track(
          {
            event_name: EventName.AmazonPricingRetrieved,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: {
              operation: 'foep_batch',
              mode: 'sync',
              items_count: skus.length,
              items_succeeded: result.itemsSucceeded,
              items_failed: result.itemsFailed,
              run_id: result.runId,
              legacy_seller_id: opts.legacySellerId,
            },
          },
          root.dataDir,
        );
        writeJson(result);
      } catch (err) {
        emitGenericError(err, !!root.json);
      }
    });
}

interface FoepCommandOpts {
  skus?: string;
  skusFile?: string;
  marketplace?: string;
  amazonSellerId?: string;
  legacySellerId?: string;
  async?: boolean;
}

// ---------------------------------------------------------------------------
// Competitive Summary
// ---------------------------------------------------------------------------

function registerCompetitiveSummaryCommand(pricing: Command): void {
  pricing
    .command('get-competitive-summary-batch')
    .alias('cs-batch')
    .description(
      'Competitive Summary: who currently wins the Featured Offer per ASIN, reference prices, ' +
        'optional lowest-priced offers. Keyed by ASIN. Sync cap 200; --async for larger jobs.',
    )
    .requiredOption('--asins <list>', 'Comma-separated ASINs. Mutually exclusive with --asins-file.')
    .option('--asins-file <path>', 'File with one ASIN per line.')
    .option('--marketplace <code>', 'Country code or raw marketplaceId.')
    .option('--amazon-seller-id <id>', 'AmazonSellerID.')
    .option('--legacy-seller-id <id>', 'Exact legacySellerId.')
    .option(
      '--included-data <list>',
      'Comma-separated: featuredBuyingOptions,referencePrices,lowestPricedOffers',
    )
    .option('--async', 'Async mode.')
    .action(async (opts: CsCommandOpts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const asins = await loadItemList(opts.asins, opts.asinsFile);
        if (asins.length === 0) {
          throw new Error('No ASINs supplied. Pass --asins a,b,c or --asins-file path.');
        }
        const includedData = parseIncludedData(opts.includedData);
        const merchantSelection = {
          ...(opts.amazonSellerId ? { amazonSellerId: opts.amazonSellerId } : {}),
          ...(opts.legacySellerId ? { legacySellerId: opts.legacySellerId } : {}),
          ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
        };
        if (opts.async) {
          const result = await startCompetitiveSummaryBatch(
            {
              ...merchantSelection,
              asins,
              ...(includedData ? { includedData } : {}),
            },
            { dataDirOverride: root.dataDir },
          );
          if (isReportFailure(result)) {
            await trackFailure(
              'competitive_summary_batch',
              'async',
              asins.length,
              result,
              startedAt,
              root.dataDir,
            );
            return emitFailure(result, !!root.json);
          }
          await track(
            {
              event_name: EventName.AmazonPricingStarted,
              outcome: 'ok',
              duration_ms: Date.now() - startedAt,
              payload: {
                operation: 'competitive_summary_batch',
                mode: 'async',
                items_count: asins.length,
                run_id: result.runId,
                legacy_seller_id: opts.legacySellerId,
              },
            },
            root.dataDir,
          );
          if (root.json) writeJson(result);
          else
            process.stdout.write(
              `\nrunId: ${result.runId}\nstatus: ${result.status}\nitems: ${result.itemsTotal}\n\n` +
                `Poll with: mixshift amazon pricing poll-run ${result.runId}\n` +
                `Get result: mixshift amazon pricing get-run-result ${result.runId}\n`,
            );
          return;
        }
        const result = await getCompetitiveSummaryBatch(
          {
            ...merchantSelection,
            asins,
            ...(includedData ? { includedData } : {}),
          },
          { dataDirOverride: root.dataDir },
        );
        if (isReportFailure(result)) {
          await trackFailure(
            'competitive_summary_batch',
            'sync',
            asins.length,
            result,
            startedAt,
            root.dataDir,
          );
          return emitFailure(result, !!root.json);
        }
        await track(
          {
            event_name: EventName.AmazonPricingRetrieved,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: {
              operation: 'competitive_summary_batch',
              mode: 'sync',
              items_count: asins.length,
              items_succeeded: result.itemsSucceeded,
              items_failed: result.itemsFailed,
              run_id: result.runId,
              legacy_seller_id: opts.legacySellerId,
            },
          },
          root.dataDir,
        );
        writeJson(result);
      } catch (err) {
        emitGenericError(err, !!root.json);
      }
    });
}

interface CsCommandOpts {
  asins?: string;
  asinsFile?: string;
  marketplace?: string;
  amazonSellerId?: string;
  legacySellerId?: string;
  includedData?: string;
  async?: boolean;
}

// ---------------------------------------------------------------------------
// poll-run / get-run-result
// ---------------------------------------------------------------------------

function registerPollRunCommand(pricing: Command): void {
  pricing
    .command('poll-run <runId>')
    .description('Poll a pricing run (FOEP or CompetitiveSummary) for status + progress.')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await pollPricingRun(runId, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await track(
            {
              event_name: EventName.AmazonPricingFailed,
              outcome: 'failed',
              duration_ms: Date.now() - startedAt,
              error_class: result.kind,
              payload: { operation: 'poll_run', run_id: runId },
            },
            root.dataDir,
          );
          return emitFailure(result, !!root.json);
        }
        await track(
          {
            event_name: EventName.AmazonPricingPolled,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: {
              run_id: runId,
              status: result.status,
              items_completed: result.itemsCompleted,
            },
          },
          root.dataDir,
        );
        writeJson(result);
      } catch (err) {
        emitGenericError(err, !!root.json);
      }
    });
}

function registerGetRunResultCommand(pricing: Command): void {
  pricing
    .command('get-run-result <runId>')
    .description('Fetch the per-item responses for a pricing run (call after status=DONE).')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await getPricingRunResult(runId, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await track(
            {
              event_name: EventName.AmazonPricingFailed,
              outcome: 'failed',
              duration_ms: Date.now() - startedAt,
              error_class: result.kind,
              payload: { operation: 'get_run_result', run_id: runId },
            },
            root.dataDir,
          );
          return emitFailure(result, !!root.json);
        }
        await track(
          {
            event_name: EventName.AmazonPricingRetrieved,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: {
              run_id: runId,
              status: result.status,
              items_succeeded: result.itemsSucceeded,
              items_failed: result.itemsFailed,
            },
          },
          root.dataDir,
        );
        writeJson(result);
      } catch (err) {
        emitGenericError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadItemList(inline: string | undefined, file: string | undefined): Promise<string[]> {
  if (inline && file) {
    throw new Error('Pass --skus / --asins OR the --*-file variant, not both.');
  }
  if (inline) {
    return inline
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (file) {
    const text = await readFile(file, 'utf8');
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'));
  }
  return [];
}

function parseIncludedData(raw: string | undefined): CompetitiveSummaryIncludedData[] | undefined {
  if (!raw) return undefined;
  const allowed = new Set<CompetitiveSummaryIncludedData>([
    'featuredBuyingOptions',
    'referencePrices',
    'lowestPricedOffers',
  ]);
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: CompetitiveSummaryIncludedData[] = [];
  for (const it of items) {
    if (allowed.has(it as CompetitiveSummaryIncludedData)) {
      out.push(it as CompetitiveSummaryIncludedData);
    } else {
      throw new Error(
        `Unknown --included-data value: ${it}. Allowed: featuredBuyingOptions, referencePrices, lowestPricedOffers.`,
      );
    }
  }
  return out.length > 0 ? out : undefined;
}

async function trackFailure(
  operation: Operation | 'poll_run' | 'get_run_result',
  mode: 'sync' | 'async',
  itemsCount: number,
  result: ReportFailure,
  startedAt: number,
  dataDir: string | undefined,
): Promise<void> {
  await track(
    {
      event_name: EventName.AmazonPricingFailed,
      outcome: 'failed',
      duration_ms: Date.now() - startedAt,
      error_class: result.kind,
      payload: {
        operation,
        mode,
        items_count: itemsCount,
        failure_kind: result.kind,
      },
    },
    dataDir,
  );
}

function emitFailure(failure: ReportFailure, json: boolean): void {
  if (json) {
    writeJson({ status: 'failed', ...failure });
  } else {
    process.stderr.write(`\nerror (${failure.kind}): ${failure.friendly}\n`);
    if (failure.message) process.stderr.write(`detail: ${failure.message}\n`);
  }
  process.exitCode = exitCodeForKind(failure.kind);
}

function emitGenericError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    writeJson({ status: 'failed', kind: 'unknown', message });
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
