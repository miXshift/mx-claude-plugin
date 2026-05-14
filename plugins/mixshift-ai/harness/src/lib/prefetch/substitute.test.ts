import { describe, expect, it } from 'vitest';
import { substituteParams, findReferencedParams } from './substitute.js';

describe('substituteParams', () => {
  it('inlines numeric list params as CSV', () => {
    const sql = `SELECT * FROM t WHERE seller_id IN (:seller_id_list)`;
    const { sql: out, params } = substituteParams(sql, {
      seller_id_list: [111, 222, 333],
    });
    expect(out).toBe(`SELECT * FROM t WHERE seller_id IN (111, 222, 333)`);
    expect(params).toEqual({});
  });

  it('inlines string list params with single-quote escaping', () => {
    const sql = `SELECT * FROM t WHERE asin IN (:asin_list)`;
    const { sql: out } = substituteParams(sql, {
      asin_list: ["B07ABC", "B07'XYZ"],
    });
    expect(out).toBe(`SELECT * FROM t WHERE asin IN ('B07ABC', 'B07''XYZ')`);
  });

  it('leaves scalar :param tokens for mysql2 named placeholders', () => {
    const sql = `SELECT * FROM t WHERE seller_id = :seller_id AND day = :yesterday`;
    const { sql: out, params } = substituteParams(sql, {
      seller_id: 111,
      yesterday: '2026-04-24',
      // Extra unused param — should NOT appear in output params
      unused: 'noise',
    });
    expect(out).toBe(sql);
    expect(params).toEqual({ seller_id: 111, yesterday: '2026-04-24' });
    expect(params).not.toHaveProperty('unused');
  });

  it('mixes list inlining with scalar passthrough in one query', () => {
    const sql = `SELECT *
      FROM keywordtargetingmetric
      WHERE SellerID = :seller_id
        AND DateTime IN (:date_list)
        AND lookback >= :lookback_days`;
    const { sql: out, params } = substituteParams(sql, {
      seller_id: 99,
      date_list: ['2026-04-23', '2026-04-24'],
      lookback_days: 30,
    });
    expect(out).toContain("DateTime IN ('2026-04-23', '2026-04-24')");
    expect(out).toContain(':seller_id');
    expect(out).toContain(':lookback_days');
    expect(params).toEqual({ seller_id: 99, lookback_days: 30 });
  });

  it('does not match :seller_id when the SQL has :seller_id_list', () => {
    // The word-boundary guard prevents :seller_id from gobbling
    // :seller_id_list. Ensures both can coexist in one param map.
    const sql = `SELECT * WHERE SellerID = :seller_id AND OtherID IN (:seller_id_list)`;
    const { sql: out, params } = substituteParams(sql, {
      seller_id: 42,
      seller_id_list: [1, 2, 3],
    });
    expect(out).toBe(
      `SELECT * WHERE SellerID = :seller_id AND OtherID IN (1, 2, 3)`,
    );
    expect(params).toEqual({ seller_id: 42 });
  });

  it('throws on empty list (MySQL would reject "IN ()")', () => {
    expect(() =>
      substituteParams(`SELECT * WHERE x IN (:vals)`, { vals: [] }),
    ).toThrow(/empty list/);
  });

  it('throws on non-finite numbers in list', () => {
    expect(() =>
      substituteParams(`SELECT * WHERE x IN (:vals)`, {
        vals: [1, Number.NaN, 3],
      }),
    ).toThrow(/non-finite/);
  });

  it('throws on object values inside list', () => {
    expect(() =>
      substituteParams(`SELECT * WHERE x IN (:vals)`, {
        vals: [1, { foo: 'bar' }, 3] as unknown[],
      }),
    ).toThrow(/unsupported type/);
  });

  it('handles bigint in lists', () => {
    const { sql } = substituteParams(`SELECT * WHERE x IN (:vals)`, {
      vals: [10n, 20n],
    });
    expect(sql).toBe(`SELECT * WHERE x IN (10, 20)`);
  });
});

describe('findReferencedParams', () => {
  it('finds simple :name tokens', () => {
    expect(findReferencedParams(`SELECT :a, :b`)).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
  });

  it('deduplicates repeated tokens', () => {
    const result = findReferencedParams(`SELECT :a, :a, :b`);
    expect(result.sort()).toEqual(['a', 'b']);
  });

  it('ignores tokens inside string literals', () => {
    const sql = `SELECT 'literal:not_a_param' AS x WHERE id = :real_param`;
    expect(findReferencedParams(sql)).toEqual(['real_param']);
  });

  it('ignores tokens inside line comments', () => {
    const sql = `-- :commented_out\nSELECT :real_one`;
    expect(findReferencedParams(sql)).toEqual(['real_one']);
  });

  it('skips Postgres :: cast operator', () => {
    const sql = `SELECT col::text WHERE id = :real_param`;
    expect(findReferencedParams(sql)).toEqual(['real_param']);
  });
});
