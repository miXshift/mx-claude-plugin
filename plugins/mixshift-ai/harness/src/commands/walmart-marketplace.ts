/**
 * `mixshift walmart marketplace ...` — Walmart Marketplace (seller API) READS.
 *
 *   walmart marketplace sellers                      the sellers you can read
 *   walmart marketplace operations [--family <name>] browse what is callable
 *   walmart marketplace call <operation> --seller <id>
 *                  [--environment sandbox|production] [--query <json>] [--path <json>]
 *
 * READ ONLY. An operation the catalog marks as a write is refused before
 * anything is sent: changes are made in the MixShift app. There is no
 * --commit here by design.
 *
 * Exit / telemetry contract matches `walmart ads`: handlers set
 * process.exitCode and return; telemetry carries operation id + seller id +
 * environment + duration + outcome, never the payload.
 */

import type { Command } from 'commander';
import {
  listMarketplaceSellers,
  listMarketplaceOperations,
  marketplaceCall,
  isMarketplaceFailure,
  exitCodeForMarketplaceKind,
  type MarketplaceFailure,
  type MarketplaceOperationView,
  type MarketplaceSellerView,
} from '../lib/walmart/marketplace-call.js';
import { cleanServerText } from '../lib/amazon/reports.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerMarketplace(walmart: Command): void {
  const mp = walmart
    .command('marketplace')
    .description(
      'Walmart Marketplace (seller API) reads: orders, items, inventory, and the per-SKU snapshot. ' +
        'Read only: changes are made in the MixShift app.',
    );
  registerSellers(mp);
  registerOperations(mp);
  registerCall(mp);
}

// ---------------------------------------------------------------------------
// sellers
// ---------------------------------------------------------------------------

function registerSellers(mp: Command): void {
  mp.command('sellers')
    .description('List the Walmart Marketplace sellers connected to your MixShift account.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listMarketplaceSellers({ dataDirOverride: root.dataDir });
        if (isMarketplaceFailure(result)) {
          await trackMp(EventName.WalmartMarketplaceSellersListed, 'failed', startedAt, root.dataDir, {
            kind: result.kind,
            ...(result.httpStatus ? { http_status: result.httpStatus } : {}),
          });
          return emitFailure(result, !!root.json);
        }
        await trackMp(EventName.WalmartMarketplaceSellersListed, 'ok', startedAt, root.dataDir, {
          count: result.sellers.length,
          sample: result.sellers.slice(0, 25).map((s) => ({ seller_id: s.sellerId, environment: s.environment })),
          truncated: result.sellers.length > 25,
        });
        if (root.json) {
          writeJson({ status: 'ok', count: result.sellers.length, sellers: result.sellers });
        } else {
          process.stderr.write(`\n✓ ${result.sellers.length} seller(s)\n\n`);
          process.stdout.write(renderSellers(result.sellers) + '\n');
        }
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

function registerOperations(mp: Command): void {
  mp.command('operations')
    .description(
      'Browse the Walmart Marketplace operations. Read the notes before calling: they carry ' +
        'required parameters and Walmart quirks. Operations marked WRITE are not callable from the plugin.',
    )
    .option('--family <name>', 'filter to one family (see the families list)')
    .action(async (opts: { family?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listMarketplaceOperations(opts.family, { dataDirOverride: root.dataDir });
        if (isMarketplaceFailure(result)) {
          await trackMp(EventName.WalmartMarketplaceOperationsListed, 'failed', startedAt, root.dataDir, {
            kind: result.kind,
          });
          return emitFailure(result, !!root.json);
        }
        await trackMp(EventName.WalmartMarketplaceOperationsListed, 'ok', startedAt, root.dataDir, {
          count: result.operations.length,
          ...(opts.family ? { family: opts.family } : {}),
        });
        if (root.json) {
          writeJson({
            status: 'ok',
            count: result.operations.length,
            families: result.families,
            operations: result.operations,
          });
        } else {
          process.stderr.write(`\n✓ ${result.operations.length} operation(s)\n\n`);
          process.stdout.write(renderOperations(result.operations, result.families) + '\n');
        }
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

interface CallCliOptions {
  seller?: string;
  environment?: string;
  query?: string;
  path?: string;
}

/** Parse a --query / --path value: a JSON object, nothing else. */
export function parseJsonObject(flag: string, raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${flag} must be a JSON object, e.g. ${flag} '{"sku":"ABC-1"}'.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object, e.g. ${flag} '{"sku":"ABC-1"}'.`);
  }
  return parsed as Record<string, unknown>;
}

function registerCall(mp: Command): void {
  mp.command('call <operation>')
    .description(
      'Execute one cataloged Walmart Marketplace READ for one seller. Run `walmart marketplace operations` ' +
        'first for the id and its notes. Write operations are refused: changes are made in the MixShift app.',
    )
    .option('--seller <id>', 'seller id from `walmart marketplace sellers` (required)')
    .option('--environment <env>', 'sandbox or production, when the seller is connected in both')
    .option('--query <json>', 'query parameters as a JSON object, e.g. \'{"sku":"ABC-1"}\'')
    .option('--path <json>', 'path parameters as a JSON object')
    .action(async (operation: string, opts: CallCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const sellerId = opts.seller?.trim();
        if (!sellerId) {
          return emitError(
            new Error('--seller is required. Run `mixshift walmart marketplace sellers` for the ids you can use.'),
            !!root.json,
          );
        }
        if (opts.environment && opts.environment !== 'sandbox' && opts.environment !== 'production') {
          return emitError(new Error('--environment must be sandbox or production.'), !!root.json);
        }
        const query = parseJsonObject('--query', opts.query);
        const path = parseJsonObject('--path', opts.path);

        const result = await marketplaceCall(
          {
            operation,
            sellerId,
            ...(opts.environment ? { environment: opts.environment } : {}),
            ...(query ? { query } : {}),
            ...(path ? { path } : {}),
          },
          { dataDirOverride: root.dataDir },
        );
        if (isMarketplaceFailure(result)) {
          await trackMp(EventName.WalmartMarketplaceCalled, 'failed', startedAt, root.dataDir, {
            operation,
            seller_id: sellerId,
            kind: result.kind,
            ...(result.httpStatus ? { http_status: result.httpStatus } : {}),
            ...(result.walmartStatus ? { walmart_status: result.walmartStatus } : {}),
            ...(result.unrecognizedKind ? { unrecognized_kind: result.unrecognizedKind } : {}),
            // Parameter NAMES only, never values.
            ...(query ? { query_keys: Object.keys(query).sort() } : {}),
          });
          return emitFailure(result, !!root.json);
        }
        await trackMp(EventName.WalmartMarketplaceCalled, 'ok', startedAt, root.dataDir, {
          operation,
          seller_id: result.sellerId,
          environment: result.environment,
          ...(typeof result.status === 'number' ? { walmart_status: result.status } : {}),
        });

        // The service's `status` is Walmart's HTTP status; it travels as
        // walmart_status so the envelope's own status stays 'ok'.
        const { ok: _ok, status: walmartStatus, ...rest } = result;
        if (root.json) {
          writeJson({ status: 'ok', ...rest, ...(walmartStatus !== undefined ? { walmart_status: walmartStatus } : {}) });
          return;
        }
        process.stderr.write(`\n✓ ${result.operation} (seller ${result.sellerId}, ${result.environment})\n\n`);
        const shown = 'payload' in result ? result.payload : rest;
        process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function trackMp(
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
      ...(outcome === 'failed' && typeof payload.kind === 'string' ? { error_class: payload.kind } : {}),
      payload,
    },
    dataDir,
  );
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function emitFailure(failure: MarketplaceFailure, json: boolean): void {
  if (json) {
    writeJson({
      status: 'error',
      failure_kind: failure.kind,
      message: failure.friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      walmart_status: failure.walmartStatus,
      reason: failure.reason,
      seller_id: failure.sellerId,
      required_scope: failure.requiredScope,
      unrecognized_kind: failure.unrecognizedKind,
      source: failure.source,
      retryable: failure.retryable,
      fix: failure.fix,
      invalid_params: failure.invalidParams,
      walmart_response: failure.walmartResponse,
    });
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.message && failure.message !== failure.friendly) process.stderr.write(`  ${failure.message}\n`);
    if (failure.fix) process.stderr.write(`  fix: ${failure.fix}\n`);
    if (failure.walmartStatus) process.stderr.write(`  Walmart's HTTP status: ${failure.walmartStatus}\n`);
    if (failure.walmartResponse !== undefined) {
      const said = cleanServerText(
        typeof failure.walmartResponse === 'string' ? failure.walmartResponse : JSON.stringify(failure.walmartResponse),
      );
      if (said) process.stderr.write(`  Walmart said: ${said.length > 500 ? `${said.slice(0, 500)}...` : said}\n`);
    }
  }
  process.exitCode = exitCodeForMarketplaceKind(failure.kind);
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

export function renderSellers(sellers: MarketplaceSellerView[]): string {
  if (sellers.length === 0) {
    return '_(no Walmart Marketplace sellers are connected to this MixShift account)_';
  }
  const lines = ['| seller | id | environment | scopes |', '|---|---|---|---|'];
  for (const s of sellers) {
    const scopes = Array.isArray(s.scopes) && s.scopes.length > 0 ? s.scopes.join(', ') : '';
    lines.push(`| ${s.label} | ${s.sellerId} | ${s.environment} | ${scopes} |`);
  }
  return lines.join('\n');
}

export function renderOperations(operations: MarketplaceOperationView[], families: string[] = []): string {
  if (operations.length === 0) {
    return '_(no operations matched' + (families.length > 0 ? `; families: ${families.join(', ')}` : '') + ')_';
  }
  const byFamily = new Map<string, MarketplaceOperationView[]>();
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
        op.method && op.method !== 'GET' ? op.method : null,
        op.write ? 'WRITE (not callable from the plugin)' : null,
      ]
        .filter(Boolean)
        .join('; ');
      blocks.push(`- **${op.id}**${flags ? ` (${flags})` : ''}`);
      if (op.requiredQuery && op.requiredQuery.length > 0) {
        blocks.push(`  - required query: ${op.requiredQuery.join(', ')}`);
      }
      if (op.notes) blocks.push(`  - notes: ${op.notes}`);
    }
    blocks.push('');
  }
  return blocks.join('\n').trimEnd();
}
