/**
 * Pre-send column check: the block cases (a column certainly absent from a
 * single catalogued table), the pass cases (every valid-SQL shape the check
 * must read correctly), the send-unchanged cases (anything it cannot be sure
 * about), the suggestion ranking, and the hint text. A false block is the
 * failure mode this suite exists to prevent: every `ok`/`skipped` case here is
 * a shape seen in real successful queries.
 */
import { describe, it, expect } from 'vitest';
import { checkColumns, suggestColumns, unknownColumnFriendly, type ColumnCheck } from './column-check.js';
import type { SchemaCatalog, SchemaTable } from './schema-catalog.js';

function table(name: string, columns: string[], extra: Partial<SchemaTable> = {}): [string, SchemaTable] {
  return [name, { name, columns, keyColumns: {}, gotchas: [], ...extra }];
}

const catalog: SchemaCatalog = new Map([
  table(
    'campaignmetric',
    ['CampaignID', 'AmazonCampaignID', 'SellerID', 'AmazonSellerID', 'SellerName', 'DateKey', 'DateTime', 'CampaignName', 'CampaignType', 'Cost', 'Clicks', 'Sales', 'Orders', 'Units', 'Impressions', 'ACos'],
    {
      keyColumns: { spend: 'Cost', sales: 'Sales' },
      gotchas: ['There is no `Date` column. Filter on `DateTime` (datetime), or `DateKey` (int, YYYYMMDD).'],
    },
  ),
  table('seller', ['ID', 'AgencyName', 'MerchantAlias', 'Name', 'AmazonSellerID', 'ProfileId', 'MarketPlaceID', 'IsActive', 'dtCreatedOn'], {
    gotchas: ['The primary key is `ID`. There is no `SellerID` column here.'],
  }),
  table('business_reports_dpst_date', ['ID', 'SellerID', 'DateTime', 'SalesAmount', 'UnitsOrdered', 'Sessions', 'PageViews'], {
    keyColumns: { sales: 'SalesAmount', units: 'UnitsOrdered' },
  }),
  table('mws_items', ['ID', 'SellerID', 'SKU', 'ASIN', 'ItemName', 'ItemPrice', 'ItemQuantityAvailable', 'Brand', 'IsActive']),
]);

const check = (sql: string): ColumnCheck => checkColumns(sql, catalog);
const blocked = (sql: string) => {
  const r = check(sql);
  expect(r.verdict, sql).toBe('unknown_column');
  return r as Extract<ColumnCheck, { verdict: 'unknown_column' }>;
};
const passes = (sql: string) => expect(check(sql).verdict, sql).toBe('ok');
const skipped = (sql: string, reason?: string) => {
  const r = check(sql);
  expect(r.verdict, sql).toBe('skipped');
  if (reason) expect((r as { reason: string }).reason, sql).toBe(reason);
};

describe('checkColumns: blocks a column that is certainly absent', () => {
  it('the archetype: a money column guessed on a metric table', () => {
    const r = blocked('SELECT SUM(spend) FROM campaignmetric WHERE SellerID = 1');
    expect(r.table).toBe('campaignmetric');
    expect(r.column).toBe('spend');
    expect(r.suggestions[0]).toBe('Cost');
    expect(r.columns).toContain('Cost');
    expect(r.gotchas).toHaveLength(1);
  });

  it('the widest real case: SellerName on seller (suggests Name)', () => {
    const r = blocked("SELECT * FROM seller WHERE SellerName LIKE '%acme%' OR SellerName LIKE '%Acme%'");
    expect(r.column).toBe('SellerName');
    expect(r.suggestions[0]).toBe('Name');
  });

  it('a qualified name through the table alias', () => {
    expect(blocked('SELECT s.SellerName FROM seller s WHERE s.IsActive = 1').column).toBe('SellerName');
    expect(blocked('SELECT seller.SellerName FROM seller').column).toBe('SellerName');
    expect(blocked('SELECT s.Name FROM seller AS s ORDER BY s.Nmae').column).toBe('Nmae');
  });

  it('a column inside a function, in WHERE, GROUP BY, ORDER BY and HAVING', () => {
    expect(blocked('SELECT MIN(DateKey), MAX(DateKey) FROM business_reports_dpst_date WHERE SellerID = 1').column).toBe('DateKey');
    expect(blocked('SELECT COUNT(*) FROM seller WHERE Status = 1').column).toBe('Status');
    expect(blocked('SELECT COUNT(*) AS n FROM campaignmetric GROUP BY CampaignTyp').column).toBe('CampaignTyp');
    expect(blocked('SELECT CampaignName FROM campaignmetric ORDER BY spend DESC').column).toBe('spend');
    expect(blocked('SELECT CampaignName, SUM(Cost) FROM campaignmetric GROUP BY CampaignName HAVING SUM(Spent) > 1').column).toBe('Spent');
  });

  it('an alias with the same name as the guessed column does not hide the guess', () => {
    // Seen live: `MAX(Title) title` on a table with no Title column.
    expect(blocked('SELECT ASIN, MAX(Brand) brand, MAX(Title) title FROM mws_items GROUP BY ASIN').column).toBe('Title');
    expect(blocked('SELECT Cost spend, spend * 2 FROM campaignmetric').column).toBe('spend');
  });

  it('reports the first unknown column when there are several', () => {
    expect(blocked('SELECT units, sales FROM business_reports_dpst_date').column).toBe('units');
  });

  it('a column name that is a reserved-looking word but not a keyword', () => {
    expect(blocked('SELECT Title FROM mws_items').column).toBe('Title');
  });

  it('type-name words are columns outside a type position: the most-guessed `Date`', () => {
    const r = blocked('SELECT YEAR(Date) y, SUM(Cost) FROM campaignmetric GROUP BY y');
    expect(r.column).toBe('Date');
    expect(r.suggestions).toContain('DateTime');
    expect(blocked('SELECT Date d, SalesAmount FROM business_reports_dpst_date WHERE Date >= \'2026-01-01\'').column).toBe('Date');
    expect(blocked('SELECT * FROM campaignmetric ORDER BY date').column).toBe('date');
    expect(blocked('SELECT SUM(Cost) FROM campaignmetric WHERE year = 2026').column).toBe('year');
  });

  it('still blocks with a trailing semicolon, comments, and odd spacing', () => {
    expect(blocked('  select\n  spend -- the ad spend\n from campaignmetric ; ').column).toBe('spend');
    expect(blocked('/* mtd */ SELECT spend FROM campaignmetric').column).toBe('spend');
  });
});

describe('checkColumns: sends valid single-table SQL through', () => {
  it('plain projections, star, count, distinct', () => {
    passes('SELECT * FROM seller');
    passes('SELECT ID, Name FROM seller WHERE IsActive = 1 LIMIT 10');
    passes('SELECT COUNT(*) FROM seller');
    passes('SELECT COUNT(DISTINCT CampaignID) FROM campaignmetric');
    passes('SELECT DISTINCT CampaignType FROM campaignmetric');
    passes('select sellerid, cost from campaignmetric');
  });

  it('column names compare case-insensitively, as MySQL does', () => {
    passes('SELECT sellerid, COST, dateTIME FROM campaignmetric');
  });

  it('aliases: AS, implicit, table alias, star through alias, alias reused in GROUP/ORDER BY', () => {
    passes('SELECT SUM(Cost) AS spend, SUM(Sales) AS ad_sales FROM campaignmetric GROUP BY DateKey ORDER BY spend DESC');
    passes('SELECT SUM(Cost) spend, DateTime d FROM campaignmetric GROUP BY d ORDER BY spend');
    passes('SELECT m.CampaignName, SUM(m.Cost) FROM campaignmetric m WHERE m.SellerID = 1 GROUP BY m.CampaignName');
    passes('SELECT m.* FROM campaignmetric AS m LIMIT 5');
    passes('SELECT Cost total_cost, Clicks + Impressions reach FROM campaignmetric');
    passes('SELECT IsActive IS NULL flag, 1 one, \'x\' label FROM seller');
    passes("SELECT CASE WHEN Cost > 0 THEN 'spent' ELSE 'none' END bucket FROM campaignmetric");
  });

  it('functions, date arithmetic, intervals, casts, collation, windows', () => {
    passes("SELECT DATE_FORMAT(DateTime, '%Y-%m') AS ym, SUM(Cost) FROM campaignmetric WHERE DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY ym");
    passes('SELECT YEAR(DateTime), MONTH(DateTime), WEEK(DateTime, 1) FROM campaignmetric');
    passes('SELECT CAST(Cost AS SIGNED), CONVERT(Clicks, CHAR), Cost DIV 2, Cost MOD 3 FROM campaignmetric');
    passes("SELECT Name FROM seller WHERE Name COLLATE utf8mb4_general_ci LIKE '%x%'");
    passes('SELECT CampaignName, SUM(Cost) OVER (PARTITION BY CampaignID ORDER BY DateTime ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS c7 FROM campaignmetric');
    passes('SELECT ROUND(SUM(Cost) / NULLIF(SUM(Sales), 0), 4) AS acos FROM campaignmetric');
    passes("SELECT EXTRACT(YEAR FROM DateTime) y, TRIM(LEADING 'x' FROM CampaignName) FROM campaignmetric");
    passes("SELECT GROUP_CONCAT(DISTINCT CampaignName ORDER BY CampaignName SEPARATOR ', ') FROM campaignmetric");
    passes('SELECT IFNULL(Cost, 0), COALESCE(Sales, 0), GREATEST(Cost, Sales), IF(Cost > 1, 1, 0) FROM campaignmetric');
    passes('SELECT CURRENT_DATE, CURRENT_TIMESTAMP, NOW(), CURDATE() FROM seller');
    passes("SELECT DateTime + INTERVAL 1 DAY, TIMESTAMPDIFF(DAY, DateTime, NOW()) FROM campaignmetric");
    passes('SELECT * FROM campaignmetric WHERE DateKey BETWEEN 20260901 AND 20260930 AND CampaignType IN (\'sp\', \'sb\') AND Cost IS NOT NULL');
    passes("SELECT * FROM seller WHERE Name REGEXP '^A' OR Name RLIKE 'b$' OR Name SOUNDS LIKE 'c'");
    passes('SELECT * FROM campaignmetric ORDER BY 1 DESC, 2 LIMIT 10 OFFSET 20');
    passes('SELECT * FROM campaignmetric LIMIT 5, 10');
    passes('SELECT CampaignName FROM campaignmetric GROUP BY CampaignName WITH ROLLUP');
    passes('SELECT SQL_CALC_FOUND_ROWS Name FROM seller');
  });

  it('type names and units in a type position, and type-named aliases', () => {
    passes('SELECT DateTime d, SUM(Cost) spend FROM campaignmetric GROUP BY d ORDER BY spend');
    passes('SELECT YEAR(DateTime) year, MONTH(DateTime) month, DATE(DateTime) AS date FROM campaignmetric GROUP BY year, month, date ORDER BY date');
    passes('SELECT CAST(Cost AS DECIMAL(10, 2)), CAST(DateTime AS DATE), CONVERT(Clicks, CHAR), CONVERT(CampaignName USING utf8mb4) FROM campaignmetric');
    passes("SELECT TIMESTAMPDIFF(DAY, DateTime, NOW()), TIMESTAMPADD(MONTH, 1, DateTime), DATE_ADD(DateTime, INTERVAL 1 WEEK) FROM campaignmetric");
    passes("SELECT * FROM campaignmetric WHERE DateTime >= NOW() - INTERVAL 7 DAY AND DateTime < CURDATE() + INTERVAL '1' MONTH");
    passes('SELECT EXTRACT(YEAR FROM DateTime), EXTRACT(DAY FROM DateTime) FROM campaignmetric');
    passes("SELECT * FROM seller WHERE BINARY Name = 'Acme'");
    passes("SELECT SUM(CASE WHEN DateTime >= '2026-10-01' THEN Cost ELSE 0 END) mtd, MAX(CASE WHEN Cost > 0 THEN DateTime END) last_spend FROM campaignmetric");
  });

  it('keywords and column names inside string literals are not column references', () => {
    passes("SELECT Name FROM seller WHERE Name = 'spend from nowhere' OR Name = \"SellerName\"");
    passes("SELECT Name FROM seller WHERE Name = 'it''s' OR Name = 'a\\'b'");
  });

  it('parameters and user variables are not columns', () => {
    passes('SELECT Name FROM seller WHERE ID = ? AND IsActive = :active');
    passes('SELECT @rank := @rank + 1 AS r, Name FROM seller');
    passes('SELECT @@version, Name FROM seller');
  });

  it('a column that is also a keyword-like word in the catalog resolves as a column', () => {
    // `Orders` and `Units` are columns; `Sales` is both a role and a column.
    passes('SELECT Orders, Units, Sales FROM campaignmetric');
  });
});

describe('checkColumns: sends anything it cannot be sure about unchanged', () => {
  it('empty / not a SELECT', () => {
    skipped('', 'empty');
    skipped('   ', 'empty');
    skipped('SHOW COLUMNS FROM campaignmetric', 'not_select');
    skipped('DESCRIBE seller', 'not_select');
    skipped('EXPLAIN SELECT spend FROM campaignmetric', 'not_select');
    skipped('SELECT 1', 'not_select');
  });

  it('backticks anywhere', () => {
    skipped('SELECT `spend` FROM campaignmetric', 'backtick');
    skipped('SELECT Cost FROM `campaignmetric`', 'backtick');
  });

  it('CTEs, subqueries, unions', () => {
    skipped('WITH x AS (SELECT spend FROM campaignmetric) SELECT * FROM x', 'cte');
    skipped('SELECT spend FROM campaignmetric WHERE SellerID IN (SELECT ID FROM seller)', 'subquery_or_union');
    skipped('SELECT * FROM (SELECT spend FROM campaignmetric) t', 'subquery_or_union');
    skipped('SELECT spend FROM campaignmetric WHERE EXISTS (SELECT 1 FROM seller)', 'subquery_or_union');
    skipped('SELECT Cost FROM campaignmetric UNION ALL SELECT spend FROM campaignmetric', 'subquery_or_union');
  });

  it('joins of every spelling, including comma joins', () => {
    skipped('SELECT m.spend FROM campaignmetric m JOIN seller s ON s.ID = m.SellerID', 'multi_table');
    skipped('SELECT m.spend FROM campaignmetric m LEFT JOIN seller s ON s.ID = m.SellerID', 'multi_table');
    skipped('SELECT m.spend FROM campaignmetric AS m INNER JOIN seller AS s ON s.ID = m.SellerID', 'multi_table');
    skipped('SELECT m.spend FROM campaignmetric m STRAIGHT_JOIN seller s ON s.ID = m.SellerID', 'multi_table');
    skipped('SELECT m.spend FROM campaignmetric m, seller s WHERE s.ID = m.SellerID', 'multi_table');
    skipped('SELECT spend FROM campaignmetric NATURAL JOIN seller', 'multi_table');
    skipped('SELECT spend FROM campaignmetric CROSS JOIN seller', 'multi_table');
  });

  it('a schema-qualified or uncatalogued table, an unknown qualifier, an index hint', () => {
    skipped('SELECT column_name FROM information_schema.columns', 'qualified_table');
    skipped('SELECT spend FROM sponsoredbrandsmetric', 'unknown_table');
    skipped('SELECT x.spend FROM campaignmetric', 'unknown_qualifier');
    skipped('SELECT spend FROM campaignmetric FORCE INDEX (idx_seller_date)', 'index_hint');
    skipped('SELECT spend FROM campaignmetric USE INDEX (idx_seller_date)', 'index_hint');
    skipped('SELECT * FROM dual', 'unknown_table');
  });
});

describe('suggestColumns', () => {
  const cm = catalog.get('campaignmetric')!;
  it('prefers the curated role hint', () => {
    expect(suggestColumns('spend', cm)[0]).toBe('Cost');
    expect(suggestColumns('SPEND', cm)[0]).toBe('Cost');
  });
  it('then the same name with different case or underscores', () => {
    expect(suggestColumns('seller_id', cm)[0]).toBe('SellerID');
    expect(suggestColumns('campaign_name', cm)[0]).toBe('CampaignName');
  });
  it('then a small edit distance, transpositions included', () => {
    expect(suggestColumns('DateTiem', cm)[0]).toBe('DateTime');
    expect(suggestColumns('Clciks', cm)[0]).toBe('Clicks');
  });
  it('then a shared prefix or a contained name', () => {
    expect(suggestColumns('SellerName', catalog.get('seller')!)[0]).toBe('Name');
    expect(suggestColumns('DateKey', catalog.get('business_reports_dpst_date')!)[0]).toBe('DateTime');
    expect(suggestColumns('SellerSKU', catalog.get('mws_items')!)[0]).toBe('SKU');
    expect(suggestColumns('Price', catalog.get('mws_items')!)[0]).toBe('ItemPrice');
  });
  it('returns nothing rather than a bad guess, and at most three', () => {
    expect(suggestColumns('Title', catalog.get('mws_items')!)).toEqual([]);
    expect(suggestColumns('xyzzy', cm)).toEqual([]);
    expect(suggestColumns('Sale', cm).length).toBeLessThanOrEqual(3);
  });
});

describe('unknownColumnFriendly', () => {
  it('names the column, the table, the best match, the real columns, the gotchas, and that nothing was sent', () => {
    const r = blocked('SELECT SUM(spend) FROM campaignmetric');
    const text = unknownColumnFriendly(r);
    expect(text).toContain('No column `spend` on `campaignmetric`. Did you mean `Cost`?');
    expect(text).toContain('Columns on `campaignmetric` (16): CampaignID, AmazonCampaignID,');
    expect(text).toContain('Before you name a column:\n- There is no `Date` column.');
    expect(text).toContain('The query was not sent.');
    expect(text).toContain('tell the user which column you used in place of `spend`');
    expect(text).not.toContain('—');
  });
  it('lists runner-up suggestions and omits the question when there is no match', () => {
    const several = blocked('SELECT SellerI FROM campaignmetric');
    expect(unknownColumnFriendly(several)).toMatch(/Did you mean `SellerID` \(or `[A-Za-z]+`, `[A-Za-z]+`\)\?/);
    const none = blocked('SELECT Title FROM mws_items');
    const text = unknownColumnFriendly(none);
    expect(text).toContain('No column `Title` on `mws_items`.\nColumns on `mws_items`');
    expect(text).not.toContain('Did you mean');
    expect(text).not.toContain('Before you name a column');
  });
});
