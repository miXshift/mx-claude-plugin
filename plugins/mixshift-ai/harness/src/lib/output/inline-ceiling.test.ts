import { describe, it, expect } from 'vitest';
import {
  planInlineDelivery,
  planInlineDocument,
  previewLines,
  DEFAULT_INLINE_ROW_CEILING,
  DEFAULT_INLINE_DOC_BYTE_CEILING,
  INLINE_BYTE_CEILING,
  INLINE_PREVIEW_ROWS,
} from './inline-ceiling.js';

/** n narrow rows: two small columns, well under the byte ceiling in bulk. */
function narrow(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ a: i, b: 'x' }));
}

/** n rows each `width` bytes wide in the second column. */
function wide(n: number, width: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ a: i, b: 'x'.repeat(width) }));
}

describe('planInlineDelivery', () => {
  it('renders a small result inline', () => {
    const plan = planInlineDelivery(narrow(10));
    expect(plan.mode).toBe('inline');
    expect(plan.reason).toBeUndefined();
    expect(plan.preview).toEqual([]);
    expect(plan.columns).toEqual(['a', 'b']);
  });

  it('renders a 0-row result inline with empty columns', () => {
    const plan = planInlineDelivery([]);
    expect(plan.mode).toBe('inline');
    expect(plan.columns).toEqual([]);
  });

  it('renders exactly at the row ceiling inline (boundary)', () => {
    const plan = planInlineDelivery(narrow(DEFAULT_INLINE_ROW_CEILING));
    expect(plan.mode).toBe('inline');
  });

  it('spills one row over the row ceiling', () => {
    const plan = planInlineDelivery(narrow(DEFAULT_INLINE_ROW_CEILING + 1));
    expect(plan.mode).toBe('spill');
    expect(plan.reason).toBe('row_ceiling');
    expect(plan.preview).toHaveLength(INLINE_PREVIEW_ROWS);
    expect(plan.columns).toEqual(['a', 'b']);
  });

  it('spills a few wide rows on the byte ceiling even under the row ceiling', () => {
    // 50 rows, each ~20KB wide → ~1MB, over the 512KB byte ceiling but under 500 rows.
    const plan = planInlineDelivery(wide(50, 20 * 1024));
    expect(plan.mode).toBe('spill');
    expect(plan.reason).toBe('byte_ceiling');
    // preview capped at INLINE_PREVIEW_ROWS
    expect(plan.preview).toHaveLength(INLINE_PREVIEW_ROWS);
  });

  it('does not serialize (byte-check skipped) when already over the row ceiling', () => {
    // A huge wide result over BOTH ceilings must classify as row_ceiling (the
    // row check short-circuits before the byte check) — proving we never
    // JSON.stringify the whole set just to decide to spill.
    const plan = planInlineDelivery(wide(DEFAULT_INLINE_ROW_CEILING + 100, 4 * 1024));
    expect(plan.mode).toBe('spill');
    expect(plan.reason).toBe('row_ceiling');
  });

  describe('--inline escape hatch', () => {
    it('renders everything inline regardless of row count', () => {
      const plan = planInlineDelivery(narrow(45_000), { inline: true });
      expect(plan.mode).toBe('inline');
      expect(plan.rowCeiling).toBe(Infinity);
    });

    it('renders everything inline regardless of byte size', () => {
      const plan = planInlineDelivery(wide(50, 50 * 1024), { inline: true });
      expect(plan.mode).toBe('inline');
    });
  });

  describe('--rows N escape hatch', () => {
    it('raises the row ceiling so a mid-size result renders inline', () => {
      const plan = planInlineDelivery(narrow(1500), { rows: 2000 });
      expect(plan.mode).toBe('inline');
      expect(plan.rowCeiling).toBe(2000);
    });

    it('still spills above the raised ceiling', () => {
      const plan = planInlineDelivery(narrow(2001), { rows: 2000 });
      expect(plan.mode).toBe('spill');
      expect(plan.reason).toBe('row_ceiling');
    });

    it('disables the byte ceiling (explicit row control)', () => {
      // Wide rows that would trip the byte ceiling on the default path, but the
      // user opted into an explicit row budget, so they render inline.
      const plan = planInlineDelivery(wide(100, 20 * 1024), { rows: 2000 });
      expect(plan.mode).toBe('inline');
    });

    it('caps the preview at the (small) raised ceiling when spilling', () => {
      const plan = planInlineDelivery(narrow(100), { rows: 5 });
      expect(plan.mode).toBe('spill');
      expect(plan.preview).toHaveLength(5);
    });

    it('ignores a non-positive --rows and falls back to the default ceiling', () => {
      const plan = planInlineDelivery(narrow(DEFAULT_INLINE_ROW_CEILING + 1), { rows: 0 });
      expect(plan.mode).toBe('spill');
      expect(plan.rowCeiling).toBe(DEFAULT_INLINE_ROW_CEILING);
    });
  });

  it('preview never exceeds the number of rows available', () => {
    // Force a byte spill with fewer rows than INLINE_PREVIEW_ROWS.
    const plan = planInlineDelivery(wide(5, 200 * 1024));
    expect(plan.mode).toBe('spill');
    expect(plan.preview).toHaveLength(5);
  });

  it('keeps the byte ceiling below the gateway 10MB cap', () => {
    // Sanity: the whole point is a ceiling well under the gateway caps.
    expect(INLINE_BYTE_CEILING).toBeLessThan(10 * 1024 * 1024);
    expect(DEFAULT_INLINE_ROW_CEILING).toBeLessThan(50_000);
  });
});

describe('planInlineDocument', () => {
  it('renders a small document inline', () => {
    expect(planInlineDocument(1024).mode).toBe('inline');
  });

  it('renders exactly at the ceiling inline (boundary)', () => {
    expect(planInlineDocument(DEFAULT_INLINE_DOC_BYTE_CEILING).mode).toBe('inline');
  });

  it('spills one byte over the ceiling', () => {
    const plan = planInlineDocument(DEFAULT_INLINE_DOC_BYTE_CEILING + 1);
    expect(plan.mode).toBe('spill');
  });

  it('forces inline with the escape hatch regardless of size', () => {
    const plan = planInlineDocument(50 * 1024 * 1024, { inline: true });
    expect(plan.mode).toBe('inline');
    expect(plan.ceiling).toBe(Infinity);
  });

  it('keeps the doc ceiling far under the 25MB inline-decode cap', () => {
    expect(DEFAULT_INLINE_DOC_BYTE_CEILING).toBeLessThan(25 * 1024 * 1024);
  });
});

describe('previewLines', () => {
  it('returns all lines when under the limit, not truncated', () => {
    const r = previewLines('a\nb\nc\n', 40);
    expect(r.preview).toBe('a\nb\nc');
    expect(r.truncated).toBe(false);
    expect(r.totalLines).toBe(3);
  });

  it('truncates to the first N lines and flags it', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    const r = previewLines(text, 40);
    expect(r.truncated).toBe(true);
    expect(r.totalLines).toBe(100);
    expect(r.preview.split('\n')).toHaveLength(40);
    expect(r.preview.split('\n')[0]).toBe('line0');
  });

  it('handles an empty document', () => {
    const r = previewLines('', 40);
    expect(r.preview).toBe('');
    expect(r.truncated).toBe(false);
    expect(r.totalLines).toBe(0);
  });

  it('does not count a single trailing newline as an extra line', () => {
    expect(previewLines('only\n', 40).totalLines).toBe(1);
  });
});
