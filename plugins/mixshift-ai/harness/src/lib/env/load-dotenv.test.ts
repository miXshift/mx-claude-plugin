import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseDotenv, applyToEnv } from './load-dotenv.js';

describe('parseDotenv', () => {
  it('parses simple KEY=value lines', () => {
    const out = parseDotenv('FOO=bar\nBAZ=qux');
    expect(out.get('FOO')).toBe('bar');
    expect(out.get('BAZ')).toBe('qux');
  });

  it('skips comments and blank lines', () => {
    const out = parseDotenv(
      [
        '# leading comment',
        '',
        'FOO=bar',
        '   # indented comment',
        '',
        'BAZ=qux',
        '',
      ].join('\n'),
    );
    expect(out.size).toBe(2);
    expect(out.get('FOO')).toBe('bar');
    expect(out.get('BAZ')).toBe('qux');
  });

  it('strips matching surrounding quotes (single or double)', () => {
    const out = parseDotenv(
      [
        'A="quoted value"',
        "B='single quoted'",
        'C=no_quotes',
        'D="mixed"that\'s fine',  // only fully-wrapped quotes get stripped
        "E='unbalanced",          // unbalanced quote — leave as-is
        'F="unbalanced',          // same
      ].join('\n'),
    );
    expect(out.get('A')).toBe('quoted value');
    expect(out.get('B')).toBe('single quoted');
    expect(out.get('C')).toBe('no_quotes');
    expect(out.get('D')).toBe('"mixed"that\'s fine'); // only fully-wrapped paired quotes get stripped
    expect(out.get('E')).toBe("'unbalanced");
    expect(out.get('F')).toBe('"unbalanced');
  });

  it('handles = inside values (only splits on the first =)', () => {
    const out = parseDotenv('URL=https://discord.com/api/webhooks/123/abc=def=ghi');
    expect(out.get('URL')).toBe('https://discord.com/api/webhooks/123/abc=def=ghi');
  });

  it('trims whitespace around keys and values', () => {
    const out = parseDotenv('  KEY  =  value with trailing space   ');
    expect(out.get('KEY')).toBe('value with trailing space');
  });

  it('rejects malformed lines silently', () => {
    const out = parseDotenv(
      [
        'GOOD=ok',
        'no equals sign',
        '=leading_equals',
        '123BAD_START=value', // starts with digit — invalid identifier
        'has spaces in key = value',
        'GOOD2=alsook',
      ].join('\n'),
    );
    expect(out.size).toBe(2);
    expect(out.get('GOOD')).toBe('ok');
    expect(out.get('GOOD2')).toBe('alsook');
  });

  it('handles CRLF line endings (Windows-saved files)', () => {
    const out = parseDotenv('FOO=bar\r\nBAZ=qux\r\n');
    expect(out.get('FOO')).toBe('bar');
    expect(out.get('BAZ')).toBe('qux');
  });

  it('returns empty map for empty input', () => {
    expect(parseDotenv('').size).toBe(0);
    expect(parseDotenv('\n\n\n').size).toBe(0);
    expect(parseDotenv('# just a comment').size).toBe(0);
  });
});

describe('applyToEnv', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot a known set of env vars we'll touch + restore in afterEach.
    for (const k of ['TEST_LOAD_ENV_A', 'TEST_LOAD_ENV_B', 'TEST_LOAD_ENV_C']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it('sets vars that are not already in process.env', () => {
    const parsed = new Map([
      ['TEST_LOAD_ENV_A', 'from_file_a'],
      ['TEST_LOAD_ENV_B', 'from_file_b'],
    ]);
    const result = applyToEnv(parsed);
    expect(result.applied).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(process.env.TEST_LOAD_ENV_A).toBe('from_file_a');
    expect(process.env.TEST_LOAD_ENV_B).toBe('from_file_b');
  });

  it('preserves shell values when key already exists in process.env', () => {
    process.env.TEST_LOAD_ENV_A = 'from_shell';
    const parsed = new Map([
      ['TEST_LOAD_ENV_A', 'from_file_a'],
      ['TEST_LOAD_ENV_B', 'from_file_b'],
    ]);
    const result = applyToEnv(parsed);
    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual(['TEST_LOAD_ENV_A']);
    expect(process.env.TEST_LOAD_ENV_A).toBe('from_shell'); // unchanged
    expect(process.env.TEST_LOAD_ENV_B).toBe('from_file_b');
  });

  it('treats undefined env vars as not-set (despite being a key in process.env on some platforms)', () => {
    // Some platforms have all env vars as keys but undefined values. The
    // loader should treat undefined as "not set" and apply the file value.
    delete process.env.TEST_LOAD_ENV_C;
    const parsed = new Map([['TEST_LOAD_ENV_C', 'from_file_c']]);
    const result = applyToEnv(parsed);
    expect(result.applied).toBe(1);
    expect(process.env.TEST_LOAD_ENV_C).toBe('from_file_c');
  });

  it('handles empty parsed map without errors', () => {
    const result = applyToEnv(new Map());
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([]);
  });
});
