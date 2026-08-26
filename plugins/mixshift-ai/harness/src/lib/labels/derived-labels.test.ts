import { describe, it, expect } from 'vitest';
import {
  buildGroupingExpression,
  applyDerivedGrouping,
  UnsafeLabelError,
  UNCLASSIFIED,
  LABEL_QUERY_COLUMNS,
} from './derived-labels.js';

const DHC07_SHAPE = `
SELECT
    COALESCE(NULLIF(c.Objective, ''), '(unclassified)') AS Objective,
    SUM(m.Cost) AS spend
FROM campaignmetric m
JOIN campaign c ON m.CampaignID = c.ID
WHERE m.SellerID = :seller_id
GROUP BY COALESCE(NULLIF(c.Objective, ''), '(unclassified)')
ORDER BY spend DESC;`;

describe('buildGroupingExpression', () => {
  it('keeps the raw column first so an operator label always wins', () => {
    // The rule that matters most: a human who typed a label meant it. A
    // derived label may only fill a gap, never overwrite words someone chose.
    const expr = buildGroupingExpression({ buckets: { Brand: [1, 2] } }, 'Objective')!;
    expect(expr.indexOf("NULLIF(c.Objective, '')")).toBeLessThan(expr.indexOf('CASE'));
    expect(expr).toMatch(/^COALESCE\(NULLIF\(c\.Objective, ''\), CASE /);
  });

  it('falls back to the same literal the pack already emits', () => {
    // The fallback must not change the output shape: the skill has documented
    // handling for an '(unclassified)' row and would not recognise a new one.
    const expr = buildGroupingExpression({ buckets: { Brand: [1] } }, 'Objective')!;
    // Asserted as a LITERAL on purpose. Interpolating UNCLASSIFIED here meant
    // the test moved with the constant: renaming it to 'Other' kept 26/26
    // green while derived runs emitted a fallback row the skill's documented
    // '(unclassified)' handling does not recognise. Pin the contract, not the
    // variable.
    expect(expr).toContain("ELSE '(unclassified)'");
    expect(UNCLASSIFIED, 'the shipped literal is part of the output contract').toBe(
      '(unclassified)',
    );
  });

  it('returns null when there is nothing to add, so the untouched pack runs', () => {
    expect(buildGroupingExpression(null, 'Objective')).toBeNull();
    expect(buildGroupingExpression({ buckets: {} }, 'Objective')).toBeNull();
    // A bucket with no campaigns is not a grouping, it is an empty name.
    expect(buildGroupingExpression({ buckets: { Brand: [] } }, 'Objective')).toBeNull();
  });

  it('emits one WHEN per bucket with the ids inlined as integers', () => {
    const expr = buildGroupingExpression(
      { buckets: { 'Non-Brand': [10, 11], Brand: [12] } },
      'Objective',
    )!;
    expect(expr).toContain("WHEN c.ID IN (10,11) THEN 'Non-Brand'");
    expect(expr).toContain("WHEN c.ID IN (12) THEN 'Brand'");
  });
});

describe('buildGroupingExpression — SQL safety', () => {
  // These labels reach us from brand context, which a user edited. They are
  // concatenated into SQL, so the allowlist is load-bearing, not cosmetic.
  it.each([
    ["Brand'; DROP TABLE campaign; --", 'a quote-escape injection'],
    ["O'Brien", 'an apostrophe, which would terminate the literal'],
    ['Brand\\', 'a trailing backslash'],
    ['', 'an empty label'],
    ['x'.repeat(65), 'an over-long label'],
    ['Brand\nDefense', 'an embedded newline'],
    ['<script>', 'angle brackets'],
  ])('refuses %j (%s)', (label, _why) => {
    expect(() => buildGroupingExpression({ buckets: { [label]: [1] } }, 'Objective')).toThrow(
      UnsafeLabelError,
    );
  });

  it.each([
    ['1 OR 1=1', 'an injected predicate'],
    ['1);DROP TABLE campaign;--', 'a statement break'],
    [1.5, 'a non-integer'],
    [-3, 'a negative id'],
    [0, 'zero'],
    [Number.MAX_SAFE_INTEGER + 2, 'an unsafe integer'],
  ])('refuses the campaign id %j (%s)', (id, _why) => {
    expect(() =>
      buildGroupingExpression({ buckets: { Brand: [id as unknown as number] } }, 'Objective'),
    ).toThrow(UnsafeLabelError);
  });

  it('accepts the bucket names real accounts actually use', () => {
    const ok = ['Non-Brand', 'Brand Defense', 'Top of Funnel', 'Auto/Catch-All', 'B&M', 'SP_Video'];
    for (const label of ok) {
      expect(() => buildGroupingExpression({ buckets: { [label]: [1] } }, 'Objective')).not.toThrow();
    }
  });

  it('refuses an injected column or table alias', () => {
    expect(() => buildGroupingExpression({ buckets: { Brand: [1] } }, "Objective'; --")).toThrow(
      UnsafeLabelError,
    );
    expect(() => buildGroupingExpression({ buckets: { Brand: [1] } }, 'Objective', 'c;x')).toThrow(
      UnsafeLabelError,
    );
  });
});

describe('applyDerivedGrouping', () => {
  it('replaces the expression in BOTH the SELECT and the GROUP BY', () => {
    // These must move together. The packs repeat the COALESCE deliberately
    // (the SELECT alias shadows the bare column in MySQL), so replacing only
    // one would group by one thing while labelling by another and silently
    // mis-attribute spend -- a wrong table that still foots to account total.
    const expr = buildGroupingExpression({ buckets: { Brand: [7] } }, 'Objective')!;
    const out = applyDerivedGrouping(DHC07_SHAPE, 'Objective', expr);
    expect(out).not.toContain("COALESCE(NULLIF(c.Objective, ''), '(unclassified)')");
    expect(out.match(/CASE WHEN c\.ID IN \(7\)/g)).toHaveLength(2);
    // Everything else is untouched: same aggregates, same filter, same order.
    expect(out).toContain('SUM(m.Cost) AS spend');
    expect(out).toContain('WHERE m.SellerID = :seller_id');
    expect(out).toContain('ORDER BY spend DESC');
  });

  it('throws rather than half-applying when the pack shape changes', () => {
    const expr = buildGroupingExpression({ buckets: { Brand: [7] } }, 'Objective')!;
    const oneOccurrence = `SELECT COALESCE(NULLIF(c.Objective, ''), '(unclassified)') AS Objective FROM x`;
    expect(() => applyDerivedGrouping(oneOccurrence, 'Objective', expr)).toThrow(/found 1/);
    // Failing loudly beats emitting a query whose grouping and labelling disagree.
    expect(() => applyDerivedGrouping('SELECT 1', 'Objective', expr)).toThrow(/found 0/);
  });

  it('does not let a COMMENT satisfy the both-occurrences guard', () => {
    // The guard used to count matches anywhere in the text, so a pack with the
    // expression in a comment plus ONE real occurrence passed: the SELECT was
    // rewritten and the GROUP BY was not, which is a table that still foots to
    // the account total while attributing spend to the wrong rows.
    const expr = buildGroupingExpression({ buckets: { Brand: [7] } }, 'Objective')!;
    const commentPlusOne = [
      "-- see COALESCE(NULLIF(c.Objective, ''), '(unclassified)') for why",
      "SELECT COALESCE(NULLIF(c.Objective, ''), '(unclassified)') AS Objective FROM t",
    ].join('\n');
    expect(() => applyDerivedGrouping(commentPlusOne, 'Objective', expr)).toThrow(
      /found 1 outside comments/,
    );
  });

  it('never splices the query into itself through a $ replacement token', () => {
    // `$&`, `` $` `` and `$'` are special in a replacement STRING. No label can
    // contain `$` today, but applyDerivedGrouping is exported and takes the
    // expression as a plain string.
    const out = applyDerivedGrouping(DHC07_SHAPE, 'Objective', "CASE WHEN 1 THEN '$&' END");
    expect(out).not.toContain('COALESCE(NULLIF');
    expect(out.match(/CASE WHEN 1 THEN '\$&' END/g)).toHaveLength(2);
  });

  it('covers both affected queries with the right column each', () => {
    expect(LABEL_QUERY_COLUMNS['DHC-07']).toEqual({ dimension: 'objective', column: 'Objective' });
    expect(LABEL_QUERY_COLUMNS['DHC-08']).toEqual({ dimension: 'item_group', column: 'ItemGroup' });
  });
});
