/**
 * Brand retire helpers: the manifest lifecycle reader and the copy every
 * retired-brand line comes from. The manifest bodies come from the wire
 * fixture (testdata/context-sync/brand-lifecycle-wire.json), shaped exactly by
 * the slice-1 wire contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __resetRetiredNotices,
  emitRetiredNotice,
  formatLifecycleDate,
  isRetiredBrand,
  lifecycleStateOf,
  partitionRetired,
  retiredExplicitNoticeLine,
  retiredLifecycleOf,
  retiredSkipSummaryLine,
  safeDisplay,
} from './lifecycle.js';
import type { WireManifestBrand } from './types.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'testdata', 'context-sync', 'brand-lifecycle-wire.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<
  string,
  { status: number; body: { brands?: WireManifestBrand[] } & Record<string, unknown> }
>;
const NEW_BRANDS = FIXTURE.manifest_all!.body.brands!;
const OLD_BRANDS = FIXTURE.manifest_old_gateway!.body.brands!;

describe('lifecycle state', () => {
  it('reads retired and active entries from the contract-shaped manifest', () => {
    const acme = NEW_BRANDS.find((b) => b.brand_slug === 'acme-snacks');
    const summit = NEW_BRANDS.find((b) => b.brand_slug === 'summit-trail');
    expect(lifecycleStateOf(acme)).toBe('retired');
    expect(isRetiredBrand(acme)).toBe(true);
    expect(retiredLifecycleOf(acme)).toMatchObject({ changed_by: 'pat@example.com' });
    expect(lifecycleStateOf(summit)).toBe('active');
    expect(retiredLifecycleOf(summit)).toBeNull();
  });

  it('treats an ABSENT lifecycle field (older service) and an unlisted brand as active', () => {
    for (const b of OLD_BRANDS) expect(lifecycleStateOf(b)).toBe('active');
    expect(lifecycleStateOf(undefined)).toBe('active');
  });

  it('partitions a bulk slug list, keeping order and local-only brands', () => {
    const { active, retired } = partitionRetired(
      ['summit-trail', 'acme-snacks', 'local-only'],
      NEW_BRANDS,
    );
    expect(active).toEqual(['summit-trail', 'local-only']);
    expect(retired.map((r) => r.slug)).toEqual(['acme-snacks']);
    // Against an older service nothing is ever skipped.
    expect(partitionRetired(['acme-snacks', 'summit-trail'], OLD_BRANDS).retired).toEqual([]);
  });
});

describe('copy', () => {
  const lc = retiredLifecycleOf(NEW_BRANDS.find((b) => b.brand_slug === 'acme-snacks'))!;

  it('bulk skip summary line matches the contract wording exactly', () => {
    expect(retiredSkipSummaryLine([{ slug: 'acme-snacks', lifecycle: lc }])).toBe(
      '1 retired brand skipped: acme-snacks (retired by pat@example.com on Sep 24, 2026; ' +
        'mixshift brand restore acme-snacks to undo)',
    );
    expect(
      retiredSkipSummaryLine([
        { slug: 'acme-snacks', lifecycle: lc },
        { slug: 'b-two', lifecycle: { ...lc, changed_by: null, changed_at: null } },
      ]),
    ).toBe(
      '2 retired brands skipped: acme-snacks (retired by pat@example.com on Sep 24, 2026; ' +
        'mixshift brand restore acme-snacks to undo), b-two (retired by a teammate; ' +
        'mixshift brand restore b-two to undo)',
    );
  });

  it('explicit-action notice names who, when, how, and never says deleted', () => {
    const line = retiredExplicitNoticeLine('acme-snacks', lc);
    expect(line).toBe(
      'acme-snacks was retired for your team by pat@example.com on Sep 24, 2026 via plugin. ' +
        'Continuing, because you asked for it by name. To bring it back for everyone: ' +
        '`mixshift brand restore acme-snacks`.\n',
    );
    expect(line).not.toMatch(/delet/i);
    expect(line).not.toContain('—');
  });

  it('strips terminal control characters from server-supplied names', () => {
    expect(safeDisplay('evil\u001b[31m@example.com\u0007')).toBe('evil[31m@example.com');
    expect(safeDisplay('   ')).toBeNull();
    expect(safeDisplay(42)).toBeNull();
    expect(safeDisplay('x'.repeat(200), 20)).toBe(`${'x'.repeat(17)}...`);
  });

  it('formats dates as a UTC calendar day and rejects junk', () => {
    expect(formatLifecycleDate('2026-09-24T23:59:00.000Z')).toBe('Sep 24, 2026');
    expect(formatLifecycleDate('not a date')).toBeNull();
    expect(formatLifecycleDate(null)).toBeNull();
  });
});

describe('emitRetiredNotice', () => {
  let writes: string[];
  beforeEach(() => {
    __resetRetiredNotices();
    writes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown): boolean => {
      writes.push(String(c));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints once per brand per process', () => {
    const lc = retiredLifecycleOf(NEW_BRANDS[0])!;
    emitRetiredNotice('acme-snacks', lc);
    emitRetiredNotice('acme-snacks', lc);
    emitRetiredNotice('other-brand', lc);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('acme-snacks was retired');
    expect(writes[1]).toContain('other-brand was retired');
  });
});
