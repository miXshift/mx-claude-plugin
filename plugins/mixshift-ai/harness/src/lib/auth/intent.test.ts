import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { intentHeader } from './intent.js';

const INTENT_VAR = 'MIXSHIFT_INTENT';
const SKILL_VAR = 'MIXSHIFT_SKILL_ID';

let savedIntent: string | undefined;
let savedSkill: string | undefined;

beforeEach(() => {
  savedIntent = process.env[INTENT_VAR];
  savedSkill = process.env[SKILL_VAR];
  delete process.env[INTENT_VAR];
  delete process.env[SKILL_VAR];
});

afterEach(() => {
  if (savedIntent === undefined) delete process.env[INTENT_VAR];
  else process.env[INTENT_VAR] = savedIntent;
  if (savedSkill === undefined) delete process.env[SKILL_VAR];
  else process.env[SKILL_VAR] = savedSkill;
});

describe('intentHeader precedence', () => {
  it('returns {} when neither env var is set', () => {
    expect(intentHeader({})).toEqual({});
  });

  it('reads process.env by default (no explicit env arg)', () => {
    process.env[SKILL_VAR] = 'mx-data-explore';
    expect(intentHeader()).toEqual({ 'x-mixshift-intent': 'mx-data-explore' });
  });

  it('uses MIXSHIFT_SKILL_ID when only that is set', () => {
    expect(intentHeader({ MIXSHIFT_SKILL_ID: 'mx-amazon-ads' })).toEqual({
      'x-mixshift-intent': 'mx-amazon-ads',
    });
  });

  it('MIXSHIFT_INTENT overrides MIXSHIFT_SKILL_ID when both are set', () => {
    expect(
      intentHeader({
        MIXSHIFT_INTENT: 'custom-workflow',
        MIXSHIFT_SKILL_ID: 'mx-amazon-ads',
      }),
    ).toEqual({ 'x-mixshift-intent': 'custom-workflow' });
  });

  it('falls back to MIXSHIFT_SKILL_ID when MIXSHIFT_INTENT is set but empty (shell FOO= == unset)', () => {
    expect(
      intentHeader({
        MIXSHIFT_INTENT: '',
        MIXSHIFT_SKILL_ID: 'mx-amazon-ads',
      }),
    ).toEqual({ 'x-mixshift-intent': 'mx-amazon-ads' });
  });

  it('returns {} when both are set but empty', () => {
    expect(intentHeader({ MIXSHIFT_INTENT: '', MIXSHIFT_SKILL_ID: '' })).toEqual({});
  });
});

describe('intentHeader sanitization (mirrors the server sanitizer)', () => {
  it('trims surrounding whitespace', () => {
    expect(intentHeader({ MIXSHIFT_SKILL_ID: '  mx-amazon-ads  ' })).toEqual({
      'x-mixshift-intent': 'mx-amazon-ads',
    });
  });

  it('folds uppercase to lowercase', () => {
    expect(intentHeader({ MIXSHIFT_SKILL_ID: 'MX-Amazon-ADS' })).toEqual({
      'x-mixshift-intent': 'mx-amazon-ads',
    });
  });

  it('accepts the full allowed charset: a-z0-9_.:-', () => {
    const value = 'mx-amazon-ads_v2.report:daily';
    expect(intentHeader({ MIXSHIFT_SKILL_ID: value })).toEqual({
      'x-mixshift-intent': value,
    });
  });

  it('accepts the 64-char boundary', () => {
    const value = 'a'.repeat(64);
    expect(intentHeader({ MIXSHIFT_SKILL_ID: value })).toEqual({
      'x-mixshift-intent': value,
    });
  });

  it('rejects strings longer than 64 chars (post-trim)', () => {
    const value = 'a'.repeat(65);
    expect(intentHeader({ MIXSHIFT_SKILL_ID: value })).toEqual({});
  });

  it('accepts 64 chars after trimming surrounding whitespace', () => {
    const value = `  ${'a'.repeat(64)}  `;
    expect(intentHeader({ MIXSHIFT_SKILL_ID: value })).toEqual({
      'x-mixshift-intent': 'a'.repeat(64),
    });
  });

  it('rejects invalid characters (spaces, slashes, symbols)', () => {
    for (const bad of ['has spaces', 'has/slash', 'has$dollar', 'has@sign', 'has#hash', 'a,b']) {
      expect(intentHeader({ MIXSHIFT_SKILL_ID: bad })).toEqual({});
    }
  });

  it('rejects header-injection attempts (CR/LF smuggling)', () => {
    const injected = 'mx-amazon-ads\r\nX-Evil-Header: pwned';
    expect(intentHeader({ MIXSHIFT_SKILL_ID: injected })).toEqual({});
  });

  it('rejects a value that is only whitespace', () => {
    expect(intentHeader({ MIXSHIFT_SKILL_ID: '   ' })).toEqual({});
  });

  it('rejects empty string env value the same as unset', () => {
    expect(intentHeader({ MIXSHIFT_SKILL_ID: '' })).toEqual({});
  });
});

describe('intentHeader never throws', () => {
  it('is safe to spread unconditionally', () => {
    expect(() => ({ ...intentHeader({}), Authorization: 'Bearer x' })).not.toThrow();
  });
});
