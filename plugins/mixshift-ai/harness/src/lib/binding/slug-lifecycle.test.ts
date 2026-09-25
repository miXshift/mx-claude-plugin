/**
 * Brand retire (slice 1): a RETIRED brand keeps its slug reserved, so slug
 * minting never hands a retired brand's slug to a new sub-brand (restore
 * brings the brand back under the same slug, docs, timeline and ledger keys).
 * The manifest is the contract-shaped wire fixture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectExistingSlugs, mintSlug } from './slug.js';
import { createContextSyncClient, type FetchManifestOptions } from '../context-sync/client.js';
import type { WireManifestBrand } from '../context-sync/types.js';

vi.mock('../context-sync/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context-sync/client.js')>();
  return { ...actual, createContextSyncClient: vi.fn() };
});

const FIXTURE = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', 'testdata', 'context-sync', 'brand-lifecycle-wire.json',
    ),
    'utf8',
  ),
) as Record<string, { body: { brands: WireManifestBrand[] } }>;

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mx-slug-lifecycle-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('collectExistingSlugs + brand retire', () => {
  it('asks for lifecycle=all and keeps the retired slug reserved', async () => {
    const seen: Array<FetchManifestOptions | undefined> = [];
    vi.mocked(createContextSyncClient).mockReturnValue({
      fetchManifest: async (opts?: FetchManifestOptions) => {
        seen.push(opts);
        return { ok: true, brands: FIXTURE.manifest_all!.body.brands, retired_count: 1 };
      },
      fetchDoc: async () => ({ ok: false, kind: 'not_found', message: 'nf', friendly: 'nf' }),
      putDoc: async () => ({ ok: true, status: 'created', revision: 1 }),
      putAssignment: async () => ({ ok: true }),
    });

    const existing = await collectExistingSlugs(dataDir);

    expect(seen).toEqual([{ lifecycle: 'all' }]);
    expect(existing.has('acme-snacks')).toBe(true); // retired, still reserved
    expect(existing.has('summit-trail')).toBe(true);
    // A new label that slugifies to the retired brand's slug gets a different one.
    expect(mintSlug('Acme Snacks', existing, 'Northwind Agency')).toBe('northwind-agency-acme-snacks');
  });
});
