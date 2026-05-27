import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveClientId } from './client-id.js';

const ENV_VAR = 'MIXSHIFT_PLUGIN_CLIENT_ID';

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = originalEnv;
});

describe('resolveClientId precedence', () => {
  it('defaults to mx-claude-plugin when nothing is set', () => {
    expect(resolveClientId()).toBe('mx-claude-plugin');
  });

  it('uses env var when set', () => {
    process.env[ENV_VAR] = 'mx-claude-plugin-dev';
    expect(resolveClientId()).toBe('mx-claude-plugin-dev');
  });

  it('CLI flag overrides env var', () => {
    process.env[ENV_VAR] = 'mx-claude-plugin-dev';
    expect(resolveClientId('mx-claude-plugin-staging')).toBe(
      'mx-claude-plugin-staging',
    );
  });

  it('CLI flag overrides default when env var unset', () => {
    expect(resolveClientId('test-cli')).toBe('test-cli');
  });
});

describe('resolveClientId validation', () => {
  it('rejects uppercase letters in CLI flag', () => {
    expect(() => resolveClientId('Mx-Claude-Plugin')).toThrow(/Invalid client_id/);
  });

  it('rejects spaces / special chars', () => {
    for (const bad of ['has spaces', 'has:colons', 'underscores_no', 'dot.notation']) {
      expect(() => resolveClientId(bad)).toThrow(/Invalid client_id/);
    }
  });

  it('rejects empty string from env var', () => {
    process.env[ENV_VAR] = '';
    // Empty env var falls through to the default (?? operator). Verify
    // that's the behavior — empty env var should NOT be treated as
    // "set to empty", because in shell convention empty == unset.
    expect(resolveClientId()).toBe('mx-claude-plugin');
  });

  it('rejects strings longer than 64 chars', () => {
    expect(() => resolveClientId('a'.repeat(65))).toThrow(/Invalid client_id/);
  });

  it('accepts the 64-char boundary', () => {
    expect(resolveClientId('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('error message identifies source: --client-id', () => {
    expect(() => resolveClientId('BAD')).toThrow(/--client-id/);
  });

  it('error message identifies source: env var', () => {
    process.env[ENV_VAR] = 'BAD';
    expect(() => resolveClientId()).toThrow(/MIXSHIFT_PLUGIN_CLIENT_ID/);
  });
});
