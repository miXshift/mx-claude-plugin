import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runNetworkDoctor } from './doctor.js';

const API_BASE = 'https://mcp.mixshift.io';

/** Env vars readProxyInfo() consults. Snapshot + restore around each test so
 *  a real sandbox proxy in the runner's environment can't leak into asserts. */
const PROXY_KEYS = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'all_proxy',
  'ALL_PROXY',
] as const;

/** A minimal stand-in for a fetch Response — only the fields doctor reads. */
function OK(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

/** fetchImpl that resolves with the given Response. */
function fetchReturning(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch;
}

/** fetchImpl that rejects with the given error (transport failure). */
function fetchThrowing(err: unknown): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

function fetchFailed(cause: unknown): Error {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = cause;
  return e;
}

describe('runNetworkDoctor', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of PROXY_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of PROXY_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reports ok when /health returns 200', async () => {
    const report = await runNetworkDoctor({
      apiBase: API_BASE,
      fetchImpl: fetchReturning(OK(200)),
    });
    expect(report.ok).toBe(true);
    expect(report.host).toBe('mcp.mixshift.io');
    expect(report.health.reachable).toBe(true);
    expect(report.health.status).toBe(200);
    expect(report.health.error).toBeNull();
    expect(report.remediation).toBeNull();
  });

  it('reports not-ok with the HTTP status when /health is non-2xx', async () => {
    const report = await runNetworkDoctor({
      apiBase: API_BASE,
      fetchImpl: fetchReturning(OK(503)),
    });
    expect(report.ok).toBe(false);
    expect(report.health.reachable).toBe(false);
    expect(report.health.status).toBe(503);
    expect(report.health.error).toContain('HTTP 503');
    expect(report.remediation).not.toBeNull();
  });

  it('classifies a thrown ENOTFOUND and surfaces allowlist remediation', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
      code: 'ENOTFOUND',
    });
    const report = await runNetworkDoctor({
      apiBase: API_BASE,
      fetchImpl: fetchThrowing(fetchFailed(cause)),
    });
    expect(report.ok).toBe(false);
    expect(report.health.status).toBeNull();
    expect(report.health.error).toContain('Could not resolve');
    expect(report.remediation).toContain('not reachable');
    const required = report.allowlist.required.map((e) => e.domain);
    expect(required).toContain('mcp.mixshift.io');
    expect(required).toContain('*.amazonaws.com');
  });

  it('detects an active egress proxy from the environment', async () => {
    process.env.https_proxy = 'http://localhost:3128';
    const report = await runNetworkDoctor({
      apiBase: API_BASE,
      fetchImpl: fetchReturning(OK(200)),
    });
    expect(report.proxy.honored).toBe(true);
    expect(report.proxy.https_proxy).toBe('http://localhost:3128');
  });

  it('reports no proxy when none is configured', async () => {
    const report = await runNetworkDoctor({
      apiBase: API_BASE,
      fetchImpl: fetchReturning(OK(200)),
    });
    expect(report.proxy.honored).toBe(false);
    expect(report.proxy.https_proxy).toBeNull();
  });

  it('tailors remediation to a sandbox when a proxy is present', async () => {
    process.env.https_proxy = 'http://localhost:3128';
    const report = await runNetworkDoctor({
      apiBase: API_BASE,
      fetchImpl: fetchReturning(OK(503)),
    });
    expect(report.remediation).toContain('egress proxy');
    expect(report.remediation).toContain('allowlist');
  });
});
