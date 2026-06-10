/**
 * `mixshift ads ...` — the Amazon Ads API call surface (phase 2: reads).
 * Top-level sibling of `mixshift amazon ...` (SP-API): a different Amazon API
 * with a different auth model (advertising logins + profile-scoped calls),
 * same catalog-driven shape.
 *
 * Command shape:
 *   ads profiles                              who you can call for
 *   ads operations [--family <name>]          browse what is callable
 *   ads call <operation> [selectors] [--query k=v ...] [--path k=v ...]
 *                         [--body-file <f> | --body <json>]
 *
 * Discovery-first: run `ads operations` and read the notes. Reporting and
 * exports are async on Amazon's side but every call here is a single fast
 * request/response (create, then poll by re-calling get), so chat hosts need
 * no special casing. Download urls in payloads are presigned: fetch WITHOUT
 * auth headers and gunzip.
 *
 * Exit / telemetry contract matches the amazon commands: handlers set
 * process.exitCode and return; telemetry captures operation id + duration +
 * outcome only, never the payload (it carries seller-level business data).
 */

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import {
  listAdsProfiles,
  listAdsOperations,
  adsCall,
  type AdsCallInput,
  type AdsOperationView,
  type AdsProfileView,
  type AdsQueryValue,
} from '../lib/amazon/ads-call.js';
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

export function registerAdsCommands(program: Command): void {
  const ads = program
    .command('ads')
    .description(
      'Call the Amazon Ads API (read-only): reporting v3, entity exports, ' +
        'campaign/keyword/target lists with current bids, intraday budget usage, ' +
        'live bid and keyword recommendations.',
    );

  registerProfiles(ads);
  registerOperations(ads);
  registerCall(ads);
}

// ---------------------------------------------------------------------------
// ads profiles
// ---------------------------------------------------------------------------

function registerProfiles(ads: Command): void {
  ads
    .command('profiles')
    .description('List the Ads profiles you can call for (one per advertiser account + marketplace).')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listAdsProfiles({ dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackAds(EventName.AdsProfilesListed, 'failed', startedAt, root.dataDir, {
            kind: result.kind,
          });
          return emitFailure(result, !!root.json);
        }
        await trackAds(EventName.AdsProfilesListed, 'ok', startedAt, root.dataDir, {
          count: result.profiles.length,
        });
        if (root.json) {
          writeJson({ status: 'ok', count: result.profiles.length, profiles: result.profiles });
        } else {
          process.stderr.write(`\n✓ ${result.profiles.length} profile(s)\n\n`);
          process.stdout.write(renderProfiles(result.profiles) + '\n');
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// ads operations
// ---------------------------------------------------------------------------

function registerOperations(ads: Command): void {
  ads
    .command('operations')
    .description(
      'Browse the callable Ads API operations. Read the notes before calling: ' +
        'they carry body vs query conventions and media types.',
    )
    .option('--family <name>', 'filter to one family (e.g. "Reporting", "Sponsored Products")')
    .action(async (opts: { family?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listAdsOperations(opts.family, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackAds(EventName.AdsOperationsListed, 'failed', startedAt, root.dataDir, {
            kind: result.kind,
          });
          return emitFailure(result, !!root.json);
        }
        await trackAds(EventName.AdsOperationsListed, 'ok', startedAt, root.dataDir, {
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
// ads call <operation>
// ---------------------------------------------------------------------------

interface CallCliOptions {
  profileId?: string;
  legacySellerId?: string;
  sellerId?: string;
  marketplace?: string;
  query: Record<string, string>;
  path: Record<string, string>;
  bodyFile?: string;
  body?: string;
  contentType?: string;
}

function registerCall(ads: Command): void {
  ads
    .command('call <operation>')
    .description(
      'Execute one cataloged Ads API operation (read-only). Run `ads operations` ' +
        'first for the operation id and its notes.',
    )
    .option('--profile-id <id>', 'Ads profileId from `ads profiles`')
    .option(
      '--legacy-seller-id <id>',
      'exact per-marketplace seller record id (same ids as `amazon merchants`)',
    )
    .option('--seller-id <id>', 'AmazonSellerID; pair with --marketplace when multi-marketplace')
    .option('--marketplace <m>', 'country code (US, UK, ...) or raw marketplaceId')
    .option(
      '--query <k=v>',
      'query param (SD lists, sb.list_keywords; repeatable)',
      collectKv,
      {},
    )
    .option('--path <k=v>', 'path placeholder, e.g. --path reportId=... (repeatable)', collectKv, {})
    .option('--body-file <file>', 'JSON request body from a file')
    .option('--body <json>', 'inline JSON request body (small payloads; prefer --body-file)')
    .option('--content-type <vnd>', 'advanced: override the cataloged vnd media type')
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

        const input: AdsCallInput = {
          operation,
          profileId: opts.profileId,
          legacySellerId: opts.legacySellerId,
          sellerId: opts.sellerId,
          marketplace: opts.marketplace,
          pathParams: opts.path,
          query: opts.query as Record<string, AdsQueryValue>,
          ...(body !== undefined ? { body } : {}),
          ...(opts.contentType ? { contentTypeOverride: opts.contentType } : {}),
        };
        const result = await adsCall(input, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackAds(EventName.AdsCalled, 'failed', startedAt, root.dataDir, {
            operation,
            kind: result.kind,
            ...(result.httpStatus ? { http_status: result.httpStatus } : {}),
          });
          return emitFailure(result, !!root.json);
        }
        await trackAds(EventName.AdsCalled, 'ok', startedAt, root.dataDir, { operation });
        if (root.json) {
          writeJson({
            status: 'ok',
            operation: result.operation,
            profile_id: result.profileId,
            legacy_seller_id: result.legacySellerId,
            marketplace_id: result.marketplaceId,
            payload: result.payload,
          });
        } else {
          process.stderr.write(`\n✓ ${result.operation} (profile ${result.profileId})\n\n`);
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

async function trackAds(
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

function renderProfiles(profiles: AdsProfileView[]): string {
  if (profiles.length === 0) {
    return '_(no Ads profiles: this tenant has no connected advertising logins with profile ids)_';
  }
  const cols = ['profileId', 'legacySellerId', 'name', 'type', 'region', 'marketplace'];
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const rows = profiles.map((p) => {
    const marketplace = [p.countryCode, p.marketplaceName ?? p.marketplaceId]
      .filter((s): s is string => !!s)
      .join(' ');
    return (
      '| ' +
      [
        p.profileId,
        String(p.legacySellerId),
        mdCell(p.name),
        p.merchantType,
        p.merchantRegion,
        mdCell(marketplace),
      ].join(' | ') +
      ' |'
    );
  });
  return [header, sep, ...rows].join('\n');
}

function renderOperations(operations: AdsOperationView[]): string {
  if (operations.length === 0) {
    return '_(no operations matched: check the --family spelling against `ads operations`)_';
  }
  const byFamily = new Map<string, AdsOperationView[]>();
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
        op.body === 'required' ? 'body required' : op.body === 'optional' ? 'body optional' : null,
      ]
        .filter(Boolean)
        .join(', ');
      blocks.push(`- **${op.id}**${flags ? ` (${flags})` : ''}: ${op.summary}`);
      if (op.notes) blocks.push(`  - notes: ${op.notes}`);
    }
    blocks.push('');
  }
  return blocks.join('\n').trimEnd();
}

function mdCell(s: string): string {
  return s.replaceAll('|', '\\|');
}
