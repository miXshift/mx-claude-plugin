import { describe, it, expect } from 'vitest';
import {
  LABEL_LENS_PARAM_BY_QUERY,
  lensFor,
  summarizeLens,
  renderLensNotice,
  type LensDecision,
} from './lens.js';
import type { BindingBlock } from '../context/schema.js';

const fullBinding: BindingBlock = {
  kind: 'sub_brand',
  amazon_seller_id: 'A1EXAMPLE23456',
  seller_ids: [1, 2],
  retail_label: { source: 'mws_items.Brand', value: 'Forager Pantry' },
  ads_label: { source: 'campaign.Brand', value: 'Forager Pantry' },
  scope_note: 'scoped',
};

describe('LABEL_LENS_PARAM_BY_QUERY (the gateway contract copy)', () => {
  it('maps exactly the seven label-aware entries from gateway PR #106', () => {
    expect(LABEL_LENS_PARAM_BY_QUERY).toEqual({
      'BRAIN-CATALOG-SC': 'retail_brand_label',
      'BRAIN-CATALOG-VC': 'retail_brand_label',
      'BRAIN-CAMPAIGN': 'ads_brand_label',
      'CS-09': 'retail_brand_label',
      'CS-11': 'retail_brand_label',
      'CS-12': 'retail_brand_label',
      'CS-13': 'retail_brand_label',
    });
  });
});

describe('lensFor', () => {
  it('returns null for an unbound brand — nothing sent, nothing recorded', () => {
    expect(lensFor('BRAIN-CATALOG-SC', null)).toBeNull();
    expect(lensFor('CS-02', undefined)).toBeNull();
  });

  it('applies the retail param with the verbatim label value', () => {
    const lens = lensFor('CS-09', fullBinding);
    expect(lens).not.toBeNull();
    expect(lens!.params).toEqual({ retail_brand_label: 'Forager Pantry' });
    expect(lens!.decision).toEqual({
      query_id: 'CS-09',
      outcome: 'applied',
      param: 'retail_brand_label',
      value: 'Forager Pantry',
    });
  });

  it('applies the ads param to BRAIN-CAMPAIGN', () => {
    const lens = lensFor('BRAIN-CAMPAIGN', fullBinding);
    expect(lens!.params).toEqual({ ads_brand_label: 'Forager Pantry' });
    expect(lens!.decision.outcome).toBe('applied');
  });

  it('records account_wide (empty params) for a bound brand on a non-lens query', () => {
    const lens = lensFor('CS-02', fullBinding);
    expect(lens!.params).toEqual({});
    expect(lens!.decision).toEqual({ query_id: 'CS-02', outcome: 'account_wide' });
  });

  it('records missing_label_value when the binding lacks that side', () => {
    const noAds: BindingBlock = { ...fullBinding };
    delete (noAds as { ads_label?: unknown }).ads_label;
    const lens = lensFor('BRAIN-CAMPAIGN', noAds);
    expect(lens!.params).toEqual({});
    expect(lens!.decision.outcome).toBe('missing_label_value');
    expect(lens!.decision.param).toBe('ads_brand_label');
  });

  it('never normalizes the label value', () => {
    const odd: BindingBlock = {
      ...fullBinding,
      retail_label: { source: 'vendor_items.CustomBrand', value: '  Chef Soraya & Co. (EU) ' },
    };
    const lens = lensFor('CS-11', odd);
    expect(lens!.params.retail_brand_label).toBe('  Chef Soraya & Co. (EU) ');
  });
});

describe('summarizeLens + renderLensNotice', () => {
  const decisions: LensDecision[] = [
    { query_id: 'CS-09', outcome: 'applied', param: 'retail_brand_label', value: 'X' },
    { query_id: 'CS-02', outcome: 'account_wide' },
    { query_id: 'CS-04', outcome: 'account_wide' },
    { query_id: 'BRAIN-CAMPAIGN', outcome: 'missing_label_value', param: 'ads_brand_label' },
  ];

  it('splits decisions three ways', () => {
    expect(summarizeLens(decisions)).toEqual({
      bound: true,
      applied: ['CS-09'],
      account_wide: ['CS-02', 'CS-04'],
      missing_label_value: ['BRAIN-CAMPAIGN'],
    });
  });

  it('renders a loud single-line notice naming the account-wide queries and the slug', () => {
    const notice = renderLensNotice(summarizeLens(decisions), 'forager-pantry');
    expect(notice).toContain('label-scoped: CS-09');
    expect(notice).toContain('ACCOUNT-WIDE');
    expect(notice).toContain('CS-02, CS-04');
    expect(notice).toContain('forager-pantry');
    expect(notice).toContain('BRAIN-CAMPAIGN');
  });

  it('returns null (says nothing) when no decisions exist', () => {
    expect(renderLensNotice(summarizeLens([]), 'x-brand')).toBeNull();
  });
});
