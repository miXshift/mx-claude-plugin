/**
 * `mixshift dsp supply-preset`: build the target deletions that leave DSP line
 * items on Amazon-owned inventory and Amazon Publisher Direct only.
 *
 * Why (mx-ops ads_automation_epic §4b, D-192(b)): an agency's DSP plan said
 * "Amazon O&O + Publisher Direct only", but Amazon adds about 50 inventory
 * source targets to every new display line item, most of them third-party
 * exchanges, and removing them meant reading every target and copying ids by
 * hand.
 *
 * How the supply is told apart (read live on the MixShift test advertiser
 * 2026-11-05): every INVENTORY_SOURCE target carries
 * targetDetails.inventorySourceTarget.inventorySourceType, one of AMAZON
 * (Amazon owned and operated), APD (Amazon Publisher Direct) or
 * THIRD_PARTY_EXCHANGE. The preset removes THIRD_PARTY_EXCHANGE targets and
 * keeps the rest, including any type it does not recognize.
 *
 * Read-only here: this module plans. The deletions themselves go through the
 * audited `dsp.delete_targets` write (dry run, the user confirms, --commit),
 * which snapshots every removed target so it can be added back.
 */

import type { AdsCallInput, AdsCallSuccess } from '../amazon/ads-call.js';
import { isReportFailure, type ReportFailure } from '../amazon/reports.js';

export type SupplyPreset = 'amazon-direct';
export const SUPPLY_PRESETS: readonly SupplyPreset[] = ['amazon-direct'];

/** Amazon's DeleteTargetRequest.targetIds maxItems (the gateway's dsp.delete_targets cap). */
export const DELETE_TARGETS_MAX = 1000;
const FILTER_MAX = 100;
const MAX_PAGES = 50;

export interface SupplyLinePlan {
  adGroupId: string;
  amazon: number;
  publisherDirect: number;
  thirdPartyExchange: number;
  other: number;
  /** Target ids to delete on this line item (third-party exchanges). */
  remove: string[];
  /** Why this line item is left alone, when it is. */
  skipped?: string;
}

export interface SupplyPlan {
  ok: true;
  preset: SupplyPreset;
  advertiserId: string;
  lines: SupplyLinePlan[];
  /** All ids to delete, de-duplicated, in line item order. */
  targetIds: string[];
  /** targetIds split into dsp.delete_targets bodies of at most DELETE_TARGETS_MAX. */
  batches: string[][];
}

export type SupplyCall = (
  input: Pick<AdsCallInput, 'operation' | 'pathParams' | 'query' | 'body'>,
) => Promise<AdsCallSuccess | ReportFailure>;

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;

/**
 * Read the line items' inventory source targets and plan the deletions.
 * Returns a ReportFailure when a read fails or stops early: a partial read
 * would plan a partial delete set and report it as the whole.
 */
export async function planSupplyPreset(
  call: SupplyCall,
  advertiserId: string,
  adGroupIds: string[],
  preset: SupplyPreset = 'amazon-direct',
): Promise<SupplyPlan | ReportFailure> {
  const ids = [...new Set(adGroupIds)];
  const lines = new Map<string, SupplyLinePlan>(
    ids.map((id) => [id, { adGroupId: id, amazon: 0, publisherDirect: 0, thirdPartyExchange: 0, other: 0, remove: [] }]),
  );
  for (let i = 0; i < ids.length; i += FILTER_MAX) {
    const part = ids.slice(i, i + FILTER_MAX);
    let token: string | undefined;
    let done = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await call({
        operation: 'dsp.query_targets',
        pathParams: { advertiserId },
        body: {
          adProductFilter: { include: ['AMAZON_DSP'] },
          adGroupIdFilter: { include: part },
          targetTypeFilter: { include: ['INVENTORY_SOURCE'] },
          maxResults: 500,
          ...(token ? { nextToken: token } : {}),
        },
      });
      if (isReportFailure(res)) return res;
      const payload = asRec(res.payload) ?? {};
      const rows = Array.isArray(payload.targets) ? payload.targets : [];
      for (const row of rows) {
        const t = asRec(row);
        if (!t || t.negative === true || str(t.targetType) !== 'INVENTORY_SOURCE') continue;
        const line = lines.get(str(t.adGroupId) ?? '');
        const targetId = str(t.targetId);
        if (!line || !targetId) continue;
        const kind = str(asRec(asRec(t.targetDetails)?.inventorySourceTarget)?.inventorySourceType);
        if (kind === 'AMAZON') line.amazon += 1;
        else if (kind === 'APD') line.publisherDirect += 1;
        else if (kind === 'THIRD_PARTY_EXCHANGE') {
          line.thirdPartyExchange += 1;
          line.remove.push(targetId);
        } else line.other += 1;
      }
      token = str(payload.nextToken);
      if (!token) {
        done = true;
        break;
      }
    }
    if (!done) {
      return {
        ok: false,
        kind: 'invalid_request',
        friendly: 'The line items have more inventory source targets than one plan reads; nothing was planned.',
        message: `dsp.query_targets still had pages after ${MAX_PAGES}. Run the preset on fewer line items at a time.`,
      } as ReportFailure;
    }
  }

  for (const line of lines.values()) {
    const kept = line.amazon + line.publisherDirect;
    if (line.thirdPartyExchange === 0 && kept === 0 && line.other === 0) {
      line.skipped = 'no inventory source targets found (wrong id, or not a line item on this advertiser)';
      line.remove = [];
    } else if (kept === 0 && line.thirdPartyExchange > 0) {
      // Removing every source could leave the line item with no supply
      // targeting at all, whose meaning Amazon does not document: refuse it.
      line.skipped = 'no Amazon or Publisher Direct source to keep; removing its exchanges would leave no supply targeting';
      line.remove = [];
    } else if (line.thirdPartyExchange === 0 && line.other > 0) {
      // Unclassified sources are never called "already done": if Amazon stops
      // sending inventorySourceType, every row lands here.
      line.skipped = `could not classify ${line.other} inventory source(s); nothing planned, check them by hand`;
    } else if (line.thirdPartyExchange === 0) {
      line.skipped = 'already Amazon and Publisher Direct only';
    }
  }

  const targetIds = [...new Set([...lines.values()].flatMap((l) => l.remove))];
  const batches: string[][] = [];
  for (let i = 0; i < targetIds.length; i += DELETE_TARGETS_MAX) batches.push(targetIds.slice(i, i + DELETE_TARGETS_MAX));
  return { ok: true, preset, advertiserId, lines: [...lines.values()], targetIds, batches };
}

export function renderSupplyPlan(plan: SupplyPlan): string {
  const out: string[] = [];
  out.push(`Supply preset "${plan.preset}" (keep Amazon owned and Publisher Direct; remove third-party exchanges)`);
  out.push(`advertiser ${plan.advertiserId}`);
  out.push('');
  for (const l of plan.lines) {
    out.push(
      `line item ${l.adGroupId}: Amazon ${l.amazon}, Publisher Direct ${l.publisherDirect}, ` +
        `third-party exchanges ${l.thirdPartyExchange}` +
        (l.other ? `, other ${l.other} (kept)` : '') +
        (l.skipped ? ` -> left alone: ${l.skipped}` : ` -> remove ${l.remove.length}`),
    );
  }
  out.push('');
  out.push(
    plan.targetIds.length
      ? `${plan.targetIds.length} target(s) to remove in ${plan.batches.length} call(s).`
      : 'Nothing to remove.',
  );
  return out.join('\n');
}
