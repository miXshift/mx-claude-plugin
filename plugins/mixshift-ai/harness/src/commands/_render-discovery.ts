/**
 * Render brand discovery output as a table or JSON.
 *
 * Designed to be readable when Claude relays it back to the user:
 *   - Aligned columns, no Unicode box-drawing (some terminals mangle it)
 *   - Status icons via ASCII (✓ / ✗) since most terminals handle those
 *   - Multi-account brands roll up into one row with a count
 */

import type { BrandSuggestion } from '../lib/discovery/brand-grouping.js';

export function renderDiscoveryTable(suggestions: BrandSuggestion[]): string {
  if (suggestions.length === 0) {
    return '\nNo brands discovered. Check that your MySQL user has read access to the `seller` table.\n';
  }

  const rows = suggestions.map((s) => ({
    slug: s.slug,
    name: s.display_name,
    accounts: String(s.accounts.length),
    types: summarizeAccountTypes(s.accounts.map((a) => a.account_type)),
    markets: summarizeMarketplaces(s.accounts.map((a) => a.marketplace)),
    ads: s.ads_active ? '✓' : '✗',
    retail: s.retail_active ? '✓' : '✗',
  }));

  const headers = {
    slug: 'ID',
    name: 'BRAND',
    accounts: 'ACCOUNTS',
    types: 'TYPES',
    markets: 'MARKETS',
    ads: 'ADS',
    retail: 'RETAIL',
  };

  const widths = Object.fromEntries(
    (Object.keys(headers) as (keyof typeof headers)[]).map((k) => [
      k,
      Math.max(headers[k].length, ...rows.map((r) => r[k].length)),
    ]),
  ) as Record<keyof typeof headers, number>;

  const formatRow = (r: Record<keyof typeof headers, string>) =>
    (Object.keys(headers) as (keyof typeof headers)[])
      .map((k) => r[k].padEnd(widths[k]))
      .join('  ');

  const lines: string[] = [];
  lines.push(formatRow(headers));
  lines.push(formatRow(Object.fromEntries(
    (Object.keys(headers) as (keyof typeof headers)[]).map((k) => [k, '-'.repeat(widths[k])]),
  ) as Record<keyof typeof headers, string>));
  for (const r of rows) lines.push(formatRow(r));
  lines.push('');
  lines.push(`${suggestions.length} brand${suggestions.length === 1 ? '' : 's'} discovered.`);
  lines.push('');
  lines.push('Next: `mixshift brand add <id>` to onboard a brand,');
  lines.push('  or  `mixshift brand list` once you have a portfolio set up.');
  return lines.join('\n');
}

function summarizeAccountTypes(types: ('SC' | 'VC' | 'unknown')[]): string {
  const counts = countBy(types);
  const parts: string[] = [];
  if (counts['SC']) parts.push(counts['SC'] === 1 ? 'SC' : `SC×${counts['SC']}`);
  if (counts['VC']) parts.push(counts['VC'] === 1 ? 'VC' : `VC×${counts['VC']}`);
  if (counts['unknown']) parts.push(`?×${counts['unknown']}`);
  return parts.join(',') || '?';
}

function summarizeMarketplaces(markets: (string | null)[]): string {
  const unique = new Set(markets.filter((m): m is string => Boolean(m)));
  if (unique.size === 0) return '?';
  if (unique.size <= 3) return [...unique].sort().join(',');
  return `${unique.size} markets`;
}

function countBy<T extends string>(arr: T[]): Record<T, number> {
  return arr.reduce(
    (acc, v) => {
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    },
    {} as Record<T, number>,
  );
}
