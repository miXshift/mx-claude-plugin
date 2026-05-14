import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postWebhook } from './discord.js';
import type { WebhookRequest } from './types.js';

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function ok(): Response {
  // 204 No Content must have a null body per spec; passing '' fails on Node 22.
  return new Response(null, { status: 204 });
}

describe('postWebhook', () => {
  it('returns ok=false when no webhook URL configured', async () => {
    const result = await postWebhook('', sampleIp());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no webhook url/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts ip whitelist request with correct embed shape', async () => {
    fetchSpy.mockResolvedValue(ok());
    const result = await postWebhook('https://example.com/hook', sampleIp());
    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].title).toBe('IP Whitelist Request');
    expect(body.embeds[0].color).toBe(0x4f46e5);
    const fieldNames = body.embeds[0].fields.map((f: { name: string }) => f.name);
    expect(fieldNames).toContain('IP Address');
    expect(fieldNames).toContain('Email');
  });

  it('posts table access request with table + seller_ids', async () => {
    fetchSpy.mockResolvedValue(ok());
    const result = await postWebhook('https://example.com/hook', {
      kind: 'table_access_request',
      user_email: 'sam@example.com',
      plugin_version: '0.0.1',
      os: 'win32 22.04',
      table_name: 'mws_inventory_health',
      seller_ids: [113, 114],
      note: 'Tried to export inventory data',
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.embeds[0].title).toBe('Table Access Request');
    expect(body.embeds[0].color).toBe(0xf59e0b);
    const fields = body.embeds[0].fields as Array<{ name: string; value: string }>;
    const table = fields.find((f) => f.name === 'Table');
    expect(table?.value).toContain('mws_inventory_health');
    const sellers = fields.find((f) => f.name === 'Seller IDs attempted');
    expect(sellers?.value).toBe('113, 114');
  });

  it('posts user feedback with category + context', async () => {
    fetchSpy.mockResolvedValue(ok());
    const result = await postWebhook('https://example.com/hook', {
      kind: 'user_feedback',
      user_email: 'sam@example.com',
      plugin_version: '0.0.1',
      os: 'win32 22.04',
      message: 'The export command timed out on a 6-month range.',
      category: 'bug',
      context: {
        skill_id: 'data-explore',
        command: 'mixshift data export --table campaignmetric',
        brand_slug: 'hydrapak',
      },
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.embeds[0].title).toBe('User Feedback');
    expect(body.embeds[0].color).toBe(0x10b981);
    const fields = body.embeds[0].fields as Array<{ name: string; value: string }>;
    expect(fields.find((f) => f.name === 'Category')?.value).toBe('bug');
    expect(fields.find((f) => f.name === 'Brand')?.value).toBe('hydrapak');
    expect(fields.find((f) => f.name === 'Message')?.value).toContain('timed out');
  });

  it('truncates feedback messages over 1900 chars', async () => {
    fetchSpy.mockResolvedValue(ok());
    const huge = 'x'.repeat(2500);
    await postWebhook('https://example.com/hook', {
      kind: 'user_feedback',
      user_email: 'sam@example.com',
      plugin_version: '0.0.1',
      os: 'win32',
      message: huge,
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    const msg = (body.embeds[0].fields as Array<{ name: string; value: string }>)
      .find((f) => f.name === 'Message')!;
    expect(msg.value.length).toBe(1900);
  });

  it('returns ok=false when webhook returns 4xx/5xx', async () => {
    fetchSpy.mockResolvedValue(new Response('forbidden', { status: 403 }));
    const result = await postWebhook('https://example.com/hook', sampleIp());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain('403');
  });

  it('returns ok=false on network error', async () => {
    fetchSpy.mockRejectedValue(new Error('ENETUNREACH'));
    const result = await postWebhook('https://example.com/hook', sampleIp());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENETUNREACH');
  });
});

function sampleIp(): WebhookRequest {
  return {
    kind: 'ip_whitelist_request',
    user_email: 'sam@example.com',
    plugin_version: '0.0.1',
    os: 'win32 22.04',
    public_ip: '1.2.3.4',
  };
}
