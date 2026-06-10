import { describe, it, expect, vi } from 'vitest';
import { exchangeSetupCode } from './setup-code.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('exchangeSetupCode', () => {
  it('POSTs the trimmed code and returns the one-time credential', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        client_id: 'svc_fresh123',
        client_secret: 'one-time-secret',
        label: 'svc:foep-watch',
        scopes: ['account:read', 'ads:read'],
        token_url: 'https://svc.test/oauth/token',
      }),
    );
    const out = await exchangeSetupCode('https://svc.test', '  svc-abcd-efgh ', fetchImpl);
    expect(out).toEqual({
      client_id: 'svc_fresh123',
      client_secret: 'one-time-secret',
      label: 'svc:foep-watch',
      scopes: ['account:read', 'ads:read'],
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/oauth/service-setup/exchange');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      setup_code: 'svc-abcd-efgh',
    });
  });

  it('maps invalid_setup_code to an actionable single-use/expiry message', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, { error: 'invalid_setup_code' }),
    );
    await expect(exchangeSetupCode('https://svc.test', 'SVC-DEAD-CODE', fetchImpl)).rejects.toThrow(
      /single-use|expired|already used/i,
    );
  });

  it('surfaces rate limiting distinctly', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(429, {}));
    await expect(exchangeSetupCode('https://svc.test', 'SVC-AAAA-BBBB', fetchImpl)).rejects.toThrow(
      /Too many attempts/i,
    );
  });

  it('throws when the response carries no credential', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await expect(exchangeSetupCode('https://svc.test', 'SVC-AAAA-BBBB', fetchImpl)).rejects.toThrow(
      /no credential/i,
    );
  });

  it('wraps network failures with the endpoint named', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(exchangeSetupCode('https://svc.test', 'SVC-AAAA-BBBB', fetchImpl)).rejects.toThrow(
      /service-setup\/exchange/,
    );
  });
});
