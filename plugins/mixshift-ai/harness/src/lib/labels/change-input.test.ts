/**
 * The local rules for a label change: values, ids, --set / --clear flags and the CSV file. Row-numbered errors,
 * grouping by combination of values, and the 1,000-row cap. Made-up ids and values throughout.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLEAR_MARKER, fieldKeysFor, checkEntityId, checkLabelValue, parseChangeCsv, parseCsv, parseSetFlags } from './change-input.js';
import { LABEL_FIELD_KEYS } from './field-keys.js';
import { loadPending, pendingDir, removePending, savePending } from './pending.js';

describe('checkLabelValue', () => {
  it('trims, keeps case, refuses blank, control characters and over-long values', () => {
    expect(checkLabelValue('item', 'brand', '  Acme Home  ')).toEqual({ ok: true, value: 'Acme Home' });
    expect(checkLabelValue('item', 'brand', '   ').ok).toBe(false);
    expect(checkLabelValue('item', 'brand', 'a\tb').ok).toBe(false);
    expect(checkLabelValue('item', 'brand', 'a\nb').ok).toBe(false);
    expect(checkLabelValue('item', 'brand', 'x'.repeat(250)).ok).toBe(true);
    expect(checkLabelValue('item', 'brand', 'x'.repeat(251)).ok).toBe(false);
    expect(checkLabelValue('campaign', 'brand', 'x'.repeat(201)).ok).toBe(false);
    // Bytes, not characters, for the long text fields.
    expect(checkLabelValue('item', 'label_1', 'x'.repeat(65_535)).ok).toBe(true);
    expect(checkLabelValue('item', 'label_1', 'x'.repeat(65_536)).ok).toBe(false);
    expect(checkLabelValue('item', 'manager', 'Alex').ok).toBe(false);
    expect(checkLabelValue('campaign', 'nickname', 'x').ok).toBe(false);
  });
});

describe('checkEntityId', () => {
  it('upper-cases ASINs and takes campaign ids as digits', () => {
    expect(checkEntityId('item', ' b0example01 ')).toEqual({ ok: true, id: 'B0EXAMPLE01' });
    expect(checkEntityId('item', 'B0 EXAMPLE').ok).toBe(false);
    expect(checkEntityId('campaign', '123456789012345678').ok).toBe(true);
    expect(checkEntityId('campaign', '1234567890123456789012').ok).toBe(false);
    expect(checkEntityId('campaign', 'B0EXAMPLE01').ok).toBe(false);
    expect(checkEntityId('item', '').ok).toBe(false);
  });
});

describe('parseSetFlags', () => {
  it('builds the set map; a value may hold an equals sign; a clear is null', () => {
    expect(parseSetFlags('item', ['brand=Acme=Home', 'TAG_1=Spring'], ['tag_2'])).toEqual({ ok: true, set: { brand: 'Acme=Home', tag_1: 'Spring', tag_2: null } });
  });
  it('refuses unknown fields, repeats and a field both set and cleared', () => {
    expect(parseSetFlags('item', ['nope=1'], []).ok).toBe(false);
    expect(parseSetFlags('item', ['brand=a', 'brand=b'], []).ok).toBe(false);
    expect(parseSetFlags('item', ['brand=a'], ['brand']).ok).toBe(false);
    expect(parseSetFlags('item', [], ['brand', 'brand']).ok).toBe(false);
    expect(parseSetFlags('item', ['=x'], []).ok).toBe(false);
  });
});

describe('parseCsv', () => {
  it('reads quoted cells with commas, doubled quotes and line breaks, CRLF and LF, and skips blank lines', () => {
    const r = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n"two\nlines",z\n');
    expect(r).toEqual({
      ok: true,
      records: [
        { line: 1, cells: ['a', 'b'] },
        { line: 2, cells: ['x, y', 'say "hi"'] },
        { line: 4, cells: ['two\nlines', 'z'] },
      ],
    });
  });
  it('refuses an unclosed quote and a stray quote, with the line', () => {
    expect(parseCsv('a,b\n"open,x\n')).toMatchObject({ ok: false, message: expect.stringContaining('line 2') });
    expect(parseCsv('a,b\nx"y,z\n')).toMatchObject({ ok: false, message: expect.stringContaining('line 2') });
    expect(parseCsv('a\n"x"y\n')).toMatchObject({ ok: false });
  });
});

describe('parseChangeCsv', () => {
  it('groups rows with the same changes, keeping file order, and the clear marker is case-insensitive', () => {
    const r = parseChangeCsv(`asin,brand,tag_1\nb0a,Acme,\nB0B,Acme,\nB0C,Acme,${CLEAR_MARKER.toUpperCase()}\n`, 'item');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toBe(3);
    expect(r.fields).toEqual(['brand', 'tag_1']);
    expect(r.groups.map((g) => ({ ids: g.ids, set: g.set, lines: g.lines }))).toEqual([
      { ids: ['B0A', 'B0B'], set: { brand: 'Acme' }, lines: [2, 3] },
      { ids: ['B0C'], set: { brand: 'Acme', tag_1: null }, lines: [4] },
    ]);
  });

  it('accepts "id" as the identity column and header names in any case, with spaces', () => {
    expect(parseChangeCsv('ID,Item Group\nB0A,Line\n', 'item').ok).toBe(true);
    expect(parseChangeCsv('Campaign ID,Manager\n123,Alex\n', 'campaign').ok).toBe(true);
    expect(parseChangeCsv('asin,brand\nB0A,Acme\n', 'campaign').ok).toBe(false);
  });

  it('reports header problems and an empty file', () => {
    expect(parseChangeCsv('', 'item')).toMatchObject({ ok: false });
    expect(parseChangeCsv('asin\nB0A\n', 'item')).toMatchObject({ ok: false, errors: [expect.stringContaining('no label columns')] });
    expect(parseChangeCsv('asin,brand\n', 'item')).toMatchObject({ ok: false, errors: ['The file has a header and no rows.'] });
    expect(parseChangeCsv('brand,asin\nAcme,B0A\n', 'item')).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining('first column must be "asin"')]) });
    expect(parseChangeCsv('asin;brand\nB0A;Acme\n', 'item')).toMatchObject({ ok: false, errors: [expect.stringContaining('semicolons')] });
  });

  it('lists up to 20 errors with line numbers and counts the rest', () => {
    const rows = Array.from({ length: 30 }, (_v, i) => `B0X${String(i).padStart(4, '0')},`).join('\n');
    const r = parseChangeCsv(`asin,brand\n${rows}\n`, 'item');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(20);
    expect(r.errors[0]).toBe('Line 2: every label cell is empty, so this row changes nothing. Fill a cell, or remove the row.');
    expect(r.more).toBe(10);
  });

  it('caps rows at one change set (1,000) and the number of combinations at 10 (so one file cannot use the 25-preview allowance)', () => {
    const big = Array.from({ length: 1001 }, (_v, i) => `B0X${i},Acme`).join('\n');
    expect(parseChangeCsv(`asin,brand\n${big}\n`, 'item')).toMatchObject({ ok: false, errors: [expect.stringContaining('1001 rows, and one change set holds at most 1000')] });
    const exactly = Array.from({ length: 1000 }, (_v, i) => `B0X${i},Acme`).join('\n');
    expect(parseChangeCsv(`asin,brand\n${exactly}\n`, 'item').ok).toBe(true);
    const ten = Array.from({ length: 10 }, (_v, i) => `B0X${i},Brand ${i}`).join('\n');
    expect(parseChangeCsv(`asin,brand\n${ten}\n`, 'item').ok).toBe(true);
    const many = Array.from({ length: 11 }, (_v, i) => `B0X${i},Brand ${i}`).join('\n');
    expect(parseChangeCsv(`asin,brand\n${many}\n`, 'item')).toMatchObject({ ok: false, errors: [expect.stringContaining('11 different combinations')] });
  });
});

describe('the approval kept on this machine', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const HASH = 'cd'.repeat(32);
  const rec = (over: Record<string, unknown> = {}) => ({
    change_set_id: ID,
    approval_hash: HASH,
    account: 12345,
    kind: 'set',
    scope: 'region',
    created_at: '2026-11-12T10:00:00.000000Z',
    expires_at: '2999-01-01T00:00:00.000000Z',
    ...over,
  });

  it('round-trips, lowercases the hash, and refuses an id or hash that is not well formed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'labels-pending-'));
    try {
      expect(await savePending(rec({ approval_hash: HASH.toUpperCase() }), dir)).toBe(true);
      expect(await loadPending(ID.toUpperCase(), dir)).toMatchObject({ change_set_id: ID, approval_hash: HASH, account: 12345 });
      expect(await savePending(rec({ change_set_id: '../escape' }), dir)).toBe(false);
      expect(await savePending(rec({ approval_hash: 'nope' }), dir)).toBe(false);
      expect(await loadPending('../escape', dir)).toBeNull();
      await removePending(ID, dir);
      expect(await loadPending(ID, dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sweeps records whose preview expired more than a day ago when the next one is saved; a broken record is not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'labels-pending-'));
    try {
      const OLD = '66666666-7777-4888-8999-aaaaaaaaaaaa';
      await savePending(rec(), dir);
      await writeFile(join(pendingDir(dir), `${OLD}.json`), JSON.stringify(rec({ change_set_id: OLD, expires_at: '2020-01-01T00:00:00.000000Z' })));
      expect(await loadPending(OLD, dir)).not.toBeNull();
      await savePending(rec(), dir);
      expect(await loadPending(OLD, dir)).toBeNull();
      expect(await loadPending(ID, dir)).not.toBeNull();
      await writeFile(join(pendingDir(dir), `${OLD}.json`), 'not json');
      expect(await loadPending(OLD, dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the field key list the redactor keeps', () => {
  it('is exactly the fields the label commands accept', () => {
    expect([...LABEL_FIELD_KEYS].sort()).toEqual([...new Set([...fieldKeysFor('item'), ...fieldKeysFor('campaign')])].sort());
  });
});
