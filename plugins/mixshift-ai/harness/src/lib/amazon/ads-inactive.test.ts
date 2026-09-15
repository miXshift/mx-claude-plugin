import { describe, it, expect } from 'vitest';
import { listAdsProfiles, adsCall } from './ads-call.js';
import { exitCodeForKind } from './reports.js';

/**
 * mx-ops#57. The gateway used to offer merchants that are INACTIVE for Ads as
 * callable, then report the resulting Amazon 401 as `reauth_required` with
 * "your authorization was lost". Users re-connected accounts that were fine.
 *
 * These pin the CLIENT half: the list carries and relays what was withheld,
 * and the two new kinds never tell a user to re-authorize.
 */

function injected(fetchImpl: typeof fetch) {
  return {
    apiBaseOverride: 'https://svc.test',
    tokenProvider: async () => 'tok',
    fetchImpl,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('listAdsProfiles: inactive merchants are counted and announced', () => {
  it('asks for active-only by default and carries the counts and note', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string | URL) => {
      seenUrl = String(url);
      return jsonResponse({
        profiles: [{ profileId: 'P1', legacySellerId: 371, amazonSellerId: 'A1', isActive: true }],
        activeCount: 1,
        inactiveCount: 383,
        inactiveHidden: true,
        note: '1 active merchant shown. 383 inactive merchants are hidden.',
      });
    }) as unknown as typeof fetch;

    const r = await listAdsProfiles(injected(fetchImpl));

    expect(seenUrl).not.toContain('includeInactive');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.activeCount).toBe(1);
    expect(r.inactiveCount).toBe(383);
    expect(r.inactiveHidden).toBe(true);
    // Relaying this is the difference between "your merchant is missing" and
    // "your merchant is inactive, here is how to switch it on".
    expect(r.note).toContain('383 inactive');
  });

  it('opts in to inactive merchants when asked, and flags them', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string | URL) => {
      seenUrl = String(url);
      return jsonResponse({
        profiles: [
          { profileId: 'P1', legacySellerId: 371, amazonSellerId: 'A1', isActive: true },
          { profileId: 'P2', legacySellerId: 27, amazonSellerId: 'A2', isActive: false },
        ],
        activeCount: 1,
        inactiveCount: 1,
        inactiveHidden: false,
      });
    }) as unknown as typeof fetch;

    const r = await listAdsProfiles({ ...injected(fetchImpl), includeInactive: true });

    expect(seenUrl).toContain('includeInactive=true');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profiles.find((p) => p.legacySellerId === 27)?.isActive).toBe(false);
    expect(r.note).toBeUndefined();
  });

  it('still parses a service build that sends none of the new fields', async () => {
    // Forward-compat in reverse: the plugin ships ahead of the gateway deploy.
    const fetchImpl = (async () =>
      jsonResponse({ profiles: [{ profileId: 'P1', legacySellerId: 371, amazonSellerId: 'A1' }] })) as unknown as typeof fetch;

    const r = await listAdsProfiles(injected(fetchImpl));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profiles).toHaveLength(1);
    expect(r.activeCount).toBeUndefined();
    expect(r.inactiveHidden).toBeUndefined();
    expect(r.note).toBeUndefined();
  });
});

/** Drive a failure envelope through adsCall with no server `friendly`, so the
 *  client's own default copy is what comes back. Mirrors the reports.test.ts
 *  pattern for reauth_required. */
async function defaultCopyFor(kind: string, status: number): Promise<string> {
  const fetchImpl = (async () =>
    jsonResponse({ ok: false, kind }, status)) as unknown as typeof fetch;
  const r = await adsCall({ operation: 'sp.list_campaigns', legacySellerId: 27 }, injected(fetchImpl));
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected a failure');
  expect(r.kind).toBe(kind);
  return r.friendly;
}

describe('the new kinds never send a user to re-authorize', () => {
  it('merchant_inactive says activate, not re-authorize, and is terminal', async () => {
    const msg = (await defaultCopyFor('merchant_inactive', 422)).toLowerCase();
    expect(msg).toContain('activate');
    expect(msg).toContain('re-authorizing will not help');
    // mx-ops#46: the copy must stop a retry loop, and must not read as a
    // retry instruction. "then retry" is exactly what agents acted on before.
    expect(msg).toMatch(/do\s+not\s+retry/);
    expect(msg).not.toMatch(/then retry/);
  });

  it('profile_not_authorized says the connection is fine, so re-auth will not help', async () => {
    const msg = (await defaultCopyFor('profile_not_authorized', 403)).toLowerCase();
    expect(msg).toContain('re-authorizing will not change this');
    expect(msg).toMatch(/will not help|do\s+not\s+retry/);
    expect(msg).not.toMatch(/then retry/);
  });

  it('gives each a distinct exit code, and never reauth_required’s 5', () => {
    expect(exitCodeForKind('merchant_inactive')).toBe(13);
    expect(exitCodeForKind('profile_not_authorized')).toBe(14);
    expect(exitCodeForKind('merchant_inactive')).not.toBe(exitCodeForKind('reauth_required'));
    expect(exitCodeForKind('profile_not_authorized')).not.toBe(exitCodeForKind('reauth_required'));
  });
});
