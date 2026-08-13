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
 *
 * FAIL-LOUD CONTRACT (FINDING 1, red team over PR #131): a query/resolution
 * failure must never look like a real "single brand" answer, and must never
 * silently succeed on exit code or JSON `status`.
 *   - JSON `status`: 'ok' only when `fetched.ok`; 'error' when the seller-id
 *     resolution step failed or ALL FOUR sbd-* queries failed (nothing real
 *     to classify from); 'partial' when some but not all of the four failed
 *     (a real, incomplete report).
 *   - `process.exitCode = 1` on 'error' (matches the sibling `commands/
 *     brand.ts` convention for its own error paths).
 *   - On 'error', the classification is replaced with `proposal: null` +
 *     a reason (see `insufficientDataClassification` in discovery.ts) —
 *     never a heuristic result computed from all-empty rows.
 *   - `--emit-stake` is skipped, loudly, unless `fetched.ok` — never posts a
 *     stake built from a partial or failed run (which would also occupy
 *     that UTC day's idempotency key and block a corrected same-day re-run).
 */

import type { Command } from 'commander';
import {
  fetchLabelDiscovery,
  assembleCoverageReport,
  classifyFetchOutcome,
  insufficientDataClassification,
  type CoverageReport,
  type LabelDiscoveryFetchResult,
} from '../lib/binding/discovery.js';
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

/** Human-facing reason for a null classification — the CLI's own framing of
 *  `classifyFetchOutcome`'s 'error' case, distinct from the per-query error
 *  list (which is reported separately either way). */
function insufficientDataReason(
  fetched: LabelDiscoveryFetchResult,
  amazonSellerId: string,
): string {
  const sellerResolutionFailed = fetched.errors.some((e) => e.query_id === 'resolve_seller_ids');
  if (sellerResolutionFailed) {
    return (
      `Could not resolve Amazon Seller ID "${amazonSellerId}" to a warehouse account ` +
      'in this tenant, so no labels could be read.'
    );
  }
  return 'All four discovery queries failed, so no labels could be read.';
}

const STAKE_SKIPPED_REASON =
  'Skipped --emit-stake: discovery did not fully succeed, so no coverage stake was posted. ' +
  "Posting a wrong or partial snapshot would occupy today's idempotency key and block a " +
  'corrected re-run later today.';

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
    const fetchOutcome = classifyFetchOutcome(fetched);

    let report = assembleCoverageReport({
      sellerId: opts.sellerId,
      retailRows: fetched.retailRows,
      vendorRows: fetched.vendorRows,
      adsRows: fetched.adsRows,
      matchRows: fetched.matchRows,
    });
    if (fetchOutcome === 'error') {
      // No real rows exist to classify from (nothing queried, or every
      // query failed) — an all-empty report would otherwise collapse to a
      // heuristic "single_brand" that looks like a real answer.
      report = {
        ...report,
        classification: insufficientDataClassification(
          insufficientDataReason(fetched, opts.sellerId),
        ),
      };
    }

    let stake: EmitCoverageStakeResult | undefined;
    let stakeSkippedReason: string | undefined;
    if (opts.emitStake) {
      if (fetched.ok) {
        stake = await emitCoverageStake(report, { dataDirOverride: root.dataDir });
      } else {
        stakeSkippedReason = STAKE_SKIPPED_REASON;
      }
    }

    await track(
      {
        event_name: EventName.BrandSubbrandDiscovered,
        outcome: fetched.ok ? 'ok' : 'failed',
        duration_ms: Date.now() - t0,
        ...(fetched.ok ? {} : { error_class: 'partial_query_failure' }),
        payload: {
          discovery_status: fetchOutcome,
          retail_distinct_labels: report.retail.distinct_labels,
          ads_distinct_labels: report.ads.distinct_labels,
          match_rate: report.match.match_rate,
          classification_proposal: report.classification.proposal,
          query_errors: fetched.errors.map((e) => e.query_id),
          emit_stake: opts.emitStake ?? false,
          ...(stake ? { stake_outcome: stake.ok ? stake.outcome : 'failed' } : {}),
          ...(stakeSkippedReason ? { stake_skipped: true } : {}),
        },
      },
      root.dataDir,
    );

    if (fetchOutcome === 'error') {
      process.exitCode = 1;
    }

    if (root.json) {
      process.stdout.write(
        JSON.stringify(
          {
            status: fetchOutcome, // 'ok' | 'partial' | 'error' — never 'ok' unless fetched.ok
            report,
            resolved_seller_ids: fetched.resolvedSellerIds,
            query_errors: fetched.errors,
            ...(stake ? { stake } : {}),
            ...(stakeSkippedReason ? { stake_skipped: true, stake_skip_reason: stakeSkippedReason } : {}),
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    process.stdout.write(
      renderCoverageReport(report, fetched, fetchOutcome, { stake, skippedReason: stakeSkippedReason }),
    );
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

export interface StakeRenderInfo {
  stake?: EmitCoverageStakeResult;
  skippedReason?: string;
}

export function renderCoverageReport(
  report: CoverageReport,
  fetched: LabelDiscoveryFetchResult,
  fetchOutcome: 'ok' | 'partial' | 'error',
  stakeInfo: StakeRenderInfo = {},
): string {
  const lines: string[] = [];
  lines.push(`\nSub-brand label coverage for seller ${report.seller_id}`);
  lines.push(`Generated: ${report.generated_at}`);
  if (fetched.resolvedSellerIds.length > 0) {
    lines.push(`Resolved warehouse seller_id(s): ${fetched.resolvedSellerIds.join(', ')}`);
  }
  lines.push('');

  if (fetchOutcome !== 'ok') {
    lines.push(
      fetchOutcome === 'error'
        ? '✗ Discovery FAILED — no usable data:'
        : '⚠ Some discovery queries did not return results (report below is real but incomplete):',
    );
    for (const e of fetched.errors) {
      lines.push(`  - ${e.query_id}: ${e.friendly}`);
    }
    lines.push(
      '  (If this says "unknown query", the gateway side of this feature ' +
        'may not be deployed yet — this is expected ahead of that release. ' +
        'If this says no seller was found, check the seller ID and that ' +
        'this account has been activated in your MixShift warehouse.)',
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
  lines.push(
    report.classification.proposal === null
      ? 'Shape proposal: NOT AVAILABLE (insufficient data — see the failure above)'
      : `Shape proposal: ${report.classification.proposal} (UNCONFIRMED — you decide)`,
  );
  for (const e of report.classification.evidence) lines.push(`  - ${e}`);
  lines.push('');
  lines.push(
    'This is a proposal only. "(unclassified)" rows are never a sub-brand ' +
      'candidate. Nothing was created — promoting a label to a real brand ' +
      'is a separate step.',
  );

  if (stakeInfo.stake) {
    lines.push('');
    lines.push(
      stakeInfo.stake.ok
        ? `✓ Coverage stake ${stakeInfo.stake.outcome} on ${stakeInfo.stake.brand_slug} (timeline event ${stakeInfo.stake.event_id}).`
        : `⚠ Coverage stake NOT recorded on ${stakeInfo.stake.brand_slug}: ${stakeInfo.stake.detail}`,
    );
  } else if (stakeInfo.skippedReason) {
    lines.push('');
    lines.push(`⚠ ${stakeInfo.skippedReason}`);
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
