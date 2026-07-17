import { describe, it, expect } from 'vitest';
import { deriveQueryShape } from './query-runner.js';

describe('deriveQueryShape', () => {
  it('SELECT * → select_star, table extracted, projected_cols null', () => {
    expect(deriveQueryShape('SELECT * FROM campaigns')).toEqual({
      table: 'campaigns',
      select_star: true,
      projected_cols: null,
    });
  });

  it('SELECT t.* → select_star true', () => {
    expect(deriveQueryShape('SELECT c.* FROM campaigns c')).toEqual({
      table: 'campaigns',
      select_star: true,
      projected_cols: null,
    });
  });

  it('explicit column list → projected_cols counted, not select_star', () => {
    expect(deriveQueryShape('SELECT a, b, c FROM t')).toEqual({
      table: 't',
      select_star: false,
      projected_cols: 3,
    });
  });

  it('does not count commas inside function calls', () => {
    expect(deriveQueryShape('SELECT COUNT(*), IFNULL(a, 0), b FROM sales')).toEqual({
      table: 'sales',
      select_star: false,
      projected_cols: 3,
    });
  });

  it('drops a leading DISTINCT quantifier', () => {
    expect(deriveQueryShape('SELECT DISTINCT a, b FROM t')).toEqual({
      table: 't',
      select_star: false,
      projected_cols: 2,
    });
    expect(deriveQueryShape('SELECT DISTINCT * FROM t').select_star).toBe(true);
  });

  it('lowercases the table and drops the schema qualifier', () => {
    expect(deriveQueryShape('SELECT * FROM DashAmazon.Campaigns').table).toBe('campaigns');
    expect(deriveQueryShape('SELECT * FROM `dashamazon`.`mws_items`').table).toBe('mws_items');
  });

  it('takes the FIRST (primary) table when joins are present', () => {
    expect(
      deriveQueryShape('SELECT a.x, b.y FROM campaigns a JOIN ad_groups b ON a.id = b.cid'),
    ).toEqual({ table: 'campaigns', select_star: false, projected_cols: 2 });
  });

  it('handles an aliased table with AS', () => {
    expect(deriveQueryShape('SELECT x FROM mws_items AS m WHERE m.asin = ?').table).toBe(
      'mws_items',
    );
  });

  it('CTE: primary table is the OUTER query FROM, not the CTE body', () => {
    const sql =
      'WITH recent AS (SELECT id FROM staging_orders WHERE dt > ?) ' +
      'SELECT o.* FROM orders o JOIN recent r ON o.id = r.id';
    expect(deriveQueryShape(sql)).toEqual({
      table: 'orders',
      select_star: true,
      projected_cols: null,
    });
  });

  it('subquery in FROM → table null (not confidently extractable)', () => {
    const sql = 'SELECT x, y FROM (SELECT x, y FROM campaigns) AS sub';
    expect(deriveQueryShape(sql)).toEqual({
      table: null,
      select_star: false,
      projected_cols: 2,
    });
  });

  it('skips line and block comments', () => {
    const sql =
      '-- pull the campaigns\nSELECT /* only two */ a, b\nFROM campaigns -- FROM decoys\n';
    expect(deriveQueryShape(sql)).toEqual({
      table: 'campaigns',
      select_star: false,
      projected_cols: 2,
    });
  });

  it('does not mistake a keyword inside a string literal', () => {
    const sql = "SELECT name FROM brands WHERE note = 'select * from evil'";
    expect(deriveQueryShape(sql)).toEqual({
      table: 'brands',
      select_star: false,
      projected_cols: 1,
    });
  });

  it('no FROM (e.g. SELECT 1) → table null', () => {
    expect(deriveQueryShape('SELECT 1')).toEqual({
      table: null,
      select_star: false,
      projected_cols: 1,
    });
  });

  it('tolerates a trailing semicolon and surrounding whitespace', () => {
    expect(deriveQueryShape('  SELECT * FROM t ;  ').table).toBe('t');
  });

  it('empty / whitespace SQL → all nulls', () => {
    expect(deriveQueryShape('')).toEqual({ table: null, select_star: false, projected_cols: null });
    expect(deriveQueryShape('   ')).toEqual({
      table: null,
      select_star: false,
      projected_cols: null,
    });
  });

  // The critical gotcha: the pager wraps each page as
  // `SELECT * FROM (<user sql>) AS _mx_page ORDER BY ... LIMIT ... OFFSET ...`.
  // Deriving from the wrapped SQL must report the USER's table, never `_mx_page`.
  it('pager wrapper (paged page) → reports the INNER user table, not _mx_page', () => {
    const wrapped =
      'SELECT * FROM (SELECT id, spend FROM campaigns ORDER BY spend DESC LIMIT 120) ' +
      'AS _mx_page ORDER BY 1, 2 LIMIT 5000 OFFSET 10000';
    expect(deriveQueryShape(wrapped)).toEqual({
      table: 'campaigns',
      select_star: false,
      projected_cols: 2,
    });
  });

  it('pager probe wrapper (LIMIT 1) → reports the inner user table', () => {
    const probe = 'SELECT * FROM (SELECT * FROM mws_items WHERE SellerID = ?) AS _mx_page LIMIT 1';
    expect(deriveQueryShape(probe)).toEqual({
      table: 'mws_items',
      select_star: true,
      projected_cols: null,
    });
  });

  it('a genuine user subquery aliased something OTHER than _mx_page is not unwrapped', () => {
    // Only the pager alias triggers unwrap; a real user derived-table stays null.
    const sql = 'SELECT * FROM (SELECT * FROM t) AS my_sub';
    expect(deriveQueryShape(sql).table).toBe(null);
  });
});
