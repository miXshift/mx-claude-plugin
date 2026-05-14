import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { rowsToCsv, createCsvWriter, formatCell } from './csv.js';

describe('formatCell', () => {
  it('renders nulls as empty', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(undefined)).toBe('');
  });

  it('renders dates as YYYY-MM-DD (no time)', () => {
    expect(formatCell(new Date('2026-05-14T13:45:00Z'))).toBe('2026-05-14');
  });

  it('renders numbers without quotes', () => {
    expect(formatCell(42)).toBe('42');
    expect(formatCell(3.14)).toBe('3.14');
    expect(formatCell(-5)).toBe('-5');
  });

  it('renders Infinity / NaN as empty', () => {
    expect(formatCell(NaN)).toBe('');
    expect(formatCell(Infinity)).toBe('');
  });

  it('quotes strings only when needed', () => {
    expect(formatCell('hello')).toBe('hello');
    expect(formatCell('hello, world')).toBe('"hello, world"');
    expect(formatCell('line1\nline2')).toBe('"line1\nline2"');
    expect(formatCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('coerces objects to JSON-quoted strings', () => {
    expect(formatCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('rowsToCsv', () => {
  it('writes header + rows with RFC 4180 formatting', () => {
    const csv = rowsToCsv(
      [
        { id: 1, name: 'Acme', spend: 100.5 },
        { id: 2, name: 'Beta, Inc.', spend: 200 },
      ],
      [{ name: 'id' }, { name: 'name' }, { name: 'spend' }],
    );
    expect(csv).toBe(
      'id,name,spend\n' +
        '1,Acme,100.5\n' +
        '2,"Beta, Inc.",200\n',
    );
  });

  it('uses custom header labels when provided', () => {
    // RFC 4180: quote only when value contains quote/comma/newline.
    // Spaces and parens don't require quoting.
    const csv = rowsToCsv(
      [{ seller_id: 113, amount: 50 }],
      [
        { name: 'seller_id', header: 'SellerID' },
        { name: 'amount', header: 'Amount (USD)' },
      ],
    );
    expect(csv).toBe('SellerID,Amount (USD)\n113,50\n');
  });

  it('quotes headers containing commas', () => {
    const csv = rowsToCsv(
      [{ x: 1 }],
      [{ name: 'x', header: 'Comma, in header' }],
    );
    expect(csv).toBe('"Comma, in header"\n1\n');
  });

  it('handles missing columns as empty cells', () => {
    const csv = rowsToCsv(
      [{ a: 1 }, { a: 2, b: 'x' }],
      [{ name: 'a' }, { name: 'b' }],
    );
    expect(csv).toBe('a,b\n1,\n2,x\n');
  });
});

describe('createCsvWriter', () => {
  it('streams rows + header to the given Writable', () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const writer = createCsvWriter(stream, [{ name: 'id' }, { name: 'name' }]);
    writer.writeRow({ id: 1, name: 'Acme' });
    writer.writeRow({ id: 2, name: 'Beta' });
    expect(chunks.join('')).toBe('id,name\n1,Acme\n2,Beta\n');
    expect(writer.rowsWritten()).toBe(2);
  });

  it('writes header exactly once even if explicit writeHeader is called first', () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const writer = createCsvWriter(stream, [{ name: 'x' }]);
    writer.writeHeader();
    writer.writeHeader(); // no-op
    writer.writeRow({ x: 1 });
    expect(chunks.join('')).toBe('x\n1\n');
  });
});
