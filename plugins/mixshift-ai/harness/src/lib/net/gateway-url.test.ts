import { describe, it, expect, vi } from 'vitest';
import { resolveGatewayBase } from './gateway-url.js';

// resolveGatewayBaseSafe() wraps loadPluginDefaults() — mock it so we can
// drive both the happy path and the "loadPluginDefaults rejects" regression
// case (a present-but-corrupt/locked defaults file) without touching disk.
vi.mock('../defaults/load.js', () => ({
  loadPluginDefaults: vi.fn(),
}));

import { resolveGatewayBaseSafe } from './gateway-url.js';
import { loadPluginDefaults } from '../defaults/load.js';
import { defaultsSchema, type PluginDefaults } from '../defaults/schema.js';

function defaultsWithGatewayBase(baseUrl: string): PluginDefaults {
  const defaults = defaultsSchema.parse({ schema_version: 1 });
  defaults.gateway.base_url = baseUrl;
  return defaults;
}

describe('resolveGatewayBase', () => {
  it('accepts an https URL', () => {
    expect(resolveGatewayBase('https://mcp.mixshift.io')).toBe('https://mcp.mixshift.io');
  });

  it('accepts http on loopback (127.0.0.1)', () => {
    expect(resolveGatewayBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });

  it('accepts http on loopback (localhost)', () => {
    expect(resolveGatewayBase('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('strips a trailing slash so callers can safely append a path', () => {
    expect(resolveGatewayBase('https://mcp.mixshift.io/')).toBe('https://mcp.mixshift.io');
  });

  it('rejects a plain http URL on a non-loopback host', () => {
    expect(resolveGatewayBase('http://evil.com')).toBe('');
  });

  it('rejects a non-http(s) protocol', () => {
    expect(resolveGatewayBase('ftp://mcp.mixshift.io')).toBe('');
  });

  it('rejects malformed input', () => {
    expect(resolveGatewayBase('not a url')).toBe('');
    expect(resolveGatewayBase('mcp.mixshift.io')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(resolveGatewayBase('')).toBe('');
  });
});

describe('resolveGatewayBaseSafe', () => {
  it('returns the validated base when loadPluginDefaults resolves a valid https base_url', async () => {
    vi.mocked(loadPluginDefaults).mockResolvedValue(
      defaultsWithGatewayBase('https://mcp.mixshift.io'),
    );
    expect(await resolveGatewayBaseSafe()).toBe('https://mcp.mixshift.io');
  });

  it('returns "" when the resolved base_url is empty', async () => {
    vi.mocked(loadPluginDefaults).mockResolvedValue(defaultsWithGatewayBase(''));
    expect(await resolveGatewayBaseSafe()).toBe('');
  });

  it('returns "" and never throws when loadPluginDefaults rejects (regression guard)', async () => {
    vi.mocked(loadPluginDefaults).mockRejectedValue(
      new Error('defaults file is corrupt or locked'),
    );
    await expect(resolveGatewayBaseSafe()).resolves.toBe('');
  });
});
