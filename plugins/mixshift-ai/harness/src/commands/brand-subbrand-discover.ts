/**
 * `mixshift brand discover --seller-id <AmazonSellerID>` — sub-brand LABEL
 * discovery (mx-ops#6 P1; docs/subbrand-architecture.md §4.1 in
 * mx-legacy-auth).
 *
 * Distinct from the seller-id-LESS `brand discover` (registered in
 * commands/brand.ts), which discovers ACCOUNTS this tenant has warehouse
 * access to. This surface answers a different question for ONE already-known
 * Amazon seller account: what sub-brand labels live inside it, and does the
 * evidence look like one brand or several. It never mutates
 * `~/.mixshift/clients/index.yaml` and never creates a brand — that is the
 * promotion flow (Phase 2).
 *
 * CONTRACT NOTE: the underlying sbd-01..04 named queries may not be deployed
 * yet (see lib/binding/discovery.ts). A partial/`unknown_query` failure is
 * reported per side rather than crashing the command.
 */

import type { Command } from 'commander';
import { fetchLabelDiscovery, assembleCoverageReport } from '../lib/binding/discovery.js';
import type { CoverageReport, LabelDiscoveryFetchResult } from '../lib/binding/discovery.js';
import { emitCoverageStake, type EmitCoverageStakeResult } from '../lib/binding/stake.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export interface SubbrandDiscoverCliOptions {
  sellerId: string;
  emitStake?: boolean;
}

/**
 * The seller-id branch of `mixshift brand discover`. Called from
 * commands/brand.ts's `discover` action when `--seller-id` is present,
 * BEFORE any of that command's normal (account-discovery) logic runs.
 */
export async function runSubbrandDiscovery(
  opts: SubbrandDiscoverCliOptions,
  cmd: Command,
): Promise<void> {
  const root = cmd.optsWithGlobals<RootOptions>();
  const t0 = Date.now();
  try {
    const fetched = await fetchLabelDiscovery(opts.sellerId, {
      dataDirOverride: root.dataDir,
    });
    const report = assembleCoverageReport({
      sellerId: opts.sellerId,
      retailRows: fetched.retailRows,
      vendorRows: fetched.vendorRows,
      adsRows: fetched.adsRows,
      matchRows: fetched.matchRows,
    });

    let stake: EmitCoverageStakeResult | undefined;
    if (opts.emitStake) {
      stake = await emitCoverageStake(report, { dataDirOverride: root.dataDir });
    }

    await track(
      {
        event_name: EventName.BrandSubbrandDiscovered,
        outcome: fetched.ok ? 'ok' : 'failed',
        duration_ms: Date.now() - t0,
        ...(fetched.ok ? {} : { error_class: 'partial_query_failure' }),
        payload: {
          retail_distinct_labels: report.retail.distinct_labels,
          ads_distinct_labels: report.ads.distinct_labels,
          match_rate: report.match.match_rate,
          classification_proposal: report.classification.proposal,
          query_errors: fetched.errors.map((e) => e.query_id),
          emit_stake: opts.emitStake ?? false,
          ...(stake ? { stake_outcome: stake.ok ? stake.outcome : 'failed' } : {}),
        },
      },
      root.dataDir,
    );

    if (root.json) {
      process.stdout.write(
        JSON.stringify(
          {
            status: 'ok',
            report,
            query_errors: fetched.errors,
            ...(stake ? { stake } : {}),
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    process.stdout.write(renderCoverageReport(report, fetched, stake));
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (root.json) {
      process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
    } else {
      process.stderr.write(`error: ${message}\n`);
    }
    process.exitCode = 1;
    return;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderCoverageReport(
  report: CoverageReport,
  fetched: LabelDiscoveryFetchResult,
  stake?: EmitCoverageStakeResult,
): string {
  const lines: string[] = [];
  lines.push(`\nSub-brand label coverage for seller ${report.seller_id}`);
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');

  if (!fetched.ok) {
    lines.push('⚠ Some discovery queries did not return results:');
    for (const e of fetched.errors) {
      lines.push(`  - ${e.query_id}: ${e.friendly}`);
    }
    lines.push(
      '  (If this says "unknown query", the gateway side of this feature ' +
        'may not be deployed yet — this is expected ahead of that release.)',
    );
    lines.push('');
  }

  lines.push(renderSide('RETAIL', report.retail));
  lines.push('');
  lines.push(renderSide('ADS', report.ads));
  lines.push('');
  lines.push(
    `Cross-side match: ${report.match.matched}/${report.match.distinct_labels_considered} ` +
      `label(s) appear on both sides` +
      (report.match.match_rate !== null
        ? ` (${(report.match.match_rate * 100).toFixed(0)}%).`
        : '.') +
      ` ${report.match.retail_only} retail-only, ${report.match.ads_only} ads-only.`,
  );
  lines.push('');
  lines.push(`Shape proposal: ${report.classification.proposal} (UNCONFIRMED — you decide)`);
  for (const e of report.classification.evidence) lines.push(`  - ${e}`);
  lines.push('');
  lines.push(
    'This is a proposal only. "(unclassified)" rows are never a sub-brand ' +
      'candidate. Nothing was created — promoting a label to a real brand ' +
      'is a separate step.',
  );

  if (stake) {
    lines.push('');
    lines.push(
      stake.ok
        ? `✓ Coverage stake ${stake.outcome} on ${stake.brand_slug} (timeline event ${stake.event_id}).`
        : `⚠ Coverage stake NOT recorded on ${stake.brand_slug}: ${stake.detail}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderSide(
  label: string,
  side: CoverageReport['retail'] | CoverageReport['ads'],
): string {
  const lines: string[] = [];
  lines.push(
    `${label}: ${side.distinct_labels} distinct label(s), ` +
      `${(side.unclassified_share * 100).toFixed(0)}% of units unclassified ` +
      `(${side.total_units} total units).`,
  );
  const top = side.labels.slice(0, 5);
  for (const l of top) {
    lines.push(`  - ${l.label}: ${l.units} unit(s)  [${l.source}]`);
  }
  if (side.labels.length > top.length) {
    lines.push(`  ... and ${side.labels.length - top.length} more`);
  }
  return lines.join('\n');
}
