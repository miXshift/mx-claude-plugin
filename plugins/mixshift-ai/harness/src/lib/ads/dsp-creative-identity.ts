/**
 * Per-line-item responsive creative identity: is the responsive ecommerce
 * creative (REC) on this DSP line item the one recorded for its own order?
 *
 * Pure: `dsp readiness` does the reads (associations including inactive ones,
 * moderation, creative details from dsp.query_ads) and hands them here with the
 * tenant's creative map (lib/ads/dsp-creative-map.ts). Verdicts:
 *
 *   PASS      a recorded mapping exists for the order and its creative is
 *             attached (attachment active), with no other REC beside it.
 *   FAIL      an attached creative is recorded for a different order (proven
 *             mismatch, any attachment state), or the order's recorded creative
 *             is not attached to the line item (missing, or gone from the
 *             advertiser: a stale mapping).
 *   CONFIRM   a REC is attached whose origin nobody recorded ("responsive
 *             creative attached, originating order unverified"), also when it
 *             sits beside the expected one, or a creative's type could not be
 *             told.
 *   WARN      the expected creative is attached but its attachment is not
 *             active (it does not serve until switched on).
 *   UNCHECKED a read this verdict needs failed or stopped early. Never PASS.
 *
 * What it never does: decide where a creative came from by its name, its
 * ASINs, its dates, whether it is eligible, or where it is attached. Two orders
 * can feature the same products, and tracked products need not equal featured
 * products, so a product difference is a separate WARN, never a FAIL.
 *
 * Moderation and the attachment's active state are judged by the existing
 * `creative` check; this check only adds identity, so the two stay independent.
 */

import type { ReadinessCheck, ReadinessLevel } from './dsp-readiness.js';
import { scopedEntries, type CreativeMapInput, type CreativeMappingEntry } from './dsp-creative-map.js';

export type IdentityVerdict = ReadinessLevel | 'not_applicable';

/** One creative attached to a line item, as the association and moderation reads saw it. */
export interface AttachedCreative {
  creativeId: string;
  /** Association state (ACTIVE / INACTIVE), when Amazon gave one. */
  state?: string;
  /** Ad experiences from the moderation row or the association (RESPONSIVE_ECOMMERCE marks a REC). */
  experiences: string[];
}

/** A creative as dsp.query_ads describes it. */
export interface CreativeDetail {
  creativeId: string;
  name?: string;
  adType?: string;
  /** True when creative.componentCreative.responsiveEcommerceSettings is present. */
  responsive: boolean;
  /** Featured products (ASINs) of a REC. */
  products: string[];
}

export type Read<T> = { ok: true; value: T; truncated: boolean } | { ok: false; error: string };

export interface IdentityInput {
  advertiserId: string;
  orderId: string;
  lineItems: Array<{ adGroupId: string; name?: string; inventoryType?: string }>;
  creativeMap: CreativeMapInput;
  /** Attachments per line item id, every state. */
  attachments: Read<Map<string, AttachedCreative[]>>;
  /** Creative details by id; undefined when nothing needed reading. */
  details?: Read<Map<string, CreativeDetail>>;
  /** The order's tracked products, only when the read was complete. */
  trackedAsins?: string[];
}

export type AttachedRole = 'expected' | 'other_order' | 'unmatched_rec' | 'unknown_type' | 'non_rec';

export interface IdentityResult {
  adGroupId: string;
  orderId: string;
  verdict: IdentityVerdict;
  /** Stable reason code, e.g. expected_attached, other_order_attached, expected_missing. */
  reason: string;
  /** The order's recorded creative ids (empty without a mapping). */
  expectedCreativeIds: string[];
  /** Every creative attached to the line item, any state. */
  attachedCreativeIds: string[];
  /** The attached creatives that matter to identity, with what is known about each. */
  creatives: Array<{
    creativeId: string;
    role: AttachedRole;
    state?: string;
    name?: string;
    products?: string[];
    /** Orders this tenant + advertiser recorded the creative for. */
    recordedForOrders: string[];
  }>;
  /** Where the expectation came from: plugin_build, user_confirmed, both, none, or unavailable. */
  evidenceSource: string;
  detail: string;
  fix?: string;
}

/** Line item inventory types a responsive ecommerce creative cannot serve on. */
const NON_REC_INVENTORY = new Set(['AUDIO', 'ONLINE_VIDEO', 'STREAMING_TV']);

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

function evidenceOf(entries: CreativeMappingEntry[]): string {
  const sources = uniq(entries.map((e) => e.source)).sort();
  if (sources.length === 0) return 'none';
  return sources.join('+');
}

function describeEvidence(entries: CreativeMappingEntry[]): string {
  return uniq(
    entries.map((e) =>
      e.source === 'plugin_build'
        ? `recorded by a MixShift build${e.audit_id ? ` (audit ${e.audit_id})` : ''} on ${e.recorded_at.slice(0, 10)}`
        : `confirmed by the user on ${e.recorded_at.slice(0, 10)}${e.reuse ? ' as an intentional reuse' : ''}`,
    ),
  ).join('; ');
}

function fmtCreative(c: { creativeId: string; name?: string; products?: string[]; state?: string }): string {
  const products = c.products && c.products.length
    ? `, products ${c.products.slice(0, 5).join(', ')}${c.products.length > 5 ? ', ...' : ''}`
    : '';
  return `${c.creativeId}${c.name ? ` "${c.name}"` : ''}${products}${c.state && c.state !== 'ACTIVE' ? `, attachment ${c.state}` : ''}`;
}

export function evaluateResponsiveIdentity(input: IdentityInput): {
  results: IdentityResult[];
  checks: ReadinessCheck[];
} {
  const { orderId, advertiserId } = input;
  const mapOk = input.creativeMap.status === 'ok';
  const mine = mapOk
    ? scopedEntries(
        (input.creativeMap as Extract<CreativeMapInput, { status: 'ok' }>).entries,
        (input.creativeMap as Extract<CreativeMapInput, { status: 'ok' }>).tenant,
        advertiserId,
      )
    : [];
  const forOrder = mine.filter((e) => e.order_id === orderId);
  const expected = uniq(forOrder.map((e) => e.creative_id));
  const ordersOf = (cid: string): string[] => uniq(mine.filter((e) => e.creative_id === cid).map((e) => e.order_id));
  const evidenceSource = mapOk ? evidenceOf(forOrder) : 'unavailable';
  const mapNote = mapOk
    ? ''
    : ` (the creative map could not be used: ${(input.creativeMap as { reason: string }).reason})`;

  const results: IdentityResult[] = [];
  const checks: ReadinessCheck[] = [];
  const confirmCmd = (cid: string, reuse = false): string =>
    `mixshift dsp creative-map confirm ${orderId} --advertiser-id ${advertiserId} --creative-id ${cid}${reuse ? ' --reuse' : ''}`;

  for (const li of input.lineItems) {
    const L = li.adGroupId;
    const label = `Responsive creative on line item ${li.name ? `"${li.name}" ` : ''}${L}`;
    const base = {
      adGroupId: L,
      orderId,
      expectedCreativeIds: expected,
      evidenceSource,
    };
    const push = (r: Omit<IdentityResult, keyof typeof base>): void => {
      const full: IdentityResult = { ...base, ...r };
      results.push(full);
      if (full.verdict !== 'not_applicable') {
        checks.push({
          id: 'responsive_creative_identity',
          adGroupId: L,
          level: full.verdict,
          label,
          detail: full.detail,
          ...(full.fix ? { fix: full.fix } : {}),
        });
      }
    };

    // ---- reads this verdict depends on ---------------------------------
    if (!input.attachments.ok) {
      push({
        verdict: 'unchecked',
        reason: 'attachments_unreadable',
        attachedCreativeIds: [],
        creatives: [],
        detail: `Could not read the creatives attached to order ${orderId} line item ${L}: ${input.attachments.error}`,
      });
      continue;
    }
    const attached = input.attachments.value.get(L) ?? [];
    const attachedIds = uniq(attached.map((a) => a.creativeId));
    if (input.attachments.truncated) {
      push({
        verdict: 'unchecked',
        reason: 'attachments_truncated',
        attachedCreativeIds: attachedIds,
        creatives: [],
        detail: `The attachment read for order ${orderId} stopped early, so line item ${L} may carry creatives not seen here.`,
      });
      continue;
    }
    const applicable = !li.inventoryType || !NON_REC_INVENTORY.has(li.inventoryType);
    if (attachedIds.length === 0 && (expected.length === 0 || !applicable)) {
      push({
        verdict: 'not_applicable',
        reason: 'no_creative',
        attachedCreativeIds: [],
        creatives: [],
        detail: 'No creative attached and no responsive creative recorded for this order.',
      });
      continue;
    }
    if (input.details && !input.details.ok) {
      push({
        verdict: 'unchecked',
        reason: 'details_unreadable',
        attachedCreativeIds: attachedIds,
        creatives: [],
        detail: `Could not read the creative details for order ${orderId} line item ${L}: ${input.details.error}`,
      });
      continue;
    }
    if (input.details?.ok && input.details.truncated) {
      push({
        verdict: 'unchecked',
        reason: 'details_truncated',
        attachedCreativeIds: attachedIds,
        creatives: [],
        detail: `The creative details read stopped early, so the creatives on order ${orderId} line item ${L} were not all identified.`,
      });
      continue;
    }
    const details = input.details?.ok ? input.details.value : new Map<string, CreativeDetail>();

    // ---- classify each attached creative ---------------------------------
    const byId = new Map<string, AttachedCreative[]>();
    for (const a of attached) byId.set(a.creativeId, [...(byId.get(a.creativeId) ?? []), a]);
    const creatives = attachedIds.map((cid) => {
      const rows = byId.get(cid) ?? [];
      const exps = uniq(rows.flatMap((r) => r.experiences));
      const d = details.get(cid);
      const isRec = exps.includes('RESPONSIVE_ECOMMERCE') || d?.responsive === true;
      const typeKnown = exps.length > 0 || d !== undefined;
      // ACTIVE if any attachment row of this creative on this line is active.
      const state = rows.some((r) => r.state === 'ACTIVE') ? 'ACTIVE' : rows.find((r) => r.state)?.state;
      const recordedForOrders = ordersOf(cid);
      const role: AttachedRole = expected.includes(cid)
        ? 'expected'
        : recordedForOrders.length
          ? 'other_order'
          : isRec
            ? 'unmatched_rec'
            : !typeKnown
              ? 'unknown_type'
              : 'non_rec';
      return {
        creativeId: cid,
        role,
        ...(state ? { state } : {}),
        ...(d?.name ? { name: d.name } : {}),
        ...(d && d.products.length ? { products: d.products } : {}),
        recordedForOrders,
        _detail: d,
        _isRec: isRec,
      };
    });
    const strip = (cs: typeof creatives): IdentityResult['creatives'] =>
      cs.map(({ _detail, _isRec, ...rest }) => rest);
    const relevant = strip(creatives.filter((c) => c.role !== 'non_rec'));
    const of = (role: AttachedRole): typeof creatives => creatives.filter((c) => c.role === role);
    const exp = of('expected');
    const other = of('other_order');
    const unmatched = of('unmatched_rec');
    const unknown = of('unknown_type');

    // ---- proven mismatch: a creative recorded for another order ---------
    if (other.length) {
      const lines = other.map((c) => {
        const ev = describeEvidence(mine.filter((e) => e.creative_id === c.creativeId));
        return `${fmtCreative(c)} is recorded for order ${c.recordedForOrders.join(', ')} (${ev})`;
      });
      push({
        verdict: 'fail',
        reason: 'other_order_attached',
        attachedCreativeIds: attachedIds,
        creatives: relevant,
        detail:
          `Order ${orderId} line item ${L} carries another order's responsive creative: ${lines.join('; ')}.` +
          (expected.length
            ? ` This order's recorded creative is ${expected.join(', ')}` +
              (exp.length ? ' (attached as well).' : ' (not attached).')
            : ' This order has no recorded responsive creative of its own.'),
        fix:
          `Remove ${other.map((c) => c.creativeId).join(', ')} from line item ${L} in the DSP console ` +
          '(MixShift cannot detach a creative), then attach this order\'s own responsive creative' +
          (expected.length && !exp.length ? ` (${expected.join(', ')}, with dsp.create_ad_associations after a preview)` : '') +
          `. Only if the user says the creative is shared with this order on purpose, record that: ${confirmCmd(
            other[0]!.creativeId,
            true,
          )}. Nothing was changed.`,
      });
      continue;
    }

    if (expected.length) {
      if (!exp.length) {
        if (!applicable && !unmatched.length && !unknown.length) {
          push({
            verdict: 'not_applicable',
            reason: 'line_type_not_rec',
            attachedCreativeIds: attachedIds,
            creatives: relevant,
            detail: `Line item inventory type ${li.inventoryType} does not carry a responsive ecommerce creative.`,
          });
          continue;
        }
        // Gone from the advertiser: the details read was complete and did not return it.
        const gone = input.details?.ok ? expected.filter((cid) => !details.has(cid)) : [];
        const stale = gone.length === expected.length;
        push({
          verdict: 'fail',
          reason: stale ? 'expected_stale' : 'expected_missing',
          attachedCreativeIds: attachedIds,
          creatives: relevant,
          detail:
            (stale
              ? `The responsive creative recorded for order ${orderId} (${expected.join(', ')}; ${describeEvidence(forOrder)}) ` +
                'was not found on the advertiser: it was deleted, or the mapping is stale.'
              : `Line item ${L} does not carry the responsive creative recorded for order ${orderId} ` +
                `(${expected.join(', ')}; ${describeEvidence(forOrder)}).`) +
            (unmatched.length || unknown.length
              ? ` Attached instead: ${[...unmatched, ...unknown].map(fmtCreative).join('; ')} (origin not recorded).`
              : attachedIds.length
                ? ` Attached: ${attachedIds.join(', ')}.`
                : ' Nothing is attached.'),
          fix: stale
            ? `Check the order's creative in the DSP console with the user, then replace the record: ` +
              `mixshift dsp creative-map remove ${orderId} --advertiser-id ${advertiserId} --creative-id ${expected[0]} ` +
              `and ${confirmCmd('<creative id>')}.`
            : `Attach ${expected.join(' or ')} to line item ${L} (dsp.create_ad_associations, previewed and confirmed by the user)` +
              (unmatched.length ? ', and remove the other responsive creative in the DSP console if it is not meant to be there' : '') +
              '. Nothing was changed.',
        });
        continue;
      }
      if (unmatched.length || unknown.length) {
        push({
          verdict: 'confirm',
          reason: unmatched.length ? 'extra_unmatched_rec' : 'unknown_type',
          attachedCreativeIds: attachedIds,
          creatives: relevant,
          detail:
            `The recorded creative ${exp.map((c) => c.creativeId).join(', ')} is attached, and so is ` +
            [...unmatched, ...unknown]
              .map((c) => `${fmtCreative(c)}${c.role === 'unknown_type' ? ' (could not tell whether it is a responsive creative)' : ''}`)
              .join('; ') +
            `, whose originating order is not recorded.`,
          fix:
            'Ask the user whether that creative belongs on this line item. If it was made for this order, record it ' +
            `(${confirmCmd(unmatched[0]?.creativeId ?? unknown[0]!.creativeId)}); if not, remove it in the DSP console. ` +
            'Do not decide from its name, products or dates.',
        });
        continue;
      }
      const missingDetail = exp.filter((c) => !c._detail && !c._isRec);
      const notRec = exp.filter((c) => c._detail && !c._isRec);
      if (notRec.length || missingDetail.length) {
        push({
          verdict: 'confirm',
          reason: notRec.length ? 'expected_not_rec' : 'expected_no_details',
          attachedCreativeIds: attachedIds,
          creatives: relevant,
          detail: notRec.length
            ? `The recorded creative ${notRec.map(fmtCreative).join('; ')} is attached, but Amazon does not describe it as a responsive ecommerce creative.`
            : `The recorded creative ${missingDetail.map((c) => c.creativeId).join(', ')} is attached, but Amazon returned no details for it.`,
          fix: 'Check the creative in the DSP console with the user; if the record is wrong, remove it with `mixshift dsp creative-map remove`.',
        });
        continue;
      }
      const live = exp.filter((c) => c.state === 'ACTIVE');
      if (!live.length) {
        push({
          verdict: 'warn',
          reason: 'expected_inactive',
          attachedCreativeIds: attachedIds,
          creatives: relevant,
          detail:
            `The recorded creative ${exp.map(fmtCreative).join('; ')} is attached, but the attachment is not active, ` +
            'so it does not serve until it is switched on.',
          fix: 'Switch the attachment on in the DSP console (MixShift cannot change an attachment state).',
        });
        continue;
      }
      push({
        verdict: 'pass',
        reason: 'expected_attached',
        attachedCreativeIds: attachedIds,
        creatives: relevant,
        detail: `${exp.map(fmtCreative).join('; ')} is this order's responsive creative (${describeEvidence(forOrder)}).`,
      });
      continue;
    }

    // ---- no recorded creative for this order ----------------------------
    if (unmatched.length) {
      push({
        verdict: 'confirm',
        reason: 'unverified_origin',
        attachedCreativeIds: attachedIds,
        creatives: relevant,
        detail:
          `Responsive creative attached, originating order unverified: order ${orderId} line item ${L} carries ` +
          `${unmatched.map(fmtCreative).join('; ')}${mapNote}.`,
        fix:
          `Ask the user which order ${unmatched.length > 1 ? 'these were' : 'it was'} made for. If it was made for order ${orderId}, record it: ` +
          `${confirmCmd(unmatched[0]!.creativeId)} (a dry run; add --commit after the user confirms). If it belongs to another ` +
          'order, remove it from this line item in the DSP console. Never decide from its name, products or dates.',
      });
      continue;
    }
    if (unknown.length) {
      push({
        verdict: 'confirm',
        reason: 'unknown_type',
        attachedCreativeIds: attachedIds,
        creatives: relevant,
        detail:
          `Could not tell whether ${unknown.map((c) => c.creativeId).join(', ')} on order ${orderId} line item ${L} ` +
          'is a responsive ecommerce creative: Amazon returned neither its ad experiences nor its details.',
        fix: 'Check the creative in the DSP console with the user.',
      });
      continue;
    }
    push({
      verdict: 'not_applicable',
      reason: 'no_rec',
      attachedCreativeIds: attachedIds,
      creatives: relevant,
      detail: 'No responsive creative attached and none recorded for this order.',
    });
  }

  // ---- featured products vs tracked products: a WARN, never identity ----
  if (input.trackedAsins && input.trackedAsins.length && input.details?.ok && !input.details.truncated) {
    const tracked = new Set(input.trackedAsins);
    for (const r of results) {
      const off = r.creatives.filter(
        (c) => c.role !== 'other_order' && c.products && c.products.length && !c.products.some((p) => tracked.has(p)),
      );
      if (!off.length) continue;
      checks.push({
        id: 'responsive_creative_products',
        adGroupId: r.adGroupId,
        level: 'warn',
        label: `Responsive creative products on line item ${r.adGroupId}`,
        detail:
          `${off.map(fmtCreative).join('; ')} features none of order ${orderId}'s tracked products. ` +
          'Featured and tracked products need not match, so this alone does not mean the creative belongs to another order.',
        fix: 'Check with the user that the creative advertises what this order sells.',
      });
    }
  }

  return { results, checks };
}
