/**
 * Human-readable rendering for `mixshift ads proposals ...` (stderr text and
 * the list table). Pure functions: no I/O, so they are unit-testable and the
 * command layer stays thin.
 */

import type { ProposalView } from './proposals.js';
import type { ReportFailure } from '../amazon/reports.js';

const MAX_ITEM_LINES = 25;
const MAX_ITEM_CHARS = 240;

function cell(s: string | number | null | undefined): string {
  return String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function oneLine(v: unknown, max = MAX_ITEM_CHARS): string {
  const s = JSON.stringify(v) ?? '';
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
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
  return v === null || v === undefined ? 'none' : String(v);
}

export function renderGuard(p: ProposalView): string[] {
  const flagged = p.guard?.flagged ?? [];
  if (flagged.length === 0) return ['  guard: no money change above the threshold'];
  const pct = p.guard?.thresholdPct !== undefined ? ` ${p.guard.thresholdPct}%` : '';
  const lines = [
    `  guard: ${flagged.length} money change(s) above the${pct} threshold` +
      (p.guardAcknowledged ? ' (acknowledged)' : ' (approval needs --acknowledge-guard)'),
  ];
  for (const f of flagged.slice(0, MAX_ITEM_LINES)) {
    const change =
      typeof f.pctChange === 'number' ? ` (${f.pctChange > 0 ? '+' : ''}${f.pctChange}%)` : '';
    lines.push(
      `    - ${fmtVal(f.id)} ${fmtVal(f.field)}: ${fmtVal(f.from)} -> ${fmtVal(f.to)}${change}`,
    );
  }
  if (flagged.length > MAX_ITEM_LINES) lines.push(`    ... and ${flagged.length - MAX_ITEM_LINES} more`);
  return lines;
}

/** The facts a person needs before approving: what, how many, how risky, how long. */
export function renderProposalSummary(p: ProposalView, withItems = false): string[] {
  const lines = [
    `  id: ${p.id}`,
    `  status: ${p.status}`,
    `  operation: ${p.operation}${p.profileId ? ` (profile ${p.profileId})` : ''}`,
    `  items: ${p.itemsCount ?? '?'}`,
  ];
  if (p.title) lines.push(`  title: ${p.title}`);
  if (p.rationale) lines.push(`  rationale: ${p.rationale}`);
  if (p.expiresAt) lines.push(`  expires: ${p.expiresAt}`);
  if (p.proposedBy) lines.push(`  proposed by: ${p.proposedBy}`);
  if (p.approvedBy) lines.push(`  approved by: ${p.approvedBy}${p.approvedAt ? ` at ${p.approvedAt}` : ''}`);
  if (p.approvalNote) lines.push(`  approval note: ${p.approvalNote}`);
  if (p.rejectedBy) lines.push(`  rejected by: ${p.rejectedBy}${p.rejectReason ? ` (${p.rejectReason})` : ''}`);
  if (p.commitAuditId) lines.push(`  audit: ${p.commitAuditId}`);
  lines.push(...renderGuard(p));
  if (withItems) {
    const items = proposalItems(p);
    if (items.length > 0) {
      lines.push('  change set:');
      for (const it of items.slice(0, MAX_ITEM_LINES)) lines.push(`    ${oneLine(it)}`);
      if (items.length > MAX_ITEM_LINES) lines.push(`    ... and ${items.length - MAX_ITEM_LINES} more`);
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
