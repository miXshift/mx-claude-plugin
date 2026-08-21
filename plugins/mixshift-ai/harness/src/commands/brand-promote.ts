/**
 * `mixshift brand promote --seller-id <AmazonSellerID>` and `mixshift brand
 * demote <slug>` — sub-brand PROMOTION / DEMOTION (mx-ops#6 P2;
 * docs/subbrand-architecture.md §4.2, §5, §5.1 in mx-legacy-auth).
 *
 * PROPOSE-ONLY BY DEFAULT (design doc §5: "auto-publish-on-write is LIVE, so
 * a botched promotion would publish to the org store; every step must be
 * confirmable and idempotent"):
 *   - `brand promote --seller-id <id>` with NO `--apply` NEVER writes — it
 *     always renders the promotion plan (dry-run is the default, not an
 *     opt-in flag).
 *   - `brand demote <slug>` with NO `--apply` NEVER writes — it renders a
 *     preview of what demoting would do.
 *   - `--apply` executes exactly ONE decision at a time (promote) or the one
 *     demotion action (demote) — never a batch commit. See lib/binding/
 *     promote.ts / demote.ts for the write-side contract.
 *
 * The first live promotions on a real customer account require ops sign-off
 * (build brief's Sam-gate) — `FIRST_LIVE_PROMOTION_NOTICE` says so in every
 * plan the command renders, not just in the design doc.
 */

import type { Command } from 'commander';
import { discoverSellers } from '../lib/discovery/seller-query.js';
import {
  fetchLabelDiscovery,
  assembleCoverageReport,
  classifyFetchOutcome,
  type CoverageReport,
  type FetchOutcome,
} from '../lib/binding/discovery.js';
import {
  buildPromotionPlan,
  applyPromotionDecision,
  FIRST_LIVE_PROMOTION_NOTICE,
  type PromotionDecision,
  type PromotionPlan,
  type PromotionPlanItem,
  type OldBrandPlan,
} from '../lib/binding/promote.js';
import { assembleEconomics, fmtMoney } from '../lib/binding/economics.js';
import { previewDemotion, applyDemotion, type DemotionPreview } from '../lib/binding/demote.js';
import { emitCoverageStake } from '../lib/binding/stake.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandPromoteCommands(brand: Command): void {
  brand
    .command('promote')
    .description(
      'Build a promotion plan: turn discovered sub-brand labels into real, ' +
        'bound brands. Default is a DRY-RUN plan; nothing is written. Pass ' +
        '--apply <decision-json> to execute ONE plan item at a time.',
    )
    .requiredOption('--seller-id <id>', 'the Amazon Seller ID to promote sub-brands for')
    .option(
      '--apply <decision>',
      'apply ONE decision from the plan (JSON). Schema: ' +
        '{"action":"promote_label","label":"..."} | {"action":"retire_old_brand"} | ' +
        '{"action":"rebind_old_brand","label":"..."} | {"action":"cancel"}.',
    )
    .action(async (opts: { sellerId: string; apply?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const t0 = Date.now();
      try {
        const prepared = await preparePlan(opts.sellerId, root.dataDir);

        if (prepared.fetchOutcome !== 'ok') {
          await track(
            {
              event_name: EventName.BrandSubbrandPromoted,
              outcome: 'failed',
              duration_ms: Date.now() - t0,
              error_class: 'discovery_incomplete',
              payload: { discovery_status: prepared.fetchOutcome },
            },
            root.dataDir,
          );
          process.exitCode = 1;
          const message =
            'Discovery did not fully succeed, so no promotion plan was built from partial or ' +
            `missing data. Run \`mixshift brand discover --seller-id ${opts.sellerId}\` to see ` +
            'the underlying error.';
          if (root.json) {
            process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
          } else {
            process.stderr.write(`\n${message}\n\n`);
          }
          return;
        }

        const { plan, report, sellerName, resolvedSellerIds } = prepared;

        if (!opts.apply) {
          await track(
            {
              event_name: EventName.BrandSubbrandPromoted,
              outcome: 'ok',
              duration_ms: Date.now() - t0,
              payload: {
                mode: 'dry_run',
                item_count: plan.items.length,
                would_create_count: plan.items.filter((i) => i.status === 'would_create').length,
                old_brand_present: plan.old_brand !== null,
              },
            },
            root.dataDir,
          );
          if (root.json) {
            process.stdout.write(JSON.stringify({ status: 'ok', mode: 'dry_run', plan }, null, 2) + '\n');
          } else {
            process.stdout.write(renderPlan(plan));
          }
          return;
        }

        let decision: PromotionDecision;
        try {
          decision = JSON.parse(opts.apply) as PromotionDecision;
        } catch (err) {
          return emitError(root.json, `--apply must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }

        const result = await applyPromotionDecision(plan, decision, {
          dataDirOverride: root.dataDir,
          sellerName,
          resolvedSellerIds,
        });

        // Coverage stake re-emit after a successful write (design brief:
        // "after a successful promotion, emit the coverage stake to the
        // account namespace; reuse the P1 stake module"). Best-effort — a
        // stake failure never demotes the promotion result, same discipline
        // as `brand discover --seller-id --emit-stake`. Reuses the SAME
        // CoverageReport already fetched for the plan rather than re-fetching
        // (warehouse counts are unaffected by writing a context.yaml binding
        // elsewhere); the idempotency key is scoped to today's UTC date, so
        // multiple promotions applied in the same run/day converge to one
        // stake, never one per item.
        let stakeNote = '';
        if (result.status === 'ok' && result.did_write) {
          try {
            const stake = await emitCoverageStake(report, { dataDirOverride: root.dataDir });
            stakeNote = stake.ok
              ? ` Coverage stake ${stake.outcome} on ${stake.brand_slug}.`
              : ` (Coverage stake not recorded: ${stake.detail})`;
          } catch {
            // never block the promotion result on a stake failure
          }
        }

        await track(
          {
            event_name: EventName.BrandSubbrandPromoted,
            outcome: result.status === 'ok' ? 'ok' : 'failed',
            duration_ms: Date.now() - t0,
            ...(result.status !== 'ok' ? { error_class: result.status } : {}),
            payload: { mode: 'apply', status: result.status, did_write: result.did_write },
          },
          root.dataDir,
        );

        if (result.status === 'validation_failed') process.exitCode = 4;

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              {
                status: result.status,
                detail: result.detail,
                slug: result.slug ?? null,
                did_write: result.did_write,
                validation_issues: result.validation_issues,
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }

        const icon = result.status === 'ok' ? '✓' : result.status === 'cancelled' ? '•' : '✗';
        process.stdout.write(`\n${icon} ${result.detail}${stakeNote}\n\n`);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return emitError(root.json, message);
      }
    });

  brand
    .command('demote <slug>')
    .description(
      'Reverse a sub-brand promotion: unset its binding and park its local ' +
        'directory. Default is a preview; nothing is written. Pass --apply ' +
        'to execute. Org-store revision history is never deleted by this ' +
        'command; a hard delete stays a manual, ops-gated operation.',
    )
    .option('--apply', 'execute the demotion (default is preview-only)', false)
    .action(async (slug: string, opts: { apply: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const t0 = Date.now();
      try {
        if (!opts.apply) {
          const preview = await previewDemotion(slug, root.dataDir);
          await track(
            {
              event_name: EventName.BrandSubbrandDemoted,
              outcome: 'ok',
              duration_ms: Date.now() - t0,
              payload: { mode: 'preview', is_sub_brand: preview.is_sub_brand },
            },
            root.dataDir,
          );
          if (root.json) {
            process.stdout.write(JSON.stringify({ status: 'ok', mode: 'preview', preview }, null, 2) + '\n');
          } else {
            process.stdout.write(renderDemotionPreview(preview));
          }
          return;
        }

        const result = await applyDemotion(slug, root.dataDir);
        await track(
          {
            event_name: EventName.BrandSubbrandDemoted,
            outcome: result.status === 'ok' ? 'ok' : 'failed',
            duration_ms: Date.now() - t0,
            ...(result.status !== 'ok' ? { error_class: result.status } : {}),
            payload: { mode: 'apply', status: result.status, did_write: result.did_write },
          },
          root.dataDir,
        );

        if (result.status === 'not_a_sub_brand') process.exitCode = 4;
        if (result.status === 'error') process.exitCode = 1;

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              {
                status: result.status,
                detail: result.detail,
                did_write: result.did_write,
                parked_dir: result.parked_dir ?? null,
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }
        const icon = result.status === 'ok' ? '✓' : '✗';
        process.stdout.write(`\n${icon} ${result.detail}\n\n`);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return emitError(root.json, message);
      }
    });
}

// ---------------------------------------------------------------------------
// Plan preparation
// ---------------------------------------------------------------------------

interface PreparedPlan {
  plan: PromotionPlan;
  report: CoverageReport;
  sellerName: string;
  resolvedSellerIds: number[];
  fetchOutcome: FetchOutcome;
}

async function preparePlan(sellerId: string, dataDir: string | undefined): Promise<PreparedPlan> {
  const fetched = await fetchLabelDiscovery(sellerId, { dataDirOverride: dataDir });
  const fetchOutcome = classifyFetchOutcome(fetched);
  const report = assembleCoverageReport({
    sellerId,
    retailRows: fetched.retailRows,
    vendorRows: fetched.vendorRows,
    adsRows: fetched.adsRows,
    matchRows: fetched.matchRows,
  });

  if (fetchOutcome !== 'ok') {
    return {
      plan: emptyPlan(sellerId),
      report,
      sellerName: sellerId,
      resolvedSellerIds: fetched.resolvedSellerIds,
      fetchOutcome,
    };
  }

  const sellers = await discoverSellers({ dataDirOverride: dataDir, includeInactive: true });
  const accounts = sellers.filter((s) => fetched.resolvedSellerIds.includes(s.seller_id));
  const sellerName = accounts[0]?.seller_name ?? sellerId;

  const economics = assembleEconomics({
    retailEconRows: fetched.retailEconRows,
    adsEconRows: fetched.adsEconRows,
    vendorEconRows: fetched.vendorEconRows,
  });

  const plan = await buildPromotionPlan(report, fetched.resolvedSellerIds, sellerName, {
    dataDirOverride: dataDir,
    economics,
  });

  return { plan, report, sellerName, resolvedSellerIds: fetched.resolvedSellerIds, fetchOutcome };
}

function emptyPlan(sellerId: string): PromotionPlan {
  return {
    seller_id: sellerId,
    generated_at: new Date().toISOString(),
    items: [],
    old_brand: null,
    additional_unbound_brands: [],
    notice: FIRST_LIVE_PROMOTION_NOTICE,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPlan(plan: PromotionPlan): string {
  const lines: string[] = [];
  lines.push(`\nPromotion plan for seller ${plan.seller_id}`);
  lines.push(`Generated: ${plan.generated_at}`);
  lines.push('');
  lines.push(plan.notice);
  lines.push('');

  if (plan.items.length === 0) {
    lines.push('No label carries meaningful retail mass yet; nothing to promote.');
  } else {
    // NOT "above the meaningful-mass gate": candidacy is the UNION of catalog
    // mass and economic share, so this list deliberately includes labels that
    // fail the mass gate and qualified on money instead. Claiming otherwise
    // made `brand discover` and `brand promote` contradict each other on the
    // same account ("exactly one label with meaningful mass" vs "2 label(s)
    // above the meaningful-mass gate").
    lines.push(`${plan.items.length} label(s) worth considering, by catalog mass or by revenue:`);
    for (const item of plan.items) {
      lines.push(renderPlanItem(item));
    }
  }
  lines.push('');

  if (plan.old_brand) {
    lines.push(renderOldBrand(plan.old_brand));
    lines.push('');
  }

  if (plan.additional_unbound_brands.length > 0) {
    lines.push(
      `⚠ Additional un-bound local brand(s) also reference this seller account: ` +
        `${plan.additional_unbound_brands.join(', ')}. Review by hand before promoting.`,
    );
    lines.push('');
  }

  lines.push(
    'Apply ONE item at a time, e.g.:\n' +
      `  mixshift brand promote --seller-id ${plan.seller_id} --apply '{"action":"promote_label","label":"<label>"}'`,
  );
  lines.push('');
  return lines.join('\n');
}

function renderPlanItem(item: PromotionPlanItem): string {
  let base: string;
  if (item.status === 'already_bound') {
    base = `  ✓ "${item.label}": already bound to "${item.existing_slug}" (no action needed)`;
  } else if (item.status === 'flagged') {
    // Shown, never hidden — the operator sees the whole account and decides.
    // Promoting it is still possible, just no longer the default.
    const headline =
      item.flag_reason === 'dormant' ? 'looks wound down' : 'too small to be worth its own brand';
    base = `  ! "${item.label}": ${headline} — NOT proposed (would be "${item.proposed_slug}")`;
  } else {
    base = `  + "${item.label}": would create "${item.proposed_slug}"`;
  }
  const money =
    item.economic_weight > 0
      ? `      trailing 365d: ${fmtMoney(item.revenue_365d)} revenue, ${fmtMoney(item.spend_365d)} ad spend`
      : '      trailing 365d: no revenue or ad spend found';
  // "no campaigns yet" under a non-zero ad-spend figure is not an edge case:
  // the coverage query counts only enabled/paused campaigns while the
  // economics query deliberately does not filter State (money spent by a
  // since-archived campaign was still spent). So has_ads === false alongside
  // spend > 0 is the DEFINING signature of a wound-down brand — the flagship
  // case this feature serves — and "yet" reads as "never had any", which is
  // the opposite of what happened.
  const adsDetail = item.has_ads
    ? `${item.ads_campaign_count} campaign(s)`
    : item.spend_365d > 0
      ? 'no live campaigns (the spend above is historical)'
      : 'no campaigns yet';
  const detail = `      retail: ${item.retail_units} unit(s) [${item.retail_source ?? 'n/a'}]; ads: ${adsDetail}`;
  const lines = [base, money, detail];
  if (item.status === 'flagged') {
    lines.push(`      why: ${item.flag_detail ?? item.lifecycle_reason}`);
    lines.push('      promote it anyway with --apply if that is wrong.');
  }
  return lines.join('\n');
}

function renderOldBrand(oldBrand: OldBrandPlan): string {
  const lines: string[] = [];
  lines.push(`Existing whole-account brand: "${oldBrand.display_name}" (slug: ${oldBrand.slug})`);
  lines.push(
    oldBrand.proposed_disposition === 'rebind_as_dominant'
      ? `  Proposed disposition: re-bind as the dominant sub-brand for "${oldBrand.dominant_label}"`
      : '  Proposed disposition: retire (park the local directory)',
  );
  lines.push(`  Rationale: ${oldBrand.rationale}`);
  if (oldBrand.triage.length > 0) {
    lines.push(`  Content triage proposal (${oldBrand.triage.length} item(s), edit before applying anything):`);
    for (const t of oldBrand.triage) {
      const target = t.proposed_target_slug ? ` -> ${t.proposed_target_slug}` : '';
      lines.push(`    - ${t.section}: ${t.proposed_disposition}${target} (${t.summary})`);
    }
  }
  return lines.join('\n');
}

function renderDemotionPreview(preview: DemotionPreview): string {
  const lines: string[] = [];
  lines.push(`\nDemotion preview for "${preview.slug}"`);
  lines.push('');
  if (!preview.is_sub_brand) {
    lines.push(`"${preview.slug}" has no binding; it is not a promoted sub-brand. Nothing to demote.`);
  } else {
    lines.push(`Current binding: ${preview.binding_summary}`);
    lines.push(`Would unset the binding and park the local directory to "${preview.would_park_to}".`);
  }
  lines.push('');
  lines.push(preview.note);
  lines.push('');
  return lines.join('\n');
}

function emitError(json: boolean | undefined, message: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}
