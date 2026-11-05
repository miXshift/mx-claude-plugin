/**
 * `mixshift dsp ...`: DSP composites built on the Ads call surface.
 *
 *   dsp readiness <campaignId> --advertiser-id <id> [selector]
 *       Read-only "Before activating an order" checklist (mx-amazon-dsp skill).
 *       Prints pass / fail / warn / confirm per line with the ids it checked,
 *       and exits 3 when the order is not ready (any fail, or a check that
 *       could not be run). Nothing is written to Amazon.
 *
 *   dsp supply-preset <adGroupId...> --advertiser-id <id> [--preset amazon-direct]
 *       Plans removing third-party exchange INVENTORY_SOURCE targets (keeping
 *       Amazon owned and Publisher Direct), writes the dsp.delete_targets body
 *       to a file and runs its DRY RUN. The commit is a separate, confirmed
 *       `ads call dsp.delete_targets --commit` on the same audited path; this
 *       command never commits.
 *
 * Exit / telemetry contract matches `ads`: handlers set process.exitCode and
 * return; telemetry carries counts, check ids and outcome, never Amazon's
 * payload (seller-level business data) or the advertiser id.
 */

import type { Command } from 'commander';
import { adsCall } from '../lib/amazon/ads-call.js';
import {
  isReportFailure,
  exitCodeForKind,
  failureContractJson,
  failureContractLines,
  failureContractTelemetry,
  type ReportFailure,
} from '../lib/amazon/reports.js';
import { checkDspReadiness, renderReadiness, type ReadinessCall } from '../lib/ads/dsp-readiness.js';
import {
  planSupplyPreset,
  renderSupplyPlan,
  SUPPLY_PRESETS,
  type SupplyCall,
  type SupplyPreset,
} from '../lib/ads/dsp-supply.js';
import { resolveDataDir } from '../lib/paths/resolve.js';
import { track, EventName } from '../lib/telemetry/index.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface ReadinessCliOptions {
  advertiserId?: string;
  profileId?: string;
  legacySellerId?: string;
  sellerId?: string;
  marketplace?: string;
}

/** Exit code when the checklist ran and the order is not ready. */
export const EXIT_NOT_READY = 3;

const NUMERIC_ID = /^\d{1,30}$/;

export function registerDspCommands(program: Command): void {
  const dsp = program
    .command('dsp')
    .description('Amazon DSP checks built on the Ads API (reads and dry-run previews; never commits).');

  dsp
    .command('readiness <campaignId>')
    .description(
      'Check one DSP order before switching it on: media type, goal KPI, tracked products, ' +
        'targeting and an approved creative on every line item. Read-only; exits ' +
        `${EXIT_NOT_READY} when the order is not ready.`,
    )
    .option('--advertiser-id <id>', 'DSP advertiser id (the Amazon-Ads-AccountId of the order)')
    .option('--profile-id <id>', 'Ads profileId from `ads profiles`')
    .option(
      '--legacy-seller-id <id>',
      'exact per-marketplace seller record id (picks the stored authorization and the region)',
    )
    .option('--seller-id <id>', 'AmazonSellerID; pair with --marketplace when multi-marketplace')
    .option('--marketplace <m>', 'country code (US, UK, ...) or raw marketplaceId')
    .action(async (campaignId: string, opts: ReadinessCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const json = !!root.json;
      const startedAt = Date.now();
      try {
        if (!opts.advertiserId) {
          return usage('--advertiser-id is required (the DSP advertiser that owns the order).', json);
        }
        if (!NUMERIC_ID.test(opts.advertiserId)) {
          return usage('--advertiser-id must be the numeric DSP advertiser id.', json);
        }
        if (!NUMERIC_ID.test(campaignId)) {
          return usage('<campaignId> must be the numeric DSP order (campaign) id.', json);
        }
        const call: ReadinessCall = (input) =>
          adsCall(
            {
              ...input,
              profileId: opts.profileId,
              legacySellerId: opts.legacySellerId,
              sellerId: opts.sellerId,
              marketplace: opts.marketplace,
            },
            { dataDirOverride: root.dataDir },
          );
        const result = await checkDspReadiness(call, opts.advertiserId, campaignId);
        if (isReportFailure(result)) {
          await trackReadiness('failed', startedAt, root.dataDir, {
            kind: result.kind,
            ...(opts.legacySellerId !== undefined ? { legacy_seller_id: opts.legacySellerId } : {}),
            ...failureContractTelemetry(result),
          });
          return emitFailure(result, json);
        }
        await trackReadiness('ok', startedAt, root.dataDir, {
          ready: result.ready,
          line_items: result.lineItems.length,
          pass: result.counts.pass,
          fail: result.counts.fail,
          warn: result.counts.warn,
          confirm: result.counts.confirm,
          unchecked: result.counts.unchecked,
          // Stable check ids only (e.g. "creative", "tracked_products"): which
          // gates real orders trip, never what Amazon said about them.
          failed_checks: [...new Set(result.checks.filter((c) => c.level === 'fail').map((c) => c.id))],
          ...(opts.legacySellerId !== undefined ? { legacy_seller_id: opts.legacySellerId } : {}),
        });
        if (json) {
          process.stdout.write(JSON.stringify({ status: 'ok', ...result }, null, 2) + '\n');
        } else {
          process.stdout.write(renderReadiness(result) + '\n');
        }
        process.exitCode = result.ready ? 0 : EXIT_NOT_READY;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (json) process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
        else process.stderr.write(`error: ${message}\n`);
        process.exitCode = 1;
      }
    });

  registerSupplyPreset(dsp);
}

interface SupplyCliOptions extends ReadinessCliOptions {
  preset?: string;
  outDir?: string;
}

function registerSupplyPreset(dsp: Command): void {
  dsp
    .command('supply-preset <adGroupIds...>')
    .description(
      'Plan and preview removing third-party exchange supply from DSP line items, keeping Amazon owned ' +
        'inventory and Amazon Publisher Direct ("Amazon O&O + Publisher Direct only"). Writes the ' +
        'dsp.delete_targets body to a file and runs its dry run; nothing changes until that is committed.',
    )
    .option('--advertiser-id <id>', 'DSP advertiser id that owns the line items')
    .option('--preset <name>', `supply preset (${SUPPLY_PRESETS.join(', ')})`, 'amazon-direct')
    .option('--out-dir <dir>', 'where to write the delete body files (default: <data dir>/dsp)')
    .option('--profile-id <id>', 'Ads profileId from `ads profiles`')
    .option('--legacy-seller-id <id>', 'exact per-marketplace seller record id')
    .option('--seller-id <id>', 'AmazonSellerID; pair with --marketplace when multi-marketplace')
    .option('--marketplace <m>', 'country code (US, UK, ...) or raw marketplaceId')
    .action(async (adGroupIds: string[], opts: SupplyCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const json = !!root.json;
      const startedAt = Date.now();
      try {
        if (!opts.advertiserId || !NUMERIC_ID.test(opts.advertiserId)) {
          return usage('--advertiser-id is required: the numeric DSP advertiser id.', json);
        }
        const bad = adGroupIds.find((id) => !NUMERIC_ID.test(id));
        if (bad !== undefined) return usage(`line item id "${bad}" is not a numeric DSP ad group id.`, json);
        if (!SUPPLY_PRESETS.includes(opts.preset as SupplyPreset)) {
          return usage(`--preset must be one of: ${SUPPLY_PRESETS.join(', ')}.`, json);
        }
        const selector = {
          profileId: opts.profileId,
          legacySellerId: opts.legacySellerId,
          sellerId: opts.sellerId,
          marketplace: opts.marketplace,
        };
        const call: SupplyCall = (input) => adsCall({ ...input, ...selector }, { dataDirOverride: root.dataDir });
        const plan = await planSupplyPreset(call, opts.advertiserId, adGroupIds, opts.preset as SupplyPreset);
        if (isReportFailure(plan)) {
          await trackSupply('failed', startedAt, root.dataDir, { kind: plan.kind, stage: 'plan' });
          return emitFailure(plan, json);
        }

        const outDir = resolve(opts.outDir ?? join(resolveDataDir(root.dataDir), 'dsp'));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const previews: Array<{ bodyFile: string; items: number; auditId?: string; commit: string }> = [];
        if (plan.batches.length) await mkdir(outDir, { recursive: true });
        for (const [i, targetIds] of plan.batches.entries()) {
          const bodyFile = join(outDir, `supply-${opts.preset}-${opts.advertiserId}-${stamp}-${i + 1}.json`);
          await writeFile(bodyFile, JSON.stringify({ targetIds }, null, 2) + '\n', 'utf8');
          // The dry run, asked for explicitly: the service validates, snapshots
          // every target in the set and records an audit row; Amazon is not
          // called. An answer that is not a dry run stops the command loudly.
          const res = await adsCall(
            {
              operation: 'dsp.delete_targets',
              pathParams: { advertiserId: opts.advertiserId },
              body: { targetIds },
              dryRun: true,
              ...selector,
            },
            { dataDirOverride: root.dataDir },
          );
          if (isReportFailure(res)) {
            await trackSupply('failed', startedAt, root.dataDir, { kind: res.kind, stage: 'preview' });
            return emitFailure(res, json);
          }
          if (res.dryRun !== true) {
            await trackSupply('failed', startedAt, root.dataDir, { kind: 'not_a_dry_run', stage: 'preview' });
            const message =
              'The service did not answer the preview as a dry run. Stopped; check the line items with ' +
              '`mixshift dsp supply-preset` again (or dsp.query_targets) before doing anything else.' +
              (res.auditId ? ` audit: ${res.auditId}` : '');
            if (json) process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
            else process.stderr.write(`error: ${message}\n`);
            process.exitCode = 1;
            return;
          }
          previews.push({
            bodyFile,
            items: res.itemsCount ?? targetIds.length,
            ...(res.auditId ? { auditId: res.auditId } : {}),
            commit: commitCommand(selector, opts.advertiserId, bodyFile, res.auditId, root.dataDir),
          });
        }

        await trackSupply('ok', startedAt, root.dataDir, {
          preset: plan.preset,
          line_items: plan.lines.length,
          skipped: plan.lines.filter((l) => l.skipped).length,
          targets: plan.targetIds.length,
          batches: plan.batches.length,
          ...(opts.legacySellerId !== undefined ? { legacy_seller_id: opts.legacySellerId } : {}),
        });
        if (json) {
          process.stdout.write(JSON.stringify({ status: 'ok', ...plan, previews }, null, 2) + '\n');
          return;
        }
        process.stdout.write(renderSupplyPlan(plan) + '\n');
        for (const p of previews) {
          process.stdout.write(
            `\nDRY RUN dsp.delete_targets: ${p.items} target(s) validated, nothing removed.` +
              (p.auditId ? ` audit: ${p.auditId}` : '') +
              `\n  body: ${p.bodyFile}\n  After the user confirms, apply with:\n    ${p.commit}\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (json) process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
        else process.stderr.write(`error: ${message}\n`);
        process.exitCode = 1;
      }
    });
}

/**
 * Quote one argument so the same text pastes into bash and PowerShell:
 * single quotes are literal in both (no `$`, backslash or backtick expansion),
 * so Windows and UNC paths survive. A value holding a single quote cannot be
 * written once for both shells; it gets bash's form.
 */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function commitCommand(
  selector: { profileId?: string; legacySellerId?: string; sellerId?: string; marketplace?: string },
  advertiserId: string,
  bodyFile: string,
  auditId: string | undefined,
  dataDir?: string,
): string {
  const parts = ['mixshift'];
  // The commit must run under the same sign-in as the preview.
  if (dataDir) parts.push(`--data-dir ${shellQuote(resolve(dataDir))}`);
  parts.push('ads call dsp.delete_targets');
  if (selector.profileId) parts.push(`--profile-id ${shellQuote(selector.profileId)}`);
  if (selector.legacySellerId) parts.push(`--legacy-seller-id ${shellQuote(selector.legacySellerId)}`);
  if (selector.sellerId) parts.push(`--seller-id ${shellQuote(selector.sellerId)}`);
  if (selector.marketplace) parts.push(`--marketplace ${shellQuote(selector.marketplace)}`);
  parts.push(`--path advertiserId=${advertiserId}`, `--body-file ${shellQuote(bodyFile)}`, '--commit');
  if (auditId && /^[A-Za-z0-9_-]{1,128}$/.test(auditId)) parts.push(`--proposal-id ${auditId}`);
  return parts.join(' ');
}

async function trackSupply(
  outcome: 'ok' | 'failed',
  startedAt: number,
  dataDir: string | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  await track(
    {
      event_name: EventName.DspSupplyPresetPlanned,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(outcome === 'failed' && typeof payload.kind === 'string' ? { error_class: payload.kind } : {}),
      payload,
    },
    dataDir,
  );
}

function usage(message: string, json: boolean): void {
  if (json) process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
  else process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

async function trackReadiness(
  outcome: 'ok' | 'failed',
  startedAt: number,
  dataDir: string | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  await track(
    {
      event_name: EventName.DspReadinessChecked,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(outcome === 'failed' && typeof payload.kind === 'string' ? { error_class: payload.kind } : {}),
      payload,
    },
    dataDir,
  );
}

function emitFailure(failure: ReportFailure, json: boolean): void {
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          status: 'error',
          failure_kind: failure.kind,
          message: failure.friendly,
          detail: failure.message,
          http_status: failure.httpStatus,
          amazon_error_code: failure.amazonErrorCode,
          ...failureContractJson(failure),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.message) process.stderr.write(`  ${failure.message}\n`);
    for (const line of failureContractLines(failure)) process.stderr.write(`${line}\n`);
  }
  process.exitCode = exitCodeForKind(failure.kind);
}
