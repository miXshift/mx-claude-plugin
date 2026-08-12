/**
 * Account-namespace coverage stake emission (mx-ops#6 P1;
 * docs/subbrand-architecture.md §2.2, §4.2 step 4, §6 in
 * mx-legacy-auth).
 *
 * After a label-discovery run (lib/binding/discovery.ts), optionally posts
 * one timeline stake summarizing coverage to the ACCOUNT namespace — never
 * to a brand slug, since discovery runs before any sub-brand exists.
 *
 * SLUG SPELLING (pinned below): the design doc's own prose writes the
 * namespace as `acct:<AmazonSellerID>` (a colon separator). That spelling
 * was verified against BOTH validators that would ever see it and FAILS
 * both:
 *
 *   - harness (this repo): every brand_slug regex in the codebase —
 *     lib/context/schema.ts, lib/clients/index-schema.ts,
 *     lib/brain/schema.ts — is `/^[a-z][a-z0-9-]*$/`. No colon, lowercase
 *     only.
 *   - server (mx-legacy-auth, read-only checked at
 *     src/routes/timeline.ts:70): `const BRAND_SLUG_RE =
 *     /^[a-z0-9][a-z0-9-]{0,63}$/`. No colon, lowercase only, and it is
 *     applied to BOTH the GET `brand` filter and the POST
 *     `brand_slug` field (postEventSchema), so a colon would 400 on
 *     every post, not just fail a client-side check.
 *
 * A colon fails BOTH, so this module uses the design doc's OWN documented
 * fallback spelling: a hyphen (`acct-<AmazonSellerID>`), pinned in the one
 * exported constant below. Reported back per the build brief.
 *
 * SECOND finding while pinning this: AmazonSellerID is conventionally
 * uppercase alphanumeric (e.g. "A1EXAMPLE23456"), but the slug charset
 * above is lowercase-only — the design doc's example does not spell out
 * the case transform. `accountNamespaceSlug` lowercases the id
 * deterministically; Amazon never emits two seller ids differing only by
 * case, so this is a safe, reversible-in-practice normalization, but it is
 * a second contradiction between the doc's literal example and what the
 * validators actually accept, so it is called out explicitly rather than
 * silently patched.
 */

import type { CoverageReport } from './discovery.js';
import { createTimelineClient, type TimelineClient } from '../timeline/client.js';
import type { PostTimelineEventInput, PostTimelineEventResult } from '../timeline/types.js';

/** PINNED — see module header. Never change without a migration plan: every
 *  already-emitted coverage stake is keyed under this prefix. */
export const ACCOUNT_NAMESPACE_PREFIX = 'acct-';

/** Server cap mirrored locally (mx-legacy-auth routes/timeline.ts
 *  MAX_EVIDENCE_BYTES = 4096), same pattern as
 *  lib/timeline/stake-sync.ts's MAX_INTERPRETATION_CHARS etc. */
export const MAX_EVIDENCE_BYTES = 4_096;
export const MAX_INTERPRETATION_CHARS = 4_000;

/** The account-namespace timeline slug for one Amazon Seller ID. See module
 *  header for why this is a hyphen, not the doc's literal colon example,
 *  and why the id is lowercased. */
export function accountNamespaceSlug(amazonSellerId: string): string {
  return `${ACCOUNT_NAMESPACE_PREFIX}${amazonSellerId.toLowerCase()}`;
}

/**
 * Deterministic idempotency key for one coverage snapshot: re-running
 * discovery + `--emit-stake` for the SAME account on the SAME UTC day
 * converges to the same event (server contract R10: a duplicate key
 * returns the existing id, no second row). A re-run on a LATER day mints a
 * new key, because coverage is a standing metric that is expected to move
 * over time (design doc §4.2 step 4) — each day's snapshot is its own stake,
 * not an update to a prior one.
 */
export function coverageIdempotencyKey(amazonSellerId: string, isoDate: string): string {
  return `acctcov:${accountNamespaceSlug(amazonSellerId)}:${isoDate}`;
}

/** The YYYY-MM-DD head of an ISO timestamp (UTC), used to key the
 *  idempotency day-bucket and to stamp the stake's own `ts`. */
function utcDatePart(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Build the wire POST body for one coverage snapshot. `category: 'other'`
 * is the harness's own designed escape (mirrors stake-sync.ts's
 * resolveCategory) — none of the 15 fixed stake categories describe a label
 * coverage snapshot, and `other` exists exactly so a real event is never
 * forced into the wrong fixed bucket. `source: 'system'` because this is a
 * machine-computed metric, not a human declaration — the classification
 * PROPOSAL inside it is explicitly unconfirmed (never auto-applied).
 *
 * Evidence is a small, FIXED-SHAPE summary (no per-label breakdown) so its
 * serialized size stays well under MAX_EVIDENCE_BYTES regardless of how
 * many labels a large account has — see stake.test.ts for a large-account
 * size check.
 */
export function buildCoverageStakePayload(report: CoverageReport): PostTimelineEventInput {
  const day = utcDatePart(report.generated_at);
  const interpretation = summarizeCoverage(report).slice(0, MAX_INTERPRETATION_CHARS);
  return {
    brand_slug: accountNamespaceSlug(report.seller_id),
    family: 'structural',
    kind: 'structural.sub_brand_coverage',
    category: 'other',
    source: 'system',
    interpretation,
    ts: report.generated_at,
    evidence: {
      recorded_from: 'mixshift brand discover --emit-stake',
      seller_id: report.seller_id,
      retail_distinct_labels: report.retail.distinct_labels,
      retail_unclassified_share: round2(report.retail.unclassified_share),
      ads_distinct_labels: report.ads.distinct_labels,
      ads_unclassified_share: round2(report.ads.unclassified_share),
      match_rate: report.match.match_rate === null ? null : round2(report.match.match_rate),
      classification_proposal: report.classification.proposal,
    },
    idempotency_key: coverageIdempotencyKey(report.seller_id, day),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarizeCoverage(report: CoverageReport): string {
  const matchPct =
    report.match.match_rate === null ? 'n/a' : `${(report.match.match_rate * 100).toFixed(0)}%`;
  // `proposal` is only ever null when the caller's fetch did not fully
  // succeed (see discovery.ts's insufficientDataClassification) — the CLI
  // never calls emitCoverageStake in that case (FINDING 1, red team over
  // PR #131), but this stays a defensive, honest fallback rather than
  // printing the literal string "null" if ever called directly.
  const proposalText =
    report.classification.proposal === null
      ? 'not available (insufficient data)'
      : `${report.classification.proposal} (unconfirmed — the user has not reviewed this)`;
  return (
    `Sub-brand label coverage for account ${report.seller_id}: retail side has ` +
    `${report.retail.distinct_labels} distinct label(s) (${(report.retail.unclassified_share * 100).toFixed(0)}% ` +
    `unclassified units), ads side has ${report.ads.distinct_labels} distinct label(s) ` +
    `(${(report.ads.unclassified_share * 100).toFixed(0)}% unclassified units), cross-side match rate ` +
    `${matchPct}. Shape proposal: ${proposalText}.`
  );
}

export interface EmitCoverageStakeOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to the real timeline client. */
  client?: TimelineClient;
  timeoutMs?: number;
}

export type EmitCoverageStakeResult =
  | { ok: true; outcome: 'created' | 'duplicate'; event_id: string; brand_slug: string }
  | { ok: false; outcome: 'failed'; detail: string; brand_slug: string };

/**
 * Post one coverage snapshot to the account namespace. Never throws:
 * network/validation failures are reported in the result, matching the
 * house pattern (lib/timeline/stake-sync.ts's syncStakes).
 */
export async function emitCoverageStake(
  report: CoverageReport,
  options: EmitCoverageStakeOptions = {},
): Promise<EmitCoverageStakeResult> {
  const body = buildCoverageStakePayload(report);
  const client = options.client ?? createTimelineClient({ dataDirOverride: options.dataDirOverride });
  const posted: PostTimelineEventResult = await client.postEvent(body, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (!posted.ok) {
    return { ok: false, outcome: 'failed', detail: posted.friendly, brand_slug: body.brand_slug };
  }
  return {
    ok: true,
    outcome: posted.duplicate ? 'duplicate' : 'created',
    event_id: posted.id,
    brand_slug: body.brand_slug,
  };
}

/** Exported for a defensive size test — computes the serialized byte length
 *  of one stake's evidence object, the same measure the server enforces. */
export function evidenceByteLength(report: CoverageReport): number {
  const body = buildCoverageStakePayload(report);
  return Buffer.byteLength(JSON.stringify(body.evidence ?? {}), 'utf8');
}
