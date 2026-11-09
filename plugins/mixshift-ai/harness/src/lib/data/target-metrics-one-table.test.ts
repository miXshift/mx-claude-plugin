import { describe, it, expect, beforeEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { describeTable } from './tables-catalog.js';
import { getQueryEntry, readQuerySql, resetCatalogCache } from '../prefetch/sql-library.js';
import { pluginPath } from '../prefetch/plugin-root.js';
import { findReferencedParams, substituteParams } from '../prefetch/substitute.js';

// Rule (Sam 2026-11-09): Sponsored Products target search-term rows can be
// duplicated across keywordtargetingmetric (recordType 'Product Attribute
// Targeting') and targetexpressionsmetric, with the same spend, sales, orders
// and clicks. Never sum the two tables. ANEG-04 (lifetime performance by
// location in the ASIN target negation review) reads keywordtargetingmetric
// alone; it used to UNION ALL both tables and SUM, which counted a duplicated
// location twice.

const KT = /\bkeywordtargetingmetric\b/i;
const TE = /\btargetexpressionsmetric\b/i;

/** Executable SQL only: whole-line and trailing `--` comments removed. */
const code = (sql: string): string =>
  sql
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)--(\s.*)?$/, ''))
    .join('\n');

/** The `--` comment text, one line each, prefixes stripped, joined by spaces. */
const comments = (sql: string): string =>
  sql
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('--'))
    .map((l) => l.trim().replace(/^--\s?/, ''))
    .join(' ');

/** True when executable SQL reads both target metrics tables. */
const readsBothTables = (sql: string): boolean => {
  const c = code(sql);
  return KT.test(c) && TE.test(c);
};

async function libraryFile(file: string): Promise<string> {
  return readFile(pluginPath('shared', 'sql-library', file), 'utf8');
}

describe('ANEG-04 reads keywordtargetingmetric only', () => {
  beforeEach(() => resetCatalogCache());

  it('selects Product Attribute Targeting rows from keywordtargetingmetric and never touches targetexpressionsmetric', async () => {
    const { sql } = await readQuerySql('ANEG-04');
    const c = code(sql);
    expect(c).toMatch(/\bFROM\s+keywordtargetingmetric\b/i);
    expect(c).toContain("recordType = 'Product Attribute Targeting'");
    expect(c).not.toMatch(TE);
    expect(c).not.toMatch(/\bUNION\b/i);
    expect(c).not.toMatch(/\bJOIN\b/i);
    // One table, one pass: no derived table that a second source could feed.
    expect(c.match(/\bFROM\b/gi)).toHaveLength(1);
  });

  it('keeps the output columns and the location grain the skill joins on', async () => {
    const c = code((await readQuerySql('ANEG-04')).sql);
    for (const col of [
      'AS target_asin',
      'CampaignName',
      'AdGroupName',
      'AS lifetime_spend',
      'AS lifetime_sales',
      'AS lifetime_orders',
      'AS lifetime_clicks',
      'AS lifetime_acos',
    ]) {
      expect(c, col).toContain(col);
    }
    expect(c).toMatch(/GROUP BY SearchTerm, CampaignName, AdGroupName/);
  });

  it('still matches ASINs in either letter case, on the one table, counting each row once', async () => {
    const { sql } = await readQuerySql('ANEG-04');
    const c = code(sql);
    // The case-folded match used to live only on the removed branch. Without
    // it, an ASIN list in a different case from the stored text matches zero
    // rows and the location reads as zero lifetime orders.
    expect(c).toMatch(
      /\(\s*SearchTerm IN \(:window_asin_set\)\s+OR LOWER\(SearchTerm\) IN \(:window_asin_set_lower\)\s*\)/,
    );
    expect(findReferencedParams(sql).sort()).toEqual(['seller_id', 'window_asin_set', 'window_asin_set_lower']);
    expect(await libraryFile('ANEG-04.sql')).toMatch(
      /^-- Params: :seller_id, :window_asin_set, :window_asin_set_lower\s*$/m,
    );

    const bound = substituteParams(sql, {
      seller_id: 7,
      window_asin_set: ['B0AAAAAAAA', 'B0BBBBBBBB'],
      window_asin_set_lower: ['b0aaaaaaaa', 'b0bbbbbbbb'],
    });
    expect(bound.sql).toContain("SearchTerm IN ('B0AAAAAAAA', 'B0BBBBBBBB')");
    expect(bound.sql).toContain("LOWER(SearchTerm) IN ('b0aaaaaaaa', 'b0bbbbbbbb')");
    expect(bound.params).toEqual({ seller_id: 7 });
    expect(findReferencedParams(bound.sql)).toEqual(['seller_id']);
  });

  it('states the never-sum rule in its header instead of the old two-table requirement', async () => {
    const header = comments(await libraryFile('ANEG-04.sql'));
    expect(header).toMatch(/keywordtargetingmetric only/i);
    expect(header).toMatch(KT);
    expect(header).toMatch(TE);
    expect(header).toMatch(/never sum/i);
    expect(header).not.toMatch(/CRITICAL/);
    expect(header).not.toMatch(/\bUNIONs\b/);
  });

  it('has a catalog entry that names keywordtargetingmetric only', async () => {
    const entry = await getQueryEntry('ANEG-04');
    expect(entry.file).toBe('ANEG-04.sql');
    const text = `${entry.purpose}\n${entry.notes ?? ''}`;
    expect(text).toMatch(KT);
    expect(text).not.toMatch(TE);
    expect(text).not.toMatch(/UNION/i);
    expect(text).toMatch(/never sum/i);
  });
});

describe('no shipped SQL sums the two target metrics tables', () => {
  it('detects a query that reads both tables, and ignores table names in comments', () => {
    const both =
      'SELECT SUM(x) FROM (SELECT Cost x FROM keywordtargetingmetric\nUNION ALL\nSELECT Cost FROM targetexpressionsmetric) t;';
    expect(readsBothTables(both)).toBe(true);
    expect(readsBothTables('-- never sum keywordtargetingmetric with targetexpressionsmetric\nSELECT 1 FROM keywordtargetingmetric;')).toBe(false);
    expect(readsBothTables('SELECT 1 FROM keywordtargetingmetric; -- not targetexpressionsmetric')).toBe(false);
  });

  it('holds for every library query', async () => {
    const dir = pluginPath('shared', 'sql-library');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const ktReaders: string[] = [];
    const offenders: string[] = [];
    for (const f of files) {
      const sql = await readFile(join(dir, f), 'utf8');
      if (KT.test(code(sql))) ktReaders.push(f);
      if (readsBothTables(sql)) offenders.push(f);
    }
    // The scan has to reach the target tables, or it passes vacuously.
    expect(ktReaders).toContain('ANEG-04.sql');
    expect(offenders).toEqual([]);
  });

  it('holds for every sql code block in a skill', async () => {
    const dir = pluginPath('skills');
    const docs = (await readdir(dir, { recursive: true }))
      .map(String)
      .filter((f) => f.endsWith('.md'));
    expect(docs.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    let blocks = 0;
    for (const f of docs) {
      const text = await readFile(join(dir, f), 'utf8');
      for (const m of text.matchAll(/```sql\r?\n([\s\S]*?)```/gi)) {
        blocks++;
        if (readsBothTables(m[1] ?? '')) offenders.push(f);
      }
    }
    expect(blocks).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe('mx-asin-target-negation skill text', () => {
  it('describes ANEG-04 as one table and drops the two-table requirement', async () => {
    const skill = await readFile(pluginPath('skills', 'mx-asin-target-negation', 'SKILL.md'), 'utf8');
    // The frontmatter changelog keeps the v1.5.0 history entry; check the body.
    const body = skill.slice(skill.indexOf('\n---', 3) + 4);
    expect(body.length).toBeGreaterThan(1000);
    expect(body).not.toMatch(/UNION/i);
    expect(body).not.toMatch(/TWO TABLE REQUIREMENT/i);
    expect(body).not.toMatch(/Query BOTH/i);
    expect(body).toMatch(/never sum/i);
    const aneg04 = body.split(/\r?\n/).find((l) => l.startsWith('- `ANEG-04`'));
    expect(aneg04).toBeDefined();
    expect(aneg04).toMatch(KT);
    expect(aneg04).not.toMatch(TE);
  });

  it('carries the rule in the manifest notes and batch plan', async () => {
    const manifest = parseYaml(
      await readFile(pluginPath('skills', 'mx-asin-target-negation', 'skill.manifest.yaml'), 'utf8'),
    ) as { notes: string; sql_ids: string[]; pre_execution: { batch_plan: Array<{ notes?: string }> } };
    expect(manifest.sql_ids).toContain('ANEG-04');
    expect(manifest.notes).not.toMatch(/UNION/i);
    expect(manifest.notes).toMatch(/ANEG-04 reads keywordtargetingmetric only/i);
    expect(manifest.notes).toMatch(/never summed/i);
    const batchNotes = manifest.pre_execution.batch_plan.map((b) => b.notes ?? '').join(' ');
    expect(batchNotes).not.toMatch(/UNION/i);
    expect(batchNotes).toMatch(/keywordtargetingmetric only/i);
  });
});

describe('table notes for ad-hoc queries', () => {
  it('warn on both target metrics tables never to sum them', async () => {
    const pairs: Array<[string, string]> = [
      ['keywordtargetingmetric', 'targetexpressionsmetric'],
      ['targetexpressionsmetric', 'keywordtargetingmetric'],
    ];
    for (const [name, other] of pairs) {
      const t = await describeTable(name);
      expect(t, name).not.toBeNull();
      const gotchas = (t!.gotchas ?? []).join(' ');
      expect(gotchas, name).toMatch(new RegExp(`never sum this table with ${other}`, 'i'));
      expect(gotchas, name).toContain('ANEG-04');
    }
  });
});
