/**
 * Brand Context page composer.
 *
 * Reads all four cold-start sources (context.yaml + narrative.md +
 * brand-intelligence.yaml + corpora/*.csv) plus the audit-labels.yaml drive
 * map, computes the verdict + audit coverage + open-gap buckets + skill
 * readiness, and produces three artifacts:
 *
 *   - brand-context.html        — 19-section page (the upstream's template + new
 *                                 design-system primitives)
 *   - brand-context.headline.json — ~500-token model summary
 *   - brand-context.review.json — compact review map: buckets, runtime
 *                                 inputs, skill readiness, audit summary
 *
 * Plus the sidecar (lib/sidecar/write.ts) for the run record.
 *
 * Phase B scope: replicates the upstream's v2.5.1 brand-context-template.html
 * structure using our design-system primitives. Section bodies that depend
 * on Phase C work (enrichment, detected_anomalies, reporting-style) render
 * graceful empty states so the surface works end-to-end today and gets
 * richer when Phase C lands.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { dirname, join } from 'node:path';
import {
  brandDir,
  contextPath,
  narrativePath,
} from '../paths/resolve.js';

// ---------------------------------------------------------------------------
// Source shapes (loose — we degrade gracefully on missing fields)
// ---------------------------------------------------------------------------

export interface BrandContextSources {
  context: Record<string, unknown> | null;
  context_path: string;
  narrative_md: string | null;
  narrative_path: string;
  brand_intelligence: Record<string, unknown> | null;
  brand_intelligence_path: string;
  /** Map of CSV filename → row count (cheap; we don't load full rows for
   *  rendering — just emit per-file counts in audit / lane sections). */
  corpora_summary: Array<{ filename: string; row_count: number }>;
  corpora_path: string;
  /** Optional enrichment artifact from Phase 1.5 (deferred in 0.5.x).
   *  Null when not yet produced. */
  enrichment: Record<string, unknown> | null;
  /** ISO timestamp from context.yaml::last_updated. */
  last_updated: string | null;
}

export async function readBrandContextSources(
  brandSlug: string,
  runDate: string,
  dataDirOverride?: string,
): Promise<BrandContextSources> {
  const ctxPath = contextPath(brandSlug, dataDirOverride);
  const narPath = narrativePath(brandSlug, dataDirOverride);
  const dir = brandDir(brandSlug, dataDirOverride);
  const briPath = join(dir, 'brand-intelligence.yaml');
  const corporaPath = join(dir, 'corpora');
  const enrichmentPath = join(
    dir,
    'runs',
    'mx-brand-context',
    runDate,
    `${runDate}.enrichment.json`,
  );

  const [context, narrative, intel, corpora, enrichment] = await Promise.all([
    readYamlIfExists(ctxPath),
    readTextIfExists(narPath),
    readYamlIfExists(briPath),
    summarizeCorpora(corporaPath),
    readJsonIfExists(enrichmentPath),
  ]);

  const last_updated =
    (context as { last_updated?: string } | null)?.last_updated ?? null;

  return {
    context: context as Record<string, unknown> | null,
    context_path: ctxPath,
    narrative_md: narrative,
    narrative_path: narPath,
    brand_intelligence: intel as Record<string, unknown> | null,
    brand_intelligence_path: briPath,
    corpora_summary: corpora,
    corpora_path: corporaPath,
    enrichment: enrichment as Record<string, unknown> | null,
    last_updated,
  };
}

// ---------------------------------------------------------------------------
// narrative.md parsing — H2 section → body
// ---------------------------------------------------------------------------

/**
 * Parse narrative.md into a section map keyed by H2 heading text (lowercase,
 * stripped of trailing punctuation). Body is the markdown between the H2 and
 * the next H2 (or EOF).
 *
 * Canonical sections per the SKILL.md:
 *   "brand identity" | "brand positioning"
 *   "customer language samples" | "buyer language"
 *   "current quarter context"
 *   "historical notes"
 *
 * Other H2s become generic appendix entries.
 */
export function parseNarrativeSections(
  md: string | null,
): Record<string, string> {
  if (!md) return {};
  const lines = md.split(/\r?\n/);
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentBody: string[] = [];
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (currentKey !== null) {
        out[currentKey] = currentBody.join('\n').trim();
      }
      currentKey = h2[1]!.toLowerCase().replace(/[?.!:;,]$/, '').trim();
      currentBody = [];
    } else if (currentKey !== null) {
      currentBody.push(line);
    }
  }
  if (currentKey !== null) {
    out[currentKey] = currentBody.join('\n').trim();
  }
  return out;
}

/**
 * Look up a narrative section by any of its acceptable canonical names.
 * Returns the first matching body, or null.
 */
export function findNarrativeSection(
  sections: Record<string, string>,
  candidates: string[],
): string | null {
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (key in sections && sections[key]!.length > 0) return sections[key]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audit coverage — drives the Schema Coverage Audit section + headline numbers
// ---------------------------------------------------------------------------

export interface AuditLabel {
  path: string;
  label: string;
  category: string;
  tier: 'required' | 'recommended' | 'optional';
  description?: string;
  aggregate?: boolean;
  list_count?: boolean;
  dict_count?: boolean;
  fresh_check?: boolean;
  display_as?: 'status';
}

export interface AuditCoverage {
  /** Per-field audit row evaluation. */
  rows: Array<{
    label: AuditLabel;
    /** Resolved value at the path, or undefined if missing. */
    value: unknown;
    /** 'ok' (present), 'miss' (required missing), 'warn' (recommended
     *  missing or stale), 'muted' (optional / present-but-noisy). */
    status: 'ok' | 'miss' | 'warn' | 'muted';
    /** Pre-formatted display value for the audit row. */
    display: string;
    /** True when the value resolves but is stale per `fresh_check`. */
    is_stale: boolean;
  }>;
  required_present: number;
  required_total: number;
  recommended_present: number;
  recommended_total: number;
  stale_count: number;
  open_gaps_count: number;
}

/**
 * Compute the audit coverage stats against a parsed context.yaml.
 * `now` defaults to current time; passed for testability.
 */
export function computeAuditCoverage(
  context: Record<string, unknown> | null,
  labels: AuditLabel[],
  now: Date = new Date(),
): AuditCoverage {
  const rows: AuditCoverage['rows'] = [];
  let required_present = 0;
  let required_total = 0;
  let recommended_present = 0;
  let recommended_total = 0;
  let stale_count = 0;
  let open_gaps_count = 0;

  for (const label of labels) {
    const value = context ? resolveAuditPath(context, label.path) : undefined;
    const isPresent = !isAuditMissing(value);
    const isStale = !!(
      label.fresh_check &&
      isPresent &&
      typeof value === 'string' &&
      isStaleDate(value, now)
    );
    if (isStale) stale_count += 1;

    if (label.tier === 'required') {
      required_total += 1;
      if (isPresent) required_present += 1;
    } else if (label.tier === 'recommended') {
      recommended_total += 1;
      if (isPresent) recommended_present += 1;
    }

    let status: 'ok' | 'miss' | 'warn' | 'muted';
    if (!isPresent) {
      status = label.tier === 'required' ? 'miss' : label.tier === 'recommended' ? 'warn' : 'muted';
    } else if (isStale) {
      status = 'warn';
    } else {
      status = 'ok';
    }

    rows.push({
      label,
      value,
      status,
      display: formatAuditValue(label, value, isPresent, isStale),
      is_stale: isStale,
    });

    // open_gaps array-count handling
    if (label.path === 'open_gaps' && Array.isArray(value)) {
      open_gaps_count = value.length;
    }
  }

  return {
    rows,
    required_present,
    required_total,
    recommended_present,
    recommended_total,
    stale_count,
    open_gaps_count,
  };
}

function resolveAuditPath(obj: unknown, path: string): unknown {
  // Supports: foo.bar, foo[].bar (aggregate), foo[] (count-only)
  if (obj === null || obj === undefined) return undefined;
  const arrayWildcard = path.includes('[]');
  if (arrayWildcard) {
    const [head, tail] = path.split('[]');
    const arr = getNested(obj, head!.replace(/\.$/, ''));
    if (!Array.isArray(arr)) return undefined;
    if (!tail || tail === '') return arr; // foo[] = the array itself (count)
    return arr.map((el) => getNested(el, tail.replace(/^\./, '')));
  }
  return getNested(obj, path);
}

function getNested(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function isAuditMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    // For aggregate paths (`foo[].bar`), all-undefined extracted values =
    // missing too.
    if (value.every((v) => v === undefined || v === null || v === '')) return true;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value as Record<string, unknown>).length === 0) return true;
  }
  return false;
}

function isStaleDate(value: string, now: Date, days: number = 30): boolean {
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return false;
    const ageMs = now.getTime() - d.getTime();
    return ageMs > days * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function formatAuditValue(
  label: AuditLabel,
  value: unknown,
  isPresent: boolean,
  isStale: boolean,
): string {
  if (!isPresent) {
    return label.tier === 'required'
      ? 'missing (required)'
      : label.tier === 'recommended'
        ? 'missing (recommended)'
        : 'not set';
  }
  if (isStale && typeof value === 'string') return `${value} (stale)`;
  if (label.aggregate && Array.isArray(value)) {
    return value.filter((v) => v !== undefined && v !== null).map(String).join(' / ');
  }
  if (label.list_count && Array.isArray(value)) {
    return `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`;
  }
  if (label.dict_count && typeof value === 'object' && !Array.isArray(value)) {
    return `${Object.keys(value as Record<string, unknown>).length} entries`;
  }
  if (label.display_as === 'status') return 'configured';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Verdict logic
// ---------------------------------------------------------------------------

export type Verdict = 'GREEN' | 'YELLOW' | 'RED' | 'OBSERVATIONAL';

/**
 * Whether a Tier-3 context.yaml exists and validates:
 *   - 'valid'   — present and schema-valid (the cold-started case).
 *   - 'invalid' — present but malformed/schema-invalid (genuinely broken → RED).
 *   - 'absent'  — no context.yaml on disk yet (an EARLY state, not an error;
 *                 a brand may be Tier-2-brain-only after `brand key add`).
 */
export type ContextState = 'valid' | 'invalid' | 'absent';

export interface VerdictArgs {
  coverage: AuditCoverage;
  observational: boolean;
  /** True when the run is Phase 1 only (Phase 2 AMA pending). */
  validator_passed: boolean;
  /** Tri-state context presence. Distinguishes "no context yet" (early) from
   *  "context present but broken" (RED). Defaults to deriving from
   *  `validator_passed` so existing callers keep their behavior:
   *  passed → 'valid', failed → 'invalid'. */
  context_state?: ContextState;
  /** True when a Tier-2 brain exists (auto-fetched after `brand key add`).
   *  A brain-only brand (context absent + brain present) is a legitimate
   *  early state, rendered non-RED. Defaults to false. */
  brain_present?: boolean;
}

export function computeVerdict(args: VerdictArgs): { verdict: Verdict; reason: string } {
  if (args.observational) {
    return {
      verdict: 'OBSERVATIONAL',
      reason: 'Phase 1 complete; Phase 2 AM intake pending.',
    };
  }

  // Derive the context state for callers that pass only `validator_passed`.
  const contextState: ContextState =
    args.context_state ?? (args.validator_passed ? 'valid' : 'invalid');

  // EARLY STATE — no context.yaml yet. This is NOT a broken brand: a brand
  // that has only been `brand key add`-ed has its Tier-2 brain auto-fetched
  // but no cold-start context. Render a non-RED "auto-discovered" state (the
  // ⊙ brain data + ◯ gaps still render below). If there's no brain either,
  // it's the truly-empty "nothing yet" state — still non-RED, just a nudge to
  // set the brand up.
  if (contextState === 'absent') {
    return args.brain_present
      ? {
          verdict: 'OBSERVATIONAL',
          reason:
            'Auto-discovered from your account — confirm and enrich to sharpen.',
        }
      : {
          verdict: 'OBSERVATIONAL',
          reason:
            'Nothing captured yet — add the brand and run setup to populate context.',
        };
  }

  // GENUINELY BROKEN — context.yaml is present but malformed/invalid. Keep
  // this RED so a real schema error stays loud (distinct from the early state).
  if (contextState === 'invalid') {
    return {
      verdict: 'RED',
      reason: 'Schema validator failed — fix context.yaml and re-render.',
    };
  }

  if (args.coverage.required_present < args.coverage.required_total) {
    const missing = args.coverage.required_total - args.coverage.required_present;
    return {
      verdict: 'RED',
      reason: `${missing} required field(s) missing.`,
    };
  }
  if (args.coverage.open_gaps_count > 0 || args.coverage.stale_count > 0) {
    const parts: string[] = [];
    if (args.coverage.open_gaps_count > 0)
      parts.push(`${args.coverage.open_gaps_count} open gap(s)`);
    if (args.coverage.stale_count > 0)
      parts.push(`${args.coverage.stale_count} stale field(s)`);
    return {
      verdict: 'YELLOW',
      reason: parts.join('; ') + '.',
    };
  }
  if (args.coverage.recommended_present < args.coverage.recommended_total) {
    const missing = args.coverage.recommended_total - args.coverage.recommended_present;
    return {
      verdict: 'YELLOW',
      reason: `${missing} recommended field(s) not populated.`,
    };
  }
  return {
    verdict: 'GREEN',
    reason: 'All required + recommended fields populated; no open gaps; context fresh.',
  };
}

// ---------------------------------------------------------------------------
// Audit-labels loader
// ---------------------------------------------------------------------------

/**
 * Read the canonical audit-labels.yaml from the shared schema location. Path
 * walks up from this module file the same way design-system.ts walks for
 * its assets — keeps the harness self-contained regardless of bundle layout.
 */
export async function loadAuditLabels(): Promise<AuditLabel[]> {
  // shared/clients/_schema/audit-labels.yaml lives at the plugin root.
  // From harness/dist/cli.js (bundled) or harness/src/... (dev), walk up
  // until we find it.
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { parse } = await import('node:path');
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  for (let i = 0; i < 10; i++) {
    const candidate = join(
      dir,
      'shared',
      'clients',
      '_schema',
      'audit-labels.yaml',
    );
    if (existsSync(candidate)) {
      const raw = await readFile(candidate, 'utf-8');
      const parsed = parseYaml(raw) as { fields?: AuditLabel[] };
      return parsed.fields ?? [];
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  // Not found — return empty so renderer degrades gracefully.
  return [];
}

// ---------------------------------------------------------------------------
// Internal I/O helpers
// ---------------------------------------------------------------------------

async function readYamlIfExists(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return parseYaml(raw);
  } catch {
    return null;
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function summarizeCorpora(
  dirPath: string,
): Promise<Array<{ filename: string; row_count: number }>> {
  try {
    const entries = await readdir(dirPath);
    const summaries: Array<{ filename: string; row_count: number }> = [];
    for (const f of entries) {
      if (!f.endsWith('.csv')) continue;
      try {
        const s = await stat(join(dirPath, f));
        if (!s.isFile()) continue;
        const raw = await readFile(join(dirPath, f), 'utf-8');
        // Count newlines minus 1 for header. Cheap, no CSV parsing.
        const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
        const row_count = Math.max(0, lines.length - 1);
        summaries.push({ filename: f, row_count });
      } catch {
        // ignore unreadable files
      }
    }
    return summaries;
  } catch {
    return [];
  }
}
