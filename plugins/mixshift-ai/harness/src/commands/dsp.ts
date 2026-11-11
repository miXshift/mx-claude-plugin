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
 *   dsp creative-map list|confirm|remove
 *       The plugin-local record of which responsive ecommerce creative each
 *       order is meant to carry (lib/ads/dsp-creative-map.ts), which `dsp
 *       readiness` checks every line item against. `confirm` records a
 *       console-built creative the user named (dry run unless --commit; it reads
 *       the order and the creative from Amazon first and refuses an id it cannot
 *       find). Nothing here writes to Amazon.
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
import {
  creativeMapForReadiness,
  creativeMapPath,
  loadCreativeMap,
  recordCreativeMappings,
  removeCreativeMapping,
  resolveMappingIdentity,
  scopedEntries,
  type CreativeMappingEntry,
} from '../lib/ads/dsp-creative-map.js';
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
        // The tenant's creative map, read locally; when it cannot be used every
        // responsive creative reads CONFIRM, never PASS.
        const creativeMap = await creativeMapForReadiness(root.dataDir);
        const result = await checkDspReadiness(call, opts.advertiserId, campaignId, { creativeMap });
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
          // Responsive creative identity: verdict counts and reason codes only,
          // never a creative, line item or order id.
          rec_identity: identityCounts(result.responsiveCreativeIdentity ?? []),
          creative_map: creativeMap.status,
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
  registerCreativeMap(dsp);
}

function identityCounts(results: Array<{ verdict: string; reason: string }>): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  return { ...counts, reasons: [...new Set(results.map((r) => r.reason))].sort() };
}

// ---------------------------------------------------------------------------
// dsp creative-map ...
// ---------------------------------------------------------------------------

interface CreativeMapCliOptions extends ReadinessCliOptions {
  creativeId?: string;
  reuse?: boolean;
  commit?: boolean;
}

function registerCreativeMap(dsp: Command): void {
  const map = dsp
    .command('creative-map')
    .description(
      'The record of which responsive ecommerce creative each DSP order is meant to carry, checked by ' +
        '`dsp readiness` on every line item. Kept on this machine for the signed-in tenant; never sent to Amazon.',
    );

  map
    .command('list')
    .description('List the recorded order -> responsive creative mappings for the signed-in tenant.')
    .option('--advertiser-id <id>', 'only this DSP advertiser')
    .option('--order <campaignId>', 'only this DSP order')
    .action(async (opts: { advertiserId?: string; order?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const json = !!root.json;
      try {
        if (opts.advertiserId !== undefined && !NUMERIC_ID.test(opts.advertiserId)) {
          return usage('--advertiser-id must be the numeric DSP advertiser id.', json);
        }
        if (opts.order !== undefined && !NUMERIC_ID.test(opts.order)) {
          return usage('--order must be the numeric DSP order (campaign) id.', json);
        }
        const who = await resolveMappingIdentity(root.dataDir);
        if (!who.ok) return usage(`No creative map can be read: ${who.reason}.`, json);
        const loaded = await loadCreativeMap(root.dataDir);
        if (!loaded.ok) return usage(loaded.reason, json);
        const rows = loaded.entries.filter(
          (e) =>
            e.tenant === who.identity.tenant &&
            (opts.advertiserId === undefined || e.advertiser_id === opts.advertiserId) &&
            (opts.order === undefined || e.order_id === opts.order),
        );
        if (json) {
          process.stdout.write(JSON.stringify({ status: 'ok', count: rows.length, entries: rows.map(publicEntry) }, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          rows.length
            ? rows.map(renderEntry).join('\n') + '\n'
            : 'No responsive creative is recorded for an order' +
                (opts.advertiserId ? ` on advertiser ${opts.advertiserId}` : '') +
                '. `dsp readiness` shows every responsive creative as unverified until one is.\n',
        );
      } catch (err) {
        fail(err, json);
      }
    });

  map
    .command('confirm <campaignId>')
    .description(
      'Record that a responsive ecommerce creative belongs to this order, after the user said so. Reads the ' +
        'order and the creative from Amazon first; a dry run unless --commit. Never infer the order from a ' +
        "creative's name, products, dates or attachments.",
    )
    .option('--advertiser-id <id>', 'DSP advertiser id that owns the order and the creative')
    .option('--creative-id <id>', 'the responsive ecommerce creative (adCreativeId / adId)')
    .option('--reuse', 'the creative is already recorded for another order and the user says it is shared on purpose')
    .option('--commit', 'write the record (only after the user confirmed the dry run)')
    .option('--profile-id <id>', 'Ads profileId from `ads profiles`')
    .option('--legacy-seller-id <id>', 'exact per-marketplace seller record id')
    .option('--seller-id <id>', 'AmazonSellerID; pair with --marketplace when multi-marketplace')
    .option('--marketplace <m>', 'country code (US, UK, ...) or raw marketplaceId')
    .action(async (campaignId: string, opts: CreativeMapCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const json = !!root.json;
      const startedAt = Date.now();
      try {
        const bad = idProblem(campaignId, opts);
        if (bad) return usage(bad, json);
        const advertiserId = opts.advertiserId as string;
        const creativeId = opts.creativeId as string;
        const who = await resolveMappingIdentity(root.dataDir);
        if (!who.ok) return usage(`Nothing can be recorded: ${who.reason}.`, json);
        if (who.identity.automation) {
          return usage(
            'A creative mapping records what a person confirmed; it cannot be written under a service credential. ' +
              'Sign in as a person (`mixshift auth login`) to confirm it.',
            json,
          );
        }
        const loaded = await loadCreativeMap(root.dataDir);
        if (!loaded.ok) return usage(loaded.reason, json);
        const mine = scopedEntries(loaded.entries, who.identity.tenant, advertiserId);
        const already = mine.find((e) => e.order_id === campaignId && e.creative_id === creativeId);
        const elsewhere = [...new Set(mine.filter((e) => e.creative_id === creativeId && e.order_id !== campaignId).map((e) => e.order_id))];
        if (elsewhere.length && !opts.reuse && !already) {
          return usage(
            `Creative ${creativeId} is already recorded for order ${elsewhere.join(', ')}. If the user says it is shared ` +
              `with order ${campaignId} on purpose, run this again with --reuse; otherwise ask which order it belongs to.`,
            json,
          );
        }

        // Read-only proof that both ids are real on this advertiser, before anything is recorded.
        const selector = {
          profileId: opts.profileId,
          legacySellerId: opts.legacySellerId,
          sellerId: opts.sellerId,
          marketplace: opts.marketplace,
        };
        const verified = await verifyOrderAndCreative(
          (input) => adsCall({ ...input, ...selector }, { dataDirOverride: root.dataDir }),
          advertiserId,
          campaignId,
          creativeId,
        );
        if (isReportFailure(verified)) {
          await trackCreativeMap('failed', startedAt, root.dataDir, { action: 'confirm', kind: verified.kind });
          return emitFailure(verified, json);
        }
        if (!verified.ok) {
          await trackCreativeMap('failed', startedAt, root.dataDir, { action: 'confirm', kind: verified.code });
          return usage(verified.message, json);
        }

        const entry: CreativeMappingEntry = {
          tenant: who.identity.tenant,
          advertiser_id: advertiserId,
          order_id: campaignId,
          creative_id: creativeId,
          source: 'user_confirmed',
          recorded_at: new Date().toISOString(),
          ...(who.identity.actor ? { recorded_by: who.identity.actor } : {}),
          ...(opts.reuse ? { reuse: true } : {}),
        };
        const plan =
          `order ${campaignId}${verified.orderName ? ` "${verified.orderName}"` : ''} -> responsive creative ${creativeId}` +
          `${verified.creativeName ? ` "${verified.creativeName}"` : ''}` +
          (verified.products.length ? `, products ${verified.products.slice(0, 5).join(', ')}${verified.products.length > 5 ? ', ...' : ''}` : '') +
          ` (advertiser ${advertiserId}${opts.reuse ? `; shared on purpose with order ${elsewhere.join(', ')}` : ''})`;

        if (already) {
          if (json) process.stdout.write(JSON.stringify({ status: 'ok', recorded: false, already: publicEntry(already) }, null, 2) + '\n');
          else process.stdout.write(`Already recorded: ${renderEntry(already)}\n`);
          return;
        }
        if (!opts.commit) {
          await trackCreativeMap('ok', startedAt, root.dataDir, { action: 'confirm', dry_run: true, reuse: !!opts.reuse });
          if (json) {
            process.stdout.write(JSON.stringify({ status: 'ok', dry_run: true, would_record: publicEntry(entry) }, null, 2) + '\n');
          } else {
            process.stdout.write(
              `DRY RUN: would record ${plan}.\nNothing was written. After the user confirms this is the order the ` +
                'creative was made for, run the same command with --commit.\n',
            );
          }
          return;
        }
        const res = await recordCreativeMappings([entry], root.dataDir);
        await trackCreativeMap('ok', startedAt, root.dataDir, {
          action: 'confirm',
          dry_run: false,
          added: res.added.length,
          reuse: !!opts.reuse,
        });
        if (json) {
          process.stdout.write(JSON.stringify({ status: 'ok', recorded: res.added.length > 0, entry: publicEntry(entry), file: creativeMapPath(root.dataDir) }, null, 2) + '\n');
        } else {
          process.stdout.write(`Recorded ${plan}.\n  ${creativeMapPath(root.dataDir)}\nRun \`mixshift dsp readiness ${campaignId} --advertiser-id ${advertiserId}\` to check its line items.\n`);
        }
      } catch (err) {
        fail(err, json);
      }
    });

  map
    .command('remove <campaignId>')
    .description('Remove one recorded order -> responsive creative mapping (a stale or wrong one). A dry run unless --commit.')
    .option('--advertiser-id <id>', 'DSP advertiser id')
    .option('--creative-id <id>', 'the recorded creative id')
    .option('--commit', 'remove the record (only after the user confirmed)')
    .action(async (campaignId: string, opts: CreativeMapCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const json = !!root.json;
      const startedAt = Date.now();
      try {
        const bad = idProblem(campaignId, opts);
        if (bad) return usage(bad, json);
        const who = await resolveMappingIdentity(root.dataDir);
        if (!who.ok) return usage(`Nothing can be removed: ${who.reason}.`, json);
        if (who.identity.automation) {
          return usage('A creative mapping is removed by a person, not under a service credential.', json);
        }
        const key = {
          tenant: who.identity.tenant,
          advertiser_id: opts.advertiserId as string,
          order_id: campaignId,
          creative_id: opts.creativeId as string,
        };
        const loaded = await loadCreativeMap(root.dataDir);
        if (!loaded.ok) return usage(loaded.reason, json);
        const found = loaded.entries.filter(
          (e) =>
            e.tenant === key.tenant &&
            e.advertiser_id === key.advertiser_id &&
            e.order_id === key.order_id &&
            e.creative_id === key.creative_id,
        );
        if (!found.length) {
          return usage(`No record of creative ${key.creative_id} for order ${campaignId} on advertiser ${key.advertiser_id}.`, json);
        }
        if (!opts.commit) {
          if (json) process.stdout.write(JSON.stringify({ status: 'ok', dry_run: true, would_remove: found.map(publicEntry) }, null, 2) + '\n');
          else process.stdout.write(`DRY RUN: would remove ${found.map(renderEntry).join('; ')}.\nNothing was changed; add --commit after the user confirms.\n`);
          return;
        }
        const removed = await removeCreativeMapping(key, root.dataDir);
        await trackCreativeMap('ok', startedAt, root.dataDir, { action: 'remove', removed: removed.length });
        if (json) process.stdout.write(JSON.stringify({ status: 'ok', removed: removed.map(publicEntry) }, null, 2) + '\n');
        else process.stdout.write(`Removed ${removed.map(renderEntry).join('; ')}.\n`);
      } catch (err) {
        fail(err, json);
      }
    });
}

function idProblem(campaignId: string, opts: CreativeMapCliOptions): string | undefined {
  if (!opts.advertiserId || !NUMERIC_ID.test(opts.advertiserId)) {
    return '--advertiser-id is required: the numeric DSP advertiser id.';
  }
  if (!NUMERIC_ID.test(campaignId)) return '<campaignId> must be the numeric DSP order (campaign) id.';
  if (!opts.creativeId || !NUMERIC_ID.test(opts.creativeId)) {
    return '--creative-id is required: the numeric id of the responsive ecommerce creative.';
  }
  return undefined;
}

/** The record as shown to the user: no tenant key. */
function publicEntry(e: CreativeMappingEntry): Record<string, unknown> {
  const { tenant: _tenant, ...rest } = e;
  return rest;
}

function renderEntry(e: CreativeMappingEntry): string {
  return (
    `advertiser ${e.advertiser_id} order ${e.order_id} -> creative ${e.creative_id} ` +
    `(${e.source === 'plugin_build' ? `MixShift build${e.audit_id ? `, audit ${e.audit_id}` : ''}` : 'confirmed by user'}` +
    `${e.reuse ? ', shared on purpose' : ''}, ${e.recorded_at.slice(0, 10)})`
  );
}

/**
 * Read-only: the order exists under the advertiser, and the creative exists
 * there and is a responsive ecommerce creative. Returns a ReportFailure when a
 * read itself fails (nothing is recorded then either).
 */
export async function verifyOrderAndCreative(
  call: ReadinessCall,
  advertiserId: string,
  campaignId: string,
  creativeId: string,
): Promise<
  | { ok: true; orderName?: string; creativeName?: string; products: string[] }
  | { ok: false; code: string; message: string }
  | ReportFailure
> {
  const path = { advertiserId };
  const dsp = { include: ['AMAZON_DSP'] };
  const camp = await call({
    operation: 'dsp.query_campaigns',
    pathParams: path,
    body: { adProductFilter: dsp, campaignIdFilter: { include: [campaignId] }, maxResults: 10 },
  });
  if (isReportFailure(camp)) return camp;
  const campaigns = (camp.payload as { campaigns?: unknown } | undefined)?.campaigns;
  const order = Array.isArray(campaigns)
    ? (campaigns as Array<Record<string, unknown>>).find((c) => String(c?.campaignId ?? '') === campaignId)
    : undefined;
  if (!order) {
    return { ok: false, code: 'order_not_found', message: `No DSP order ${campaignId} under advertiser ${advertiserId}; nothing was recorded.` };
  }
  const ads = await call({
    operation: 'dsp.query_ads',
    pathParams: path,
    body: { adProductFilter: dsp, adIdFilter: { include: [creativeId] }, maxResults: 10 },
  });
  if (isReportFailure(ads)) return ads;
  const rows = (ads.payload as { ads?: unknown } | undefined)?.ads;
  const ad = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown>>).find((a) => String(a?.adId ?? '') === creativeId)
    : undefined;
  if (!ad) {
    return {
      ok: false,
      code: 'creative_not_found',
      message: `Creative ${creativeId} was not found on advertiser ${advertiserId}; nothing was recorded.`,
    };
  }
  const settings = (((ad.creative as Record<string, unknown> | undefined)?.componentCreative as Record<string, unknown> | undefined)
    ?.responsiveEcommerceSettings ?? undefined) as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== 'object') {
    return {
      ok: false,
      code: 'not_responsive',
      message:
        `Creative ${creativeId} is not a responsive ecommerce creative (Amazon lists it as ${String(ad.adType ?? 'an unknown type')}); ` +
        'this record is only for responsive ecommerce creatives. Nothing was recorded.',
    };
  }
  const products = Array.isArray(settings.products)
    ? (settings.products as Array<Record<string, unknown>>).map((p) => String(p?.productId ?? '')).filter((x) => x.length > 0)
    : [];
  return {
    ok: true,
    ...(typeof order.name === 'string' && order.name ? { orderName: order.name } : {}),
    ...(typeof ad.name === 'string' && ad.name ? { creativeName: ad.name } : {}),
    products,
  };
}

async function trackCreativeMap(
  outcome: 'ok' | 'failed',
  startedAt: number,
  dataDir: string | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  await track(
    {
      event_name: EventName.DspCreativeMapChanged,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(outcome === 'failed' && typeof payload.kind === 'string' ? { error_class: payload.kind } : {}),
      payload,
    },
    dataDir,
  );
}

function fail(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
  else process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
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
            commit: commitCommand(
              selector,
              opts.advertiserId,
              bodyFile,
              res.auditId,
              // The same sign-in as this preview, also when it came from the
              // environment rather than the flag.
              root.dataDir ?? process.env.MIXSHIFT_DATA_DIR,
            ),
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
