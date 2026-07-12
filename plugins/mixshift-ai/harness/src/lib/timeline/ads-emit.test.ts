import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import {
  emitAdsCommitEvent,
  extractEntityIds,
  resolveBrandSlugForSeller,
  ADS_EMIT_TIMEOUT_MS,
  ENTITY_IDS_CAP,
} from './ads-emit.js';
import type { TimelineClient } from './client.js';
import type {
  PostTimelineEventInput,
  PostTimelineEventResult,
} from './types.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-ads-emit-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function account(sellerId: number): Record<string, unknown> {
  return {
    seller_id: sellerId,
    seller_name: `Seller ${sellerId}`,
    merchant_alias: null,
    account_type: 'SC',
    marketplace: 'Amazon.com',
    region: 'NA',
    is_active: true,
    is_mws_user: true,
    ads_active: true,
    retail_active: true,
  };
}

async function writeRegistry(
  brands: Array<{ slug: string; sellerIds: number[] }>,
): Promise<void> {
  const clientsDir = join(testDir, 'clients');
  await mkdir(clientsDir, { recursive: true });
  await writeFile(
    join(clientsDir, 'index.yaml'),
    stringifyYaml({
      schema_version: 1,
      discovered_at: '2026-07-01T00:00:00.000Z',
      brands: brands.map((b) => ({
        slug: b.slug,
        display_name: b.slug,
        ads_active: true,
        retail_active: true,
        is_dormant: false,
        cold_started: false,
        cold_started_at: null,
        accounts: b.sellerIds.map(account),
      })),
    }),
    'utf8',
  );
}

function capturingClient(
  result: PostTimelineEventResult = { ok: true, id: 'evt_9' },
): { client: TimelineClient; posts: PostTimelineEventInput[] } {
  const posts: PostTimelineEventInput[] = [];
  const client: TimelineClient = {
    listEvents: async () => ({ ok: true, events: [] }),
    postEvent: async (input: PostTimelineEventInput) => {
      posts.push(input);
      return result;
    },
    corroborateEvent: async () => ({
      ok: false,
      kind: 'unknown',
      message: 'unused',
      friendly: 'unused',
    }),
  };
  return { client, posts };
}

// ---------------------------------------------------------------------------
// emitAdsCommitEvent
// ---------------------------------------------------------------------------

describe('emitAdsCommitEvent', () => {
  it('POSTs one action.ads_change_committed event with proposal linkage and decision', async () => {
    await writeRegistry([{ slug: 'acme', sellerIds: [574] }]);
    const { client, posts } = capturingClient();

    const result = await emitAdsCommitEvent(
      {
        operation: 'sp.update_keywords',
        legacySellerId: 574,
        auditId: 'audit_commit_1',
        itemsCount: 2,
        requestBody: [
          { keywordId: '111', bid: 0.8 },
          { keywordId: '222', bid: 1.1 },
        ],
        beforeState: [{ keywordId: '111', bid: 0.7 }],
        responsePayload: { success: [{}, {}], error: [] },
        proposalId: 'audit_preview_0',
      },
      { dataDirOverride: testDir, client, env: {} },
    );

    expect(result).toEqual({ posted: true, id: 'evt_9', brand_slug: 'acme' });
    expect(posts).toHaveLength(1);
    const evt = posts[0]!;
    expect(evt.brand_slug).toBe('acme');
    expect(evt.family).toBe('action');
    expect(evt.kind).toBe('action.ads_change_committed');
    // proposal_id = the threaded PREVIEW audit id; decision = approved.
    expect(evt.proposal_id).toBe('audit_preview_0');
    expect(evt.decision).toBe('approved');
    expect(evt.payload).toMatchObject({
      operation: 'sp.update_keywords',
      entity_type: 'keywords',
      entity_ids: ['111', '222'],
      items_count: 2,
      success_count: 2,
      error_count: 0,
      change_set_id: 'audit_commit_1',
    });
    expect(String(evt.payload!.before_summary)).toContain('111');
  });

  it('falls back to the commit audit id as proposal_id when none was threaded', async () => {
    await writeRegistry([{ slug: 'acme', sellerIds: [574] }]);
    const { client, posts } = capturingClient();
    await emitAdsCommitEvent(
      { operation: 'sp.update_campaigns', legacySellerId: 574, auditId: 'audit_x' },
      { dataDirOverride: testDir, client, env: {} },
    );
    expect(posts[0]!.proposal_id).toBe('audit_x');
    expect(posts[0]!.payload).toMatchObject({ change_set_id: 'audit_x' });
  });

  it('attributes skill_id / model_id from the env convention', async () => {
    await writeRegistry([{ slug: 'acme', sellerIds: [574] }]);
    const { client, posts } = capturingClient();
    await emitAdsCommitEvent(
      { operation: 'sp.update_campaigns', legacySellerId: 574 },
      {
        dataDirOverride: testDir,
        client,
        env: {
          MIXSHIFT_SKILL_ID: 'mx-keyword-bid-health@1.2.0',
          MIXSHIFT_MODEL_ID: 'claude-fable-5',
        },
      },
    );
    expect(posts[0]!.skill_id).toBe('mx-keyword-bid-health@1.2.0');
    expect(posts[0]!.model_id).toBe('claude-fable-5');
  });

  it('SKIPS silently when the seller maps to no registry brand (never guesses)', async () => {
    await writeRegistry([{ slug: 'acme', sellerIds: [574] }]);
    const { client, posts } = capturingClient();
    const result = await emitAdsCommitEvent(
      { operation: 'sp.update_keywords', legacySellerId: 999 },
      { dataDirOverride: testDir, client, env: {} },
    );
    expect(result).toEqual({ posted: false, reason: 'no_brand' });
    expect(posts).toHaveLength(0);
  });

  it('SKIPS when the seller maps to MULTIPLE brands (ambiguity = never guess)', async () => {
    await writeRegistry([
      { slug: 'acme', sellerIds: [574] },
      { slug: 'zenco', sellerIds: [574] },
    ]);
    const { client, posts } = capturingClient();
    const result = await emitAdsCommitEvent(
      { operation: 'sp.update_keywords', legacySellerId: 574 },
      { dataDirOverride: testDir, client, env: {} },
    );
    expect(result).toEqual({ posted: false, reason: 'no_brand' });
    expect(posts).toHaveLength(0);
  });

  it('SKIPS when no registry exists at all', async () => {
    const { client, posts } = capturingClient();
    const result = await emitAdsCommitEvent(
      { operation: 'sp.update_keywords', legacySellerId: 574 },
      { dataDirOverride: testDir, client, env: {} },
    );
    expect(result).toEqual({ posted: false, reason: 'no_brand' });
    expect(posts).toHaveLength(0);
  });

  it('a failing POST is swallowed (never throws, never affects the commit)', async () => {
    await writeRegistry([{ slug: 'acme', sellerIds: [574] }]);
    const { client } = capturingClient({
      ok: false,
      kind: 'host_unreachable',
      message: 'down',
      friendly: 'unreachable',
    });
    const result = await emitAdsCommitEvent(
      { operation: 'sp.update_keywords', legacySellerId: 574 },
      { dataDirOverride: testDir, client, env: {} },
    );
    expect(result).toEqual({
      posted: false,
      reason: 'post_failed',
      detail: 'unreachable',
    });
  });

  it('a THROWING client is swallowed too', async () => {
    await writeRegistry([{ slug: 'acme', sellerIds: [574] }]);
    const client: TimelineClient = {
      listEvents: async () => ({ ok: true, events: [] }),
      postEvent: async () => {
        throw new Error('boom');
      },
      corroborateEvent: async () => ({
        ok: false,
        kind: 'unknown',
        message: 'unused',
        friendly: 'unused',
      }),
    };
    const result = await emitAdsCommitEvent(
      { operation: 'sp.update_keywords', legacySellerId: 574 },
      { dataDirOverride: testDir, client, env: {} },
    );
    expect(result).toEqual({ posted: false, reason: 'error', detail: 'boom' });
  });

  it('a HUNG POST (e.g. token refresh outside the fetch timeout) is bounded by the deadline race', async () => {
    await writeRegistry([{ slug: 'acme', sellerIds: [574] }]);
    const client: TimelineClient = {
      listEvents: async () => ({ ok: true, events: [] }),
      postEvent: () => new Promise(() => {}), // never settles
      corroborateEvent: async () => ({
        ok: false,
        kind: 'unknown',
        message: 'unused',
        friendly: 'unused',
      }),
    };
    const t0 = Date.now();
    const result = await emitAdsCommitEvent(
      { operation: 'sp.update_keywords', legacySellerId: 574 },
      { dataDirOverride: testDir, client, env: {}, timeoutMs: 50 },
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(result).toEqual({
      posted: false,
      reason: 'post_failed',
      detail: 'timed out after 50ms',
    });
  });

  it('pins the default emission budget', () => {
    expect(ADS_EMIT_TIMEOUT_MS).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('resolveBrandSlugForSeller', () => {
  it('maps a unique seller id to its brand slug', async () => {
    await writeRegistry([
      { slug: 'acme', sellerIds: [574, 575] },
      { slug: 'zenco', sellerIds: [900] },
    ]);
    expect(await resolveBrandSlugForSeller(575, testDir)).toBe('acme');
    expect(await resolveBrandSlugForSeller(900, testDir)).toBe('zenco');
    expect(await resolveBrandSlugForSeller(1, testDir)).toBeNull();
  });

  it('returns null on a malformed registry instead of throwing', async () => {
    const clientsDir = join(testDir, 'clients');
    await mkdir(clientsDir, { recursive: true });
    await writeFile(join(clientsDir, 'index.yaml'), '{ not yaml !!!', 'utf8');
    expect(await resolveBrandSlugForSeller(574, testDir)).toBeNull();
  });
});

describe('extractEntityIds', () => {
  it('collects conventional *Id keys from arrays and wrappers, deduped', () => {
    expect(
      extractEntityIds({
        keywords: [
          { keywordId: 1, campaignId: 'c1' },
          { keywordId: 2, campaignId: 'c1' },
        ],
      }),
    ).toEqual(['1', 'c1', '2']);
  });

  it('caps at ENTITY_IDS_CAP', () => {
    const body = Array.from({ length: 80 }, (_, i) => ({ keywordId: i }));
    expect(extractEntityIds(body)).toHaveLength(ENTITY_IDS_CAP);
  });

  it('ignores non-id keys and non-scalar values, tolerates junk', () => {
    expect(extractEntityIds({ bid: 1.2, name: 'x', keywordId: { nested: true } })).toEqual([]);
    expect(extractEntityIds(null)).toEqual([]);
    expect(extractEntityIds('string')).toEqual([]);
  });
});
