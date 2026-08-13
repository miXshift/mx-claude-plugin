import { describe, it, expect, vi } from 'vitest';
import {
  ACCOUNT_NAMESPACE_PREFIX,
  accountNamespaceSlug,
  coverageIdempotencyKey,
  buildCoverageStakePayload,
  emitCoverageStake,
  evidenceByteLength,
  MAX_EVIDENCE_BYTES,
} from './stake.js';
import { assembleCoverageReport } from './discovery.js';
import type { TimelineClient } from '../timeline/client.js';
import type { PostTimelineEventResult } from '../timeline/types.js';

// Same brand_slug shape the gateway's timeline route enforces
// (mx-legacy-auth src/routes/timeline.ts BRAND_SLUG_RE) and the
// harness's own context/schema.ts brand_slug regex — see stake.ts header.
const BRAND_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function sampleReport(sellerId = 'A1EXAMPLE23456') {
  return assembleCoverageReport({
    sellerId,
    now: new Date('2026-08-12T00:00:00.000Z'),
    retailRows: [
      { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 40, row_count: 40 },
      { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 25, row_count: 25 },
    ],
    vendorRows: [],
    adsRows: [
      { SellerID: 1, source: 'campaign.Brand', label: '', campaign_count: 90 },
      { SellerID: 1, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: 10 },
    ],
    matchRows: [
      { label: 'Forager Pantry', retail_asins: 40, ads_campaigns: 10, has_retail: true, has_ads: true },
      { label: 'Alpine Trail', retail_asins: 25, ads_campaigns: 0, has_retail: true, has_ads: false },
    ],
  });
}

describe('accountNamespaceSlug — pinned spelling', () => {
  it('uses a hyphen, never the design doc\'s literal colon example', () => {
    expect(ACCOUNT_NAMESPACE_PREFIX).toBe('acct-');
    expect(accountNamespaceSlug('A1EXAMPLE23456')).toBe('acct-a1example23456');
  });

  it('lowercases the (conventionally uppercase) AmazonSellerID', () => {
    expect(accountNamespaceSlug('A1EXAMPLE23456')).not.toContain('A1EXAMPLE23456');
    expect(accountNamespaceSlug('A1EXAMPLE23456')).toBe(accountNamespaceSlug('a1example23456'));
  });

  it('the result satisfies BOTH the harness brand_slug regex and the server BRAND_SLUG_RE', () => {
    // Harness: lib/context/schema.ts brand_slug — /^[a-z][a-z0-9-]*$/
    const harnessRe = /^[a-z][a-z0-9-]*$/;
    const slug = accountNamespaceSlug('A1EXAMPLE23456');
    expect(slug).toMatch(harnessRe);
    expect(slug).toMatch(BRAND_SLUG_RE);
    expect(slug.length).toBeLessThanOrEqual(64);
  });

  it('a literal colon-spelled namespace would fail both validators (documents the finding)', () => {
    const docLiteral = 'acct:A1EXAMPLE23456';
    expect(BRAND_SLUG_RE.test(docLiteral)).toBe(false);
    expect(/^[a-z][a-z0-9-]*$/.test(docLiteral)).toBe(false);
  });
});

describe('coverageIdempotencyKey', () => {
  it('is deterministic for the same account + day', () => {
    const a = coverageIdempotencyKey('A1EXAMPLE23456', '2026-08-12');
    const b = coverageIdempotencyKey('A1EXAMPLE23456', '2026-08-12');
    expect(a).toBe(b);
  });

  it('differs across days (coverage is a standing, re-snapshotted metric)', () => {
    const day1 = coverageIdempotencyKey('A1EXAMPLE23456', '2026-08-12');
    const day2 = coverageIdempotencyKey('A1EXAMPLE23456', '2026-08-13');
    expect(day1).not.toBe(day2);
  });

  it('differs across accounts on the same day', () => {
    const acct1 = coverageIdempotencyKey('A1EXAMPLE23456', '2026-08-12');
    const acct2 = coverageIdempotencyKey('A2OTHERACCOUNT', '2026-08-12');
    expect(acct1).not.toBe(acct2);
  });
});

describe('buildCoverageStakePayload', () => {
  it('posts to the account namespace, never a brand slug', () => {
    const body = buildCoverageStakePayload(sampleReport());
    expect(body.brand_slug).toBe('acct-a1example23456');
  });

  it('uses family structural + category other (the harness escape, no fixed category fits)', () => {
    const body = buildCoverageStakePayload(sampleReport());
    expect(body.family).toBe('structural');
    expect(body.category).toBe('other');
    expect(body.kind).toBe('structural.sub_brand_coverage');
  });

  it('source is system (machine-computed, not a human declaration)', () => {
    expect(buildCoverageStakePayload(sampleReport()).source).toBe('system');
  });

  it('carries a non-empty interpretation naming the shape proposal as unconfirmed', () => {
    const body = buildCoverageStakePayload(sampleReport());
    expect(body.interpretation).toBeDefined();
    expect(body.interpretation!.length).toBeGreaterThan(0);
    expect(body.interpretation).toContain('unconfirmed');
    expect(body.interpretation).toContain('brand_nested_candidate');
  });

  it('sets the deterministic idempotency key from the report date', () => {
    const body = buildCoverageStakePayload(sampleReport());
    expect(body.idempotency_key).toBe(
      coverageIdempotencyKey('A1EXAMPLE23456', '2026-08-12'),
    );
  });

  it('evidence is a small fixed-shape summary, never a per-label dump', () => {
    const body = buildCoverageStakePayload(sampleReport());
    expect(body.evidence).toMatchObject({
      retail_distinct_labels: 2,
      ads_distinct_labels: 1,
      classification_proposal: 'brand_nested_candidate',
    });
    expect(body.evidence).not.toHaveProperty('labels');
    expect(body.evidence).not.toHaveProperty('retail');
  });
});

describe('evidence stays under the server cap regardless of account size', () => {
  it('a small account fits comfortably under MAX_EVIDENCE_BYTES', () => {
    expect(evidenceByteLength(sampleReport())).toBeLessThan(MAX_EVIDENCE_BYTES);
  });

  it('a LARGE account (many distinct labels) still fits — evidence is summary-only', () => {
    const manyLabels = Array.from({ length: 500 }, (_v, i) => ({
      SellerID: 1,
      source: 'mws_items.Brand',
      label: `Sub Brand Number ${i} With A Fairly Long Descriptive Name`,
      asin_count: 3,
      row_count: 3,
    }));
    const report = assembleCoverageReport({
      sellerId: 'A1EXAMPLE23456',
      now: new Date('2026-08-12T00:00:00.000Z'),
      retailRows: manyLabels,
      vendorRows: [],
      adsRows: [],
      matchRows: [],
    });
    expect(evidenceByteLength(report)).toBeLessThan(MAX_EVIDENCE_BYTES);
  });
});

describe('emitCoverageStake', () => {
  function stubClient(result: PostTimelineEventResult): TimelineClient {
    return {
      listEvents: vi.fn(),
      corroborateEvent: vi.fn(),
      postEvent: vi.fn(async () => result),
    } as unknown as TimelineClient;
  }

  it('reports created on a fresh post', async () => {
    const client = stubClient({ ok: true, id: 'evt-1' });
    const result = await emitCoverageStake(sampleReport(), { client });
    expect(result).toEqual({
      ok: true,
      outcome: 'created',
      event_id: 'evt-1',
      brand_slug: 'acct-a1example23456',
    });
  });

  it('reports duplicate when the idempotency key already resolved server-side', async () => {
    const client = stubClient({ ok: true, id: 'evt-1', duplicate: true });
    const result = await emitCoverageStake(sampleReport(), { client });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome).toBe('duplicate');
  });

  it('reports failed (never throws) on a server rejection', async () => {
    const client = stubClient({
      ok: false,
      kind: 'bad_params',
      message: 'bad',
      friendly: 'Something about the request was invalid.',
    });
    const result = await emitCoverageStake(sampleReport(), { client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toBe('Something about the request was invalid.');
      expect(result.brand_slug).toBe('acct-a1example23456');
    }
  });

  it('passes the built payload through to the client verbatim', async () => {
    const client = stubClient({ ok: true, id: 'evt-1' });
    await emitCoverageStake(sampleReport(), { client });
    expect(client.postEvent).toHaveBeenCalledWith(
      buildCoverageStakePayload(sampleReport()),
      {},
    );
  });
});
