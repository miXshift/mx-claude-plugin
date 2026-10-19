/**
 * `mixshift walmart ads ...` — the Walmart Connect (advertising API) call
 * surface: Sponsored Search and Display reads, reports, and audited writes.
 * Same catalog-driven shape as `mixshift ads ...` (Amazon Ads), with Walmart's
 * own selector: an advertiser id from `walmart ads advertisers`.
 *
 * Command shape:
 *   walmart ads advertisers                       who you can call for
 *   walmart ads operations [--family <name>]      browse what is callable
 *   walmart ads call <operation> --advertiser-id <id>
 *                    [--query k=v ...] [--body-file <f> | --body <json>] [--commit]
 *
 * WRITE CONTRACT: operations marked write run as a preview by default and
 * nothing reaches Walmart. `--commit` is the ONLY way to apply, and the skill
 * layer must show the user the preview and get explicit confirmation first.
 *
 * Reports are async on Walmart's side: create one, then call the matching
 * download operation until it answers ready: true. MixShift downloads and
 * parses the file, so the agent never fetches a report link itself.
 *
 * Exit / telemetry contract matches the amazon and ads commands: handlers set
 * process.exitCode and return; telemetry captures operation id + advertiser
 * id + environment + duration + outcome, never the payload (campaign data is
 * the advertiser's business data).
 */

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import {
  listWalmartAdvertisers,
  listWalmartOperations,
  walmartAdsCall,
  isWalmartFailure,
  exitCodeForWalmartKind,
  type WalmartAdsCallInput,
  type WalmartAdvertiserView,
  type WalmartFailure,
  type WalmartOperationView,
  type WalmartQueryValue,
} from '../lib/walmart/ads-call.js';
import { cleanServerText, CONTRACT_WORD } from '../lib/amazon/reports.js';
import { track, EventName } from '../lib/telemetry/index.js';
import { keyValueOption } from '../lib/cli/option-parsers.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerWalmartCommands(program: Command): void {
  const walmart = program
    .command('walmart')
    .description('Call Walmart APIs for the Walmart accounts connected to your MixShift account.');
  const ads = walmart
    .command('ads')
    .description(
      'Walmart Connect (Walmart ads): Sponsored Search and Display campaigns, ad groups, ' +
        'keywords, reports, and audited writes (preview by default, --commit to apply).',
    );
  registerAdvertisers(ads);
  registerOperations(ads);
  registerCall(ads);
}

// ---------------------------------------------------------------------------
// walmart ads advertisers
// ---------------------------------------------------------------------------

function registerAdvertisers(ads: Command): void {
  ads
    .command('advertisers')
    .description('List the Walmart advertisers connected to your MixShift account.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listWalmartAdvertisers({ dataDirOverride: root.dataDir });
        if (isWalmartFailure(result)) {
          await trackWalmart(EventName.WalmartAdsAdvertisersListed, 'failed', startedAt, root.dataDir, {
            kind: result.kind,
            ...(result.httpStatus ? { http_status: result.httpStatus } : {}),
          });
          return emitFailure(result, !!root.json);
        }
        await trackWalmart(EventName.WalmartAdsAdvertisersListed, 'ok', startedAt, root.dataDir, {
          count: result.advertisers.length,
          // Which advertisers, not just how many: ids and link attributes only.
          sample: result.advertisers.slice(0, 25).map((a) => ({
            advertiser_id: a.advertiserId,
            api: a.api,
            environment: a.environment,
            access: a.access,
          })),
          truncated: result.advertisers.length > 25,
        });
        if (root.json) {
          writeJson({ status: 'ok', count: result.advertisers.length, advertisers: result.advertisers });
        } else {
          process.stderr.write(`\n✓ ${result.advertisers.length} advertiser(s)\n\n`);
          process.stdout.write(renderAdvertisers(result.advertisers) + '\n');
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// walmart ads operations
// ---------------------------------------------------------------------------

function registerOperations(ads: Command): void {
  ads
    .command('operations')
    .description(
      'Browse the callable Walmart Connect operations. Read the notes before calling: ' +
        'they carry required params, body shapes, and Walmart quirks.',
    )
    .option('--family <name>', 'filter to one family (see the families list)')
    .action(async (opts: { family?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listWalmartOperations(opts.family, { dataDirOverride: root.dataDir });
        if (isWalmartFailure(result)) {
          await trackWalmart(EventName.WalmartAdsOperationsListed, 'failed', startedAt, root.dataDir, {
            kind: result.kind,
          });
          return emitFailure(result, !!root.json);
        }
        await trackWalmart(EventName.WalmartAdsOperationsListed, 'ok', startedAt, root.dataDir, {
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
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// walmart ads call <operation>
// ---------------------------------------------------------------------------

interface CallCliOptions {
  advertiserId?: string;
  query: Record<string, string>;
  bodyFile?: string;
  body?: string;
  commit?: boolean;
}

function registerCall(ads: Command): void {
  ads
    .command('call <operation>')
    .description(
      'Execute one cataloged Walmart Connect operation for one advertiser. Run ' +
        '`walmart ads operations` first for the id and its notes. Write operations ' +
        'preview by default; pass --commit to apply, ONLY after the user confirmed the preview.',
    )
    .option('--advertiser-id <id>', 'advertiser id from `walmart ads advertisers` (required)')
    .option(
      '--query <k=v>',
      'query param per the operation notes; on download operations also limit=N and ' +
        'groupBy=<column> (repeatable)',
      keyValueOption('--query', { bodyFlag: '--body' }),
      {},
    )
    .option('--body-file <file>', 'JSON request body from a file')
    .option('--body <json>', 'inline JSON request body (small payloads; prefer --body-file)')
    .option(
      '--commit',
      'WRITE operations: actually apply the change (default is a preview that sends ' +
        'nothing to Walmart). Use only after explicit user confirmation.',
    )
    .action(async (operation: string, opts: CallCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const advertiserId = opts.advertiserId?.trim();
        if (!advertiserId) {
          return emitError(
            new Error('--advertiser-id is required. Run `mixshift walmart ads advertisers` for the ids you can use.'),
            !!root.json,
          );
        }
        if (opts.bodyFile && opts.body) {
          return emitError(new Error('Pass --body-file or --body, not both.'), !!root.json);
        }
        let body: unknown;
        if (opts.bodyFile) {
          body = JSON.parse(await readFile(opts.bodyFile, 'utf8'));
        } else if (opts.body) {
          body = JSON.parse(opts.body);
        }

        const input: WalmartAdsCallInput = {
          operation,
          advertiserId,
          query: opts.query as Record<string, WalmartQueryValue>,
          ...(body !== undefined ? { body } : {}),
          // Only --commit sends dryRun:false; otherwise the service's own
          // preview default is the contract (and reads ignore it).
          ...(opts.commit ? { dryRun: false } : {}),
        };
        const result = await walmartAdsCall(input, { dataDirOverride: root.dataDir });
        if (isWalmartFailure(result)) {
          await trackWalmart(EventName.WalmartAdsCalled, 'failed', startedAt, root.dataDir, {
            operation,
            advertiser_id: advertiserId,
            kind: result.kind,
            ...(result.httpStatus ? { http_status: result.httpStatus } : {}),
            ...(result.unrecognizedKind ? { unrecognized_kind: result.unrecognizedKind } : {}),
            ...(result.requestOutcome ? { request_outcome: result.requestOutcome } : {}),
            ...(opts.commit ? { committed: true } : {}),
            // Parameter NAMES only, never values (same rule as amazon call).
            ...(Object.keys(opts.query).length > 0 ? { query_keys: Object.keys(opts.query).sort() } : {}),
            // Gateway contract (mx-ops#144): enums and a flag; never the fix text.
            ...(result.source !== undefined && CONTRACT_WORD.test(result.source) ? { source: result.source } : {}),
            ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
            ...(result.fix !== undefined ? { has_fix: true } : {}),
          });
          return emitFailure(result, !!root.json);
        }
        await trackWalmart(EventName.WalmartAdsCalled, 'ok', startedAt, root.dataDir, {
          operation,
          advertiser_id: result.advertiserId,
          environment: result.environment,
          ...(typeof result.dryRun === 'boolean' ? { dry_run: result.dryRun } : {}),
          ...(opts.commit ? { committed: true } : {}),
          ...(typeof result.ready === 'boolean' ? { ready: result.ready } : {}),
          ...(typeof result.status === 'number' ? { walmart_status: result.status } : {}),
          ...(typeof result.rowCount === 'number' ? { row_count: result.rowCount } : {}),
        });

        // The service's `status` is Walmart's HTTP status; it would overwrite
        // this envelope's own status: 'ok', so it travels as walmart_status.
        const { ok: _ok, status: walmartStatus, ...rest } = result;
        if (root.json) {
          writeJson({ status: 'ok', ...rest, ...(walmartStatus !== undefined ? { walmart_status: walmartStatus } : {}) });
          return;
        }
        if (result.dryRun === true) {
          const previewAudit = safeAuditId(result.auditId) ? ` Change id ${result.auditId}.` : '';
          process.stderr.write(
            `\n✓ PREVIEW ONLY: ${result.operation} (advertiser ${result.advertiserId}, ${result.environment}). ` +
              `Nothing was sent to Walmart.${previewAudit}\n` +
              '  Re-run with --commit AFTER the user confirms this change.\n\n',
          );
          process.stdout.write(JSON.stringify(result.preview ?? rest, null, 2) + '\n');
          return;
        }
        if (result.ready === false) {
          process.stderr.write(
            `\n… ${result.operation}: ${typeof result.message === 'string' ? result.message : 'not ready yet'}\n`,
          );
          process.stdout.write(JSON.stringify(rest, null, 2) + '\n');
          return;
        }
        process.stderr.write(
          `\n✓ ${result.operation} (advertiser ${result.advertiserId}, ${result.environment})` +
            `${opts.commit ? ' COMMITTED' : ''}` +
            `${safeAuditId(result.auditId) ? ` (change id ${result.auditId})` : ''}\n\n`,
        );
        const shown = 'payload' in result ? result.payload : rest;
        process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function trackWalmart(
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

/**
 * The change id is interpolated into terminal banners, so allowlist its shape
 * (the service sends a uuid) instead of printing a network value verbatim.
 * JSON output needs no guard: JSON.stringify escapes control characters.
 */
function safeAuditId(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(value);
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function emitFailure(failure: WalmartFailure, json: boolean): void {
  if (json) {
    writeJson({
      status: 'error',
      failure_kind: failure.kind,
      message: failure.friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      advertiser_id: failure.advertiserId,
      required_scope: failure.requiredScope,
      request_outcome: failure.requestOutcome,
      automatic_retry: failure.automaticRetry,
      audit_id: failure.auditId,
      unrecognized_kind: failure.unrecognizedKind,
      // Gateway contract (mx-ops#144 P5).
      source: failure.source,
      retryable: failure.retryable,
      fix: failure.fix,
      invalid_params: failure.invalidParams,
      // Walmart's own answer on a Walmart rejection (the gateway's `walmart`).
      walmart_response: failure.walmartResponse,
    });
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.message && failure.message !== failure.friendly) process.stderr.write(`  ${failure.message}\n`);
    if (failure.fix) process.stderr.write(`  fix: ${failure.fix}\n`);
    if (failure.walmartResponse !== undefined) {
      const said = cleanServerText(
        typeof failure.walmartResponse === 'string' ? failure.walmartResponse : JSON.stringify(failure.walmartResponse),
      );
      if (said) process.stderr.write(`  Walmart said: ${said.length > 500 ? `${said.slice(0, 500)}...` : said}\n`);
    }
    if (failure.retryable === false && failure.source === 'request') {
      process.stderr.write('  Not retryable as sent: change the request before calling again.\n');
    }
    if (safeAuditId(failure.auditId)) process.stderr.write(`  change id: ${failure.auditId} (MixShift change log)\n`);
  }
  process.exitCode = exitCodeForWalmartKind(failure.kind);
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

export function renderAdvertisers(advertisers: WalmartAdvertiserView[]): string {
  if (advertisers.length === 0) {
    return '_(no Walmart advertisers are connected to this MixShift account)_';
  }
  const lines = ['| advertiser | id | ads | environment | access |', '|---|---|---|---|---|'];
  for (const a of advertisers) {
    const api = a.api === 'sponsored_search' ? 'Sponsored Search' : a.api === 'display' ? 'Display' : a.api;
    const access = a.access === 'read' ? 'read only' : a.access;
    lines.push(`| ${a.label} | ${a.advertiserId} | ${api} | ${a.environment} | ${access} |`);
  }
  return lines.join('\n');
}

export function renderOperations(operations: WalmartOperationView[], families: string[] = []): string {
  if (operations.length === 0) {
    return (
      '_(no operations matched' +
      (families.length > 0 ? `; families: ${families.join(', ')}` : '') +
      ')_'
    );
  }
  const byFamily = new Map<string, WalmartOperationView[]>();
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
        op.write ? 'WRITE (preview by default)' : null,
        op.returns ? 'downloads + parses the file' : null,
        op.body ? `body: ${op.body}` : null,
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
