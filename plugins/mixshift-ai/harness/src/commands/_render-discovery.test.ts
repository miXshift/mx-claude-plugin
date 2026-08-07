import { describe, it, expect } from 'vitest';
import {
  renderDiscoveryTable,
  renderDiscoveryTableChat,
} from './_render-discovery.js';
import type { BrandSuggestion } from '../lib/discovery/brand-grouping.js';
import type { SellerRow } from '../lib/discovery/seller-query.js';

function account(overrides: Partial<SellerRow> = {}): SellerRow {
  return {
    seller_id: 1,
    seller_name: 'Acme Corp',
    amazon_seller_id: 'A1XXX',
    merchant_alias: null,
    account_type: 'SC',
    marketplace: 'US',
    region: 'NA',
    agency_name: null,
    acos_target: 20,
    ads_active: true,
    retail_active: true,
    is_active: true,
    has_mws: true,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function suggestion(overrides: Partial<BrandSuggestion> = {}): BrandSuggestion {
  return {
    slug: 'acme',
    display_name: 'Acme Corp',
    accounts: [account()],
    ads_active: true,
    retail_active: false,
    ...overrides,
  };
}

describe('renderDiscoveryTable (terminal)', () => {
  it('returns the empty-state message when no brands', () => {
    expect(renderDiscoveryTable([])).toContain('No brands discovered');
  });

  it('renders headers and one row per brand', () => {
    const out = renderDiscoveryTable([
      suggestion(),
      suggestion({ slug: 'ridgepak', display_name: 'Ridgepak' }),
    ]);
    expect(out).toContain('ID');
    expect(out).toContain('BRAND');
    expect(out).toContain('acme');
    expect(out).toContain('ridgepak');
    expect(out).toContain('2 brands discovered.');
  });
});

describe('renderDiscoveryTableChat', () => {
  it('returns the empty-state message when no brands', () => {
    expect(renderDiscoveryTableChat([])).toContain('No brands discovered');
  });

  it('renders a GFM pipe table with header, separator, and data rows', () => {
    const out = renderDiscoveryTableChat([
      suggestion({
        accounts: [account(), account({ account_type: 'VC', marketplace: 'CA' })],
        retail_active: true,
      }),
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('| ID | Brand | Accounts | Types | Markets | Ads | Retail |');
    expect(lines[1]).toMatch(/^\|[\s:|-]+\|$/); // separator row
    expect(lines[2]).toBe('| acme | Acme Corp | 2 | SC,VC | CA,US | ✓ | ✓ |');
  });

  it('renders ✗ markers for inactive surfaces', () => {
    const out = renderDiscoveryTableChat([
      suggestion({ ads_active: false, retail_active: false }),
    ]);
    expect(out).toContain('| ✗ | ✗ |');
  });

  it('preserves display-name markers (⭐ key, ✓ cold-started) prepended by brand list', () => {
    const out = renderDiscoveryTableChat([
      suggestion({ display_name: '⭐✓ Acme Corp' }),
    ]);
    expect(out).toContain('| ⭐✓ Acme Corp |');
  });

  it('escapes pipe characters in cell content so the table stays intact', () => {
    const out = renderDiscoveryTableChat([
      suggestion({ display_name: 'Acme | Subsidiary' }),
    ]);
    expect(out).toContain('Acme \\| Subsidiary');
    // The data row must still parse as exactly 7 columns.
    const dataRow = out.split('\n')[2];
    const cells = dataRow.split(/(?<!\\)\|/).filter((c) => c.trim() !== '');
    expect(cells).toHaveLength(7);
  });

  it('includes the footer prose (count + next steps) as plain markdown', () => {
    const one = renderDiscoveryTableChat([suggestion()]);
    expect(one).toContain('1 brand discovered.');
    expect(one).toContain('`mixshift brand add <id>`');
    const two = renderDiscoveryTableChat([
      suggestion(),
      suggestion({ slug: 'ridgepak', display_name: 'Ridgepak' }),
    ]);
    expect(two).toContain('2 brands discovered.');
  });

  it('summarizes many marketplaces as a count, matching the terminal renderer', () => {
    const markets = ['US', 'CA', 'DE', 'FR', 'IT'];
    const out = renderDiscoveryTableChat([
      suggestion({
        accounts: markets.map((m) => account({ marketplace: m })),
      }),
    ]);
    expect(out).toContain('5 markets');
  });
});
