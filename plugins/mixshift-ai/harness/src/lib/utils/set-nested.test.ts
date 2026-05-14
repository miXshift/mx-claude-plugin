import { describe, it, expect } from 'vitest';
import { setNested, coerceValue } from './set-nested.js';

describe('setNested', () => {
  it('sets a top-level field', () => {
    const obj: Record<string, unknown> = {};
    setNested(obj, 'foo', 'bar');
    expect(obj).toEqual({ foo: 'bar' });
  });

  it('walks into existing nested objects', () => {
    const obj: Record<string, unknown> = { a: { b: { c: 'old' } } };
    setNested(obj, 'a.b.c', 'new');
    expect(obj).toEqual({ a: { b: { c: 'new' } } });
  });

  it('creates missing intermediate objects', () => {
    const obj: Record<string, unknown> = {};
    setNested(obj, 'output.default_by_surface.cowork', 'inline-markdown');
    expect(obj).toEqual({
      output: { default_by_surface: { cowork: 'inline-markdown' } },
    });
  });

  it('throws when an intermediate is a primitive', () => {
    const obj: Record<string, unknown> = { a: 'not-an-object' };
    expect(() => setNested(obj, 'a.b.c', 'value')).toThrow(/not an object/);
  });

  it('throws when an intermediate is an array', () => {
    const obj: Record<string, unknown> = { a: [1, 2, 3] };
    expect(() => setNested(obj, 'a.b', 'value')).toThrow(/array/);
  });

  it('rejects empty paths', () => {
    expect(() => setNested({}, '', 'x')).toThrow(/empty/i);
  });
});

describe('coerceValue', () => {
  it('coerces booleans', () => {
    expect(coerceValue('true')).toBe(true);
    expect(coerceValue('false')).toBe(false);
  });

  it('coerces numbers', () => {
    expect(coerceValue('8080')).toBe(8080);
    expect(coerceValue('3.14')).toBe(3.14);
    expect(coerceValue('-5')).toBe(-5);
  });

  it('coerces null', () => {
    expect(coerceValue('null')).toBeNull();
  });

  it('preserves unquoted strings', () => {
    expect(coerceValue('local-html')).toBe('local-html');
    expect(coerceValue('claude_code')).toBe('claude_code');
    expect(coerceValue('test@example.com')).toBe('test@example.com');
  });

  it('handles JSON-quoted strings', () => {
    expect(coerceValue('"quoted"')).toBe('quoted');
  });
});
