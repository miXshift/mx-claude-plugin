import { describe, it, expect, vi } from 'vitest';
import { amazonRequest, type ReportClientOptions } from './reports';
import { spapiCall } from './spapi-call';

/**
 * Guards the surface-labelling contract on the PLUGIN side.
 *
 * Mirror of the gateway's SpApiError defect: `defaultFriendly` is reached from
 * every client module in this directory (reports, the SP-API passthrough, Ads,
 * pricing), and five of its cases hardcoded reports wording -- most visibly
 * the `unknown` fallback, which told an Ads or passthrough caller that "the
 * report request failed unexpectedly".
 *
 * These fallbacks only fire when the SERVICE did not send a `friendly`
 * (transport-level failure, non-JSON body, infra error), because
 * `serverFriendly ?? defaultFriendly(kind)` prefers the service's text. Low
 * reach, but it is the same lie, and it fires exactly when the caller has
 * least other information to go on.
 */

/** A service response with NO `friendly`, which is what forces the fallback. */
function fetchReturning(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

/**
 * `apiBaseOverride` is what skips credential resolution -- an earlier version
 * of this file passed `apiBase`, which is not an option on ReportClientOptions
 * at all, so every test fell through to real credential lookup. It passed
 * locally (this machine has a session) and failed in CI with
 * `not_authenticated`, i.e. it was never exercising the code it claimed to.
 * Typed as ReportClientOptions, not cast, so a wrong field name is a compile
 * error rather than a silently ignored one.
 */
const opts = (fetchImpl: typeof fetch): ReportClientOptions => ({
  fetchImpl,
  apiBaseOverride: 'https://example.test',
  tokenProvider: async () => 'tok',
});

describe('plugin-side surface labels', () => {
  it('does not call a passthrough failure a report failure', async () => {
    // Non-JSON body -> statusOnlyFailure -> defaultFriendly fallback.
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new Error('not json');
      },
    });
    const r = await amazonRequest(
      { method: 'POST', path: '/api/amazon/spapi/call', surface: 'spapi' },
      opts(fetchImpl as unknown as typeof fetch),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.friendly).not.toMatch(/report/i);
    expect(r.friendly).toContain('SP-API request');
  });

  it('does not call an Ads failure a report failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new Error('not json');
      },
    });
    const r = await amazonRequest(
      { method: 'POST', path: '/api/amazon/ads/call', surface: 'ads' },
      opts(fetchImpl as unknown as typeof fetch),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.friendly).not.toMatch(/report/i);
    expect(r.friendly).toContain('Amazon Ads API request');
  });

  it('still says "report request" on the reports surface', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new Error('not json');
      },
    });
    const r = await amazonRequest(
      { method: 'POST', path: '/api/amazon/reports', surface: 'report' },
      opts(fetchImpl as unknown as typeof fetch),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.friendly).toContain('report request');
  });

  it('names no surface when none is declared (the shared merchant list)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new Error('not json');
      },
    });
    const r = await amazonRequest(
      { method: 'GET', path: '/api/amazon/merchants' },
      opts(fetchImpl as unknown as typeof fetch),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.friendly).not.toMatch(/report|ads|pricing/i);
  });

  it("the service's own friendly always wins over the fallback", async () => {
    // The gateway now sends correct, surface-named text. The plugin must not
    // override it -- the fallback exists only for when there is none.
    const fetchImpl = fetchReturning(500, {
      ok: false,
      kind: 'unknown',
      friendly: 'SP-API request failed: something specific from the service',
    });
    const r = await amazonRequest(
      { method: 'POST', path: '/api/amazon/spapi/call', surface: 'spapi' },
      opts(fetchImpl as unknown as typeof fetch),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.friendly).toBe(
      'SP-API request failed: something specific from the service',
    );
  });

  it('does not describe a passthrough 403 as a restricted REPORT', async () => {
    const fetchImpl = fetchReturning(403, { notOurEnvelope: true });
    const r = await amazonRequest(
      { method: 'POST', path: '/api/amazon/spapi/call', surface: 'spapi' },
      opts(fetchImpl as unknown as typeof fetch),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('restricted_report'); // wire kind unchanged
    expect(r.friendly).not.toMatch(/\breport\b/i);
  });

  it('spapiCall declares its surface, so its failures never say "report"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 502,
      ok: false,
      json: async () => {
        throw new Error('not json');
      },
    });
    const r = await spapiCall(
      { operation: 'fulfillment_inbound.get_shipments' },
      opts(fetchImpl as unknown as typeof fetch),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.friendly).not.toMatch(/report/i);
  });
});

describe('bad_request: the caller learns what Amazon actually said', () => {
  const envelope = {
    ok: false,
    kind: 'bad_request',
    friendly: 'Amazon rejected this SP-API request (HTTP 400, InvalidInput): ShipmentStatusList is required.',
    message: 'ShipmentStatusList is required',
    status: 400,
    amazon_error_code: 'InvalidInput',
    responsePayload: { errors: [{ code: 'InvalidInput', message: 'ShipmentStatusList is required' }] },
  };

  it('keeps Amazon\'s error code, status and full body instead of dropping them', async () => {
    const r = await amazonRequest(
      { method: 'POST', path: '/api/amazon/spapi/call', surface: 'spapi' },
      opts(fetchReturning(400, envelope) as unknown as typeof fetch),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('bad_request');
    expect(r.amazonErrorCode).toBe('InvalidInput');
    // Amazon's status, NOT ours. This was silently lost to a field collision:
    // the service sends a number under `status`, which report_fatal also uses
    // as a string, and the string-only coercion dropped it.
    expect(r.amazonStatus).toBe(400);
    expect(r.httpStatus).toBe(400);
    expect(r.responsePayload).toEqual(envelope.responsePayload);
  });

  it('is recognised as a known kind rather than degraded to unknown', async () => {
    const r = await amazonRequest(
      { method: 'POST', path: '/api/amazon/spapi/call', surface: 'spapi' },
      opts(fetchReturning(400, envelope) as unknown as typeof fetch),
    );
    if (r.ok) return;
    expect(r.kind).toBe('bad_request');
    expect(r.friendly).toBe(envelope.friendly);
  });

  it('gets its own exit code so a script can stop instead of retrying', async () => {
    const { exitCodeForKind } = await import('./reports');
    expect(exitCodeForKind('bad_request')).toBe(12);
    // Distinct from the generic failure code, which is the point.
    expect(exitCodeForKind('unknown')).toBe(1);
  });

  it('a bare 400 with no envelope still classifies as bad_request', async () => {
    const r = await amazonRequest(
      { method: 'GET', path: '/api/amazon/spapi/operations', surface: 'spapi' },
      opts(fetchReturning(400, { notOurEnvelope: true }) as unknown as typeof fetch),
    );
    if (r.ok) return;
    expect(r.kind).toBe('bad_request');
    expect(r.friendly).not.toMatch(/report/i);
    expect(r.friendly).toMatch(/retrying it unchanged will not help/i);
  });
});
