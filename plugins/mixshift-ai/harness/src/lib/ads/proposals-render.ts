/**
 * Human-readable rendering for `mixshift ads proposals ...` (stderr text and
 * the list table). Pure functions: no I/O, so they are unit-testable and the
 * command layer stays thin.
 *
 * Every string the server supplied (title, rationale, who proposed or
 * approved, notes, item fields) goes through `cleanText` before it is printed,
 * so it cannot move the cursor, recolor the terminal or fake a layout line.
 */

import type { ProposalView } from './proposals.js';
import type { ReportFailure } from '../amazon/reports.js';

// The compact view (`proposals show`) lists this many items, each cut to this
// many characters. The approve preview never truncates: a person approving has
// to see every item in full.
const MAX_ITEM_LINES = 25;
const MAX_ITEM_CHARS = 240;

// Money-bearing fields, printed first on every item so a long unrelated field
// cannot push them out of view.
const MONEY_FIELDS = [
  'budget',
  'bid',
  'defaultBid',
  'budgetCaps',
  'flights',
  'budgetAmount',
  'dynamicBidding',
] as const;

// C0 and C1 control characters (newline and tab included: every server string
// is printed on one line), DEL, line and paragraph separators, bidi controls
// and zero-width characters.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** A server-supplied value made safe to print on one line. */
export function cleanText(v: unknown): string {
  return String(v ?? '')
    .replace(CONTROL_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function cell(s: string | number | null | undefined): string {
  return cleanText(s).replaceAll('|', '\\|');
}

function json(v: unknown): string {
  return cleanText(JSON.stringify(v) ?? '');
}

function oneLine(v: unknown, max = MAX_ITEM_CHARS): string {
  const s = json(v);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** One change-set item: money fields first, then the rest as compact JSON. */
export function renderItem(it: unknown, index: number): string {
  const n = `${index + 1}.`;
  if (typeof it !== 'object' || it === null || Array.isArray(it)) return `${n} ${json(it)}`;
  const o = it as Record<string, unknown>;
  const money = MONEY_FIELDS.filter((k) => k in o).map((k) => `${k}=${json(o[k])}`);
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!(MONEY_FIELDS as readonly string[]).includes(k)) rest[k] = v;
  }
  const parts: string[] = [];
  if (money.length > 0) parts.push(money.join(' '));
  if (Object.keys(rest).length > 0) parts.push(`${money.length > 0 ? 'other: ' : ''}${json(rest)}`);
  return `${n} ${parts.join(' | ') || '{}'}`;
}

/** The change-set items inside a stored request body: the body itself when it
 *  is an array, else the first array-valued property (`{ campaigns: [...] }`). */
export function proposalItems(p: ProposalView): unknown[] {
  const body = p.request?.body;
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) {
    for (const v of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function fmtVal(v: unknown): string {
  return v === null || v === undefined ? 'none' : cleanText(v);
}

export function renderGuard(p: ProposalView, full = false): string[] {
  const flagged = p.guard?.flagged ?? [];
  if (flagged.length === 0) {
    return p.guard?.evaluated === true
      ? ['  guard: no money change above the threshold']
      : ['  guard: not evaluated for this operation'];
  }
  const cap = full ? flagged.length : MAX_ITEM_LINES;
  const pct = p.guard?.thresholdPct !== undefined ? ` ${cleanText(p.guard.thresholdPct)}%` : '';
  const lines = [
    `  guard: ${flagged.length} money change(s) above the${pct} threshold` +
      (p.guardAcknowledged ? ' (acknowledged)' : ' (approval needs --acknowledge-guard)'),
  ];
  for (const f of flagged.slice(0, cap)) {
    const change =
      typeof f.pctChange === 'number' ? ` (${f.pctChange > 0 ? '+' : ''}${f.pctChange}%)` : '';
    lines.push(
      `    - ${fmtVal(f.id)} ${fmtVal(f.field)}: ${fmtVal(f.from)} -> ${fmtVal(f.to)}${change}`,
    );
  }
  if (flagged.length > cap) {
    lines.push(`    ... and ${flagged.length - cap} more flagged change(s) not shown`);
  }
  return lines;
}

/** The facts a person needs before approving: what, how many, how risky, how
 *  long. `withItems`: false = no items, true or 'compact' = the capped view for
 *  `show`, 'full' = every item, untruncated (the approve preview). */
export function renderProposalSummary(
  p: ProposalView,
  withItems: boolean | 'compact' | 'full' = false,
): string[] {
  const full = withItems === 'full';
  const lines = [
    `  id: ${cleanText(p.id)}`,
    `  status: ${cleanText(p.status)}`,
    `  operation: ${cleanText(p.operation)}${p.profileId ? ` (profile ${cleanText(p.profileId)})` : ''}`,
    `  items: ${cleanText(p.itemsCount ?? '?')}`,
  ];
  if (p.title) lines.push(`  title: ${cleanText(p.title)}`);
  if (p.rationale) lines.push(`  rationale: ${cleanText(p.rationale)}`);
  if (p.expiresAt) lines.push(`  expires: ${cleanText(p.expiresAt)}`);
  if (p.proposedBy) lines.push(`  proposed by: ${cleanText(p.proposedBy)}`);
  if (p.approvedBy) {
    lines.push(
      `  approved by: ${cleanText(p.approvedBy)}${p.approvedAt ? ` at ${cleanText(p.approvedAt)}` : ''}`,
    );
  }
  if (p.approvalNote) lines.push(`  approval note: ${cleanText(p.approvalNote)}`);
  if (p.rejectedBy) {
    lines.push(
      `  rejected by: ${cleanText(p.rejectedBy)}${p.rejectReason ? ` (${cleanText(p.rejectReason)})` : ''}`,
    );
  }
  if (p.commitAuditId) lines.push(`  audit: ${cleanText(p.commitAuditId)}`);
  lines.push(...renderGuard(p, full));
  if (withItems) {
    const items = proposalItems(p);
    if (items.length > 0) {
      lines.push('  change set:');
      const shown = full ? items : items.slice(0, MAX_ITEM_LINES);
      shown.forEach((it, i) => {
        const line = renderItem(it, i);
        const text =
          full || line.length <= MAX_ITEM_CHARS ? line : `${line.slice(0, MAX_ITEM_CHARS - 3)}...`;
        lines.push(`    ${text}`);
      });
      if (shown.length < items.length) {
        lines.push(
          `    ... ${items.length - shown.length} more item(s) omitted from this view (the full list is in the JSON below)`,
        );
      }
    }
  }
  return lines;
}

export function renderProposalTable(proposals: ProposalView[]): string {
  if (proposals.length === 0) return '_(no proposals match)_';
  const cols = ['id', 'status', 'operation', 'items', 'expires', 'title'];
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const rows = proposals.map(
    (p) =>
      '| ' +
      [p.id, p.status, p.operation, p.itemsCount ?? '', p.expiresAt ?? '', p.title ?? '']
        .map(cell)
        .join(' | ') +
      ' |',
  );
  return [header, sep, ...rows].join('\n');
}

/** Drift rows for `proposal_stale`, one line each (stderr under the headline). */
export function renderDrift(f: ReportFailure): string[] {
  if (!f.drift || f.drift.length === 0) return [];
  const lines = ['  changed since the proposal:'];
  for (const row of f.drift.slice(0, MAX_ITEM_LINES)) lines.push(`    - ${oneLine(row)}`);
  if (f.drift.length > MAX_ITEM_LINES) lines.push(`    ... and ${f.drift.length - MAX_ITEM_LINES} more`);
  return lines;
}
