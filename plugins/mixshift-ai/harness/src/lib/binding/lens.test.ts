import { describe, it, expect } from 'vitest';
import {
  LABEL_LENS_PARAM_BY_QUERY,
  lensFor,
  reconcileLensDecision,
  reconcileLensDecisions,
  summarizeLens,
  renderLensNotice,
  type LensDecision,
  type QueryLensOutcome,
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

describe('lensFor — INTENT, before the query has run', () => {
  it('returns null for an unbound brand — nothing sent, nothing recorded', () => {
    expect(lensFor('BRAIN-CATALOG-SC', null)).toBeNull();
    expect(lensFor('CS-02', undefined)).toBeNull();
  });

  it('a label-aware query with a value: sends the param, but the decision is a PLACEHOLDER, not a claim', () => {
    const lens = lensFor('CS-09', fullBinding);
    expect(lens).not.toBeNull();
    expect(lens!.params).toEqual({ retail_brand_label: 'Forager Pantry' });
    expect(lens!.pendingVerification).toBe(true);
    // The central fix: outcome is NOT 'applied' yet. It cannot be, because
    // the query has not run. It starts as 'unverified' until reconciled.
    expect(lens!.decision).toEqual({
      query_id: 'CS-09',
      outcome: 'unverified',
      param: 'retail_brand_label',
      value: 'Forager Pantry',
    });
  });

  it('sends the ads param to BRAIN-CAMPAIGN, still as a placeholder', () => {
    const lens = lensFor('BRAIN-CAMPAIGN', fullBinding);
    expect(lens!.params).toEqual({ ads_brand_label: 'Forager Pantry' });
    expect(lens!.decision.outcome).toBe('unverified');
    expect(lens!.pendingVerification).toBe(true);
  });

  it('records account_wide (final, no reconciliation needed) for a bound brand on a non-lens query', () => {
    const lens = lensFor('CS-02', fullBinding);
    expect(lens!.params).toEqual({});
    expect(lens!.pendingVerification).toBe(false);
    expect(lens!.decision).toEqual({ query_id: 'CS-02', outcome: 'account_wide' });
  });

  it('records missing_label_value (final) when the binding lacks that side', () => {
    const noAds: BindingBlock = { ...fullBinding };
    delete (noAds as { ads_label?: unknown }).ads_label;
    const lens = lensFor('BRAIN-CAMPAIGN', noAds);
    expect(lens!.params).toEqual({});
    expect(lens!.pendingVerification).toBe(false);
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

describe('reconcileLensDecision — the central fix: EVIDENCE, not intent', () => {
  const pending: LensDecision = {
    query_id: 'CS-09',
    outcome: 'unverified',
    param: 'retail_brand_label',
    value: 'Forager Pantry',
  };

  it('applied_params PRESENT and CONTAINING our key -> applied', () => {
    const outcome: QueryLensOutcome = { status: 'ok', appliedParams: ['retail_brand_label', 'seller_ids'] };
    expect(reconcileLensDecision(pending, outcome)).toEqual({ ...pending, outcome: 'applied' });
  });

  it('applied_params PRESENT and MISSING our key -> dropped (the P0 case)', () => {
    const outcome: QueryLensOutcome = { status: 'ok', appliedParams: ['seller_ids'] };
    expect(reconcileLensDecision(pending, outcome)).toEqual({ ...pending, outcome: 'dropped' });
  });

  it('applied_params ABSENT entirely -> stays unverified (older gateway, no evidence either way)', () => {
    const outcome: QueryLensOutcome = { status: 'ok' };
    expect(reconcileLensDecision(pending, outcome)).toEqual(pending);
  });

  it('the query FAILED -> query_failed, never applied', () => {
    const outcome: QueryLensOutcome = { status: 'failed' };
    expect(reconcileLensDecision(pending, outcome)).toEqual({ ...pending, outcome: 'query_failed' });
  });

  it('the query was DEFERRED -> query_failed (no rows, no scoping claim either way)', () => {
    const outcome: QueryLensOutcome = { status: 'deferred' };
    expect(reconcileLensDecision(pending, outcome)).toEqual({ ...pending, outcome: 'query_failed' });
  });

  it('no outcome recorded at all (query never ran) -> query_failed, never applied by default', () => {
    expect(reconcileLensDecision(pending, undefined)).toEqual({ ...pending, outcome: 'query_failed' });
  });

  it('is a no-op on the two STRUCTURAL outcomes, regardless of the query result', () => {
    const accountWide: LensDecision = { query_id: 'CS-02', outcome: 'account_wide' };
    const missingValue: LensDecision = { query_id: 'BRAIN-CAMPAIGN', outcome: 'missing_label_value', param: 'ads_brand_label' };
    const okOutcome: QueryLensOutcome = { status: 'ok', appliedParams: [] };
    expect(reconcileLensDecision(accountWide, okOutcome)).toEqual(accountWide);
    expect(reconcileLensDecision(missingValue, okOutcome)).toEqual(missingValue);
    expect(reconcileLensDecision(accountWide, { status: 'failed' })).toEqual(accountWide);
  });

  it('is idempotent: reconciling an already-resolved decision again is a no-op', () => {
    const applied: LensDecision = { ...pending, outcome: 'applied' };
    expect(reconcileLensDecision(applied, { status: 'failed' })).toEqual(applied);
  });
});

describe('reconcileLensDecisions (batch form)', () => {
  it('resolves every decision from its matching outcome by query_id', () => {
    const decisions: LensDecision[] = [
      { query_id: 'CS-09', outcome: 'unverified', param: 'retail_brand_label', value: 'X' },
      { query_id: 'BRAIN-CAMPAIGN', outcome: 'unverified', param: 'ads_brand_label', value: 'X' },
      { query_id: 'CS-02', outcome: 'account_wide' },
    ];
    const outcomes = new Map<string, QueryLensOutcome>([
      ['CS-09', { status: 'ok', appliedParams: ['retail_brand_label'] }],
      ['BRAIN-CAMPAIGN', { status: 'ok', appliedParams: ['seller_ids'] }],
    ]);
    const reconciled = reconcileLensDecisions(decisions, outcomes);
    expect(reconciled.find((d) => d.query_id === 'CS-09')!.outcome).toBe('applied');
    expect(reconciled.find((d) => d.query_id === 'BRAIN-CAMPAIGN')!.outcome).toBe('dropped');
    expect(reconciled.find((d) => d.query_id === 'CS-02')!.outcome).toBe('account_wide');
  });
});

describe('summarizeLens + renderLensNotice (post-reconciliation)', () => {
  const decisions: LensDecision[] = [
    { query_id: 'CS-09', outcome: 'applied', param: 'retail_brand_label', value: 'X' },
    { query_id: 'CS-13', outcome: 'dropped', param: 'retail_brand_label', value: 'X' },
    { query_id: 'CS-12', outcome: 'unverified', param: 'retail_brand_label', value: 'X' },
    { query_id: 'BRAIN-CAMPAIGN', outcome: 'query_failed', param: 'ads_brand_label', value: 'X' },
    { query_id: 'CS-02', outcome: 'account_wide' },
    { query_id: 'CS-04', outcome: 'account_wide' },
    { query_id: 'CS-11', outcome: 'missing_label_value', param: 'retail_brand_label' },
  ];

  it('splits decisions into all six buckets', () => {
    expect(summarizeLens(decisions)).toEqual({
      bound: true,
      applied: ['CS-09'],
      dropped: ['CS-13'],
      unverified: ['CS-12'],
      account_wide: ['CS-02', 'CS-04'],
      missing_label_value: ['CS-11'],
      query_failed: ['BRAIN-CAMPAIGN'],
    });
  });

  it('renders a loud single-line notice naming every non-empty bucket and the slug', () => {
    const notice = renderLensNotice(summarizeLens(decisions), 'forager-pantry');
    expect(notice).toContain('label-scoped: CS-09');
    expect(notice).toContain('DROPPED');
    expect(notice).toContain('CS-13');
    expect(notice).toContain('UNVERIFIED');
    expect(notice).toContain('CS-12');
    expect(notice).toContain('BRAIN-CAMPAIGN');
    expect(notice).toContain('ACCOUNT-WIDE');
    expect(notice).toContain('CS-02, CS-04');
    expect(notice).toContain('CS-11');
    expect(notice).toContain('forager-pantry');
  });

  it('returns null (says nothing) when no decisions exist', () => {
    expect(renderLensNotice(summarizeLens([]), 'x-brand')).toBeNull();
  });

  it('bound is false and every bucket is empty for an unbound brand (no decisions)', () => {
    expect(summarizeLens([])).toEqual({
      bound: false,
      applied: [],
      dropped: [],
      unverified: [],
      account_wide: [],
      missing_label_value: [],
      query_failed: [],
    });
  });
});
