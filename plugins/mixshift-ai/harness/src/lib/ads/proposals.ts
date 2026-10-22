/**
 * Client for the Ads proposal registry on the MixShift service: a change set
 * written now, approved later by a person, committed only after approval.
 *
 *   createProposal  -> POST /api/amazon/ads/proposals
 *   listProposals   -> GET  /api/amazon/ads/proposals[?status=&limit=]
 *   getProposal     -> GET  /api/amazon/ads/proposals/:id
 *   approveProposal -> POST /api/amazon/ads/proposals/:id/approve  {payloadHash, acknowledgeGuard?, note?}
 *   rejectProposal  -> POST /api/amazon/ads/proposals/:id/reject   {reason?}
 *   commitProposal  -> POST /api/amazon/ads/proposals/:id/commit   {payloadHash}
 *
 * Same transport as `ads call` (Bearer, 401 refresh, failure envelope). The
 * service owns every rule (human-only approval, hash check, live drift check,
 * the money guard); this client sends what the contract asks and maps the
 * answer. Shapes mirror the service's ProposalView; every field is read
 * defensively so a newer or older service build still parses.
 */

import {
  amazonRequest,
  type ReportClientOptions,
  type ReportFailure,
} from '../amazon/reports.js';
import { buildAdsRequestBody, type AdsCallInput } from '../amazon/ads-call.js';

export interface ProposalGuardFlag {
  index?: number;
  id?: string;
  field?: string;
  from?: number | string | null;
  to?: number | string | null;
  pctChange?: number | null;
}

export interface ProposalGuard {
  thresholdPct?: number;
  flagged: ProposalGuardFlag[];
}

export interface ProposalView {
  id: string;
  /** PROPOSED, APPROVED, REJECTED, COMMITTING, COMMITTED, FAILED, UNCERTAIN, STALE, or the derived EXPIRED. */
  status: string;
  operation: string;
  profileId?: string;
  legacySellerId?: number | null;
  itemsCount?: number;
  title?: string | null;
  rationale?: string | null;
  payloadHash: string;
  createdAt?: string;
  expiresAt?: string;
  proposedBy?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvalNote?: string | null;
  rejectedBy?: string | null;
  rejectedAt?: string | null;
  rejectReason?: string | null;
  committedBy?: string | null;
  completedAt?: string | null;
  commitAuditId?: string | null;
  guard?: ProposalGuard;
  guardAcknowledged?: boolean;
  skillId?: string | null;
  /** Full view only. */
  request?: { pathParams?: unknown; query?: unknown; body?: unknown };
  beforeState?: unknown;
  response?: unknown;
  drift?: unknown;
}

export interface CreateProposalInput {
  call: AdsCallInput;
  title?: string;
  rationale?: string;
  evidence?: unknown;
  expiresInHours?: number;
}

export interface ListProposalsInput {
  status?: string;
  limit?: number;
}

export interface ApproveProposalInput {
  id: string;
  payloadHash: string;
  acknowledgeGuard?: boolean;
  note?: string;
}

export interface ProposalOk {
  ok: true;
  proposal: ProposalView;
}

export interface ProposalListOk {
  ok: true;
  proposals: ProposalView[];
}

const SHORT_TIMEOUT_MS = 30_000;
// A commit runs the live before-state read and the Amazon write; the service
// retries throttles, so give it the same room as a committed `ads call`.
const COMMIT_TIMEOUT_MS = 90_000;

function pathFor(id: string, action?: string): string {
  const base = `/api/amazon/ads/proposals/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

function parseProposal(json: unknown): ProposalView | undefined {
  const p = (json as { proposal?: unknown } | null)?.proposal;
  if (typeof p !== 'object' || p === null) return undefined;
  const v = p as Partial<ProposalView>;
  if (typeof v.id !== 'string' || typeof v.payloadHash !== 'string') return undefined;
  const guard = (p as { guard?: { flagged?: unknown; thresholdPct?: unknown } }).guard;
  return {
    ...(v as ProposalView),
    status: String(v.status ?? ''),
    operation: String(v.operation ?? ''),
    ...(guard
      ? {
          guard: {
            ...(typeof guard.thresholdPct === 'number' ? { thresholdPct: guard.thresholdPct } : {}),
            flagged: Array.isArray(guard.flagged) ? (guard.flagged as ProposalGuardFlag[]) : [],
          },
        }
      : {}),
  };
}

function malformed(what: string): ReportFailure {
  return {
    ok: false,
    kind: 'unknown',
    friendly:
      'The service accepted the call but returned an unrecognized shape. ' +
      'Try again, or contact MixShift ops if it persists.',
    message: `proposals ${what} response missing a valid proposal`,
  };
}

/** Write a change set as a proposal. Calls Amazon for reads only. */
export async function createProposal(
  input: CreateProposalInput,
  opts: ReportClientOptions = {},
): Promise<ProposalOk | ReportFailure> {
  // Same body `ads call` would send, minus dryRun (the route has no such field).
  const body = buildAdsRequestBody({ ...input.call, dryRun: undefined });
  if (input.title) body.title = input.title;
  if (input.rationale) body.rationale = input.rationale;
  if (input.evidence !== undefined) body.evidence = input.evidence;
  if (input.expiresInHours !== undefined) body.expiresInHours = input.expiresInHours;
  const r = await amazonRequest(
    { method: 'POST', path: '/api/amazon/ads/proposals', body, surface: 'ads', mayChangeState: true },
    { ...opts, timeoutMs: opts.timeoutMs ?? 90_000 },
  );
  if (!r.ok) return r;
  const proposal = parseProposal(r.json);
  return proposal ? { ok: true, proposal } : malformed('create');
}

export async function listProposals(
  input: ListProposalsInput = {},
  opts: ReportClientOptions = {},
): Promise<ProposalListOk | ReportFailure> {
  const qs = new URLSearchParams();
  if (input.status) qs.set('status', input.status);
  if (input.limit !== undefined) qs.set('limit', String(input.limit));
  const q = qs.toString();
  const r = await amazonRequest(
    { method: 'GET', path: `/api/amazon/ads/proposals${q ? `?${q}` : ''}`, surface: 'ads' },
    { ...opts, timeoutMs: opts.timeoutMs ?? SHORT_TIMEOUT_MS },
  );
  if (!r.ok) return r;
  const raw = (r.json as { proposals?: unknown }).proposals;
  const proposals = Array.isArray(raw)
    ? raw.map((p) => parseProposal({ proposal: p })).filter((p): p is ProposalView => !!p)
    : [];
  return { ok: true, proposals };
}

export async function getProposal(
  id: string,
  opts: ReportClientOptions = {},
): Promise<ProposalOk | ReportFailure> {
  const r = await amazonRequest(
    { method: 'GET', path: pathFor(id), surface: 'ads' },
    { ...opts, timeoutMs: opts.timeoutMs ?? SHORT_TIMEOUT_MS },
  );
  if (!r.ok) return r;
  const proposal = parseProposal(r.json);
  return proposal ? { ok: true, proposal } : malformed('show');
}

export async function approveProposal(
  input: ApproveProposalInput,
  opts: ReportClientOptions = {},
): Promise<ProposalOk | ReportFailure> {
  const body: Record<string, unknown> = { payloadHash: input.payloadHash };
  if (input.acknowledgeGuard) body.acknowledgeGuard = true;
  if (input.note) body.note = input.note;
  const r = await amazonRequest(
    { method: 'POST', path: pathFor(input.id, 'approve'), body, surface: 'ads' },
    { ...opts, timeoutMs: opts.timeoutMs ?? SHORT_TIMEOUT_MS },
  );
  if (!r.ok) return r;
  const proposal = parseProposal(r.json);
  return proposal ? { ok: true, proposal } : malformed('approve');
}

export async function rejectProposal(
  id: string,
  reason: string | undefined,
  opts: ReportClientOptions = {},
): Promise<ProposalOk | ReportFailure> {
  const body: Record<string, unknown> = reason ? { reason } : {};
  const r = await amazonRequest(
    { method: 'POST', path: pathFor(id, 'reject'), body, surface: 'ads' },
    { ...opts, timeoutMs: opts.timeoutMs ?? SHORT_TIMEOUT_MS },
  );
  if (!r.ok) return r;
  const proposal = parseProposal(r.json);
  return proposal ? { ok: true, proposal } : malformed('reject');
}

export async function commitProposal(
  id: string,
  payloadHash: string,
  opts: ReportClientOptions = {},
): Promise<ProposalOk | ReportFailure> {
  const r = await amazonRequest(
    {
      method: 'POST',
      path: pathFor(id, 'commit'),
      body: { payloadHash },
      surface: 'ads',
      mayChangeState: true,
    },
    { ...opts, timeoutMs: opts.timeoutMs ?? COMMIT_TIMEOUT_MS },
  );
  if (!r.ok) return r;
  const proposal = parseProposal(r.json);
  return proposal ? { ok: true, proposal } : malformed('commit');
}
