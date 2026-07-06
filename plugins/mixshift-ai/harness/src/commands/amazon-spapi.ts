/**
 * `mixshift amazon operations` / `mixshift amazon call` — the generic SP-API
 * call surface. Sibling of the report and pricing subcommands; covers the
 * long tail of read operations (catalog lookups, FBA inventory, order
 * metrics, finances, orders search, offer depth, listings state, Data Kiosk,
 * vendor POs) through the service's curated operation catalog.
 *
 * Command shape:
 *   amazon operations [--family <name>]     browse what is callable
 *   amazon call <operation> [selectors] [--query k=v ...] [--path k=v ...]
 *                            [--body-file <f> | --body <json>]
 *
 * Discovery-first: run `amazon operations` and read the `notes` column before
 * calling — it carries required params, PascalCase gotchas on v0 operations,
 * caps, and body shapes. Every call is a single fast request/response (Data
 * Kiosk's wait happens by re-calling data_kiosk.get_query), so this surface
 * needs no start/poll/get split for chat hosts.
 *
 * Exit / telemetry contract matches amazon.ts: handlers set process.exitCode
 * and return; telemetry captures operation id + duration + outcome only,
 * never the payload (it can carry seller-level business data).
 */

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import {
  listOperations,
  spapiCall,
  type SpApiCallInput,
  type SpApiOperationView,
  type SpApiQueryValue,
} from '../lib/amazon/spapi-call.js';
import {
  isReportFailure,
  exitCodeForKind,
  type ReportFailure,
} from '../lib/amazon/reports.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerAmazonSpApiCommands(amazon: Command): void {
  registerOperations(amazon);
  registerCall(amazon);
}

// ---------------------------------------------------------------------------
// amazon operations
// ---------------------------------------------------------------------------

function registerOperations(amazon: Command): void {
  amazon
    .command('operations')
    .description(
      'Browse the directly callable SP-API operations (beyond reports and pricing). ' +
        'Read the notes before calling: they carry required params and gotchas.',
    )
    .option('--family <name>', 'filter to one family (e.g. "Data Kiosk", "Catalog Items")')
    .action(async (opts: { family?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listOperations(opts.family, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackSpApi(EventName.AmazonSpApiOperationsListed, 'failed', startedAt, root.dataDir, {
            kind: result.kind,
          });
          return emitFailure(result, !!root.json);
        }
        await trackSpApi(EventName.AmazonSpApiOperationsListed, 'ok', startedAt, root.dataDir, {
          count: result.operations.length,
          ...(opts.family ? { family: opts.family } : {}),
        });
        if (root.json) {
          writeJson({ status: 'ok', count: result.operations.length, operations: result.operations });
        } else {
          process.stderr.write(`\n✓ ${result.operations.length} operation(s)\n\n`);
          process.stdout.write(renderOperations(result.operations) + '\n');
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// amazon call <operation>
// ---------------------------------------------------------------------------

interface CallCliOptions {
  sellerId?: string;
  legacySellerId?: string;
  marketplace?: string;
  query: Record<string, string>;
  path: Record<string, string>;
  bodyFile?: string;
  body?: string;
}

function registerCall(amazon: Command): void {
  amazon
    .command('call <operation>')
    .description(
      'Execute one cataloged SP-API operation (read-only). Run `amazon operations` ' +
        'first for the operation id and its parameter notes.',
    )
    .option('--seller-id <id>', 'AmazonSellerID from `amazon merchants`')
    .option(
      '--legacy-seller-id <id>',
      'exact per-marketplace seller record id (authoritative disambiguator)',
    )
    .option('--marketplace <m>', 'country code (US, UK, ...) or raw marketplaceId')
    .option(
      '--query <k=v>',
      'query param per the operation notes (repeatable; csv values pass through)',
      collectKv,
      {},
    )
    .option(
      '--path <k=v>',
      'path placeholder, e.g. --path asin=B0CV4JLCVZ (repeatable)',
      collectKv,
      {},
    )
    .option('--body-file <file>', 'JSON request body from a file (body-required operations)')
    .option('--body <json>', 'inline JSON request body (small payloads; prefer --body-file)')
    .action(async (operation: string, opts: CallCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        let body: unknown;
        if (opts.bodyFile && opts.body) {
          return emitError(new Error('Pass --body-file or --body, not both.'), !!root.json);
        }
        if (opts.bodyFile) {
          body = JSON.parse(await readFile(opts.bodyFile, 'utf8'));
        } else if (opts.body) {
          body = JSON.parse(opts.body);
        }

        const input: SpApiCallInput = {
          operation,
          amazonSellerId: opts.sellerId,
          legacySellerId: opts.legacySellerId,
          marketplace: opts.marketplace,
          pathParams: opts.path,
          query: opts.query as Record<string, SpApiQueryValue>,
          ...(body !== undefined ? { body } : {}),
        };
        const result = await spapiCall(input, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackSpApi(EventName.AmazonSpApiCalled, 'failed', startedAt, root.dataDir, {
            operation,
            kind: result.kind,
            ...(result.httpStatus ? { http_status: result.httpStatus } : {}),
          });
          return emitFailure(result, !!root.json);
        }
        // Beta richness (feedback #10): stamp the resolved merchant/marketplace
        // identifiers so SP-API usage can be sliced by seller/marketplace, not
        // just operation. Mirrors the JSON output below; never the payload
        // (Amazon's response body carries seller-level data).
        await trackSpApi(EventName.AmazonSpApiCalled, 'ok', startedAt, root.dataDir, {
          operation,
          ...(result.amazonSellerId ? { amazon_seller_id: result.amazonSellerId } : {}),
          ...(result.legacySellerId ? { legacy_seller_id: result.legacySellerId } : {}),
          ...(result.marketplaceId ? { marketplace_id: result.marketplaceId } : {}),
        });
        if (root.json) {
          writeJson({
            status: 'ok',
            operation: result.operation,
            amazon_seller_id: result.amazonSellerId,
            legacy_seller_id: result.legacySellerId,
            marketplace_id: result.marketplaceId,
            payload: result.payload,
          });
        } else {
          process.stderr.write(
            `\n✓ ${result.operation} (${result.amazonSellerId} / ${result.marketplaceId})\n\n`,
          );
          process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n');
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** commander collector for repeatable k=v options. */
function collectKv(pair: string, acc: Record<string, string>): Record<string, string> {
  const idx = pair.indexOf('=');
  if (idx <= 0) {
    throw new Error(`Expected k=v, got '${pair}'.`);
  }
  acc[pair.slice(0, idx)] = pair.slice(idx + 1);
  return acc;
}

async function trackSpApi(
  eventName: string,
  outcome: 'ok' | 'failed',
  startedAt: number,
  dataDir: string | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  await track(
    {
      event_name: eventName,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(outcome === 'failed' && typeof payload.kind === 'string'
        ? { error_class: payload.kind }
        : {}),
      payload,
    },
    dataDir,
  );
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function emitFailure(failure: ReportFailure, json: boolean): void {
  if (json) {
    writeJson({
      status: 'error',
      failure_kind: failure.kind,
      message: failure.friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      candidates: failure.candidates,
    });
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.message) process.stderr.write(`  ${failure.message}\n`);
  }
  process.exitCode = exitCodeForKind(failure.kind);
}

function emitError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    writeJson({ status: 'error', message });
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderOperations(operations: SpApiOperationView[]): string {
  if (operations.length === 0) {
    return '_(no operations matched — check the --family spelling against `amazon operations`)_';
  }
  const byFamily = new Map<string, SpApiOperationView[]>();
  for (const op of operations) {
    const list = byFamily.get(op.family) ?? [];
    list.push(op);
    byFamily.set(op.family, list);
  }
  const blocks: string[] = [];
  for (const [family, ops] of byFamily) {
    blocks.push(`## ${family}`);
    for (const op of ops) {
      const flags = [
        op.method !== 'GET' ? op.method : null,
        op.body === 'required' ? 'body required' : null,
        op.deprecation ? 'DEPRECATED' : null,
      ]
        .filter(Boolean)
        .join(', ');
      blocks.push(`- **${op.id}** (${op.version}${flags ? `; ${flags}` : ''}): ${op.summary}`);
      if (op.notes) blocks.push(`  - notes: ${op.notes}`);
      if (op.deprecation) blocks.push(`  - deprecation: ${op.deprecation}`);
    }
    blocks.push('');
  }
  return blocks.join('\n').trimEnd();
}
