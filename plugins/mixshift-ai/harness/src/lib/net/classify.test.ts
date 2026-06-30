import { describe, it, expect } from 'vitest';
import { describeFetchFailure, networkErrorMessage } from './classify.js';

const HOST = 'mcp.mixshift.io';

/** Build a `TypeError: fetch failed` carrying the given `cause`, mirroring
 *  how Node's global fetch (undici) surfaces transport failures. */
function fetchFailed(cause: unknown): Error {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = cause;
  return e;
}

describe('describeFetchFailure', () => {
  it('classifies a proxy 403 (sandbox egress allowlist) with admin remediation', () => {
    const err = fetchFailed(
      new Error('Received HTTP code 403 from proxy after CONNECT'),
    );
    const msg = describeFetchFailure(err, HOST);
    expect(msg).not.toBeNull();
    expect(msg).toContain('blocked mcp.mixshift.io');
    expect(msg).toContain('Code execution');
    expect(msg).toContain('sandbox.network.allowedDomains');
    expect(msg).toContain('mixshift doctor');
  });

  it('classifies ENOTFOUND as a resolve failure pointing at the allowlist', () => {
    const cause = Object.assign(
      new Error('getaddrinfo ENOTFOUND mcp.mixshift.io'),
      { code: 'ENOTFOUND' },
    );
    const msg = describeFetchFailure(fetchFailed(cause), HOST);
    expect(msg).toContain('Could not resolve mcp.mixshift.io');
    expect(msg).toContain('allowlisted');
  });

  it('classifies EAI_AGAIN like ENOTFOUND', () => {
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN'), {
      code: 'EAI_AGAIN',
    });
    expect(describeFetchFailure(fetchFailed(cause), HOST)).toContain(
      'Could not resolve',
    );
  });

  it('classifies ECONNREFUSED', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    expect(describeFetchFailure(fetchFailed(cause), HOST)).toBe(
      'Connection to mcp.mixshift.io was refused.',
    );
  });

  it('classifies a TimeoutError as a timeout', () => {
    const err = Object.assign(
      new Error('The operation was aborted due to timeout'),
      { name: 'TimeoutError' },
    );
    expect(describeFetchFailure(err, HOST)).toBe(
      'Timed out connecting to mcp.mixshift.io.',
    );
  });

  it('classifies UND_ERR_CONNECT_TIMEOUT as a timeout', () => {
    const cause = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    expect(describeFetchFailure(fetchFailed(cause), HOST)).toBe(
      'Timed out connecting to mcp.mixshift.io.',
    );
  });

  it('routes an unrecognized transport failure to the sandbox-aware fallback', () => {
    const cause = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    const msg = describeFetchFailure(fetchFailed(cause), HOST);
    expect(msg).toContain('Could not reach mcp.mixshift.io');
    expect(msg).toContain('ECONNRESET');
    expect(msg).toContain('sandbox.network.allowedDomains');
    expect(msg).toContain('mixshift doctor');
  });

  it('routes the Cowork bare-code-0 block to the fallback without a noisy "(0)"', () => {
    // The real Cowork egress block has surfaced as a fetch failure carrying a
    // bare `0` code — the ": 0." dead-end users reported. It must land on the
    // sandbox remediation and must NOT render a meaningless "(0)" detail.
    const cause = Object.assign(new Error('fetch failed'), { code: 0 });
    const msg = describeFetchFailure(fetchFailed(cause), HOST);
    expect(msg).toContain('Could not reach mcp.mixshift.io');
    expect(msg).not.toContain('(0)');
    expect(msg).toContain('mixshift doctor');
  });

  it('returns null for an application-level HTTP error (not a transport failure)', () => {
    const err = new Error('/auth/device/init returned HTTP 400: bad actor_hint');
    expect(describeFetchFailure(err, HOST)).toBeNull();
  });

  it('does not misclassify an app-level HTTP 403 as a proxy block', () => {
    // No cause, message isn't "fetch failed" — this came back over a
    // healthy connection, so it must NOT be masked as an egress block.
    const err = new Error('/auth/exchange returned HTTP 403: forbidden');
    expect(describeFetchFailure(err, HOST)).toBeNull();
  });

  it('returns null for a plain validation error', () => {
    expect(
      describeFetchFailure(new Error('--person-label is required'), HOST),
    ).toBeNull();
  });
});

describe('networkErrorMessage', () => {
  it('uses the classified message for transport failures', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
      code: 'ENOTFOUND',
    });
    expect(networkErrorMessage(fetchFailed(cause), HOST)).toContain(
      'Could not resolve',
    );
  });

  it('falls back to the original message for non-network errors', () => {
    const err = new Error('/auth/device/init returned HTTP 400: bad actor_hint');
    expect(networkErrorMessage(err, HOST)).toBe(
      '/auth/device/init returned HTTP 400: bad actor_hint',
    );
  });

  it('stringifies a non-Error throw', () => {
    expect(networkErrorMessage('boom', HOST)).toBe('boom');
  });
});
