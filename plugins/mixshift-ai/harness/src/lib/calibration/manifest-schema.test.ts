import { describe, it, expect } from 'vitest';
import {
  calibrationManifestSchema,
  parseFieldInput,
  formatFieldValue,
  extractCalibration,
} from './manifest-schema.js';

describe('calibrationManifestSchema', () => {
  it('accepts a minimal enum field', () => {
    const result = calibrationManifestSchema.safeParse({
      schema_version: 1,
      fields: [
        {
          id: 'objective',
          prompt: 'Posture?',
          type: 'enum',
          options: [
            { value: 'growth', label: 'Growth' },
            { value: 'profit', label: 'Profit' },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty fields list', () => {
    const result = calibrationManifestSchema.safeParse({
      schema_version: 1,
      fields: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects enum with < 2 options', () => {
    const result = calibrationManifestSchema.safeParse({
      schema_version: 1,
      fields: [
        {
          id: 'x',
          prompt: '?',
          type: 'enum',
          options: [{ value: 'only', label: 'Only' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-snake-case field ids', () => {
    const result = calibrationManifestSchema.safeParse({
      schema_version: 1,
      fields: [
        { id: 'CamelCase', prompt: '?', type: 'bool' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects seed_from paths not prefixed with context.', () => {
    const result = calibrationManifestSchema.safeParse({
      schema_version: 1,
      fields: [
        {
          id: 'x',
          prompt: '?',
          type: 'bool',
          seed_from: 'config.posture.stance',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects percent default outside [0, 1]', () => {
    const result = calibrationManifestSchema.safeParse({
      schema_version: 1,
      fields: [
        { id: 'x', prompt: '?', type: 'percent', default: 1.5 },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('parseFieldInput', () => {
  const enumField = {
    id: 'x',
    prompt: '?',
    type: 'enum' as const,
    options: [
      { value: 'growth', label: 'Growth' },
      { value: 'profit', label: 'Profit' },
    ],
    required: true,
    deprecated: false,
  };

  it('parses enum by value', () => {
    expect(parseFieldInput(enumField, 'growth')).toEqual({
      ok: true,
      value: 'growth',
    });
  });

  it('parses enum by label (case-insensitive)', () => {
    expect(parseFieldInput(enumField, 'PROFIT')).toEqual({
      ok: true,
      value: 'profit',
    });
  });

  it('parses enum by numeric index (1-based)', () => {
    expect(parseFieldInput(enumField, '2')).toEqual({
      ok: true,
      value: 'profit',
    });
  });

  it('rejects unknown enum values', () => {
    const r = parseFieldInput(enumField, 'defend');
    expect(r.ok).toBe(false);
  });

  const percentField = {
    id: 'p',
    prompt: '?',
    type: 'percent' as const,
    range: { min: 0, max: 1 },
    required: true,
    deprecated: false,
  };

  it('parses percent from "32"', () => {
    expect(parseFieldInput(percentField, '32')).toEqual({ ok: true, value: 0.32 });
  });

  it('parses percent from "32%"', () => {
    expect(parseFieldInput(percentField, '32%')).toEqual({ ok: true, value: 0.32 });
  });

  it('parses percent from "0.32"', () => {
    expect(parseFieldInput(percentField, '0.32')).toEqual({
      ok: true,
      value: 0.32,
    });
  });

  it('rejects out-of-range percent', () => {
    const tight = { ...percentField, range: { min: 0.1, max: 0.5 } };
    const r = parseFieldInput(tight, '60%');
    expect(r.ok).toBe(false);
  });

  // --------------------------------------------------------------------
  // The bare "1" boundary. TACoS goal fields declare min 0.01 / max 1.0 and
  // their out-of-range message advertises "between 1% and 100%". Typing the
  // advertised floor used to store 1.0, i.e. 100% -- silently, and 100x
  // wrong, on the value the message had just recommended.
  // --------------------------------------------------------------------
  const tacosField = { ...percentField, range: { min: 0.01, max: 1.0 } };

  it('does not silently read a bare "1" as 100% when the field also admits 1%', () => {
    const r = parseFieldInput(tacosField, '1');
    expect(r.ok).toBe(false);
    // and it must offer a way out, in both readings
    expect(r.ok === false && r.error).toContain('1%');
    expect(r.ok === false && r.error).toContain('100%');
  });

  it('honours an explicit "%" on the ambiguous value: "1%" is one percent', () => {
    expect(parseFieldInput(tacosField, '1%')).toEqual({ ok: true, value: 0.01 });
  });

  it('honours an explicit "%" for the other reading: "100%" is one hundred percent', () => {
    expect(parseFieldInput(tacosField, '100%')).toEqual({ ok: true, value: 1.0 });
  });

  it('leaves a bare "1" alone where the field CANNOT mean 1% (no false ambiguity)', () => {
    // ACoS-style floor of 5%: 1% is out of range, so "1" can only be 100%.
    const acosField = { ...percentField, range: { min: 0.05, max: 1.0 } };
    expect(parseFieldInput(acosField, '1')).toEqual({ ok: true, value: 1.0 });
  });

  it('keeps the documented readings intact around the boundary', () => {
    // Bare decimals below 1 stay fractions; whole numbers above 1 stay percents.
    expect(parseFieldInput(tacosField, '0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseFieldInput(tacosField, '20')).toEqual({ ok: true, value: 0.2 });
    expect(parseFieldInput(tacosField, '20%')).toEqual({ ok: true, value: 0.2 });
  });

  const asinField = {
    id: 'h',
    prompt: '?',
    type: 'asin_list' as const,
    default: [],
    max_items: 200,
    required: false,
    deprecated: false,
  };

  it('parses valid ASIN list', () => {
    const r = parseFieldInput(asinField, 'B07XYZ1234, B08ABC9876');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(['B07XYZ1234', 'B08ABC9876']);
  });

  it('normalizes ASINs to uppercase', () => {
    const r = parseFieldInput(asinField, 'b07xyz1234');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(['B07XYZ1234']);
  });

  it('dedupes ASINs', () => {
    const r = parseFieldInput(asinField, 'B07XYZ1234, B07XYZ1234');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(['B07XYZ1234']);
  });

  it('rejects malformed ASINs', () => {
    const r = parseFieldInput(asinField, 'notanasin');
    expect(r.ok).toBe(false);
  });

  it('treats "none" as empty list', () => {
    const r = parseFieldInput(asinField, 'none');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('parses bool yes/no', () => {
    expect(parseFieldInput(
      { id: 'b', prompt: '?', type: 'bool', required: true, deprecated: false },
      'yes',
    )).toEqual({ ok: true, value: true });
    expect(parseFieldInput(
      { id: 'b', prompt: '?', type: 'bool', required: true, deprecated: false },
      'n',
    )).toEqual({ ok: true, value: false });
  });

  it('parses int with range', () => {
    const f = {
      id: 'i',
      prompt: '?',
      type: 'int' as const,
      range: { min: 0, max: 100 },
      required: true,
      deprecated: false,
    };
    expect(parseFieldInput(f, '42')).toEqual({ ok: true, value: 42 });
    expect(parseFieldInput(f, '4.2').ok).toBe(false); // not integer
    expect(parseFieldInput(f, '101').ok).toBe(false); // out of range
  });
});

describe('formatFieldValue', () => {
  it('formats percent with trailing .0 stripped', () => {
    expect(
      formatFieldValue(
        {
          id: 'p',
          prompt: '?',
          type: 'percent',
          range: { min: 0, max: 1 },
          required: true,
          deprecated: false,
        },
        0.32,
      ),
    ).toBe('32%');
  });

  it('formats short ASIN list inline', () => {
    expect(
      formatFieldValue(
        {
          id: 'h',
          prompt: '?',
          type: 'asin_list',
          default: [],
          max_items: 200,
          required: false,
          deprecated: false,
        },
        ['B07XYZ1234', 'B08ABC9876'],
      ),
    ).toBe('B07XYZ1234, B08ABC9876');
  });

  it('summarizes long ASIN list', () => {
    expect(
      formatFieldValue(
        {
          id: 'h',
          prompt: '?',
          type: 'asin_list',
          default: [],
          max_items: 200,
          required: false,
          deprecated: false,
        },
        ['B07XYZ1234', 'B08ABC9876', 'B07AAA1111', 'B08BBB2222', 'B09CCC3333'],
      ),
    ).toBe('B07XYZ1234, B08ABC9876, B07AAA1111 +2 more');
  });

  it('shows (not set) for undefined', () => {
    expect(
      formatFieldValue(
        {
          id: 'b',
          prompt: '?',
          type: 'bool',
          required: true,
          deprecated: false,
        },
        undefined,
      ),
    ).toBe('(not set)');
  });
});

describe('extractCalibration', () => {
  it('returns null when manifest has no calibration block', () => {
    expect(extractCalibration({})).toBeNull();
    expect(extractCalibration({ skill_id: 'x' })).toBeNull();
  });

  it('returns null when calibration is null', () => {
    expect(extractCalibration({ calibration: null })).toBeNull();
  });

  it('parses a valid calibration block', () => {
    const m = extractCalibration({
      skill_id: 'dhc',
      calibration: {
        schema_version: 1,
        fields: [
          { id: 'x', prompt: '?', type: 'bool', default: true },
        ],
      },
    });
    expect(m).not.toBeNull();
    expect(m!.fields).toHaveLength(1);
  });
});
