/**
 * The gateway error contract as the plugin reads it (mx-ops#144 P5).
 *
 * Every envelope here comes from testdata/gateway/error-envelopes.json, which
 * was built by the gateway's own validators, classifier and serializers (see
 * its `_provenance`), so these tests pin the plugin against what the producer
 * actually sends rather than against a shape someone remembered.
 *
 * The bug this exists for: the gateway has refused malformed calls as
 * `invalid_request` (source `request`, not retryable, with a `fix`) since
 * 2026-10-15, and the plugin did not list the kind. It recorded every one as
 * `unknown` with "try again shortly" copy, and agents re-sent the identical
 * refused call 4-5 times within seconds.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  startReport,
  exitCodeForKind,
  failureContractJson,
  failureContractLines,
  failureContractTelemetry,
  cleanServerText,
  SERVER_TEXT_MAX_CHARS,
  type ReportClientOptions,
  type ReportFailure,
} from './reports.js';
import { spapiCall } from './spapi-call.js';
import { adsCall } from './ads-call.js';
import { walmartAdsCall, exitCodeForWalmartKind } from '../walmart/ads-call.js';
import { _refreshState } from '../auth/credentials.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENVELOPES = JSON.parse(
  readFileSync(join(HERE, '..', '..', '..', 'testdata', 'gateway', 'error-envelopes.json'), 'utf8'),
) as Record<string, Record<string, unknown>>;

/** A fresh copy, so a test that edits a fixture cannot leak into another. */
function envelope(name: string): Record<string, unknown> {
  const e = ENVELOPES[name];
  if (!e) throw new Error(`no fixture ${name}`);
  return structuredClone(e);
}

function answering(status: number, body: unknown): ReportClientOptions {
  return {
    apiBaseOverride: 'https://svc.test',
    tokenProvider: async () => 'tok',
    fetchImpl: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  };
}

async function failureFrom(status: number, body: unknown): Promise<ReportFailure> {
  const r = await startReport({ amazonSellerId: 'A1', reportType: 'X' }, answering(status, body));
  if (r.ok) throw new Error('expected a failure');
  return r;
}

beforeEach(() => {
  _refreshState.inFlight = null;
});

describe('invalid_request: MixShift refused it before Amazon saw it', () => {
  it('is a known kind with its own exit code, not unknown', async () => {
    const r = await spapiCall(
      { operation: 'fulfillment_inbound.get_shipments' },
      answering(400, envelope('spapi_measured_rule')),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('invalid_request');
    expect(r.unrecognizedKind).toBeUndefined();
    expect(exitCodeForKind(r.kind)).toBe(15);
    // The gateway's own sentence still wins over our default copy.
    expect(r.friendly).toBe(envelope('spapi_measured_rule').friendly);
  });

  it('carries who acts, the retry verdict, the fix and the parameter names', async () => {
    const r = await failureFrom(400, envelope('spapi_measured_rule'));
    expect(r.source).toBe('request');
    expect(r.retryable).toBe(false);
    expect(r.fix).toContain('Nothing was sent to Amazon.');
    expect(r.docsUrl).toMatch(/^https:\/\/developer-docs\.amazon\.com\//);
    expect(r.missingParams).toEqual(['ShipmentStatusList', 'ShipmentIdList']);
  });

  it('reads invalid_params on an Ads refusal (the "ok" reportId loop)', async () => {
    const r = await adsCall(
      { operation: 'reporting.get_report', sellerId: 'A1' },
      answering(400, envelope('ads_not_an_id')),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('invalid_request');
    expect(r.invalidParams).toEqual(['pathParams.reportId']);
    expect(r.fix).toMatch(/re-polling this one will never succeed/);
  });

  it('treats an unlisted kind the gateway sources to the request, at 400, as invalid_request', async () => {
    const e = envelope('spapi_unknown_operation');
    e.kind = 'some_request_kind_shipped_later';
    const r = await failureFrom(400, e);
    expect(r.kind).toBe('invalid_request');
    expect(r.unrecognizedKind).toBe('some_request_kind_shipped_later');
  });

  it('does not stretch that to other statuses: an unlisted request kind at 409 stays unknown', async () => {
    const e = envelope('spapi_unknown_operation');
    e.kind = 'some_request_kind_shipped_later';
    const r = await failureFrom(409, e);
    expect(r.kind).toBe('unknown');
  });
});

describe("Amazon's answer, from the structured `amazon` object", () => {
  it('reads status, code and message on an Amazon rejection', async () => {
    const r = await failureFrom(400, envelope('spapi_bad_request'));
    expect(r.kind).toBe('bad_request');
    expect(r.source).toBe('amazon_rejected');
    expect(r.amazonStatus).toBe(400);
    expect(r.amazonErrorCode).toBe('InvalidInput');
    expect(r.amazonMessage).toBe('Invalid granularityType');
  });

  it('prefers `amazon` over the top-level copies of the duplication window', async () => {
    const e = envelope('spapi_bad_request');
    e.amazon_error_code = 'StaleTopLevel';
    e.status = 418;
    const r = await failureFrom(400, e);
    expect(r.amazonErrorCode).toBe('InvalidInput');
    expect(r.amazonStatus).toBe(400);
  });

  it('still works once the gateway strips the top-level copies (its planned P5 cleanup)', async () => {
    const e = envelope('spapi_bad_request');
    delete e.status;
    delete e.amazon_error_code;
    delete e.amazon_message;
    const r = await failureFrom(400, e);
    expect(r.amazonStatus).toBe(400);
    expect(r.amazonErrorCode).toBe('InvalidInput');
    expect(r.amazonMessage).toBe('Invalid granularityType');
  });

  it('still reads the top-level copies from a gateway older than the `amazon` object', async () => {
    const e = envelope('spapi_bad_request');
    delete e.amazon;
    const r = await failureFrom(400, e);
    expect(r.amazonStatus).toBe(400);
    expect(r.amazonErrorCode).toBe('InvalidInput');
    expect(r.amazonMessage).toBe('Invalid granularityType');
  });

  it("records a throttle's Amazon status and the retry verdict", async () => {
    const r = await failureFrom(429, envelope('ads_throttled'));
    expect(r.kind).toBe('throttled');
    expect(r.amazonStatus).toBe(429);
    expect(r.source).toBe('amazon_unavailable');
    expect(r.retryable).toBe(true);
  });

  it('marks a MixShift crash as not retryable', async () => {
    const r = await failureFrom(500, envelope('unknown'));
    expect(r.kind).toBe('unknown');
    expect(r.source).toBe('mixshift');
    expect(r.retryable).toBe(false);
  });
});

describe('fix text handling', () => {
  it('accepts the object shape the P3 design sketched, joined into one line', async () => {
    const e = envelope('spapi_unknown_operation');
    e.fix = { expected: 'pathParams.shipmentId', example: 'FBA15ABCD123', docsUrl: 'https://x.test/doc' };
    const r = await failureFrom(400, e);
    expect(r.fix).toBe('pathParams.shipmentId FBA15ABCD123 https://x.test/doc');
  });

  it('makes control characters inert and caps the length', () => {
    expect(cleanServerText('use \u001b[31mred\u001b[0m')).toBe('use  [31mred [0m');
    const long = cleanServerText('x'.repeat(SERVER_TEXT_MAX_CHARS + 50))!;
    expect(long.endsWith('... [truncated]')).toBe(true);
    expect(cleanServerText('   ')).toBeUndefined();
    expect(cleanServerText(42)).toBeUndefined();
  });
});

describe('output helpers', () => {
  it('--json carries the contract fields under snake_case names', async () => {
    const r = await failureFrom(400, envelope('spapi_measured_rule'));
    const out = failureContractJson(r);
    expect(out).toMatchObject({
      source: 'request',
      retryable: false,
      missing_params: ['ShipmentStatusList', 'ShipmentIdList'],
    });
    expect(String(out.fix)).toContain('Nothing was sent to Amazon.');
    expect(out.amazon).toBeUndefined(); // Amazon never answered a refusal
  });

  it('--json groups Amazon\'s answer when there is one', async () => {
    const r = await failureFrom(400, envelope('spapi_bad_request'));
    expect(failureContractJson(r).amazon).toEqual({
      status: 400,
      code: 'InvalidInput',
      message: 'Invalid granularityType',
    });
  });

  it('text output shows the fix and says not to resend as is', async () => {
    const r = await failureFrom(400, envelope('spapi_measured_rule'));
    const lines = failureContractLines(r);
    expect(lines[0]).toMatch(/^ {2}fix: Amazon: "At least one of/);
    // The docs URL is already inside the fix text, so it is not repeated.
    expect(lines.some((l) => l.startsWith('  docs:'))).toBe(false);
    expect(lines).toContain('  Not retryable as sent: change the request before calling again.');
  });

  it('telemetry gets enums and a flag, never the fix text or Amazon\'s words', async () => {
    const refused = failureContractTelemetry(await failureFrom(400, envelope('spapi_measured_rule')));
    expect(refused).toEqual({ source: 'request', retryable: false, has_fix: true });
    const rejected = failureContractTelemetry(await failureFrom(400, envelope('spapi_bad_request')));
    expect(rejected).toEqual({ source: 'amazon_rejected', retryable: false });
    expect(JSON.stringify(rejected)).not.toContain('granularityType');
  });

  it('telemetry drops a source that is not a contract word', async () => {
    const e = envelope('spapi_unknown_operation');
    e.source = 'request; DROP all the things';
    expect(failureContractTelemetry(await failureFrom(400, e))).not.toHaveProperty('source');
  });
});

describe('red-team round (2026-10-19)', () => {
  it("a route-level schema miss keeps what to change: issues become the detail and the parameter names", async () => {
    const r = await spapiCall({ operation: 'x' }, answering(400, envelope('route_spapi_schema_miss')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('invalid_request');
    expect(r.message).toBe('operation: Expected string, received number');
    expect(r.invalidParams).toEqual(['operation']);
  });

  it("prefers amazon.message over the top-level copy", async () => {
    const e = envelope('spapi_bad_request');
    e.amazon_message = 'stale top-level words';
    const r = await failureFrom(400, e);
    expect(r.amazonMessage).toBe('Invalid granularityType');
  });

  it('drops a docs link that is not a plain https URL', async () => {
    const e = envelope('spapi_measured_rule');
    e.docsUrl = 'javascript:alert(1)';
    expect((await failureFrom(400, e)).docsUrl).toBeUndefined();
    e.docsUrl = 'https://developer-docs.amazon.com/sp-api/docs/x y';
    expect((await failureFrom(400, e)).docsUrl).toBeUndefined();
  });

  it('makes the Unicode line and paragraph separators and U+061C inert', () => {
    const sep = String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + String.fromCharCode(0x061c);
    expect(cleanServerText(`a${sep}b`)).toBe('a   b');
  });
});

describe('Walmart: the same refusal on the Walmart surface', () => {
  it('reads invalid_request instead of calling it a Walmart rejection', async () => {
    const r = await walmartAdsCall(
      { operation: 'sp.list_campaigns', advertiserId: '123' },
      {
        apiBaseOverride: 'https://svc.test',
        tokenProvider: async () => 'tok',
        fetchImpl: async () =>
          new Response(JSON.stringify(envelope('walmart_unknown_operation')), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('invalid_request');
    expect(r.unrecognizedKind).toBeUndefined();
    expect(r.source).toBe('request');
    expect(r.retryable).toBe(false);
    expect(exitCodeForWalmartKind(r.kind)).toBe(15);
  });

  it('an unlisted 400 with source request reads as invalid_request; without source, bad_request as before', async () => {
    const opts = (body: unknown) => ({
      apiBaseOverride: 'https://svc.test',
      tokenProvider: async () => 'tok',
      fetchImpl: async () =>
        new Response(JSON.stringify(body), { status: 400, headers: { 'content-type': 'application/json' } }),
    });
    const withSource = await walmartAdsCall(
      { operation: 'x', advertiserId: '1' },
      opts({ ok: false, kind: 'future_kind', friendly: 'No.', source: 'request', retryable: false }),
    );
    const withoutSource = await walmartAdsCall(
      { operation: 'x', advertiserId: '1' },
      opts({ ok: false, kind: 'future_kind', friendly: 'No.' }),
    );
    expect(withSource.ok === false && withSource.kind).toBe('invalid_request');
    expect(withoutSource.ok === false && withoutSource.kind).toBe('bad_request');
  });

  const walmartAnswering = (status: number, body: unknown) => ({
    apiBaseOverride: 'https://svc.test',
    tokenProvider: async () => 'tok',
    fetchImpl: async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  });

  it('a Walmart route schema miss keeps its detail and field names', async () => {
    const r = await walmartAdsCall(
      { operation: 'x', advertiserId: '1' },
      walmartAnswering(400, envelope('route_walmart_schema_miss')),
    );
    expect(r.ok === false && r.kind).toBe('invalid_request');
    if (r.ok) return;
    expect(r.message).toBe('operation: Required');
    expect(r.invalidParams).toEqual(['operation']);
  });

  it("a Walmart rejection keeps Walmart's own answer for --json", async () => {
    const r = await walmartAdsCall(
      { operation: 'x', advertiserId: '1' },
      walmartAnswering(400, envelope('walmart_bad_request')),
    );
    expect(r.ok === false && r.kind).toBe('bad_request');
    if (r.ok) return;
    expect(r.source).toBe('amazon_rejected');
    expect(r.walmartResponse).toEqual({ code: 'INVALID_PARAMETER', details: 'campaignId must be numeric' });
  });
});
