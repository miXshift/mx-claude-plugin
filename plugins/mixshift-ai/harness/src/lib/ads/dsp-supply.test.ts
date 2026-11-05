import { describe, it, expect } from 'vitest';
import { planSupplyPreset, renderSupplyPlan, DELETE_TARGETS_MAX, type SupplyCall, type SupplyPlan } from './dsp-supply.js';
import { isReportFailure, type ReportFailure } from '../amazon/reports.js';

const ADV = '1000000000000000001';
const AG1 = '3000000000000000006';
const AG2 = '3000000000000000003';

let seq = 0;
function src(adGroupId: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    adGroupId,
    targetId: `t${seq}`,
    targetType: 'INVENTORY_SOURCE',
    negative: false,
    targetDetails: { inventorySourceTarget: { inventorySourceId: { defaultValue: String(seq) }, inventorySourceType: kind } },
    ...extra,
  };
}

function okRes(payload: unknown) {
  return { ok: true as const, operation: 'dsp.query_targets', profileId: 'p', legacySellerId: 574, marketplaceId: null, payload };
}

function fake(pages: Array<Record<string, unknown>>) {
  const bodies: Array<Record<string, unknown>> = [];
  const call: SupplyCall = async (input) => {
    bodies.push(input.body as Record<string, unknown>);
    const idx = bodies.length - 1;
    return okRes(pages[idx] ?? { targets: [] });
  };
  return { call, bodies };
}

async function plan(call: SupplyCall, ids = [AG1]): Promise<SupplyPlan> {
  const p = await planSupplyPreset(call, ADV, ids);
  if (isReportFailure(p)) throw new Error(p.friendly);
  return p;
}

describe('planSupplyPreset', () => {
  it('removes third-party exchanges and keeps Amazon owned, Publisher Direct and unknown sources', async () => {
    const tpe = [src(AG1, 'THIRD_PARTY_EXCHANGE'), src(AG1, 'THIRD_PARTY_EXCHANGE')];
    const { call, bodies } = fake([
      { targets: [src(AG1, 'AMAZON'), src(AG1, 'APD'), src(AG1, 'SOMETHING_NEW'), ...tpe] },
    ]);
    const p = await plan(call);
    expect(p.targetIds).toEqual(tpe.map((t) => t.targetId));
    expect(p.lines[0]).toMatchObject({ amazon: 1, publisherDirect: 1, thirdPartyExchange: 2, other: 1 });
    expect(p.batches).toEqual([p.targetIds]);
    // One read, filtered to inventory sources on the DSP product.
    expect(bodies[0]).toMatchObject({
      adProductFilter: { include: ['AMAZON_DSP'] },
      adGroupIdFilter: { include: [AG1] },
      targetTypeFilter: { include: ['INVENTORY_SOURCE'] },
    });
  });

  it('ignores exclusions and other target types', async () => {
    const { call } = fake([
      {
        targets: [
          src(AG1, 'AMAZON'),
          src(AG1, 'THIRD_PARTY_EXCHANGE', { negative: true }),
          { adGroupId: AG1, targetId: 'aud', targetType: 'AUDIENCE', negative: false },
        ],
      },
    ]);
    const p = await plan(call);
    expect(p.targetIds).toEqual([]);
    expect(p.lines[0]?.skipped).toContain('already Amazon and Publisher Direct only');
  });

  it('leaves a line item alone when nothing Amazon or Publisher Direct would remain', async () => {
    const { call } = fake([{ targets: [src(AG1, 'THIRD_PARTY_EXCHANGE'), src(AG2, 'AMAZON'), src(AG2, 'THIRD_PARTY_EXCHANGE')] }]);
    const p = await plan(call, [AG1, AG2]);
    const l1 = p.lines.find((l) => l.adGroupId === AG1);
    expect(l1?.remove).toEqual([]);
    expect(l1?.skipped).toContain('no Amazon or Publisher Direct source to keep');
    expect(p.targetIds).toHaveLength(1);
  });

  it('never calls unclassified sources "already done"', async () => {
    const { call } = fake([{ targets: [src(AG1, 'SOMETHING_NEW'), src(AG1, 'SOMETHING_NEW')] }]);
    const p = await plan(call);
    expect(p.targetIds).toEqual([]);
    expect(p.lines[0]?.skipped).toContain('could not classify 2 inventory source(s)');
  });

  it('flags an id that has no inventory sources (wrong id or another advertiser)', async () => {
    const { call } = fake([{ targets: [] }]);
    const p = await plan(call);
    expect(p.lines[0]?.skipped).toContain('no inventory source targets found');
  });

  it('pages by body token and de-duplicates line item ids', async () => {
    const a = src(AG1, 'THIRD_PARTY_EXCHANGE');
    const b = src(AG1, 'THIRD_PARTY_EXCHANGE');
    const { call, bodies } = fake([
      { targets: [src(AG1, 'AMAZON'), a], nextToken: 'n2' },
      { targets: [b] },
    ]);
    const p = await plan(call, [AG1, AG1]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.nextToken).toBe('n2');
    expect((bodies[0]?.adGroupIdFilter as { include: string[] }).include).toEqual([AG1]);
    expect(p.targetIds).toEqual([a.targetId, b.targetId]);
  });

  it(`splits more than ${DELETE_TARGETS_MAX} deletions into separate calls`, async () => {
    const many = Array.from({ length: DELETE_TARGETS_MAX + 5 }, () => src(AG1, 'THIRD_PARTY_EXCHANGE'));
    const { call } = fake([{ targets: [src(AG1, 'AMAZON'), ...many] }]);
    const p = await plan(call);
    expect(p.batches.map((b) => b.length)).toEqual([DELETE_TARGETS_MAX, 5]);
  });

  it('returns the failure when a read fails, so no partial plan is made', async () => {
    const call: SupplyCall = async () => ({ ok: false, kind: 'throttled', friendly: 'slow down' }) as ReportFailure;
    const p = await planSupplyPreset(call, ADV, [AG1]);
    expect(isReportFailure(p)).toBe(true);
  });

  it('refuses rather than plan from a read that never ends', async () => {
    const call: SupplyCall = async () => okRes({ targets: [src(AG1, 'THIRD_PARTY_EXCHANGE')], nextToken: 'again' });
    const p = await planSupplyPreset(call, ADV, [AG1]);
    expect(isReportFailure(p)).toBe(true);
  });

  it('renders the per-line counts and the total', async () => {
    const { call } = fake([{ targets: [src(AG1, 'AMAZON'), src(AG1, 'APD'), src(AG1, 'THIRD_PARTY_EXCHANGE')] }]);
    const text = renderSupplyPlan(await plan(call));
    expect(text).toContain(`line item ${AG1}: Amazon 1, Publisher Direct 1, third-party exchanges 1 -> remove 1`);
    expect(text).toContain('1 target(s) to remove in 1 call(s).');
  });
});
