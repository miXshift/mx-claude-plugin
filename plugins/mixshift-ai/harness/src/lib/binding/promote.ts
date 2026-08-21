/**
 * Sub-brand PROMOTION: dry-run plan + confirmed per-item apply for turning
 * discovered labels (lib/binding/discovery.ts) into real, bound sub-brands
 * (mx-ops#6 P2; docs/subbrand-architecture.md §4.2, §5, §5.1 in
 * mx-legacy-auth).
 *
 * Two-phase contract, same shape as the house `--apply <decision-json>`
 * pattern (lib/context-editor/flow.ts's applyBrandConfigEdit, lib/
 * calibration/confirm-flow.ts's applyConfirmation):
 *
 *   buildPromotionPlan(...)         — pure-ish read. Runs no writes. Builds
 *                                     a PROMOTION PLAN from an already-fetched
 *                                     CoverageReport: for each label above the
 *                                     meaningful-mass gate, the slug that
 *                                     would be minted, whether a bound brand
 *                                     already exists for that label
 *                                     (idempotency), and — when this account
 *                                     already has a pre-existing whole-account
 *                                     brand (design doc §5.1) — a CONTENT
 *                                     TRIAGE proposal for that brand's facts,
 *                                     structural events, and instructions.
 *
 *   applyPromotionDecision(...)     — write. Takes ONE decision at a time
 *                                     (never a batch commit) against an
 *                                     already-built plan, validates it,
 *                                     executes exactly that one step, and
 *                                     returns a result. Every step is
 *                                     individually re-runnable: re-running
 *                                     the same decision twice converges
 *                                     rather than erroring or double-writing.
 *
 * FAIL-CLOSED CONTRACT (mirrors the sibling --apply commands, both of which
 * exist because an earlier version fell through to a write path on an
 * unrecognized action): `applyPromotionDecision` receives its `decision`
 * argument from `JSON.parse(...) as PromotionDecision` at the CLI layer — an
 * unchecked cast, so the compile-time union is not a runtime guarantee.
 * Every branch below explicitly checks `decision.action` against the known
 * set and validates the shape of whatever that action needs; anything else
 * (wrong type, missing field, unrecognized action) returns
 * `validation_failed` and writes nothing.
 *
 * PROPOSE-ONLY GUARANTEE: nothing in this module calls a write path outside
 * of `applyPromotionDecision`'s positively-matched branches. Building a plan
 * never touches disk except to READ the local registry and existing brand
 * contexts for idempotency/triage purposes.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  type CoverageReport,
  type SideCoverage,
  type SideLabelBreakdown,
  MEANINGFUL_LABEL_SHARE,
  UNCLASSIFIED_LABEL,
} from './discovery.js';
import { resolveBinding } from './resolve.js';
import { mintSlug, collectExistingSlugs } from './slug.js';
import { readIndex, saveIndex } from '../clients/index.js';
import { emptyIndex, type IndexBrand } from '../clients/index-schema.js';
import { discoverSellers } from '../discovery/seller-query.js';
import { unknownEconomics, fmtMoney, type LabelEconomics, type Lifecycle } from './economics.js';
import type { BrandSuggestion } from '../discovery/brand-grouping.js';
import { validateBrandContext } from '../context/load.js';
import {
  contextSchema,
  bindingSchema,
  type BindingBlock,
  type BrandContext,
} from '../context/schema.js';
import { contextPath, brandDir } from '../paths/resolve.js';
import { brandDirExists } from '../context-sync/local.js';
import { pushAfterWrite } from '../context-sync/push-after-write.js';
import { formatZodError } from '../profile/format-error.js';
import { describeJsonType } from '../calibration/manifest-schema.js';

// ---------------------------------------------------------------------------
// Plan shapes
// ---------------------------------------------------------------------------

export type PromotionItemStatus = 'would_create' | 'already_bound' | 'flagged';

/** Why an item is in the plan but not proposed for creation by default.
 *  - 'dormant'    observable activity says the brand has wound down.
 *  - 'negligible' the brand is live enough, or too small to judge, but is
 *                 economically trivial against this account. Distinct from
 *                 dormant on purpose: "we can see it stopped" and "it never
 *                 amounted to much" are different findings and an operator
 *                 acts on them differently. */
export type PromotionFlagReason = 'dormant' | 'negligible';

export interface PromotionPlanItem {
  label: string;
  /** Originating source column(s), e.g. 'mws_items.Brand' — mirrors
   *  SideLabelBreakdown.source. Null only in the theoretical case of an
   *  empty source string (never observed from the wire contract). */
  retail_source: string | null;
  retail_units: number;
  ads_campaign_count: number;
  has_ads: boolean;
  /** The ads label column this label was seen on, when anything saw it
   *  there. Distinct from `has_ads`, which reports what the COVERAGE query
   *  returned and drives what the plan renders: a label can be absent from
   *  coverage yet carry real ad spend in economics, and that still yields a
   *  valid ads filter to bind on. Null when no side reported one. */
  ads_source: string | null;
  /** Trailing 365d ordered revenue (SC + VC) for this label. */
  revenue_365d: number;
  /** Trailing 365d ad spend for this label. */
  spend_365d: number;
  /** revenue_365d + spend_365d — what the plan ranks on. */
  economic_weight: number;
  /** Read from observable activity, never from a custom label column. */
  lifecycle: Lifecycle;
  /** Why `lifecycle` says what it says, in plain language. Shown to the
   *  operator on any flagged item so the flag is auditable, not a verdict. */
  lifecycle_reason: string;
  /** The slug mintSlug() would produce right now (would_create), or the
   *  slug of the brand this label is ALREADY bound to (already_bound). */
  proposed_slug: string;
  status: PromotionItemStatus;
  /** Set only when status === 'flagged'. */
  flag_reason?: PromotionFlagReason;
  /** Set only when status === 'flagged' — plain-language justification the
   *  operator reads, so the flag is auditable rather than a bare verdict. */
  flag_detail?: string;
  existing_slug?: string;
}

export type OldBrandTriageDisposition = 'move_to' | 'copy_into_all' | 'retire';

export interface OldBrandTriageItem {
  /** Dotted/indexed path into the old brand's context.yaml, e.g.
   *  'structural_events[2]' or 'negation.protected_terms'. */
  section: string;
  summary: string;
  proposed_disposition: OldBrandTriageDisposition;
  /** Present when proposed_disposition === 'move_to' — the slug (from this
   *  same plan's items[]) the content would move to. */
  proposed_target_slug?: string;
  rationale: string;
}

export type OldBrandFinalDisposition = 'retire' | 'rebind_as_dominant';

export interface OldBrandPlan {
  slug: string;
  display_name: string;
  proposed_disposition: OldBrandFinalDisposition;
  /** Present when proposed_disposition === 'rebind_as_dominant'. */
  dominant_label?: string;
  rationale: string;
  /** Per-fact/structural_event/instruction disposition PROPOSALS — the user
   *  edits these; nothing here is auto-applied (design doc §5.1). */
  triage: OldBrandTriageItem[];
}

export interface PromotionPlan {
  seller_id: string;
  generated_at: string;
  items: PromotionPlanItem[];
  /** Non-null only when this account already has a pre-existing
   *  whole-account brand (design doc §5.1's "already-onboarded accounts"
   *  case) — the common pilot path, not an edge case. */
  old_brand: OldBrandPlan | null;
  /** Extremely unlikely, but reported rather than silently dropped: other
   *  un-bound local brands whose accounts[] also reference this seller_id
   *  (near-duplicate seller rows, design doc F25). At most one such brand is
   *  treated as `old_brand`; any additional ones need manual review before
   *  promoting labels for this account. */
  additional_unbound_brands: string[];
  notice: string;
}

/** Customer-facing (no internal names) — the build brief's own guard rail:
 *  "the FIRST live promotions on real accounts are Sam-gated, so make that
 *  explicit in the command's own output." Phrased for a public audience:
 *  ops sign-off, not a named person. */
export const FIRST_LIVE_PROMOTION_NOTICE =
  'This is a proposal only; nothing has been written. The first live ' +
  'sub-brand promotions on a real customer account require MixShift ops ' +
  'sign-off before --apply runs against it.';

/** Design doc §4.1/§4.2's "meaningful catalog/spend mass" gate, reused
 *  verbatim from discovery.ts rather than re-derived (same threshold
 *  classifyShape uses to decide brand_nested_candidate vs single_brand).
 *
 *  NOTE this is a CATALOG-MASS gate, not the ranking. It answers "is this
 *  label a real segment of the account or a rounding error", which is a
 *  question about breadth and is legitimately measured in items. What it
 *  must NOT do is decide which candidates matter most — that is
 *  `rankCandidates` below, and it ranks in dollars. Conflating the two is
 *  the original defect: a label with many dormant ASINs outranked one with
 *  few very large ones. */
export function meaningfulRetailLabels(retail: SideCoverage): SideLabelBreakdown[] {
  if (retail.total_units <= 0) return [];
  return retail.labels.filter(
    (l) => l.label !== UNCLASSIFIED_LABEL && l.units / retail.total_units >= MEANINGFUL_LABEL_SHARE,
  );
}

/** A label carrying at least this share of the account's total economic
 *  weight is a promotion candidate on economics alone, even when its
 *  catalog footprint is too small to clear `MEANINGFUL_LABEL_SHARE`.
 *
 *  This is the half of the fix that ADDS candidates rather than reordering
 *  them: the reported case had the account's largest brand by revenue and
 *  ad spend missing from the plan entirely, because it was carried on
 *  relatively few items. A brand worth a meaningful slice of the account's
 *  money is a brand worth proposing, whatever its item count. */
export const MEANINGFUL_ECONOMIC_SHARE = 0.02;

/**
 * Decide whether a candidate is proposed for creation or merely surfaced.
 *
 * Two independent reasons to hold one back, deliberately kept apart:
 *
 *   dormant    — observable activity says it wound down. Requires real
 *                evidence; `unknown` lifecycle never lands here, because
 *                absent data must not read as evidence of death.
 *   negligible — it carries a trivial share of the account's money. This is
 *                the case the catalog-mass gate cannot see: a label can hold
 *                most of the ASINs and almost none of the value, which is
 *                exactly how a long-dead brand with a big stale catalog got
 *                proposed ahead of the account's largest earner.
 *
 * Returns no flag at all when there are no economics for the account —
 * flagging on no evidence would hide real brands.
 *
 * Nor when there are no economics for THIS label specifically. A label the
 * economics queries never returned arrives here as `unknownEconomics`,
 * whose zeros are placeholders rather than measurements; reading them as a
 * share would compute 0.00% and tell the operator a brand is too small to
 * be worth promoting when the truth is we have no data on it. That is the
 * same false-confidence failure this change exists to remove, so it is
 * guarded on `has_data` and not on the numbers.
 */
function flagFor(
  econ: LabelEconomics,
  totalWeight: number,
): { status: PromotionItemStatus; flag_reason?: PromotionFlagReason; flag_detail?: string } {
  if (econ.lifecycle === 'dormant') {
    return { status: 'flagged', flag_reason: 'dormant', flag_detail: econ.lifecycle_reason };
  }
  // No row for this label: we know nothing, so hold nothing back. It reached
  // the plan on catalog mass, which is evidence enough to propose it.
  if (!econ.has_data) return { status: 'would_create' };
  if (totalWeight <= 0) return { status: 'would_create' };
  const share = econ.economic_weight / totalWeight;
  if (share < MEANINGFUL_ECONOMIC_SHARE) {
    return {
      status: 'flagged',
      flag_reason: 'negligible',
      flag_detail:
        `${fmtMoney(econ.economic_weight)} of trailing revenue and ad spend, ` +
        `${(share * 100).toFixed(2)}% of this account`,
    };
  }
  return { status: 'would_create' };
}

/** A label counts as the "dominant" sub-brand candidate for the old-brand
 *  re-bind proposal once it carries at least this share of the meaningfully-
 *  massed retail units under consideration. Tunable; not itself a value the
 *  design doc's evidence measured — a documented default, same posture as
 *  discovery.ts's RETAIL_BLANK_DOMINATED_THRESHOLD / MEANINGFUL_LABEL_SHARE. */
export const DOMINANT_LABEL_SHARE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export interface BuildPromotionPlanOptions {
  dataDirOverride?: string;
  now?: Date;
  /** Per-label economics, keyed by label. Optional: when absent every item
   *  reports `unknown` lifecycle and zero weight, and ranking falls back to
   *  catalog mass — the pre-economics behaviour, so a caller that cannot
   *  reach the economics queries still gets a usable (if unranked) plan
   *  rather than an empty one. */
  economics?: Map<string, LabelEconomics>;
}

/**
 * Build a promotion plan from an already-fetched CoverageReport. Never
 * writes anything. Idempotent: re-running against the same warehouse state
 * after a PARTIAL apply (some labels already promoted) proposes only the
 * remainder — every already-bound label is reported as `already_bound`
 * with its real slug, not re-proposed as `would_create`.
 */
export async function buildPromotionPlan(
  report: CoverageReport,
  resolvedSellerIds: readonly number[],
  sellerName: string,
  opts: BuildPromotionPlanOptions = {},
): Promise<PromotionPlan> {
  const amazonSellerId = report.seller_id;
  const economics = opts.economics ?? new Map<string, LabelEconomics>();

  // Candidates come from EITHER gate: meaningful catalog mass (breadth) or
  // meaningful economic weight (money). Union, not intersection — a brand
  // can be large in one and small in the other, and either alone is reason
  // enough to put it in front of the operator.
  const totalWeight = [...economics.values()].reduce((sum, e) => sum + e.economic_weight, 0);
  const byMass = meaningfulRetailLabels(report.retail);
  const candidateLabels = new Map<string, SideLabelBreakdown>();
  for (const l of byMass) candidateLabels.set(l.label, l);
  if (totalWeight > 0) {
    for (const [label, econ] of economics) {
      if (label === UNCLASSIFIED_LABEL) continue;
      if (candidateLabels.has(label)) continue;
      if (econ.economic_weight / totalWeight < MEANINGFUL_ECONOMIC_SHARE) continue;
      // Economically significant but below the catalog-mass gate — exactly
      // the brand the item-count ranking used to drop. Carry its real retail
      // units through if discovery saw the label at all, else zero.
      //
      // Fall back to the label COLUMN economics reported when coverage never
      // returned a row. Without it this candidate reaches the write path with
      // no source and no ads, and builds a binding carrying no label filter
      // at all — a "sub-brand" scoped to the entire account, which is the
      // smearing hazard design §11 exists to prevent.
      const seen = report.retail.labels.find((r) => r.label === label);
      candidateLabels.set(label, {
        label,
        source: seen?.source ?? econ.retail_source ?? '',
        units: seen?.units ?? 0,
      });
    }
  }
  const meaningfulLabels = [...candidateLabels.values()];

  const { index } = await readIndex(opts.dataDirOverride);
  const candidateBrands = index.brands.filter((b) =>
    b.accounts.some((a) => resolvedSellerIds.includes(a.seller_id)),
  );

  const boundEntries: Array<{ slug: string; binding: BindingBlock }> = [];
  let oldBrandCandidate: IndexBrand | null = null;
  const extraUnbound: IndexBrand[] = [];
  for (const b of candidateBrands) {
    const binding = await resolveBinding(b.slug, opts.dataDirOverride);
    if (binding) {
      boundEntries.push({ slug: b.slug, binding });
    } else if (oldBrandCandidate === null) {
      oldBrandCandidate = b;
    } else {
      extraUnbound.push(b);
    }
  }

  // Reserve minted slugs WITHIN this same plan too, so two labels that
  // slugify to the same base never collide with each other in one run
  // (mintSlug only dedupes against what it's told about).
  const reservedSlugs = await collectExistingSlugs(opts.dataDirOverride);

  const items: PromotionPlanItem[] = [];
  for (const entry of meaningfulLabels) {
    const boundMatch = boundEntries.find(
      (e) =>
        e.binding.amazon_seller_id === amazonSellerId &&
        (e.binding.retail_label?.value === entry.label || e.binding.ads_label?.value === entry.label),
    );
    const adsBreakdown = report.ads.labels.find((l) => l.label === entry.label);
    const econ = economics.get(entry.label) ?? unknownEconomics(entry.label);
    // Coverage first, economics as the fallback: a label can be missing from
    // the ads COVERAGE query and still carry real spend in economics, and
    // that is enough to bind an ads filter on.
    const adsSource = (adsBreakdown?.source || econ.ads_source) ?? null;
    const econFields = {
      revenue_365d: econ.revenue_365d,
      spend_365d: econ.spend_365d,
      economic_weight: econ.economic_weight,
      lifecycle: econ.lifecycle,
      lifecycle_reason: econ.lifecycle_reason,
    };
    if (boundMatch) {
      items.push({
        label: entry.label,
        retail_source: entry.source || null,
        retail_units: entry.units,
        ads_campaign_count: adsBreakdown?.units ?? 0,
        has_ads: adsBreakdown !== undefined,
        ads_source: adsSource,
        ...econFields,
        proposed_slug: boundMatch.slug,
        status: 'already_bound',
        existing_slug: boundMatch.slug,
      });
      continue;
    }
    const proposedSlug = mintSlug(entry.label, reservedSlugs, sellerName);
    reservedSlugs.add(proposedSlug);
    items.push({
      label: entry.label,
      retail_source: entry.source || null,
      retail_units: entry.units,
      ads_campaign_count: adsBreakdown?.units ?? 0,
      has_ads: adsBreakdown !== undefined,
      ads_source: adsSource,
      ...econFields,
      proposed_slug: proposedSlug,
      // A flagged label is NOT dropped. It stays in the plan with its real
      // numbers and its reason, so the operator sees the whole account and
      // decides; it is simply not proposed for creation by default.
      // Removing it would break the plan's totals against Seller Central
      // and hide a brand someone may be looking for.
      ...flagFor(econ, totalWeight),
    });
  }

  // Rank in dollars. This is the ordering the operator reads top-down, and
  // ranking it by item count is what put a brand with $695 of trailing
  // revenue above one worth millions. Ties (and accounts with no economics
  // at all) fall back to catalog mass so ordering stays stable rather than
  // arbitrary. Flagged-dormant items sort last within their weight so the
  // actionable candidates lead.
  items.sort((a, b) => {
    const aFlagged = a.status === 'flagged' ? 1 : 0;
    const bFlagged = b.status === 'flagged' ? 1 : 0;
    if (aFlagged !== bFlagged) return aFlagged - bFlagged;
    if (b.economic_weight !== a.economic_weight) return b.economic_weight - a.economic_weight;
    return b.retail_units - a.retail_units;
  });

  const oldBrand = oldBrandCandidate
    ? await buildOldBrandPlan(oldBrandCandidate, items, opts.dataDirOverride)
    : null;

  return {
    seller_id: amazonSellerId,
    generated_at: (opts.now ?? new Date()).toISOString(),
    items,
    old_brand: oldBrand,
    additional_unbound_brands: extraUnbound.map((b) => b.slug),
    notice: FIRST_LIVE_PROMOTION_NOTICE,
  };
}

async function buildOldBrandPlan(
  brand: IndexBrand,
  items: readonly PromotionPlanItem[],
  dataDirOverride?: string,
): Promise<OldBrandPlan> {
  const totalUnits = items.reduce((n, i) => n + i.retail_units, 0);
  // Only a label the plan would actually propose can be the survivor.
  // Choosing the top label by units regardless of status let this recommend
  // re-binding the account's historical brand onto a label the SAME plan
  // flags as wound down or economically trivial — a self-contradicting
  // proposal, and on the reported account the flagged label was also the
  // one carrying the largest stale catalog, so it won on units every time.
  const rebindable = items.filter((i) => i.status !== 'flagged');
  const dominant = [...rebindable].sort((a, b) => b.retail_units - a.retail_units)[0];
  // The share stays measured against EVERY label's units, flagged ones
  // included, so the percentage the operator reads still reconciles against
  // the account rather than against a filtered subset.
  const dominantShare = dominant && totalUnits > 0 ? dominant.retail_units / totalUnits : 0;
  const proposeRebind = rebindable.length > 0 && dominantShare >= DOMINANT_LABEL_SHARE_THRESHOLD;

  const validated = await validateBrandContext(brand.slug, dataDirOverride);
  const triage = validated.ok
    ? buildTriageProposals(validated.context, items)
    : [
        {
          section: 'context.yaml',
          summary: `Could not read/validate "${brand.slug}"'s existing context (${validated.kind}).`,
          proposed_disposition: 'retire' as const,
          rationale:
            'Existing context failed to validate; review this brand by hand before promoting labels for its account.',
        },
      ];

  return {
    slug: brand.slug,
    display_name: brand.display_name,
    proposed_disposition: proposeRebind ? 'rebind_as_dominant' : 'retire',
    ...(proposeRebind && dominant ? { dominant_label: dominant.label } : {}),
    rationale: proposeRebind && dominant
      ? `"${dominant.label}" carries ${(dominantShare * 100).toFixed(0)}% of meaningfully-massed retail units; re-binding "${brand.slug}" as that sub-brand keeps its history on the surviving slug.`
      : items.length === 0
        ? 'No label carries meaningful retail mass yet, so there is nothing to re-bind this brand as.'
        : `No single label dominates (top label carries ${(dominantShare * 100).toFixed(0)}% of meaningfully-massed retail units); retiring keeps the brand roster honest rather than picking a fuzzy winner.`,
    triage,
  };
}

/**
 * Per-fact/structural_event/instruction disposition PROPOSALS for an
 * already-onboarded whole-account brand being triaged ahead of promotion
 * (design doc §5.1). Pure function over an already-validated context.
 * PROPOSAL ONLY — the caller (the skill, the AM) edits these; nothing here
 * is auto-applied.
 *
 * Heuristic, documented per-section:
 *   - structural_events[]: text-matched against the plan's labels — a match
 *     proposes move_to that label's slug; no match defaults to
 *     copy_into_all (never silently drop an event; an account-wide event
 *     like Prime Day is exactly this case).
 *   - sub_brands[] rows that name a label being promoted retire (the
 *     binding now encodes the same identity — design doc §2.3).
 *   - negation.protected_terms[]: text-matched the same way; unmatched
 *     terms default to copy_into_all (shared negation policy).
 *   - management / posture / goals / bid_health / reporting: account-level
 *     operating settings copy_into_all (design doc's copy-at-setup rule —
 *     shared answers, never a read-time merge).
 *   - brand_terms: copy_into_all by default; the design doc calls out that
 *     entries existing only to explain the OLD label taxonomy should retire
 *     in favor of the binding, so this is flagged for human review rather
 *     than auto-classified (a term map has no single canonical text field to
 *     pattern-match against safely).
 */
export function buildTriageProposals(
  context: BrandContext,
  items: readonly PromotionPlanItem[],
): OldBrandTriageItem[] {
  const proposals: OldBrandTriageItem[] = [];

  (context.structural_events ?? []).forEach((event, idx) => {
    const match = matchAgainstItems(event.interpretation, items);
    proposals.push({
      section: `structural_events[${idx}]`,
      summary: truncate(event.interpretation, 140),
      proposed_disposition: match ? 'move_to' : 'copy_into_all',
      ...(match ? { proposed_target_slug: match.proposed_slug } : {}),
      rationale: match
        ? `Mentions the "${match.label}" label by name.`
        : 'No label match found; treated as account-wide/shared by default so no sub-brand loses this event.',
    });
  });

  (context.sub_brands ?? []).forEach((sb, idx) => {
    const match = items.find((i) => i.label.toLowerCase() === sb.name.toLowerCase());
    proposals.push({
      section: `sub_brands[${idx}]`,
      summary: `sub_brands entry "${sb.name}"`,
      proposed_disposition: match ? 'retire' : 'copy_into_all',
      ...(match ? { proposed_target_slug: match.proposed_slug } : {}),
      rationale: match
        ? 'This row names a label becoming its own bound sub-brand; the binding now encodes the same identity (design doc §2.3), so the duplicate row retires.'
        : 'No matching promoted label; carrying forward as a shared reference unless corrected.',
    });
  });

  for (const term of context.negation?.protected_terms ?? []) {
    const match = matchAgainstItems(term, items);
    proposals.push({
      section: 'negation.protected_terms',
      summary: `protected term "${term}"`,
      proposed_disposition: match ? 'move_to' : 'copy_into_all',
      ...(match ? { proposed_target_slug: match.proposed_slug } : {}),
      rationale: match
        ? `Mentions the "${match.label}" label by name.`
        : 'No label match; account-wide negation policy defaults to copying into every sub-brand.',
    });
  }

  const sharedSections: Array<{ key: 'management' | 'posture' | 'goals' | 'bid_health' | 'reporting' }> = [
    { key: 'management' },
    { key: 'posture' },
    { key: 'goals' },
    { key: 'bid_health' },
    { key: 'reporting' },
  ];
  for (const s of sharedSections) {
    if (context[s.key] === undefined) continue;
    proposals.push({
      section: s.key,
      summary: `${s.key} settings`,
      proposed_disposition: 'copy_into_all',
      rationale:
        'Account-level operating settings: the design copies shared answers into every sub-brand at setup, never a read-time merge (design doc §4.2 step 3 / §5.1).',
    });
  }

  if (context.brand_terms !== undefined) {
    proposals.push({
      section: 'brand_terms',
      summary: 'brand_terms map',
      proposed_disposition: 'copy_into_all',
      rationale:
        'Brand-term dictionaries are usually shared vocabulary. Review by hand for entries that exist only to explain the OLD label taxonomy; those retire in favor of the binding (design doc §5.1), which this heuristic cannot detect from the map alone.',
    });
  }

  return proposals;
}

function matchAgainstItems(
  text: string,
  items: readonly PromotionPlanItem[],
): PromotionPlanItem | null {
  const lower = text.toLowerCase();
  return items.find((i) => lower.includes(i.label.toLowerCase())) ?? null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Apply — ONE decision at a time
// ---------------------------------------------------------------------------

export type PromotionDecision =
  | { action: 'promote_label'; label: string }
  | { action: 'retire_old_brand' }
  | { action: 'rebind_old_brand'; label: string }
  | { action: 'cancel' };

export interface PromotionApplyResult {
  status: 'ok' | 'validation_failed' | 'cancelled';
  detail: string;
  slug?: string;
  did_write: boolean;
  validation_issues: Array<{ field: string; message: string }>;
}

export interface ApplyPromotionOptions {
  dataDirOverride?: string;
  sellerName: string;
  resolvedSellerIds: readonly number[];
}

/**
 * Execute exactly ONE decision against an already-built plan. `decision`
 * arrives from an unchecked `JSON.parse(...) as PromotionDecision` at the
 * CLI layer — see module header. Every branch validates before writing;
 * anything unrecognized returns `validation_failed` and touches nothing.
 */
export async function applyPromotionDecision(
  plan: PromotionPlan,
  decision: PromotionDecision,
  opts: ApplyPromotionOptions,
): Promise<PromotionApplyResult> {
  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) {
    return failClosed('action', `Expected a decision object, got ${describeJsonType(decision)}.`);
  }

  const action = (decision as { action?: unknown }).action;

  if (action === 'cancel') {
    return { status: 'cancelled', detail: 'Cancelled. No changes saved.', did_write: false, validation_issues: [] };
  }

  if (action === 'promote_label') {
    const rawLabel: unknown = (decision as { label?: unknown }).label;
    if (typeof rawLabel !== 'string' || rawLabel.trim().length === 0) {
      return failClosed('label', `Expected a non-empty string, got ${describeJsonType(rawLabel)}.`);
    }
    const item = plan.items.find((i) => i.label === rawLabel);
    if (!item) {
      return failClosed(
        'label',
        `"${rawLabel}" is not in this plan's items. Re-run \`mixshift brand promote --seller-id ${plan.seller_id}\` to refresh the plan.`,
      );
    }
    return await promoteLabelItem(item, plan.seller_id, opts);
  }

  if (action === 'retire_old_brand') {
    if (!plan.old_brand) {
      return failClosed('action', 'This plan has no existing whole-account brand to retire.');
    }
    return await retireOldBrand(plan.old_brand.slug, opts.dataDirOverride);
  }

  if (action === 'rebind_old_brand') {
    if (!plan.old_brand) {
      return failClosed('action', 'This plan has no existing whole-account brand to re-bind.');
    }
    const rawLabel: unknown = (decision as { label?: unknown }).label;
    if (typeof rawLabel !== 'string' || rawLabel.trim().length === 0) {
      return failClosed('label', `Expected a non-empty string, got ${describeJsonType(rawLabel)}.`);
    }
    const item = plan.items.find((i) => i.label === rawLabel);
    if (!item) {
      return failClosed('label', `"${rawLabel}" is not in this plan's items.`);
    }
    return await rebindOldBrand(plan.old_brand.slug, item, plan.seller_id, opts);
  }

  return failClosed(
    'action',
    `Unknown action ${JSON.stringify(action)}. Expected "promote_label", "retire_old_brand", "rebind_old_brand", or "cancel".`,
  );
}

function failClosed(field: string, message: string): PromotionApplyResult {
  return { status: 'validation_failed', detail: message, did_write: false, validation_issues: [{ field, message }] };
}

async function promoteLabelItem(
  item: PromotionPlanItem,
  amazonSellerId: string,
  opts: ApplyPromotionOptions,
): Promise<PromotionApplyResult> {
  if (item.status === 'already_bound' && item.existing_slug) {
    return {
      status: 'ok',
      detail: `"${item.label}" is already bound to "${item.existing_slug}". Nothing to do (idempotent re-run).`,
      slug: item.existing_slug,
      did_write: false,
      validation_issues: [],
    };
  }

  const slug = item.proposed_slug;

  // Idempotent re-run guard: a prior partial apply may have already created
  // this directory even though the freshly-built plan (moments earlier)
  // could theoretically still race a concurrent run. Re-check its binding
  // directly rather than trusting the in-memory item.
  if (await brandDirExists(slug, opts.dataDirOverride)) {
    const existingBinding = await resolveBinding(slug, opts.dataDirOverride);
    const matches =
      existingBinding !== null &&
      existingBinding.amazon_seller_id === amazonSellerId &&
      (existingBinding.retail_label?.value === item.label || existingBinding.ads_label?.value === item.label);
    if (matches) {
      return {
        status: 'ok',
        detail: `"${item.label}" is already bound to "${slug}" (re-run picked up an existing promotion).`,
        slug,
        did_write: false,
        validation_issues: [],
      };
    }

    // ORPHAN RECOVERY. A promotion that died between bootstrap and the
    // binding write leaves a directory at exactly this slug with NO binding.
    // Refusing outright (the previous behavior) contradicted this module's
    // own re-runnability contract and stranded the operator with a brand that
    // reads account-wide data under a sub-brand's name. Complete it instead,
    // but ONLY when it is unmistakably our own interrupted work: no binding at
    // all, and a display name equal to this label. Anything else still refuses.
    if (existingBinding === null) {
      const validated = await validateBrandContext(slug, opts.dataDirOverride);
      // bootstrap writes `brand_name: suggestion.display_name`, and promotion
      // passes the label as display_name — so brand_name === label is the
      // fingerprint of our own interrupted bootstrap for THIS label.
      if (validated.ok && validated.context.brand_name === item.label) {
        const recoveryBinding = buildBindingBlock({
          amazonSellerId,
          resolvedSellerIds: opts.resolvedSellerIds,
          label: item.label,
          retailSource: item.retail_source ?? undefined,
          hasAds: item.has_ads,
          adsSource: item.ads_source ?? undefined,
        });
        if (recoveryBinding === null) return failClosed('label', noLabelFilterMessage(item.label));
        const recovered = await writeBindingBlock(slug, recoveryBinding, opts.dataDirOverride);
        if (!recovered.ok) return failClosed('label', recovered.detail);
        return {
          status: 'ok',
          detail: `Completed an interrupted promotion of "${item.label}" to "${slug}" (the brand directory already existed without a binding; the binding is now written and published).`,
          slug,
          did_write: true,
          validation_issues: [],
        };
      }
    }

    return failClosed(
      'label',
      `A brand directory already exists at slug "${slug}" but is not bound to "${item.label}" on this account. Refusing to overwrite it; investigate the existing brand by hand.`,
    );
  }

  const sellers = await discoverSellers({ dataDirOverride: opts.dataDirOverride, includeInactive: true });
  const accounts = sellers.filter((s) => opts.resolvedSellerIds.includes(s.seller_id));
  if (accounts.length === 0) {
    return failClosed(
      'label',
      `No warehouse account rows resolved for seller_id(s) ${opts.resolvedSellerIds.join(', ')}; cannot create "${slug}".`,
    );
  }

  const suggestion: BrandSuggestion = {
    slug,
    display_name: item.label,
    accounts,
    ads_active: accounts.some((a) => a.ads_active),
    retail_active: accounts.some((a) => a.retail_active),
  };

  // Build the binding BEFORE anything is created on disk. A candidate we
  // cannot scope must not leave a bootstrapped directory behind: that strands
  // exactly the unbound, sub-brand-named brand the orphan-recovery path below
  // has to clean up, for a promotion that was never going to succeed.
  const binding = buildBindingBlock({
    amazonSellerId,
    resolvedSellerIds: opts.resolvedSellerIds,
    label: item.label,
    retailSource: item.retail_source ?? undefined,
    hasAds: item.has_ads,
    adsSource: item.ads_source ?? undefined,
  });
  if (binding === null) return failClosed('label', noLabelFilterMessage(item.label));

  const { bootstrapBrand } = await import('../clients/bootstrap.js');
  try {
    // deferPush: publish ONCE, after the binding lands (see BootstrapOptions).
    // Publishing here would put an unbound, sub-brand-named brand into the
    // shared org store for as long as the binding write takes — or forever,
    // if it fails.
    await bootstrapBrand(suggestion, { dataDirOverride: opts.dataDirOverride, deferPush: true });
  } catch (err) {
    return failClosed('label', err instanceof Error ? err.message : String(err));
  }

  const writeResult = await writeBindingBlock(slug, binding, opts.dataDirOverride);
  if (!writeResult.ok) {
    return failClosed('label', writeResult.detail);
  }

  await upsertIndexRow(suggestion, opts.dataDirOverride);

  return {
    status: 'ok',
    detail: `Promoted "${item.label}" to sub-brand "${slug}".`,
    slug,
    did_write: true,
    validation_issues: [],
  };
}

async function retireOldBrand(
  slug: string,
  dataDirOverride?: string,
): Promise<PromotionApplyResult> {
  const parked = await parkBrandDirectory(slug, dataDirOverride);
  return {
    status: 'ok',
    detail: parked.parked
      ? `Retired "${slug}" on THIS machine (local directory parked; nothing deleted). ` +
        'Its org-store documents and revision history stay intact, which also means ' +
        'teammates and your other machines still see this brand as active until they ' +
        'retire it locally too. Tell whoever else works this account.'
      : `Nothing to retire for "${slug}" (${parked.reason}).`,
    slug,
    did_write: parked.parked,
    validation_issues: [],
  };
}

async function rebindOldBrand(
  slug: string,
  item: PromotionPlanItem,
  amazonSellerId: string,
  opts: ApplyPromotionOptions,
): Promise<PromotionApplyResult> {
  const existingBinding = await resolveBinding(slug, opts.dataDirOverride);
  if (existingBinding) {
    return failClosed(
      'action',
      `"${slug}" already has a binding; refusing to overwrite it via rebind_old_brand. Use promote_label if you meant to create a NEW sub-brand instead.`,
    );
  }
  const binding = buildBindingBlock({
    amazonSellerId,
    resolvedSellerIds: opts.resolvedSellerIds,
    label: item.label,
    retailSource: item.retail_source ?? undefined,
    hasAds: item.has_ads,
    adsSource: item.ads_source ?? undefined,
  });
  if (binding === null) return failClosed('label', noLabelFilterMessage(item.label));
  const writeResult = await writeBindingBlock(slug, binding, opts.dataDirOverride);
  if (!writeResult.ok) return failClosed('label', writeResult.detail);
  return {
    status: 'ok',
    detail: `Re-bound "${slug}" as the dominant sub-brand for "${item.label}". Its history stays on this slug.`,
    slug,
    did_write: true,
    validation_issues: [],
  };
}

// ---------------------------------------------------------------------------
// Binding block construction + write (shared by promote_label + rebind)
// ---------------------------------------------------------------------------

/**
 * Build the binding block for a sub-brand, or return null when it would
 * carry no label filter.
 *
 * Both `retail_label` and `ads_label` are optional in the schema, so a
 * candidate with no retail source and no ads produced a `sub_brand` binding
 * scoped only by `amazon_seller_id` — a "sub-brand" that silently reads the
 * WHOLE account, published to the org store, and indistinguishable
 * downstream from a legitimately account-wide brand. That is precisely the
 * smearing design §11 forbids, and the scope_note would have asserted a
 * label filter that the binding did not actually contain.
 *
 * Returning null makes it unbuildable rather than merely unlikely; every
 * caller fails closed on it, and writeBindingBlock re-checks the invariant
 * for any future caller that forgets.
 */
function buildBindingBlock(args: {
  amazonSellerId: string;
  resolvedSellerIds: readonly number[];
  label: string;
  retailSource?: string;
  hasAds: boolean;
  adsSource?: string;
}): BindingBlock | null {
  const binding: BindingBlock = {
    kind: 'sub_brand',
    amazon_seller_id: args.amazonSellerId,
    seller_ids: [...args.resolvedSellerIds],
    scope_note: buildScopeNote(args.label, args.amazonSellerId),
  };
  if (args.retailSource) {
    binding.retail_label = { source: args.retailSource, value: args.label };
  }
  if (args.hasAds) {
    binding.ads_label = { source: 'campaign.Brand', value: args.label };
  } else if (args.adsSource) {
    // Coverage never returned this label, but economics saw spend under it,
    // so the column economics reported is a valid filter to bind on.
    binding.ads_label = { source: args.adsSource, value: args.label };
  }
  if (!binding.retail_label && !binding.ads_label) return null;
  return binding;
}

/** The operator-facing explanation for a refused unfiltered binding. Shared
 *  by all three write paths so they cannot drift. */
function noLabelFilterMessage(label: string): string {
  return (
    `Refusing to bind "${label}": neither a retail label column nor an ads label column ` +
    'is known for it, so the binding would carry no label filter and the new brand would ' +
    'read the entire seller account instead of this sub-brand. This usually means the ' +
    'discovery queries returned it on no side, or the gateway economics entries ' +
    '(sbd-05/06/07) are not deployed yet. Re-run `brand promote` once discovery reports ' +
    'a complete fetch.'
  );
}

/** Plain-language, model-visible scope note (design doc §11's "old clients
 *  are the residual smearing hazard" mitigation — readable on ANY plugin
 *  version, even one that cannot parse `binding` at all). No em dashes;
 *  matches the house customer-facing copy rules. */
export function buildScopeNote(label: string, amazonSellerId: string): string {
  return (
    `This brand is a sub-brand: it is scoped to the "${label}" label under Amazon Seller ID ${amazonSellerId}. ` +
    'Any data fetch or analysis for this brand must use that label filter. ' +
    'Account-wide numbers for the seller account must never be attributed to this brand specifically.'
  );
}

interface WriteBindingResult {
  ok: boolean;
  detail: string;
}

/** Read a brand's context.yaml, merge in `binding`, validate the WHOLE
 *  resulting context (not just the binding block) against contextSchema,
 *  and only then write. Fails closed: an invalid binding or a merge that
 *  would make the context invalid writes nothing. */
async function writeBindingBlock(
  slug: string,
  binding: BindingBlock,
  dataDirOverride?: string,
): Promise<WriteBindingResult> {
  const validatedBinding = bindingSchema.safeParse(binding);
  if (!validatedBinding.success) {
    return { ok: false, detail: `Refusing to write an invalid binding block: ${formatZodError(validatedBinding.error)}` };
  }

  // LAST LINE OF DEFENCE. bindingSchema cannot express this: both label
  // filters are individually optional (a sub-brand can legitimately live on
  // retail only, or ads only), so only the pair being absent is illegal, and
  // that is a cross-field rule. A sub_brand binding with neither filter
  // scopes to the entire seller account while its scope_note claims
  // otherwise. buildBindingBlock already refuses to construct one; this
  // catches any future caller that assembles a binding by hand.
  if (
    validatedBinding.data.kind === 'sub_brand' &&
    !validatedBinding.data.retail_label &&
    !validatedBinding.data.ads_label
  ) {
    return {
      ok: false,
      detail:
        `Refusing to write a sub-brand binding for "${slug}" with no label filter: it would ` +
        'scope to the whole seller account rather than to this sub-brand.',
    };
  }

  const path = contextPath(slug, dataDirOverride);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      detail: `Could not read context.yaml for "${slug}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed: unknown = parseYaml(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, detail: `context.yaml for "${slug}" did not parse to an object; refusing to write a binding into it.` };
  }

  const merged = { ...(parsed as Record<string, unknown>), binding: validatedBinding.data };
  const fullCheck = contextSchema.safeParse(merged);
  if (!fullCheck.success) {
    return { ok: false, detail: `Adding this binding would make "${slug}"'s context.yaml invalid: ${formatZodError(fullCheck.error)}` };
  }

  // Write `merged` (the RAW parsed document plus the validated binding), NOT
  // fullCheck.data. contextSchema is a stripping zod object, so its parsed
  // output DELETES every key the current schema does not know about — and
  // this file is then published to the org store by pushAfterWrite below.
  // Writing the parsed output would silently destroy fields written by a
  // NEWER plugin version (or added by hand) on the customer's real context,
  // fleet-wide, breaking the forward-tolerance invariant every other shipped
  // writer honors (design doc §2.2). Validation above is a GATE, not the
  // serialization source.
  await writeYamlAtomic(path, merged);
  await pushAfterWrite(slug, { dataDirOverride });
  return { ok: true, detail: 'binding written' };
}

async function writeYamlAtomic(path: string, obj: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const yamlText = stringifyYaml(obj, { indent: 2, lineWidth: 0 });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, yamlText, 'utf-8');
  await rename(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Local registry upsert (a promoted sub-brand needs a row so slug-based
// commands like `mixshift brand config <slug>` can resolve it — see module
// header; discovery-driven refreshes never derive it on their own because it
// is not a seller-NAME grouping, so this is the only place that writes it)
// ---------------------------------------------------------------------------

async function upsertIndexRow(suggestion: BrandSuggestion, dataDirOverride?: string): Promise<void> {
  const { index, source } = await readIndex(dataDirOverride);
  const base = source === 'empty' ? emptyIndex() : index;
  const row: IndexBrand = {
    slug: suggestion.slug,
    display_name: suggestion.display_name,
    ads_active: suggestion.ads_active,
    retail_active: suggestion.retail_active,
    is_dormant: !suggestion.ads_active && !suggestion.retail_active,
    // context.yaml already exists the moment this runs — cold_started is a
    // true fact, not an aspiration.
    cold_started: true,
    cold_started_at: new Date().toISOString(),
    accounts: suggestion.accounts.map((a) => ({
      seller_id: a.seller_id,
      seller_name: a.seller_name,
      merchant_alias: a.merchant_alias,
      account_type: a.account_type,
      marketplace: a.marketplace,
      region: a.region,
      is_active: a.is_active,
      is_mws_user: a.has_mws,
      ads_active: a.ads_active,
      retail_active: a.retail_active,
    })),
  };
  const next = [...base.brands.filter((b) => b.slug !== suggestion.slug), row];
  await saveIndex({ ...base, brands: next }, dataDirOverride);
}

async function removeIndexRow(slug: string, dataDirOverride?: string): Promise<void> {
  const { index, source } = await readIndex(dataDirOverride);
  if (source === 'empty') return;
  const next = index.brands.filter((b) => b.slug !== slug);
  if (next.length === index.brands.length) return;
  await saveIndex({ ...index, brands: next }, dataDirOverride);
}

// ---------------------------------------------------------------------------
// Parking (shared by promote's retire_old_brand and demote.ts)
// ---------------------------------------------------------------------------

export interface ParkResult {
  parked: boolean;
  parked_dir?: string;
  reason?: string;
}

/**
 * Move a brand's local directory out of the active namespace WITHOUT
 * deleting anything — the design doc's "park the local dir" (§5, §5.1).
 * `${slug}.parked` can never collide with a real brand_slug (the schema's
 * brand_slug regex forbids '.'), so a parked directory is guaranteed
 * invisible to every slug-based lookup going forward. Reversible in
 * principle (rename back), but the DOCUMENTED restore path is a revision
 * pull from the org store, not an un-park — see demote.ts.
 *
 * Idempotent: parking an already-parked (or never-created) brand is a
 * no-op, reported via `reason`, never an error.
 */
export async function parkBrandDirectory(slug: string, dataDirOverride?: string): Promise<ParkResult> {
  if (!(await brandDirExists(slug, dataDirOverride))) {
    return { parked: false, reason: 'no local directory to park' };
  }
  const parkedSlug = `${slug}.parked`;
  if (await brandDirExists(parkedSlug, dataDirOverride)) {
    return { parked: false, reason: `already parked at "${parkedSlug}"` };
  }
  const from = brandDir(slug, dataDirOverride);
  const to = brandDir(parkedSlug, dataDirOverride);
  await rename(from, to);
  await removeIndexRow(slug, dataDirOverride);
  return { parked: true, parked_dir: to };
}
