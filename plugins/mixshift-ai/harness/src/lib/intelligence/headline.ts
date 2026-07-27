/**
 * Best-effort extraction of a compact "headline" from a completed Intelligence
 * insight result, for the two-tier CLI output (`mixshift intelligence run` /
 * `get`): a short block printed inline, with the full (often tens-of-KB)
 * envelope always written to an artifact file instead of stdout.
 *
 * The insight payload's field names are NOT fixed by one schema shared with
 * the plugin — each insight id has its own shape, and the service can evolve
 * them independently of a plugin release — so this is deliberately tolerant:
 * it reads the fixed `meta` / `limitations` envelope fields directly, and
 * best-effort-probes a short list of candidate paths for the "key totals"
 * the house style wants surfaced (a month-over-month Ops Bridge delta, a
 * TACOS delta) across naming variants. A payload that carries none of the
 * candidates degrades gracefully: the headline just omits `keyTotals`
 * entries, it never throws and never guesses at a value it can't find.
 */

import type { InsightResult } from './client.js';

export interface RunHeadline {
  ok: boolean;
  insightId?: string;
  revision?: string;
  computedAt?: string;
  /** Rendered from meta.cache — the shape isn't fixed service-side, so this
   *  is already normalized to a short display string ('hit' | 'miss' | ...). */
  cache?: string;
  limitationCount?: number;
  /** Best-effort key metrics keyed by a stable label (see CANDIDATE_TOTALS
   *  below). Empty when the payload carries none of the recognized shapes. */
  keyTotals: Record<string, unknown>;
}

/** label -> candidate dotted paths to probe, in priority order, across the
 *  naming variants a given insight might use. First hit wins per label. */
const CANDIDATE_TOTALS: ReadonlyArray<{ label: string; paths: readonly string[][] }> = [
  {
    label: 'momOpsDelta',
    paths: [
      ['momOpsDelta'],
      ['mom_ops_delta'],
      ['summary', 'momOpsDelta'],
      ['headline', 'momOpsDelta'],
      ['opsBridge', 'momOpsDelta'],
    ],
  },
  {
    label: 'momOpsDeltaPct',
    paths: [
      ['momOpsDeltaPct'],
      ['mom_ops_delta_pct'],
      ['summary', 'momOpsDeltaPct'],
      ['headline', 'momOpsDeltaPct'],
      ['opsBridge', 'momOpsDeltaPct'],
    ],
  },
  {
    label: 'tacosDelta',
    paths: [
      ['tacosDelta'],
      ['tacos_delta'],
      ['summary', 'tacosDelta'],
      ['headline', 'tacosDelta'],
      ['adsBridge', 'tacosDelta'],
    ],
  },
];

function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function formatCache(cache: unknown): string | undefined {
  if (cache === undefined || cache === null) return undefined;
  if (typeof cache === 'boolean') return cache ? 'hit' : 'miss';
  if (typeof cache === 'string') return cache;
  if (typeof cache === 'object') {
    const o = cache as Record<string, unknown>;
    if (typeof o.hit === 'boolean') return o.hit ? 'hit' : 'miss';
    if (typeof o.status === 'string') return o.status;
  }
  try {
    return JSON.stringify(cache);
  } catch {
    return undefined;
  }
}

/** Extract the headline from a completed result. Never throws — an
 *  unrecognized shape just yields fewer populated fields. */
export function extractRunHeadline(result: InsightResult): RunHeadline {
  const meta =
    result.meta && typeof result.meta === 'object' ? (result.meta as Record<string, unknown>) : {};
  const limitations = Array.isArray(result.limitations) ? result.limitations : undefined;

  const keyTotals: Record<string, unknown> = {};
  for (const candidate of CANDIDATE_TOTALS) {
    for (const path of candidate.paths) {
      const value = getPath(result, path);
      if (value !== undefined) {
        keyTotals[candidate.label] = value;
        break;
      }
    }
  }

  return {
    ok: result.ok === true,
    insightId: typeof meta.insightId === 'string' ? meta.insightId : undefined,
    revision: typeof meta.revision === 'string' ? meta.revision : undefined,
    computedAt: typeof meta.computedAt === 'string' ? meta.computedAt : undefined,
    cache: formatCache(meta.cache),
    limitationCount: limitations ? limitations.length : undefined,
    keyTotals,
  };
}

/** Render the headline as the compact human-readable block `run` / `get`
 *  print before the artifact-path line. Pure formatting; never throws. */
export function renderHeadline(h: RunHeadline): string {
  const lines: string[] = [];
  lines.push(
    `${h.ok ? '✓' : '✗'} ${h.insightId ?? '(insight id unknown)'}` +
      `${h.cache ? `  cache: ${h.cache}` : ''}`,
  );
  const meta: string[] = [];
  if (h.revision) meta.push(`revision: ${h.revision}`);
  if (h.computedAt) meta.push(`computedAt: ${h.computedAt}`);
  if (h.limitationCount !== undefined) meta.push(`limitations: ${h.limitationCount}`);
  if (meta.length > 0) lines.push(`  ${meta.join('   ')}`);
  const totalsEntries = Object.entries(h.keyTotals);
  if (totalsEntries.length > 0) {
    lines.push(`  ${totalsEntries.map(([k, v]) => `${k}: ${String(v)}`).join('   ')}`);
  }
  return lines.join('\n');
}
