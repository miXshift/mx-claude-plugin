import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_API_BASE, resolveDefaultApiBase } from './api-base.js';

describe('resolveDefaultApiBase', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.MIXSHIFT_GATEWAY_BASE_URL;
    delete process.env.MIXSHIFT_GATEWAY_BASE_URL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.MIXSHIFT_GATEWAY_BASE_URL;
    else process.env.MIXSHIFT_GATEWAY_BASE_URL = saved;
  });

  it('is the production gateway when nothing is configured', async () => {
    expect(await resolveDefaultApiBase()).toBe(DEFAULT_API_BASE);
  });

  it('uses MIXSHIFT_GATEWAY_BASE_URL when set', async () => {
    process.env.MIXSHIFT_GATEWAY_BASE_URL = 'https://gw.example.test';
    expect(await resolveDefaultApiBase()).toBe('https://gw.example.test');
  });

  it('strips a trailing slash so callers can append a path', async () => {
    process.env.MIXSHIFT_GATEWAY_BASE_URL = 'https://gw.example.test/';
    expect(await resolveDefaultApiBase()).toBe('https://gw.example.test');
  });

  it('accepts http on loopback for local development', async () => {
    process.env.MIXSHIFT_GATEWAY_BASE_URL = 'http://localhost:8787';
    expect(await resolveDefaultApiBase()).toBe('http://localhost:8787');
  });

  it('falls back to the default for a malformed or plain-http remote value', async () => {
    process.env.MIXSHIFT_GATEWAY_BASE_URL = 'not a url';
    expect(await resolveDefaultApiBase()).toBe(DEFAULT_API_BASE);
    process.env.MIXSHIFT_GATEWAY_BASE_URL = 'http://gw.example.test';
    expect(await resolveDefaultApiBase()).toBe(DEFAULT_API_BASE);
  });
});
