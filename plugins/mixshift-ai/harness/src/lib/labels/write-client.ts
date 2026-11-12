/**
 * Client for the labels WRITE surface on the MixShift service (`/api/labels/changes/*` and
 * `/api/labels/fields/names`): change sets that set, clear or rename the labels on your items
 * (ASINs) and Amazon campaigns. Shares the transport, sign-in and failure mapping of
 * lib/labels/client.ts.
 *
 *   labelsPreview        -> POST   /api/labels/changes/preview             (nothing changes)
 *   labelsCommit         -> POST   /api/labels/changes/{id}/commit         { approval_hash }
 *   labelsChangeSets     -> GET    /api/labels/changes/sets?account=&limit=&before=
 *   labelsChangeSet      -> GET    /api/labels/changes/sets/{id}
 *   labelsCancel         -> POST   /api/labels/changes/sets/{id}/cancel
 *   labelsUndo           -> POST   /api/labels/changes/sets/{id}/undo      (a NEW preview)
 *   labelsSetFieldName   -> PUT    /api/labels/fields/names                { account, entity, field, name }
 *   labelsRemoveFieldName-> DELETE /api/labels/fields/names?account=&entity=&field=
 *
 * What the service promises (and this client relies on):
 *   - A preview changes nothing. It freezes the selection and returns a change set id, an
 *     approval hash, a 24-hour expiry and a summary of exactly what would change.
 *   - A commit applies THAT preview only, and only with its approval hash. A commit that did not
 *     fully apply is never `ok:true`: it is a failure envelope (partially_applied, stale, failed)
 *     that carries the full per-item results in `body`.
 *   - A commit may be repeated safely: a change set that was committed answers what it stored.
 *   - Label changes are off until MixShift turns them on for the account: every write route then
 *     answers `not_enabled`, with `reason` saying which switch is off.
 *
 * Nothing in this file decides whether to call: the commands in commands/labels-write.ts never
 * reach `labelsCommit` or the display-name writes without the explicit confirmation flag.
 */

import {
  isState,
  labelsRequest,
  query,
  unrecognizedShape,
  type LabelEntity,
  type LabelsClientOptions,
  type LabelsFailure,
  type LabelsServiceState,
} from './client.js';

export const LABEL_SCOPES = ['marketplace', 'region', 'all'] as const;
export type LabelScope = (typeof LABEL_SCOPES)[number];

/** The most items or campaigns one change set holds (the service's own cap). */
export const CHANGE_SET_MAX = 1_000;
/** The most uncommitted previews an organization may hold at once (the service's own cap). */
export const OPEN_PREVIEWS_MAX = 25;

export type LabelsSelection =
  | { ids: readonly string[] }
  | { filter: { field: string; value: string } }
  | { rename: { field: string; from: string; to: string } };

export interface ChangeSetAccountRow {
  account: number;
  identities?: number;
  to_change?: number;
  unchanged?: number;
  merchant_type?: string | null;
  marketplace_id?: number | string | null;
}

export interface ChangeSetSampleRow {
  account: number;
  entity: LabelEntity;
  id: string;
  field: string;
  before: string | null;
  after: string | null;
}

export interface ChangeSetWarning {
  kind: string;
  message: string;
  [detail: string]: unknown;
}

export interface ResultRow {
  account: number;
  entity: LabelEntity;
  id: string;
  result: string;
  reason?: string;
  stale_fields?: string[];
}

/** One change set as the service describes it: a preview, or what happened once it was final. */
export interface ChangeSetView {
  ok: true;
  state: LabelsServiceState;
  change_set_id: string;
  kind: string;
  status: string;
  scope: LabelScope;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
  /** Only on a preview. */
  approval_hash?: string;
  can_commit: boolean;
  blocked_by?: string;
  accounts: ChangeSetAccountRow[];
  totals: { identities: number; to_change: number; unchanged: number; fields_to_change: number } | null;
  dropped: {
    identities: number;
    accounts: number;
    reasons: Record<string, number>;
    details: Array<{ account: number; reason: string; identities?: number }>;
  } | null;
  warnings: ChangeSetWarning[];
  sample: ChangeSetSampleRow[];
  preview_actor?: string | null;
  commit_actor?: string | null;
  surface?: string;
  undoes?: string;
  commit?: Record<string, unknown>;
  needs_attention?: ResultRow[];
  needs_attention_truncated?: boolean;
}

export interface CommitCountsBody {
  identities: number;
  applied: number;
  unchanged: number;
  stale: number;
  refused: number;
  fields_changed: number;
}

/** What a commit answers, in success and (inside `LabelsFailure.body`) when it did not fully apply. */
export interface CommitBody {
  change_set_id: string;
  status: string;
  already_committed: boolean;
  counts: CommitCountsBody;
  accounts: Array<{ account: number; applied: number; unchanged: number; stale: number; refused: number }>;
  needs_attention: ResultRow[];
  needs_attention_truncated: boolean;
  applied_sample: ResultRow[];
  sync?: { state?: string; note?: string };
  scope?: LabelScope;
  friendly?: string;
}

export interface ChangeSetListRow {
  change_set_id: string;
  kind: string;
  status: string;
  scope: LabelScope;
  accounts: number[];
  totals: ChangeSetView['totals'];
  commit: Record<string, unknown> | null;
  preview_actor: string | null;
  commit_actor: string | null;
  surface: string | null;
  undoes: string | null;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
}

export interface ChangeSetListPage {
  ok: true;
  state: LabelsServiceState;
  account: number;
  rows: ChangeSetListRow[];
  has_more: boolean;
  next_before: string | null;
  limit: number;
}

export interface DisplayNameAnswer {
  ok: true;
  state: LabelsServiceState;
  account: number;
  entity: LabelEntity;
  field: string;
  display_name: string | null;
  removed?: boolean;
  friendly?: string;
}

/** Previews and commits can touch a thousand items across several accounts: more room than a read. */
const WRITE_TIMEOUT_MS = 60_000;

const withTimeout = (opts: LabelsClientOptions): LabelsClientOptions => ({ timeoutMs: WRITE_TIMEOUT_MS, ...opts });

/**
 * Who is driving, for the change's record: caller-attested labels from the same environment
 * variables the Amazon Ads writes use. Omitted when unset, empty or longer than the service takes.
 */
export function attestation(env: NodeJS.ProcessEnv = process.env): { skill_id?: string; model_id?: string } {
  const skill = env.MIXSHIFT_SKILL_ID?.trim();
  const model = env.MIXSHIFT_MODEL_ID?.trim();
  return {
    ...(skill && skill.length <= 128 ? { skill_id: skill } : {}),
    ...(model && model.length <= 255 ? { model_id: model } : {}),
  };
}

function toView(json: unknown, httpStatus: number, what: string): ChangeSetView | LabelsFailure {
  const j = json as Record<string, unknown>;
  if (!isState(j?.state) || typeof j.change_set_id !== 'string' || typeof j.status !== 'string') return unrecognizedShape(httpStatus, what);
  return {
    ...(j as unknown as ChangeSetView),
    ok: true,
    accounts: Array.isArray(j.accounts) ? (j.accounts as ChangeSetAccountRow[]) : [],
    warnings: Array.isArray(j.warnings) ? (j.warnings as ChangeSetWarning[]) : [],
    sample: Array.isArray(j.sample) ? (j.sample as ChangeSetSampleRow[]) : [],
    can_commit: j.can_commit === true,
    totals: (j.totals as ChangeSetView['totals']) ?? null,
    dropped: (j.dropped as ChangeSetView['dropped']) ?? null,
  };
}

/** Build a change set from a selection and the fields to set (a value) or clear (null). Changes nothing. */
export async function labelsPreview(
  input: { account: string; entity: LabelEntity; selection: LabelsSelection; set?: Readonly<Record<string, string | null>>; scope?: LabelScope },
  opts: LabelsClientOptions = {},
): Promise<ChangeSetView | LabelsFailure> {
  const body = {
    account: Number(input.account),
    entity: input.entity,
    selection: input.selection,
    ...(input.set !== undefined ? { set: input.set } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...attestation(),
  };
  const r = await labelsRequest({ method: 'POST', path: '/api/labels/changes/preview', body }, withTimeout(opts));
  if (!r.ok) return r;
  return toView(r.json, r.httpStatus, 'preview');
}

/** Apply exactly one previewed change set. The caller has already been told, and has confirmed. */
export async function labelsCommit(
  input: { changeSetId: string; approvalHash: string },
  opts: LabelsClientOptions = {},
): Promise<({ ok: true; state: LabelsServiceState } & CommitBody) | LabelsFailure> {
  const r = await labelsRequest(
    { method: 'POST', path: `/api/labels/changes/${encodeURIComponent(input.changeSetId)}/commit`, body: { approval_hash: input.approvalHash, ...attestation() } },
    withTimeout(opts),
  );
  if (!r.ok) return r;
  const j = r.json as Record<string, unknown>;
  if (!isState(j?.state) || typeof j.change_set_id !== 'string' || typeof j.counts !== 'object' || j.counts === null) return unrecognizedShape(r.httpStatus, 'commit');
  return { ...(j as unknown as { state: LabelsServiceState } & CommitBody), ok: true };
}

/** The change sets that reach one account, newest first, a page at a time. */
export async function labelsChangeSets(
  input: { account: string; limit?: number; before?: string },
  opts: LabelsClientOptions = {},
): Promise<ChangeSetListPage | LabelsFailure> {
  const r = await labelsRequest({ method: 'GET', path: `/api/labels/changes/sets${query({ account: input.account, limit: input.limit, before: input.before })}` }, opts);
  if (!r.ok) return r;
  const j = r.json as Record<string, unknown>;
  if (!isState(j?.state) || !Array.isArray(j.change_sets)) return unrecognizedShape(r.httpStatus, 'change sets');
  const next = typeof j.next_before === 'string' && j.next_before ? j.next_before : null;
  return {
    ok: true,
    state: j.state,
    account: Number(j.account),
    rows: j.change_sets as ChangeSetListRow[],
    has_more: j.has_more === true && next !== null,
    next_before: next,
    limit: Number(j.limit ?? input.limit ?? 0),
  };
}

/** One change set: the preview, or what happened. */
export async function labelsChangeSet(id: string, opts: LabelsClientOptions = {}): Promise<ChangeSetView | LabelsFailure> {
  const r = await labelsRequest({ method: 'GET', path: `/api/labels/changes/sets/${encodeURIComponent(id)}` }, opts);
  if (!r.ok) return r;
  return toView(r.json, r.httpStatus, 'change set');
}

/** Cancel a preview. Nothing was changed by it, and nothing is. */
export async function labelsCancel(
  id: string,
  opts: LabelsClientOptions = {},
): Promise<{ ok: true; state: LabelsServiceState; change_set_id: string; status: string; friendly?: string } | LabelsFailure> {
  const r = await labelsRequest({ method: 'POST', path: `/api/labels/changes/sets/${encodeURIComponent(id)}/cancel` }, opts);
  if (!r.ok) return r;
  const j = r.json as Record<string, unknown>;
  if (!isState(j?.state) || typeof j.change_set_id !== 'string') return unrecognizedShape(r.httpStatus, 'cancel');
  return { ok: true, state: j.state, change_set_id: j.change_set_id, status: String(j.status ?? 'cancelled'), ...(typeof j.friendly === 'string' ? { friendly: j.friendly } : {}) };
}

/** A NEW preview that sets each field back to the value it had before a committed change set. Changes nothing. */
export async function labelsUndo(id: string, opts: LabelsClientOptions = {}): Promise<ChangeSetView | LabelsFailure> {
  const r = await labelsRequest({ method: 'POST', path: `/api/labels/changes/sets/${encodeURIComponent(id)}/undo`, body: { ...attestation() } }, withTimeout(opts));
  if (!r.ok) return r;
  return toView(r.json, r.httpStatus, 'undo');
}

/** Give one account's field its own display name. Takes effect now (there is no preview). */
export async function labelsSetFieldName(
  input: { account: string; entity: LabelEntity; field: string; name: string },
  opts: LabelsClientOptions = {},
): Promise<DisplayNameAnswer | LabelsFailure> {
  const r = await labelsRequest({ method: 'PUT', path: '/api/labels/fields/names', body: { account: Number(input.account), entity: input.entity, field: input.field, name: input.name } }, opts);
  if (!r.ok) return r;
  return toName(r.json, r.httpStatus);
}

/** Remove that name: the field shows its standard name again. */
export async function labelsRemoveFieldName(
  input: { account: string; entity: LabelEntity; field: string },
  opts: LabelsClientOptions = {},
): Promise<DisplayNameAnswer | LabelsFailure> {
  const r = await labelsRequest({ method: 'DELETE', path: `/api/labels/fields/names${query({ account: input.account, entity: input.entity, field: input.field })}` }, opts);
  if (!r.ok) return r;
  return toName(r.json, r.httpStatus);
}

function toName(json: unknown, httpStatus: number): DisplayNameAnswer | LabelsFailure {
  const j = json as Record<string, unknown>;
  if (!isState(j?.state) || typeof j.field !== 'string') return unrecognizedShape(httpStatus, 'field name');
  return {
    ok: true,
    state: j.state,
    account: Number(j.account),
    entity: j.entity as LabelEntity,
    field: j.field,
    display_name: typeof j.display_name === 'string' ? j.display_name : null,
    ...(typeof j.removed === 'boolean' ? { removed: j.removed } : {}),
    ...(typeof j.friendly === 'string' ? { friendly: j.friendly } : {}),
  };
}
