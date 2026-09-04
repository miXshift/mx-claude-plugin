/**
 * `mixshift ads ...` — the Amazon Ads API call surface (reads + audited
 * writes). Top-level sibling of `mixshift amazon ...` (SP-API): a different
 * Amazon API with a different auth model (advertising logins +
 * profile-scoped calls), same catalog-driven shape.
 *
 * Command shape:
 *   ads profiles                              who you can call for
 *   ads operations [--family <name>]          browse what is callable
 *   ads call <operation> [selectors] [--query k=v ...] [--path k=v ...]
 *                         [--body-file <f> | --body <json>] [--commit]
 *
 * WRITE CONTRACT: operations marked write: true (bid updates, negatives,
 * campaign creation) run as a DRY RUN by default: the service validates,
 * snapshots current state, logs an audit row, and returns a preview without
 * touching Amazon. `--commit` is the ONLY way to mutate, and the skill layer
 * must show the user the preview and get explicit confirmation first.
 * Commits return Amazon's multi-status response (partial failure is normal)
 * plus the audit row id holding the pre-write snapshot.
 *
 * Discovery-first: run `ads operations` and read the notes. Reporting and
 * exports are async on Amazon's side but every call here is a single fast
 * request/response (create, then poll by re-calling get), so chat hosts need
 * no special casing. Download urls in payloads are presigned: fetch WITHOUT
 * auth headers and gunzip.
 *
 * Exit / telemetry contract matches the amazon commands: handlers set
 * process.exitCode and return; telemetry captures operation id + duration +
 * outcome + dry_run only, never the payload (it carries seller-level
 * business data).
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
import { emitAdsCommitEvent } from '../lib/timeline/ads-emit.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerAdsCommands(program: Command): void {
  const ads = program
    .command('ads')
    .description(
      'Call the Amazon Ads API: reporting v3, entity exports, ' +
        'campaign/keyword/target lists with current bids, intraday budget usage, ' +
        'live bid and keyword recommendations, and audited writes (bids, ' +
        'negatives, campaign creation; dry-run by default, --commit to apply).',
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
          // Beta richness (feedback #10): bounded projection of profile
          // identifiers so reviews can see WHICH advertiser accounts a tenant
          // can call for, not just how many. Id/name fields only, never a full
          // profile object; capped at 25 with a truncated flag.
          sample: result.profiles.slice(0, 25).map((p) => ({
            profile_id: p.profileId,
            legacy_seller_id: p.legacySellerId,
            ...(p.amazonSellerId != null ? { amazon_seller_id: p.amazonSellerId } : {}),
            ...(p.marketplaceId != null ? { marketplace_id: p.marketplaceId } : {}),
            ...(p.countryCode != null ? { country_code: p.countryCode } : {}),
          })),
          truncated: result.profiles.length > 25,
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
  commit?: boolean;
  proposalId?: string;
}

function registerCall(ads: Command): void {
  ads
    .command('call <operation>')
    .description(
      'Execute one cataloged Ads API operation. Run `ads operations` first for ' +
        'the operation id and its notes. Write operations preview by default ' +
        '(dry run); pass --commit to apply, ONLY after the user confirmed the preview.',
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
    .option(
      '--commit',
      'WRITE operations: actually apply the change set (default is a dry-run ' +
        'preview that mutates nothing). Use only after explicit user confirmation.',
    )
    .option(
      '--proposal-id <id>',
      'WRITE operations, with --commit: the dry-run audit id (printed by the ' +
        'preview) so the brand-timeline event links preview → commit. When ' +
        'omitted, the commit audit id is used. Set MIXSHIFT_SKILL_ID / ' +
        'MIXSHIFT_MODEL_ID env vars to attribute the change to the driving ' +
        'skill/model. The same MIXSHIFT_SKILL_ID (or MIXSHIFT_INTENT to ' +
        'override it) also rides every request to MixShift as the ' +
        'x-mixshift-intent header, for usage attribution only.',
    )
    .action(async (operation: string, opts: CallCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        // Cap before anything reaches a wire body: the proposal id lands
        // verbatim on a timeline event, so free-form input is rejected up
        // front rather than bounced by the service later.
        if (
          opts.proposalId !== undefined &&
          !/^[A-Za-z0-9_-]{1,128}$/.test(opts.proposalId)
        ) {
          return emitError(
            new Error(
              '--proposal-id must be 1-128 characters of A-Z, a-z, 0-9, ' +
                'underscore, or hyphen (use the audit id printed by the dry run).',
            ),
            !!root.json,
          );
        }
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
          // Only --commit sends dryRun:false; otherwise the service's own
          // dry-run default is the contract (and reads ignore it entirely).
          ...(opts.commit ? { dryRun: false } : {}),
        };
        const result = await adsCall(input, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackAds(EventName.AdsCalled, 'failed', startedAt, root.dataDir, {
            operation,
            kind: result.kind,
            ...(opts.commit ? { committed: true } : {}),
            ...(result.httpStatus ? { http_status: result.httpStatus } : {}),
            // Amazon's OWN error code: (operation, amazon_error_code)
            // recurring across users is a catalog-gap signature. The CODE and
            // not the message, because it is low-cardinality and carries no
            // seller/order/ASIN identifiers.
            ...(result.amazonErrorCode ? { amazon_error_code: result.amazonErrorCode } : {}),
            ...(result.amazonStatus ? { amazon_status: result.amazonStatus } : {}),
            // Contract drift: the service sent a `kind` this build does not
            // know, so the class above came from the status, not the wire.
            // Recording the raw value keeps the drift visible (mx-ops#43).
            ...(result.unrecognizedKind
              ? { unrecognized_kind: result.unrecognizedKind }
              : {}),
          });
          return emitFailure(result, !!root.json);
        }
        // Beta richness (feedback #10): stamp the advertiser/account
        // identifiers already resolved on `result` so reviews can slice Ads
        // usage by profile/seller/marketplace and trace a committed write to
        // its audit id — not just "an ads.called happened". Mirrors the JSON
        // output fields below; never the request/response body (seller-level
        // business data).
        await trackAds(EventName.AdsCalled, 'ok', startedAt, root.dataDir, {
          operation,
          ...(typeof result.dryRun === 'boolean' ? { dry_run: result.dryRun } : {}),
          ...(result.profileId !== undefined ? { profile_id: result.profileId } : {}),
          ...(result.legacySellerId !== undefined ? { legacy_seller_id: result.legacySellerId } : {}),
          ...(result.marketplaceId !== undefined ? { marketplace_id: result.marketplaceId } : {}),
          ...(typeof result.itemsCount === 'number' ? { items_count: result.itemsCount } : {}),
          ...(result.auditId ? { audit_id: result.auditId } : {}),
        });
        if (root.json) {
          writeJson({
            status: 'ok',
            operation: result.operation,
            profile_id: result.profileId,
            legacy_seller_id: result.legacySellerId,
            marketplace_id: result.marketplaceId,
            ...(typeof result.dryRun === 'boolean' ? { dry_run: result.dryRun } : {}),
            ...(typeof result.itemsCount === 'number' ? { items_count: result.itemsCount } : {}),
            ...(result.auditId ? { audit_id: result.auditId } : {}),
            ...(result.beforeState !== undefined ? { before_state: result.beforeState } : {}),
            ...(result.preview !== undefined ? { preview: result.preview } : {}),
            ...(result.payload !== undefined ? { payload: result.payload } : {}),
          });
        } else if (result.dryRun === true) {
          const commitHint = result.auditId
            ? `--commit --proposal-id ${result.auditId}`
            : '--commit';
          process.stderr.write(
            `\n✓ DRY RUN ${result.operation} (profile ${result.profileId}): ` +
              `${result.itemsCount ?? '?'} item(s) validated, nothing applied.\n` +
              (result.auditId ? `  audit: ${result.auditId}\n` : '') +
              `  Re-run with ${commitHint} AFTER the user confirms this change set.\n\n`,
          );
          process.stdout.write(
            JSON.stringify({ preview: result.preview, beforeState: result.beforeState }, null, 2) + '\n',
          );
        } else if (result.dryRun === false) {
          process.stderr.write(
            `\n✓ COMMITTED ${result.operation} (profile ${result.profileId}): ` +
              `${result.itemsCount ?? '?'} item(s) sent. audit: ${result.auditId ?? 'n/a'}\n` +
              '  Amazon responds per item; check success/error arrays below.\n\n',
          );
          process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n');
        } else {
          process.stderr.write(`\n✓ ${result.operation} (profile ${result.profileId})\n\n`);
          process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n');
        }

        // Instrumentation: a committed change set is a first-class brand
        // business event — append it to the org timeline (best-effort,
        // ≤2s, never affects this command's outcome; skipped silently when
        // the seller doesn't map to exactly one registry brand). The
        // server also projects mcp_ads_changes into the timeline read
        // path, so this richer native event is ADDITIVE — its payload
        // carries change_set_id (= the audit row id) so the projection can
        // be deduped later. See lib/timeline/ads-emit.ts.
        if (result.dryRun === false) {
          // emitAdsCommitEvent never throws by contract; the .catch is
          // belt-and-braces so no future regression can turn a timeline
          // hiccup into a failed (already-applied!) commit.
          await emitAdsCommitEvent(
            {
              operation: result.operation,
              legacySellerId: result.legacySellerId,
              ...(result.auditId ? { auditId: result.auditId } : {}),
              ...(typeof result.itemsCount === 'number'
                ? { itemsCount: result.itemsCount }
                : {}),
              ...(body !== undefined ? { requestBody: body } : {}),
              ...(result.beforeState !== undefined
                ? { beforeState: result.beforeState }
                : {}),
              ...(result.payload !== undefined
                ? { responsePayload: result.payload }
                : {}),
              ...(opts.proposalId ? { proposalId: opts.proposalId } : {}),
            },
            { dataDirOverride: root.dataDir },
          ).catch(() => undefined);
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
      // Amazon's OWN code, status and response body. Previously dropped on the
      // floor, which left a user reporting a failure with nothing complete to
      // send and left us unable to tell a catalog gap from an outage.
      amazon_error_code: failure.amazonErrorCode,
      amazon_status: failure.amazonStatus,
      unrecognized_kind: failure.unrecognizedKind,
      amazon_response: failure.responsePayload ?? failure.responseText,
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
