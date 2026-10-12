/**
 * Sub-brands and item groups of an account, as MixShift keeps them for forecasting
 * (mx-ops#134): one brand inside a seller account, named by labels, that the
 * computed forecast reads on its own (`scopeKey` on FCT-READINESS-01 and
 * FCT-BASELINE-01). The definitions live in the gateway's forecasting state, the
 * same documents the forecasting app keeps (`fb:scope_def:<scope id>`), so a
 * sub-brand defined here is the app's too.
 *
 *   GET  /api/app-state/forecasting/scopes?legacy_seller_id=   the account's sub-brands
 *   POST /api/app-state/forecasting/scopes  { create: { legacySellerId, kind, name, itemValues, campaignValues } }
 *   GET  /api/app-state/forecasting/doc?key=   /docs?prefix=   POST .../batch   (removal)
 *
 * A sub-brand is the products whose label (Seller Central brand, Vendor Central
 * custom brand, or item group) is one of `itemValues` and the campaigns whose
 * label is one of `campaignValues`. Its scope id is `src:<database>:<seller>:scope:<key>`,
 * and its budgets (`mixshift forecast budget --scope <that id>`) are its own.
 */

import { appStateRequest, monthPrefix, type BudgetClientOptions, type BudgetFailure } from './budget.js';

export type SubBrandKind = 'sub_brand' | 'item_group';

export interface SubBrand {
  scopeId: string;
  scopeKey: string;
  merchantId: string;
  kind: SubBrandKind;
  name: string;
  itemValues: string[];
  campaignValues: string[];
  version: number | null;
}

/** The gateway's caps: up to 100 labels a side, each 1 to 200 characters. */
export const MAX_LABELS = 100;
export const MAX_LABEL_LENGTH = 200;
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
const SUB_BRAND_ID_RE = /^src:([a-z0-9_]+):(\d+):scope:([a-z0-9]{4,32})$/;

/** Labels as the app cleans them: trimmed, blanks dropped, each once (case kept). Throws on a bad label. */
export function cleanLabels(values: readonly string[], flag: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = raw.trim();
    if (v.length === 0) continue;
    if (v.length > MAX_LABEL_LENGTH) throw new Error(`${flag}: a label is at most ${MAX_LABEL_LENGTH} characters.`);
    if (UNSAFE_TEXT_RE.test(v)) throw new Error(`${flag}: a label is plain text on one line.`);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  if (out.length > MAX_LABELS) throw new Error(`${flag}: at most ${MAX_LABELS} labels.`);
  return out;
}

/** A sub-brand name: one line of plain text, 1 to 200 characters. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return 'a name is required';
  if (n.length > 200) return 'a name is at most 200 characters';
  if (UNSAFE_TEXT_RE.test(n)) return 'a name is plain text on one line';
  return null;
}

/** The canonical sub-brand scope id (database lowercased), or null when `raw` is not one. */
export function canonicalSubBrandId(raw: string): string | null {
  const m = /^src:([A-Za-z0-9_]+):(\d+):scope:([a-z0-9]{4,32})$/.exec(raw.trim());
  return m ? `src:${m[1]!.toLowerCase()}:${Number(m[2])}:scope:${m[3]}` : null;
}

/** The key a forecast takes as `scopeKey`: the last segment of a sub-brand scope id. */
export function scopeKeyOf(scopeId: string): string | null {
  return SUB_BRAND_ID_RE.exec(scopeId)?.[3] ?? null;
}

const sameLabels = (a: readonly string[], b: readonly string[]) => {
  const norm = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()))].sort().join('\u0000');
  return norm(a) === norm(b);
};

/** A definition already holding exactly these labels (compared as the warehouse compares them, case-insensitively). */
export function findMatching(
  subBrands: readonly SubBrand[],
  want: { kind: SubBrandKind; itemValues: readonly string[]; campaignValues: readonly string[] },
): SubBrand | null {
  return subBrands.find((s) => s.kind === want.kind && sameLabels(s.itemValues, want.itemValues) && sameLabels(s.campaignValues, want.campaignValues)) ?? null;
}

function toSubBrand(d: Record<string, unknown>): SubBrand | null {
  const scopeId = typeof d.scopeId === 'string' ? d.scopeId : typeof d.id === 'string' ? canonicalSubBrandId(d.id) : null;
  const key = scopeId ? scopeKeyOf(scopeId) : null;
  if (!scopeId || !key) return null;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
  return {
    scopeId,
    scopeKey: key,
    merchantId: typeof d.merchantId === 'string' ? d.merchantId : scopeId.slice(0, scopeId.indexOf(':scope:')),
    kind: d.kind === 'item_group' ? 'item_group' : 'sub_brand',
    name: typeof d.name === 'string' ? d.name : '',
    itemValues: strings(d.itemValues),
    campaignValues: strings(d.campaignValues),
    version: typeof d.version === 'number' ? d.version : null,
  };
}

/** The account's sub-brands (or the whole database's, with no seller). */
export async function listSubBrands(
  legacySellerId: number | null,
  opts: BudgetClientOptions = {},
): Promise<{ ok: true; merchantId: string | null; subBrands: SubBrand[]; skipped: number } | BudgetFailure> {
  const q = legacySellerId === null ? '' : `?legacy_seller_id=${legacySellerId}`;
  const r = await appStateRequest('GET', `/api/app-state/forecasting/scopes${q}`, undefined, opts);
  if (!r.ok) return r;
  const defs = Array.isArray(r.json.definitions) ? r.json.definitions : [];
  const subBrands = defs.map((d) => toSubBrand((d ?? {}) as Record<string, unknown>)).filter((s): s is SubBrand => s !== null);
  return {
    ok: true,
    merchantId: typeof r.json.merchant_id === 'string' ? r.json.merchant_id : null,
    subBrands,
    skipped: typeof r.json.skipped === 'number' ? r.json.skipped : 0,
  };
}

export interface SubBrandInput {
  legacySellerId: number;
  kind: SubBrandKind;
  name: string;
  itemValues: string[];
  campaignValues: string[];
}

/**
 * Define a sub-brand, unless one with exactly these labels already exists for the
 * account (then that one is returned, `created: false`): a forecast run twice for
 * the same brand reads one definition and one set of budgets.
 */
export async function ensureSubBrand(
  input: SubBrandInput,
  opts: BudgetClientOptions & { dryRun?: boolean } = {},
): Promise<{ ok: true; created: boolean; subBrand: SubBrand | null } | BudgetFailure> {
  const existing = await listSubBrands(input.legacySellerId, opts);
  if (!existing.ok) return existing;
  const match = findMatching(existing.subBrands, input);
  if (match) return { ok: true, created: false, subBrand: match };
  if (opts.dryRun) return { ok: true, created: false, subBrand: null };
  const r = await appStateRequest(
    'POST',
    '/api/app-state/forecasting/scopes',
    {
      create: { legacySellerId: input.legacySellerId, kind: input.kind, name: input.name.trim(), itemValues: input.itemValues, campaignValues: input.campaignValues },
      reason: 'Sub-brand defined with the MixShift plugin',
    },
    opts,
  );
  if (!r.ok) return r;
  const d = (r.json.definition ?? {}) as Record<string, unknown>;
  const subBrand = toSubBrand({ ...d, version: r.json.version });
  if (!subBrand) return { ok: false, kind: 'unknown', friendly: 'The MixShift service answered without the new sub-brand.' };
  return { ok: true, created: true, subBrand };
}

/** What removing a sub-brand deletes: its definition, its month rows, its settings. */
export interface RemovalPlan {
  scopeId: string;
  writes: Array<{ key: string; expected_version: number; doc: null }>;
  definition: boolean;
  months: number;
  settings: boolean;
}

async function versionOf(key: string, opts: BudgetClientOptions): Promise<{ ok: true; version: number | null } | BudgetFailure> {
  const r = await appStateRequest('GET', `/api/app-state/forecasting/doc?key=${encodeURIComponent(key)}`, undefined, opts);
  if (!r.ok) return r.kind === 'not_found' ? { ok: true, version: null } : r;
  return { ok: true, version: typeof r.json.version === 'number' ? r.json.version : null };
}

/**
 * Everything stored under a sub-brand, as the app's own delete removes it: the
 * definition, every month row, the settings. One batch, every key at the version
 * read, so a change made meanwhile refuses the whole removal.
 */
export async function planSubBrandRemoval(scopeId: string, opts: BudgetClientOptions = {}): Promise<{ ok: true; plan: RemovalPlan } | BudgetFailure> {
  const writes: RemovalPlan['writes'] = [];
  const def = await versionOf(`fb:scope_def:${scopeId}`, opts);
  if (!def.ok) return def;
  if (def.version !== null) writes.push({ key: `fb:scope_def:${scopeId}`, expected_version: def.version, doc: null });
  let months = 0;
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ prefix: monthPrefix(scopeId), limit: '500' });
    if (after) q.set('after', after);
    const r = await appStateRequest('GET', `/api/app-state/forecasting/docs?${q.toString()}`, undefined, opts);
    if (!r.ok) return r;
    const docs = (Array.isArray(r.json.docs) ? r.json.docs : []) as Array<{ key?: unknown; version?: unknown }>;
    for (const d of docs) {
      if (typeof d.key === 'string' && typeof d.version === 'number') {
        writes.push({ key: d.key, expected_version: d.version, doc: null });
        months += 1;
      }
    }
    after = typeof r.json.next_after === 'string' ? r.json.next_after : null;
    if (!after) break;
  }
  const settings = await versionOf(`fb:account:${scopeId}`, opts);
  if (!settings.ok) return settings;
  if (settings.version !== null) writes.push({ key: `fb:account:${scopeId}`, expected_version: settings.version, doc: null });
  return { ok: true, plan: { scopeId, writes, definition: def.version !== null, months, settings: settings.version !== null } };
}

export async function applySubBrandRemoval(plan: RemovalPlan, opts: BudgetClientOptions = {}): Promise<{ ok: true; deleted: number } | BudgetFailure> {
  if (plan.writes.length === 0) return { ok: true, deleted: 0 };
  const r = await appStateRequest('POST', '/api/app-state/forecasting/batch', { writes: plan.writes, reason: 'Sub-brand removed with the MixShift plugin' }, opts);
  if (!r.ok) return r;
  return { ok: true, deleted: plan.writes.length };
}
