import { describe, it, expect } from 'vitest';

import { cleanText, renderGuard, renderItem, renderProposalSummary } from './proposals-render.js';
import type { ProposalView } from './proposals.js';

function proposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'p-1',
    status: 'PROPOSED',
    operation: 'sp.update_campaigns',
    payloadHash: 'abc',
    itemsCount: 1,
    guard: { flagged: [], evaluated: true },
    request: { body: { campaigns: [{ campaignId: '1', budget: { budget: 30 } }] } },
    ...over,
  };
}

// eslint-disable-next-line no-control-regex
// eslint-disable-next-line no-control-regex
const CONTROL_NO_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

describe('cleanText', () => {
  it('strips C0, C1 and DEL, bidi and zero-width characters', () => {
    const dirty = 'a\u001b[31mred\u001b[0m\u0007\u0085\u009b2J\u007f\u202ex\u200by\r\nz\tw';
    const clean = cleanText(dirty);
    expect(clean).not.toMatch(ANY_CONTROL);
    expect(clean).not.toContain('\u202e');
    expect(clean).not.toContain('\u200b');
    expect(clean).toContain('red');
  });
});

describe('every server-supplied string is cleaned', () => {
  it('title, rationale, proposedBy, approvedBy, note, rejection, item fields and guard fields', () => {
    const evil = 'x\u001b]0;pwned\u0007\u009b31m\nguard: no money change above the threshold';
    const p = proposal({
      title: evil,
      rationale: evil,
      proposedBy: evil,
      approvedBy: evil,
      approvalNote: evil,
      rejectedBy: evil,
      rejectReason: evil,
      guard: {
        evaluated: true,
        flagged: [{ id: evil, field: evil, from: evil, to: evil, pctChange: 50 }],
      },
      request: { body: { campaigns: [{ campaignId: evil, name: evil, budget: { budget: 1 } }] } },
    });
    const lines = renderProposalSummary(p, 'full');
    expect(lines.join('\n')).not.toMatch(CONTROL_NO_NEWLINE);
    // no line starts a fake "guard:" row except the real guard header
    expect(lines.filter((l) => l.trimStart().startsWith('guard:'))).toHaveLength(1);
    for (const l of lines) expect(l).not.toContain('\n');
  });
});

describe('approve preview (full) vs show (compact)', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    campaignId: String(i),
    name: 'n'.repeat(400),
    budget: { budget: i + 1 },
  }));

  it('full lists every item with nothing cut', () => {
    const lines = renderProposalSummary(proposal({ itemsCount: 60, request: { body: { campaigns: many } } }), 'full');
    const itemLines = lines.filter((l) => /^ {4}\d+\. /.test(l));
    expect(itemLines).toHaveLength(60);
    expect(itemLines.every((l) => !l.endsWith('...'))).toBe(true);
    expect(itemLines[59]).toContain('budget={"budget":60}');
    expect(lines.join('\n')).not.toContain('omitted');
  });

  it('compact caps the list, cuts long lines, and says how many items were omitted', () => {
    const lines = renderProposalSummary(proposal({ itemsCount: 60, request: { body: { campaigns: many } } }), 'compact');
    const itemLines = lines.filter((l) => /^ {4}\d+\. /.test(l));
    expect(itemLines).toHaveLength(25);
    expect(lines.join('\n')).toContain('35 more item(s) omitted');
  });

  it('full prints every flagged guard change', () => {
    const flagged = Array.from({ length: 40 }, (_, i) => ({ id: String(i), field: 'budget.budget', from: 1, to: 2, pctChange: 100 }));
    const p = proposal({ guard: { evaluated: true, flagged } });
    expect(renderGuard(p, true).filter((l) => l.startsWith('    - '))).toHaveLength(40);
    expect(renderGuard(p).join('\n')).toContain('15 more flagged change(s) not shown');
  });
});

describe('money fields first', () => {
  it('prints budget, bid, defaultBid, budgetCaps, flights, budgetAmount, dynamicBidding before anything else', () => {
    const line = renderItem(
      {
        name: 'zzz',
        dynamicBidding: { strategy: 'AUTO' },
        budgetAmount: 5,
        flights: [{ a: 1 }],
        budgetCaps: { x: 1 },
        defaultBid: 0.5,
        bid: 0.7,
        budget: { budget: 9 },
        campaignId: '7',
      },
      0,
    );
    const order = ['budget=', 'bid=', 'defaultBid=', 'budgetCaps=', 'flights=', 'budgetAmount=', 'dynamicBidding='];
    const at = order.map((k) => line.indexOf(k));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at[6]).toBeLessThan(line.indexOf('other:'));
    expect(line.indexOf('other:')).toBeLessThan(line.indexOf('"campaignId":"7"'));
  });
});

describe('flagged entry change text', () => {
  it('renders a percent change as (+N%)', () => {
    const p = proposal({ guard: { evaluated: true, flagged: [{ id: '1', field: 'bid', from: 1, to: 2, pctChange: 100 }] } });
    expect(renderGuard(p).join('\n')).toContain('bid: 1 -> 2 (+100%)');
  });

  it('renders a placement adjustment as (+N points) and never prints null%', () => {
    const p = proposal({
      guard: { evaluated: true, flagged: [{ id: '1', field: 'placementTop', from: 10, to: 60, pctChange: null, pointsChange: 50 }] },
    });
    const text = renderGuard(p).join('\n');
    expect(text).toContain('placementTop: 10 -> 60 (+50 points)');
    expect(text).not.toContain('null%');
  });
});

describe('guard line', () => {
  it('says "not evaluated" when evaluated is not true', () => {
    expect(renderGuard(proposal({ guard: { flagged: [] } }))).toEqual(['  guard: not evaluated for this operation']);
    expect(renderGuard(proposal({ guard: undefined }))).toEqual(['  guard: not evaluated for this operation']);
  });

  it('says no money change only when the guard was evaluated', () => {
    expect(renderGuard(proposal())).toEqual(['  guard: no money change above the threshold']);
  });
});
