/**
 * Golden brand fixture suite (QA Layer 1).
 *
 * Exercises the brand-context machinery fully OFFLINE against the committed
 * synthetic fixtures in test/fixtures/golden-data-dir/. No warehouse, no auth,
 * no network — everything routes through `dataDirOverride`.
 *
 * Asserts four things:
 *   1. Both fixtures pass Zod validation (schema validity).
 *   2. The registry (index.yaml) validates and lists both cold-started brands.
 *   3. ACOS target resolves from Tier-3 context (cross-tier resolver).
 *   4. Every audit-label required+recommended field is present (GREEN-worthy),
 *      and every manifest `required_context_fields` path resolves against the
 *      PARSED context EXCEPT the known skill<->schema contract gaps.
 *
 * Date-independent on purpose: we assert audit COVERAGE (field presence), not
 * the freshness-stamped GREEN badge, so the suite doesn't rot as last_updated
 * ages. (The literal rendered verdict is a separate manual `brand view` check.)
 */

import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { validateBrandContext, loadBrandContext } from '../src/lib/context/load.js';
import { resolveAcosTargetPct } from '../src/lib/brain/read.js';
import { clientsIndexSchema } from '../src/lib/clients/index-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, 'fixtures', 'golden-data-dir');
const SKILLS_DIR = join(here, '..', '..', 'skills');
const AUDIT_LABELS = join(here, '..', '..', 'shared', 'clients', '_schema', 'audit-labels.yaml');

const BRANDS = ['goldenbrand-sc-acos', 'goldenbrand-vc-tacos'] as const;

/**
 * `required_context_fields` paths that DON'T survive Zod parsing — known
 * skill<->schema contract gaps surfaced by Phase 1. The schema sub-objects
 * (bidHealthSchema, campaignStructureSchema, goalsSchema) are strict
 * `z.object()`s that strip these undeclared keys; the `goals.*_revenue_target`
 * pair additionally uses the wrong name (the schema field is
 * `monthly_total_sales_target`). Tracked in the QA backlog.
 *
 * This set is PINNED on purpose: if a schema fix makes one of these resolve,
 * or a NEW required field stops resolving, the resolution test fails and forces
 * a deliberate update here — so the contract can't drift silently.
 */
const KNOWN_UNRESOLVED = new Set<string>([
  'bid_health.re_entry_rule',
  'campaign_structure.campaign_types_active',
  'goals.forecast_tracking',
  'goals.monthly_revenue_target',
  'goals.quarterly_revenue_target',
  'goals.report_quarterly_pacing',
]);

/**
 * Does `path` resolve to a non-null value in `root`? Handles dotted nesting and
 * array wildcards in both `foo[].bar` (audit-labels) and `foo[*].bar` (manifest)
 * forms — a wildcard requires a non-empty array where every element resolves.
 */
function resolves(root: unknown, path: string): boolean {
  const parts = path.split('.');
  let nodes: unknown[] = [root];
  for (const part of parts) {
    const wildcard = /\[\*?\]$/.test(part);
    const key = part.replace(/\[\*?\]$/, '');
    const next: unknown[] = [];
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') return false;
      const v = (node as Record<string, unknown>)[key];
      if (v === null || v === undefined) return false;
      if (wildcard) {
        if (!Array.isArray(v) || v.length === 0) return false;
        next.push(...v);
      } else {
        next.push(v);
      }
    }
    nodes = next;
  }
  return nodes.length > 0 && nodes.every((v) => v !== null && v !== undefined);
}

async function requiredContextFieldUnion(): Promise<string[]> {
  const out = new Set<string>();
  for (const d of await readdir(SKILLS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const m = parseYaml(
      await readFile(join(SKILLS_DIR, d.name, 'skill.manifest.yaml'), 'utf-8'),
    ) as { required_context_fields?: string[] };
    for (const f of m.required_context_fields ?? []) out.add(f);
  }
  return [...out].sort();
}

describe('golden fixtures — schema validity', () => {
  for (const slug of BRANDS) {
    it(`${slug}: context.yaml passes Zod validation`, async () => {
      const r = await validateBrandContext(slug, DATA_DIR);
      if (!r.ok) throw new Error(`${slug} validation (${r.kind}): ${r.errors.join('; ')}`);
      expect(r.ok).toBe(true);
    });
  }
});

describe('golden fixtures — registry', () => {
  it('index.yaml validates and lists both cold-started brands', async () => {
    const idx = clientsIndexSchema.parse(
      parseYaml(await readFile(join(DATA_DIR, 'clients', 'index.yaml'), 'utf-8')),
    );
    const bySlug = new Map(idx.brands.map((b) => [b.slug, b]));
    for (const slug of BRANDS) {
      const b = bySlug.get(slug);
      expect(b, `index.yaml missing ${slug}`).toBeDefined();
      expect(b!.cold_started).toBe(true);
    }
  });
});

describe('golden fixtures — cross-tier resolution', () => {
  for (const slug of BRANDS) {
    it(`${slug}: ACOS target resolves from Tier-3 context`, async () => {
      const r = await resolveAcosTargetPct(slug, DATA_DIR);
      expect(r).not.toBeNull();
      expect(r!.source).toBe('context');
      expect(typeof r!.value).toBe('number');
    });
  }
});

describe('golden fixtures — audit coverage (GREEN-worthy)', () => {
  for (const slug of BRANDS) {
    it(`${slug}: every required+recommended audit field is present`, async () => {
      const labels = parseYaml(await readFile(AUDIT_LABELS, 'utf-8')) as {
        fields: { path: string; tier: string }[];
      };
      const need = labels.fields
        .filter((f) => f.tier === 'required' || f.tier === 'recommended')
        .map((f) => f.path);
      const { context } = await loadBrandContext(slug, DATA_DIR);
      const missing = need.filter((p) => !resolves(context, p));
      expect(missing).toEqual([]);
    });

    it(`${slug}: no open_gaps`, async () => {
      const { context } = await loadBrandContext(slug, DATA_DIR);
      const gaps = (context as { open_gaps?: unknown[] }).open_gaps ?? [];
      expect(gaps).toEqual([]);
    });
  }
});

describe('golden fixtures — required_context_fields resolution (skill<->schema contract)', () => {
  for (const slug of BRANDS) {
    it(`${slug}: required fields resolve except the known contract gaps`, async () => {
      const union = await requiredContextFieldUnion();
      const { context } = await loadBrandContext(slug, DATA_DIR);
      const mismatches: string[] = [];
      for (const path of union) {
        const got = resolves(context, path);
        const expected = !KNOWN_UNRESOLVED.has(path);
        if (got !== expected) {
          mismatches.push(`${path}: resolves=${got} expected=${expected}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
