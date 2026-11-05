/**
 * `mixshift dsp readiness <campaignId>`: the read-only "Before activating an
 * order" checklist from the mx-amazon-dsp skill, run as one command.
 *
 * Why it exists (mx-ops ads_automation_epic §4a, D-192(a)): the first customer
 * DSP build (2026-11-03) built orders that could not be switched on, because
 * the checks the skill describes were six separate reads per order and were
 * skipped. The gateway refuses the one case it can prove (a ROAS goal with no
 * tracked products) on activation; this command runs the whole checklist
 * before anyone tries.
 *
 * Reads only, all through the Ads call surface:
 *   - dsp.query_campaigns                 media type, goal KPI, state
 *   - dsp.list_conversion_tracking_products  tracked products (ASINs)
 *   - dsp.query_ad_groups                 the order's line items
 *   - dsp.query_targets                   targeting per line item (defaults vs
 *                                         intended, THIRD_PARTY, supply mix)
 *   - dsp.list_creative_associations      which creatives are attached
 *   - dsp.list_association_moderations    Amazon's approval per attachment
 *   - dsp.list_eligible_creatives         what could be attached, when nothing is
 *
 * What the API cannot answer (an off-Amazon conversion in Events manager, the
 * console-only automatically created responsive ad) is printed as "confirm in
 * the console", never as a pass.
 *
 * This module is pure apart from the injected `call`, so the checklist logic
 * is tested without a network.
 */

import type { AdsCallInput, AdsCallSuccess } from '../amazon/ads-call.js';
import { isReportFailure, type ReportFailure } from '../amazon/reports.js';

export type ReadinessLevel = 'pass' | 'fail' | 'warn' | 'confirm' | 'unchecked';

export interface ReadinessCheck {
  /** Stable id, e.g. "media_type" or "creative" (with adGroupId for per-line checks). */
  id: string;
  level: ReadinessLevel;
  /** One-line label, e.g. "Media type set". */
  label: string;
  /** What was found, with ids. */
  detail: string;
  /** How to fix a fail, or what to confirm. */
  fix?: string;
  /** Set on per-line-item checks. */
  adGroupId?: string;
}

export interface ReadinessLineItem {
  adGroupId: string;
  name?: string;
  state?: string;
  inventoryType?: string;
  /** Target counts by type (positive targets only). */
  targetsByType: Record<string, number>;
  negativeTargets: number;
  supply?: { amazon: number; publisherDirect: number; thirdPartyExchange: number; other: number };
}

export interface ReadinessReport {
  ok: true;
  advertiserId: string;
  campaignId: string;
  campaignName?: string;
  campaignState?: string;
  kpi?: string;
  primaryInventoryTypes?: string[];
  trackedProducts?: number;
  lineItems: ReadinessLineItem[];
  checks: ReadinessCheck[];
  /** True only when no check failed and every check could be run. */
  ready: boolean;
  counts: Record<ReadinessLevel, number>;
}

/** The injected Ads call: operation + path/query/body; the selector is bound by the caller. */
export type ReadinessCall = (
  input: Pick<AdsCallInput, 'operation' | 'pathParams' | 'query' | 'body'>,
) => Promise<AdsCallSuccess | ReportFailure>;

const DSP = { include: ['AMAZON_DSP'] };

/** Goals that sell tracked retail products (same set the gateway's activation preflight uses). */
const RETAIL_KPIS = new Set(['ROAS', 'ROAS_PROMOTED', 'RETURN_ON_AD_SPEND', 'TOTAL_RETURN_ON_AD_SPEND']);
/** KPI names Amazon deprecated; an order carrying one should be checked in the console. */
const DEPRECATED_KPIS = new Set([
  'COST_PER_ACTION',
  'RETURN_ON_AD_SPEND',
  'TOTAL_RETURN_ON_AD_SPEND',
  'COMBINED_RETURN_ON_AD_SPEND',
]);
/**
 * Target types Amazon adds to every new line item (measured on the MixShift
 * test advertiser 2026-11-05: DAYPART 168, INVENTORY_SOURCE ~50, DEVICE 3-4,
 * DOMAIN 1, plus THIRD_PARTY verification and video ad format on some). A line
 * item whose only positive targets are these has no intended targeting.
 */
const DEFAULT_TARGET_TYPES = new Set([
  'DAYPART',
  'DEVICE',
  'INVENTORY_SOURCE',
  'DOMAIN',
  'THIRD_PARTY',
  'VIDEO_AD_FORMAT',
  'BRAND_SAFETY_TIER',
  'UNTYPED',
]);
/** Line item inventoryType -> the order media type it needs. Unknown types are not judged. */
const INVENTORY_TO_MEDIA: Record<string, string> = {
  DISPLAY: 'DISPLAY',
  AUDIO: 'AUDIO',
  ONLINE_VIDEO: 'VIDEO_OLV',
  STREAMING_TV: 'VIDEO_STV',
};

const MAX_PAGES = 20;
/**
 * Line items per targets read. Amazon accepts 100, but a new display line item
 * carries about 225 default targets, so 100 per read would exhaust MAX_PAGES
 * pages of 500 and read NOT CHECKED; 20 keeps one read well inside the bound.
 */
const CM_AD_GROUP_FILTER_MAX = 20;
const V1_AD_GROUP_CHUNK = 50;
/** Tracked products read page size (Amazon's maximum, 10,000). */
const TRACKED_PRODUCTS_PAGE = 10000;

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Page a list until nextToken is absent. `where` says whether the token rides
 * in the body (every POST list here) or the query (the tracked-products GET).
 * Returns the rows, or the first failure. Stops after MAX_PAGES and reports
 * `truncated` so a check never passes on a partial read without saying so.
 */
async function pageAll(
  call: ReadinessCall,
  input: Pick<AdsCallInput, 'operation' | 'pathParams' | 'query' | 'body'>,
  listKey: string,
  where: 'body' | 'query',
): Promise<{ ok: true; rows: unknown[]; truncated: boolean } | ReportFailure> {
  const rows: unknown[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const req = { ...input };
    if (token) {
      if (where === 'body') req.body = { ...(asRec(input.body) ?? {}), nextToken: token };
      else req.query = { ...(input.query ?? {}), nextToken: token };
    }
    const res = await call(req);
    if (isReportFailure(res)) return res;
    const payload = asRec(res.payload) ?? {};
    const list = payload[listKey];
    if (Array.isArray(list)) rows.push(...list);
    token = str(payload.nextToken);
    if (!token) return { ok: true, rows, truncated: false };
  }
  return { ok: true, rows, truncated: true };
}

function readFailureText(f: ReportFailure): string {
  return f.friendly || f.message || f.kind;
}

/** Approval of one association from its moderation row (or the association's own status). */
function approvalOf(moderation: Rec | undefined, association: Rec | undefined): {
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'UNKNOWN';
  /** APPROVED_WITH_EXCEPTIONS: serves, but some targeted supply has not approved it yet. */
  exceptions: boolean;
  reasons: string[];
  experiences: string[];
  /** Amazon's status values as read, for an UNKNOWN verdict. */
  raw: string[];
} {
  const experiences: string[] = [];
  const statuses: string[] = [];
  const reasons: string[] = [];
  const exps = (moderation?.adExperiences ?? association?.adExperiences) as unknown;
  if (Array.isArray(exps)) {
    for (const e of exps) {
      const r = asRec(e);
      if (!r) continue;
      const name = str(r.adExperience);
      if (name) experiences.push(name);
      const s = str(r.associationModerationStatus);
      if (s) statuses.push(s.toUpperCase());
      const rs = r.associationModerationReasons;
      if (Array.isArray(rs)) {
        for (const x of rs) {
          const xr = asRec(x);
          const text = str(xr?.reason) ?? str(xr?.reasonDescription) ?? str(xr?.description) ?? str(x);
          if (text) reasons.push(text);
        }
      }
    }
  }
  if (statuses.length === 0) {
    const s = str(association?.creativeAssociationStatus)?.toUpperCase();
    if (s) statuses.push(s);
  }
  const base = { reasons, experiences, raw: [...new Set(statuses)] };
  if (statuses.includes('APPROVED')) return { status: 'APPROVED', exceptions: false, ...base };
  // Measured 2026-11-05: after a line item's third-party exchanges were
  // removed, its approved creative read APPROVED_WITH_EXCEPTIONS ("pending
  // approval from one or more supply sources targeted by one of its line items").
  if (statuses.includes('APPROVED_WITH_EXCEPTIONS')) return { status: 'APPROVED', exceptions: true, ...base };
  if (statuses.some((s) => s === 'PENDING' || s === 'IN_REVIEW' || s === 'PENDING_REVIEW')) {
    return { status: 'PENDING', exceptions: false, ...base };
  }
  if (statuses.some((s) => s === 'REJECTED' || s === 'DISAPPROVED')) {
    return { status: 'REJECTED', exceptions: false, ...base };
  }
  return { status: 'UNKNOWN', exceptions: false, ...base };
}

function fmtCounts(m: Record<string, number>): string {
  const parts = Object.entries(m)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(', ') : 'none';
}

/**
 * Run the checklist for one order. Returns a ReportFailure only when the order
 * itself cannot be read (sign-in, merchant, Amazon refusing the account); any
 * later read that fails becomes an "unchecked" line, so one bad read never
 * hides the rest of the checklist and never reads as a pass.
 */
export async function checkDspReadiness(
  call: ReadinessCall,
  advertiserId: string,
  campaignId: string,
): Promise<ReadinessReport | ReportFailure> {
  const path = { advertiserId };
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck): void => {
    checks.push(c);
  };

  // ---- the order --------------------------------------------------------
  const campRes = await call({
    operation: 'dsp.query_campaigns',
    pathParams: path,
    body: { adProductFilter: DSP, campaignIdFilter: { include: [campaignId] }, maxResults: 10 },
  });
  if (isReportFailure(campRes)) return campRes;
  const campaigns = asRec(campRes.payload)?.campaigns;
  const campaign = Array.isArray(campaigns)
    ? (campaigns.map(asRec).find((c) => str(c?.campaignId) === campaignId) as Rec | undefined)
    : undefined;

  const report: ReadinessReport = {
    ok: true,
    advertiserId,
    campaignId,
    lineItems: [],
    checks,
    ready: false,
    counts: { pass: 0, fail: 0, warn: 0, confirm: 0, unchecked: 0 },
  };

  if (!campaign) {
    add({
      id: 'campaign',
      level: 'fail',
      label: 'Order found',
      detail: `No DSP order ${campaignId} under advertiser ${advertiserId}.`,
      fix: 'Check the order id (dsp.query_campaigns lists the advertiser\'s orders) and the advertiser id.',
    });
    return finish(report);
  }

  report.campaignName = str(campaign.name);
  report.campaignState = str(campaign.state);
  const optimizations = asRec(campaign.optimizations) ?? {};
  const goal = asRec(optimizations.goalSettings) ?? {};
  const kpi = str(goal.kpi);
  report.kpi = kpi;
  const media = Array.isArray(optimizations.primaryInventoryTypes)
    ? (optimizations.primaryInventoryTypes as unknown[]).map(str).filter((x): x is string => !!x)
    : [];
  report.primaryInventoryTypes = media;

  add({
    id: 'campaign',
    level: report.campaignState === 'ENABLED' ? 'warn' : 'pass',
    label: 'Order found',
    detail:
      `${report.campaignName ?? '(no name)'} (${campaignId}), state ${report.campaignState ?? 'unknown'}` +
      (report.campaignState === 'ENABLED' ? '; it is already switched on' : ''),
  });

  // ---- line items (read early: the media-type check needs them) ---------
  const agRes = await pageAll(
    call,
    {
      operation: 'dsp.query_ad_groups',
      pathParams: path,
      body: { adProductFilter: DSP, campaignIdFilter: { include: [campaignId] }, maxResults: 100 },
    },
    'adGroups',
    'body',
  );
  // Keep only this order's line items: a row that names another order never
  // counts toward this order's targeting or creatives.
  const adGroups: Rec[] = isReportFailure(agRes)
    ? []
    : agRes.rows
        .map(asRec)
        .filter((r): r is Rec => !!r && !!str(r.adGroupId))
        .filter((r) => str(r.campaignId) === undefined || str(r.campaignId) === campaignId);
  report.lineItems = adGroups.map((g) => ({
    adGroupId: str(g.adGroupId) as string,
    ...(str(g.name) ? { name: str(g.name) } : {}),
    ...(str(g.state) ? { state: str(g.state) } : {}),
    ...(str(g.inventoryType) ? { inventoryType: str(g.inventoryType) } : {}),
    targetsByType: {},
    negativeTargets: 0,
  }));

  // ---- media type -------------------------------------------------------
  if (media.length === 0) {
    add({
      id: 'media_type',
      level: 'fail',
      label: 'Media type set',
      detail: 'The order has no media type (optimizations.primaryInventoryTypes is empty).',
      fix:
        'Without a media type creatives do not populate on the order. Set it to match the line items ' +
        '(Display line items mean ["DISPLAY"]).',
    });
  } else {
    const mismatched = report.lineItems.filter((li) => {
      const need = li.inventoryType ? INVENTORY_TO_MEDIA[li.inventoryType] : undefined;
      return need !== undefined && !media.includes(need);
    });
    // A line item type this build cannot map is named, never passed silently.
    const unmapped = report.lineItems.filter((li) => !li.inventoryType || !INVENTORY_TO_MEDIA[li.inventoryType]);
    add({
      id: 'media_type',
      level: mismatched.length ? 'fail' : unmapped.length ? 'warn' : 'pass',
      label: 'Media type set',
      detail:
        `Order media type ${media.join(', ')}` +
        (mismatched.length
          ? `; does not cover line item ${mismatched
              .map((m) => `${m.adGroupId} (${m.inventoryType})`)
              .join(', ')}`
          : '') +
        (unmapped.length
          ? `; could not match line item ${unmapped
              .map((m) => `${m.adGroupId} (${m.inventoryType ?? 'no inventory type'})`)
              .join(', ')} to a media type, check it by hand`
          : ''),
      ...(mismatched.length
        ? { fix: 'Make the order media type match its line items, or move those line items to an order that does.' }
        : {}),
    });
  }

  // ---- goal KPI ---------------------------------------------------------
  add({
    id: 'goal_kpi',
    level: !kpi ? 'warn' : DEPRECATED_KPIS.has(kpi) ? 'warn' : 'pass',
    label: 'Goal KPI',
    detail: kpi
      ? `${kpi}${DEPRECATED_KPIS.has(kpi) ? ' (deprecated by Amazon; check the order in the console)' : ''}`
      : 'The order shows no goal KPI.',
  });

  // ---- tracked products -------------------------------------------------
  const tpRes = await pageAll(
    call,
    {
      operation: 'dsp.list_conversion_tracking_products',
      pathParams: { ...path, campaignId },
      query: { maxResults: TRACKED_PRODUCTS_PAGE },
    },
    'productTrackingList',
    'query',
  );
  const retail = kpi !== undefined && RETAIL_KPIS.has(kpi);
  if (isReportFailure(tpRes)) {
    add({
      id: 'tracked_products',
      level: 'unchecked',
      label: 'Tracked products present',
      detail: `Could not read the order's tracked products: ${readFailureText(tpRes)}`,
    });
  } else {
    const asins = tpRes.rows.map((r) => str(asRec(r)?.productId)).filter((x): x is string => !!x);
    report.trackedProducts = asins.length;
    const sample = asins.slice(0, 5).join(', ') + (asins.length > 5 ? ', ...' : '');
    const addFix =
      'Add the advertised ASINs with dsp.create_conversion_tracking_products, then read them back ' +
      'with dsp.list_conversion_tracking_products.';
    if (asins.length > 0) {
      // One tracked product is enough for this gate, so a read that stopped
      // early still passes; the count says it is a lower bound.
      add({
        id: 'tracked_products',
        level: 'pass',
        label: 'Tracked products present',
        detail: `${asins.length}${tpRes.truncated ? '+' : ''} tracked: ${sample}`,
      });
    } else if (retail) {
      add({
        id: 'tracked_products',
        level: 'fail',
        label: 'Tracked products present',
        detail:
          `None, and the goal ${kpi} optimizes toward retail sales: Amazon refuses to activate it ` +
          '(CONVERSION_TRACKING_REQUIRED).',
        fix: addFix,
      });
    } else if (kpi && /OFF_AMAZON/.test(kpi)) {
      // This goal's prerequisite is the off-Amazon conversion (its own CONFIRM line).
      add({
        id: 'tracked_products',
        level: 'warn',
        label: 'Tracked products present',
        detail: 'None. An order that advertises products sold on Amazon needs them before it can be switched on.',
        fix: addFix,
      });
    } else {
      // Fail closed: Amazon refuses to switch on an order that advertises
      // products sold on Amazon until it tracks them, whatever its goal, and
      // the API cannot say whether an order is that kind.
      add({
        id: 'tracked_products',
        level: 'fail',
        label: 'Tracked products present',
        detail:
          `None${kpi ? ` (goal ${kpi})` : ' (and the order shows no goal KPI)'}. Amazon refuses to switch on an ` +
          'order that advertises products sold on Amazon until it tracks them (CONVERSION_TRACKING_REQUIRED).',
        fix:
          addFix +
          ' If this order advertises nothing sold on Amazon, it needs an off-Amazon conversion from Events ' +
          'manager instead: confirm that in the DSP console and treat this line as answered.',
      });
    }
  }

  // ---- off-Amazon conversion (not readable) -----------------------------
  if (kpi && /OFF_AMAZON/.test(kpi)) {
    add({
      id: 'off_amazon_conversion',
      level: 'confirm',
      label: 'Off-Amazon conversion on the order',
      detail: `The goal ${kpi} needs an off-Amazon conversion from Events manager on this order.`,
      fix: 'Confirm it in the DSP console; the API cannot read it.',
    });
  }

  // ---- line items exist -------------------------------------------------
  if (isReportFailure(agRes)) {
    add({
      id: 'line_items',
      level: 'unchecked',
      label: 'Line items',
      detail: `Could not read the order's line items: ${readFailureText(agRes)}`,
    });
    add(automatedRec(undefined));
    return finish(report);
  }
  add({
    id: 'line_items',
    level: report.lineItems.length === 0 ? 'fail' : agRes.truncated ? 'unchecked' : 'pass',
    label: 'Line items',
    detail:
      report.lineItems.length === 0
        ? 'The order has no line items.'
        : `${report.lineItems.length} line item(s)${agRes.truncated ? ' (read stopped early)' : ''}`,
    ...(report.lineItems.length === 0 ? { fix: 'Create line items with dsp.create_ad_groups.' } : {}),
  });
  if (report.lineItems.length === 0) {
    add(automatedRec(undefined));
    return finish(report);
  }

  const ids = report.lineItems.map((l) => l.adGroupId);
  const byId = new Map(report.lineItems.map((l) => [l.adGroupId, l]));

  // ---- targeting --------------------------------------------------------
  const targetFailures = new Map<string, string>();
  const targetTruncated = new Set<string>();
  for (const part of chunk(ids, CM_AD_GROUP_FILTER_MAX)) {
    const tRes = await pageAll(
      call,
      {
        operation: 'dsp.query_targets',
        pathParams: path,
        body: { adProductFilter: DSP, adGroupIdFilter: { include: part }, maxResults: 500 },
      },
      'targets',
      'body',
    );
    if (isReportFailure(tRes)) {
      for (const id of part) targetFailures.set(id, readFailureText(tRes));
      continue;
    }
    if (tRes.truncated) for (const id of part) targetTruncated.add(id);
    for (const row of tRes.rows) {
      const t = asRec(row);
      const li = t ? byId.get(str(t.adGroupId) ?? '') : undefined;
      if (!t || !li) continue;
      if (t.negative === true) {
        li.negativeTargets += 1;
        continue;
      }
      // A row without a type is counted as a default, never as intended targeting.
      const type = str(t.targetType) ?? 'UNTYPED';
      li.targetsByType[type] = (li.targetsByType[type] ?? 0) + 1;
      if (type === 'INVENTORY_SOURCE') {
        const src = asRec(asRec(t.targetDetails)?.inventorySourceTarget);
        const kind = str(src?.inventorySourceType);
        li.supply ??= { amazon: 0, publisherDirect: 0, thirdPartyExchange: 0, other: 0 };
        if (kind === 'AMAZON') li.supply.amazon += 1;
        else if (kind === 'APD') li.supply.publisherDirect += 1;
        else if (kind === 'THIRD_PARTY_EXCHANGE') li.supply.thirdPartyExchange += 1;
        else li.supply.other += 1;
      }
    }
  }

  for (const li of report.lineItems) {
    const label = `Targeting on line item ${li.name ? `"${li.name}" ` : ''}${li.adGroupId}`;
    const failed = targetFailures.get(li.adGroupId);
    if (failed) {
      add({ id: 'targeting', adGroupId: li.adGroupId, level: 'unchecked', label, detail: `Could not read targets: ${failed}` });
      continue;
    }
    const intended = Object.entries(li.targetsByType).filter(([t]) => !DEFAULT_TARGET_TYPES.has(t));
    const supply = li.supply
      ? `; supply: Amazon ${li.supply.amazon}, Publisher Direct ${li.supply.publisherDirect}, ` +
        `third-party exchanges ${li.supply.thirdPartyExchange}` +
        (li.supply.other ? `, other ${li.supply.other}` : '')
      : '';
    add({
      id: 'targeting',
      adGroupId: li.adGroupId,
      level: targetTruncated.has(li.adGroupId) ? 'unchecked' : intended.length ? 'pass' : 'fail',
      label,
      detail:
        (intended.length
          ? `intended: ${fmtCounts(Object.fromEntries(intended))}`
          : `only Amazon's defaults (${fmtCounts(li.targetsByType)})`) +
        (li.negativeTargets ? `; ${li.negativeTargets} exclusion(s)` : '') +
        supply +
        (targetTruncated.has(li.adGroupId) ? '; read stopped early' : ''),
      ...(intended.length
        ? {}
        : { fix: 'Add the planned audiences or other targeting with dsp.create_targets.' }),
    });
    const thirdParty = li.targetsByType.THIRD_PARTY ?? 0;
    if (thirdParty > 0) {
      add({
        id: 'third_party',
        adGroupId: li.adGroupId,
        level: 'warn',
        label: `Third-party trackers on line item ${li.adGroupId}`,
        detail: `${thirdParty} THIRD_PARTY target(s).`,
        fix:
          'If this line item targets an AMC audience that forbids third-party trackers, remove them with ' +
          'dsp.delete_targets before switching on.',
      });
    }
  }

  // ---- creatives --------------------------------------------------------
  const assoc: Rec[] = [];
  const mods: Rec[] = [];
  let creativeReadError: string | undefined;
  let creativeTruncated = false;
  for (const part of chunk(ids, V1_AD_GROUP_CHUNK)) {
    const body = { adGroupIdFilter: { include: part }, maxResults: 100 };
    const aRes = await pageAll(
      call,
      { operation: 'dsp.list_creative_associations', pathParams: path, body },
      'associations',
      'body',
    );
    const mRes = await pageAll(
      call,
      { operation: 'dsp.list_association_moderations', pathParams: path, body },
      'associationStatuses',
      'body',
    );
    if (isReportFailure(aRes)) creativeReadError ??= readFailureText(aRes);
    else {
      assoc.push(...aRes.rows.map(asRec).filter((r): r is Rec => !!r));
      creativeTruncated ||= aRes.truncated;
    }
    if (isReportFailure(mRes)) creativeReadError ??= readFailureText(mRes);
    else {
      mods.push(...mRes.rows.map(asRec).filter((r): r is Rec => !!r));
      creativeTruncated ||= mRes.truncated;
    }
  }

  // Eligible creatives only for line items with nothing attached (it is the
  // fix, not the check): one batched read.
  const bare = creativeReadError
    ? []
    : ids.filter((id) => !assoc.some((a) => str(a.adGroupId) === id));
  const eligible = new Map<string, string[]>();
  let eligibleError: string | undefined;
  for (const part of chunk(bare, V1_AD_GROUP_CHUNK)) {
    const eRes = await pageAll(
      call,
      {
        operation: 'dsp.list_eligible_creatives',
        pathParams: path,
        body: { adGroupIdFilter: { include: part }, maxResults: 100 },
      },
      'adCreatives',
      'body',
    );
    if (isReportFailure(eRes)) {
      eligibleError ??= readFailureText(eRes);
      continue;
    }
    for (const row of eRes.rows) {
      const c = asRec(row);
      const cid = str(c?.adCreativeId);
      const groups = Array.isArray(c?.eligibleAdGroupIds) ? (c?.eligibleAdGroupIds as unknown[]) : [];
      if (!cid) continue;
      for (const g of groups) {
        const gid = str(g);
        if (!gid) continue;
        const list = eligible.get(gid) ?? [];
        list.push(cid);
        eligible.set(gid, list);
      }
    }
  }

  const responsive: string[] = [];
  for (const li of report.lineItems) {
    const label = `Approved creative on line item ${li.adGroupId}`;
    if (creativeReadError) {
      add({
        id: 'creative',
        adGroupId: li.adGroupId,
        level: 'unchecked',
        label,
        detail: `Could not read creative attachments: ${creativeReadError}`,
      });
      continue;
    }
    const mine = assoc.filter((a) => str(a.adGroupId) === li.adGroupId);
    if (mine.length === 0) {
      const el = eligible.get(li.adGroupId) ?? [];
      add({
        id: 'creative',
        adGroupId: li.adGroupId,
        level: 'fail',
        label,
        detail:
          'No creative attached' +
          (eligibleError
            ? ` (could not list eligible creatives: ${eligibleError})`
            : el.length
              ? `; ${el.length} eligible: ${el.slice(0, 5).join(', ')}${el.length > 5 ? ', ...' : ''}`
              : '; no eligible creative found for it'),
        fix: el.length
          ? 'Attach one with dsp.create_ad_associations (adId = the creative id), then wait for approval.'
          : 'Build a creative in the DSP console that fits the line item, then attach it.',
      });
      continue;
    }
    const judged = mine.map((a) => {
      const cid = str(a.adCreativeId) ?? '?';
      const mod = mods.find((m) => str(m.adGroupId) === li.adGroupId && str(m.adCreativeId) === cid);
      const ap = approvalOf(mod, a);
      if (ap.experiences.includes('RESPONSIVE_ECOMMERCE')) responsive.push(cid);
      return { cid, state: str(a.state), ...ap };
    });
    // Live only when Amazon says ACTIVE: a paused or unknown attachment state
    // leaves the line item with nothing to serve.
    const live = judged.filter((j) => j.status === 'APPROVED' && j.state === 'ACTIVE');
    const approvedPaused = judged.filter((j) => j.status === 'APPROVED' && j.state !== 'ACTIVE');
    const pending = judged.filter((j) => j.status === 'PENDING');
    const rejected = judged.filter((j) => j.status === 'REJECTED');
    const describe = (js: typeof judged): string => js.map((j) => j.cid).join(', ');
    if (live.length) {
      const clean = live.filter((j) => !j.exceptions);
      const partial = live.filter((j) => j.exceptions);
      const partialReasons = [...new Set(partial.flatMap((j) => j.reasons))].slice(0, 2);
      add({
        id: 'creative',
        adGroupId: li.adGroupId,
        level: creativeTruncated ? 'unchecked' : clean.length ? 'pass' : 'warn',
        label,
        detail:
          (clean.length ? `approved: ${describe(clean)}` : '') +
          (clean.length && partial.length ? '; ' : '') +
          (partial.length
            ? `approved with exceptions: ${describe(partial)}` +
              (partialReasons.length ? ` (${partialReasons.join('; ')})` : '')
            : '') +
          (pending.length ? `; still pending: ${describe(pending)}` : '') +
          (rejected.length ? `; rejected: ${describe(rejected)}` : ''),
        ...(clean.length
          ? {}
          : { fix: 'It can serve where it is approved; some of the targeted supply is still reviewing it.' }),
      });
    } else if (approvedPaused.length) {
      add({
        id: 'creative',
        adGroupId: li.adGroupId,
        level: 'fail',
        label,
        detail:
          'approved but the attachment is not active: ' +
          approvedPaused.map((j) => `${j.cid} (${j.state ?? 'state unknown'})`).join(', '),
        fix: 'Switch the creative attachment on, or the line item has nothing to serve.',
      });
    } else {
      const reasons = rejected.flatMap((r) => r.reasons).slice(0, 3);
      add({
        id: 'creative',
        adGroupId: li.adGroupId,
        level: 'fail',
        label,
        detail:
          (pending.length ? `moderation pending: ${describe(pending)}` : '') +
          (pending.length && rejected.length ? '; ' : '') +
          (rejected.length ? `rejected: ${describe(rejected)}${reasons.length ? ` (${reasons.join('; ')})` : ''}` : '') +
          (!pending.length && !rejected.length
            ? `attached, approval not recognized: ${judged
                .map((j) => `${j.cid} (${j.raw.join(', ') || 'no status'})`)
                .join(', ')}`
            : ''),
        fix: pending.length
          ? 'Wait for Amazon\'s review (dsp.list_association_moderations) before switching on.'
          : 'Fix or replace the rejected creative in the DSP console, then attach it again.',
      });
    }
  }

  add(automatedRec(responsive));
  return finish(report);
}

function automatedRec(responsive: string[] | undefined): ReadinessCheck {
  const seen = responsive && responsive.length ? [...new Set(responsive)] : [];
  return {
    id: 'automated_rec',
    level: 'confirm',
    label: 'Automatically created responsive ad (only if the user chose it)',
    detail: seen.length
      ? `A responsive ecommerce creative is attached (${seen.join(', ')}); it may be the automatic one.`
      : 'The API cannot show whether the order has Amazon\'s automatically created responsive ad.',
    fix:
      'Confirm it on the order in the DSP console. It can only be switched on when the order is created ' +
      'in the console; an order without it is rebuilt there.',
  };
}

function finish(report: ReadinessReport): ReadinessReport {
  const counts: Record<ReadinessLevel, number> = { pass: 0, fail: 0, warn: 0, confirm: 0, unchecked: 0 };
  for (const c of report.checks) counts[c.level] += 1;
  report.counts = counts;
  report.ready = counts.fail === 0 && counts.unchecked === 0;
  return report;
}

const MARK: Record<ReadinessLevel, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'WARN',
  confirm: 'CONFIRM',
  unchecked: 'NOT CHECKED',
};

/** The human checklist: one line per check, the fix indented under it. */
export function renderReadiness(r: ReadinessReport): string {
  const lines: string[] = [];
  lines.push(
    `DSP order ${r.campaignId}${r.campaignName ? ` "${r.campaignName}"` : ''} on advertiser ${r.advertiserId}`,
  );
  lines.push('');
  for (const c of r.checks) {
    lines.push(`[${MARK[c.level]}] ${c.label}: ${c.detail}`);
    if (c.fix && c.level !== 'pass') lines.push(`        ${c.fix}`);
  }
  lines.push('');
  lines.push(
    r.ready
      ? `Ready to switch on, apart from ${r.counts.confirm} item(s) to confirm in the console` +
          (r.counts.warn ? ` and ${r.counts.warn} warning(s)` : '') +
          '. Amazon can still refuse the activation; read its answer per item.'
      : `NOT ready: ${r.counts.fail} failed` +
          (r.counts.unchecked ? `, ${r.counts.unchecked} could not be checked` : '') +
          '. Do not switch this order on until they pass.',
  );
  return lines.join('\n');
}
