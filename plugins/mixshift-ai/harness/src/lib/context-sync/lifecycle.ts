/**
 * Brand lifecycle helpers (brand retire, slice 1): one place that reads the
 * optional `lifecycle` field off a manifest entry and one formatter for every
 * line the plugin prints about a retired brand.
 *
 * Rules these helpers encode (and every caller relies on):
 *   - An ABSENT lifecycle field means active. A MixShift service older than
 *     brand retire never sends it, so nothing changes against it.
 *   - Only the implicit BULK paths skip a retired brand (context status /
 *     pull / push / sync without --brand, and autosync seeding a brand the
 *     user never named). Anything that names the brand explicitly proceeds
 *     and prints one notice.
 *   - Retired never means deleted. The copy always says who retired it, when,
 *     and the exact command that brings it back.
 *   - Retire never filters reports, totals, prefetch or warehouse queries.
 *     Nothing in here is used on those paths.
 *
 * Copy rules (customer-facing): plain words, no em dashes.
 */

import type {
  BrandLifecycleState,
  WireBrandLifecycle,
  WireManifestBrand,
} from './types.js';

/** Maximum length of the optional retire note (the service enforces the same). */
export const LIFECYCLE_NOTE_MAX = 280;

/** The lifecycle state of one manifest entry. Absent entry or absent field = active. */
export function lifecycleStateOf(brand: WireManifestBrand | undefined): BrandLifecycleState {
  return brand?.lifecycle?.state === 'retired' ? 'retired' : 'active';
}

export function isRetiredBrand(brand: WireManifestBrand | undefined): boolean {
  return lifecycleStateOf(brand) === 'retired';
}

/** The lifecycle record of a RETIRED entry, else null (active or unknown). */
export function retiredLifecycleOf(
  brand: WireManifestBrand | undefined,
): WireBrandLifecycle | null {
  return isRetiredBrand(brand) ? (brand!.lifecycle as WireBrandLifecycle) : null;
}

export function findManifestBrand(
  brands: readonly WireManifestBrand[],
  slug: string,
): WireManifestBrand | undefined {
  return brands.find((b) => b.brand_slug === slug);
}

export interface RetiredBrandRef {
  slug: string;
  lifecycle: WireBrandLifecycle;
}

/**
 * Split a list of slugs into the ones a bulk action should process and the
 * retired ones it skips. Order is preserved on both sides. A slug the
 * manifest does not list at all stays in `active` (a local-only brand is
 * never retired).
 */
export function partitionRetired(
  slugs: readonly string[],
  brands: readonly WireManifestBrand[],
): { active: string[]; retired: RetiredBrandRef[] } {
  const bySlug = new Map(brands.map((b) => [b.brand_slug, b]));
  const active: string[] = [];
  const retired: RetiredBrandRef[] = [];
  for (const slug of slugs) {
    const lc = retiredLifecycleOf(bySlug.get(slug));
    if (lc) retired.push({ slug, lifecycle: lc });
    else active.push(slug);
  }
  return { active, retired };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Server text printed to a terminal: strip control characters (an escape
 * sequence in a teammate's label must never reach the user's terminal) and
 * cap the length. Returns null for empty input.
 */
export function safeDisplay(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (cleaned === '') return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Sep 24, 2026": the calendar date in the VIEWER's time zone (the machine's
 * own, or `timeZone` when given; tests pin it), or null when missing or
 * unparseable. Local on purpose: a retire made on a US evening lands after
 * midnight UTC, and "retired on <tomorrow>" would read as wrong to everyone
 * in that team. Falls back to the UTC date only if the runtime cannot format
 * the zone at all.
 */
export function formatLifecycleDate(
  iso: string | null | undefined,
  timeZone?: string,
): string | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(timeZone !== undefined ? { timeZone } : {}),
    }).format(d);
  } catch {
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }
}

/** Who a lifecycle change is attributed to, for display. */
export function lifecycleActor(lc: WireBrandLifecycle | null | undefined): string {
  return safeDisplay(lc?.changed_by) ?? 'a teammate';
}

/** "retired by jane@example.com on Sep 24, 2026" (date omitted when unknown). */
export function retiredByClause(lc: WireBrandLifecycle): string {
  const date = formatLifecycleDate(lc.changed_at);
  return `retired by ${lifecycleActor(lc)}${date ? ` on ${date}` : ''}`;
}

export function restoreCommand(slug: string): string {
  return `mixshift brand restore ${slug}`;
}

export function retireCommand(slug: string): string {
  return `mixshift brand retire ${slug}`;
}

/**
 * The one summary line a bulk context command prints for the retired brands
 * it skipped:
 *   1 retired brand skipped: acme-snacks (retired by X on DATE; mixshift brand restore acme-snacks to undo)
 */
export function retiredSkipSummaryLine(retired: readonly RetiredBrandRef[]): string {
  const n = retired.length;
  const items = retired.map(
    (r) => `${r.slug} (${retiredByClause(r.lifecycle)}; ${restoreCommand(r.slug)} to undo)`,
  );
  return `${n} retired brand${n === 1 ? '' : 's'} skipped: ${items.join(', ')}`;
}

/** The notice an EXPLICIT action on a retired brand prints (stderr, once). */
export function retiredExplicitNoticeLine(slug: string, lc: WireBrandLifecycle): string {
  const surface = safeDisplay(lc.surface, 40);
  const date = formatLifecycleDate(lc.changed_at);
  return (
    `${slug} was retired for your team by ${lifecycleActor(lc)}` +
    `${date ? ` on ${date}` : ''}${surface ? ` via ${surface}` : ''}. ` +
    'Continuing, because you asked for it by name. ' +
    `To bring it back for everyone: \`${restoreCommand(slug)}\`.\n`
  );
}

// ---------------------------------------------------------------------------
// Once-per-process stderr notice
// ---------------------------------------------------------------------------

const noticedRetiredBrands = new Set<string>();

/** Test-only: forget which brands already got the notice this process. */
export function __resetRetiredNotices(): void {
  noticedRetiredBrands.clear();
}

/**
 * Print the explicit-action notice for a retired brand on stderr, at most
 * once per brand per process. Synchronous check-add-write, so two concurrent
 * callers can never print it twice. Never throws.
 */
export function emitRetiredNotice(slug: string, lc: WireBrandLifecycle): void {
  try {
    if (noticedRetiredBrands.has(slug)) return;
    noticedRetiredBrands.add(slug);
    process.stderr.write(retiredExplicitNoticeLine(slug, lc));
  } catch {
    // A notice must never turn a working command into a crash.
  }
}
