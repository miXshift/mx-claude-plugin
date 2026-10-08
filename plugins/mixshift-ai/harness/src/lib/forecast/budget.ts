/**
 * Forecast budgets: a person's own monthly sponsored-ads budget for one forecast
 * scope, written to the gateway's forecasting app state (D-096 step 4, slice 5).
 *
 * The gateway is the one home for forecast state (D-090): the forecasting app and
 * the gateway's computed forecast both read the same month rows. A budget is the
 * `adBudget` field of the month row `fb:override:<scopeId>:<YYYY-MM-01>`; the
 * computed forecast (FCT-BASELINE-01, `source: computed`) uses a row whose
 * `adBudget.mode` is `replace` as that month's planned spend instead of the
 * estimate it would carry from history, and its cache key moves with the rows, so
 * the next run honours a budget the moment it is written.
 *
 * Wire contract (mx-legacy-auth docs/app-state-service.md, LIVE 2026-10-08), with
 * the signed-in person's own token holding `corrections:write` (plugin sessions hold
 * it by the grandfathered set):
 *
 *   GET  /api/app-state/forecasting/docs?prefix=fb:override:<scopeId>:&after=&limit=
 *     -> 200 { ok, docs:[{ key, kind, version, doc, updated_at, updated_by }], next_after }
 *   POST /api/app-state/forecasting/batch  { writes:[{ key, expected_version, doc }], reason? }
 *     -> 200 { ok, results:[{ key, version, changed }] }
 *     |  409 { ok:false, kind:'conflict', conflicts:[{ key, expected, actual }] }   nothing written
 *     |  409 state_home_elsewhere | 403 insufficient_scope | scope_not_yours | merchant_not_connected
 *     |  400 bad_params | too_large
 *
 * A month row carries more than the budget (corrected sales, ad spend, status, a
 * note); a write here changes the budget (and the note, when one is given) and
 * keeps every other field exactly as stored. The person is the actor on the row,
 * in its history and in the change log the app shows; the gateway stamps it.
 *
 * Sponsored only: the computed forecast's spend basis is sponsored ad spend
 * (`spend_basis: ads_only`), so a budget that includes DSP is entered without it.
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';
import { networkErrorMessage } from '../net/classify.js';
import { resolveApiBaseHost } from '../net/api-base.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One month's budget as the person gave it. `month` is `YYYY-MM`. */
export interface BudgetEntry {
  month: string;
  amount: number;
}

/** The most months one `set` writes: a year of horizon plus the month in progress, with room. */
export const MAX_BUDGET_MONTHS = 24;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
/**
 * Account scope `src:<schema>:<seller>` only. A sub-brand scope (`...:scope:<key>`) is
 * the forecasting app's: the computed forecast never serves one, so a budget there
 * could only ever be wrong (red team 2026-10-08).
 */
const SCOPE_RE = /^src:([A-Za-z0-9_]+):(\d+)$/;
const SUB_BRAND_RE = /^src:[A-Za-z0-9_]+:\d+:scope:/;

/** The scope id as the gateway stores it (schema lowercased), or null when it is not an account scope. */
export function canonicalScopeId(raw: string): string | null {
  const m = SCOPE_RE.exec(raw.trim());
  if (!m) return null;
  return `src:${m[1]!.toLowerCase()}:${Number(m[2])}`;
}

/** A sub-brand scope, which this command refuses with its own sentence. */
export function isSubBrandScope(raw: string): boolean {
  return SUB_BRAND_RE.test(raw.trim());
}

/** The largest monthly budget accepted: a sanity bound, far above any real account. */
export const MAX_BUDGET_AMOUNT = 1_000_000_000;
/** A plain amount, or one with thousands grouped by commas; up to two decimals. */
const AMOUNT_RE = /^(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/;

/**
 * A note as the app's change log can show it: plain text (new lines allowed), no
 * control, bidi or zero-width characters (the gateway's own unsafe-text rule, less
 * the new line), at most 2,000 characters.
 */
const NOTE_UNSAFE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
export const NOTE_MAX = 2000;
export function noteProblem(note: string): string | null {
  if (note.length > NOTE_MAX) return `a note is at most ${NOTE_MAX} characters`;
  if (NOTE_UNSAFE_RE.test(note)) return 'a note is plain text: no control, direction or zero-width characters';
  return null;
}

/**
 * Parse `YYYY-MM=amount` pairs. Amounts may carry a `$` and thousands commas; they
 * must be finite and not negative. A month given twice keeps its last amount.
 * Throws an Error whose message is safe to print.
 */
export function parseBudgetEntries(values: readonly string[]): BudgetEntry[] {
  if (values.length === 0) throw new Error('Give at least one month: --set YYYY-MM=amount (repeat --set per month).');
  const byMonth = new Map<string, number>();
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq < 0) throw new Error(`"${raw}" is not YYYY-MM=amount (e.g. --set 2026-10=50000).`);
    const month = raw.slice(0, eq).trim();
    const given = raw.slice(eq + 1).trim();
    const amountText = given.replace(/^\$/, '');
    if (!MONTH_RE.test(month)) throw new Error(`"${month}" is not a month; write it as YYYY-MM (e.g. 2026-10).`);
    // Commas only as thousands separators: "50,000" is fifty thousand, "50,00" is refused
    // (a decimal comma would otherwise read a hundred times too large).
    if (!AMOUNT_RE.test(amountText)) {
      throw new Error(`"${given}" for ${month} is not an amount; write a number such as 50000, 50,000 or 50000.50.`);
    }
    const amount = Number(amountText.replace(/,/g, ''));
    if (amount > MAX_BUDGET_AMOUNT) throw new Error(`${given} for ${month} is larger than any monthly budget this accepts (${MAX_BUDGET_AMOUNT.toLocaleString('en-US')}).`);
    byMonth.set(month, amount);
  }
  if (byMonth.size > MAX_BUDGET_MONTHS) throw new Error(`At most ${MAX_BUDGET_MONTHS} months per call; ${byMonth.size} were given.`);
  return [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([month, amount]) => ({ month, amount }));
}

/** Parse `YYYY-MM` months for `clear`. */
export function parseMonths(values: readonly string[]): string[] {
  if (values.length === 0) throw new Error('Give at least one month: --month YYYY-MM (repeat per month).');
  const out = new Set<string>();
  for (const raw of values) {
    const month = raw.trim();
    if (!MONTH_RE.test(month)) throw new Error(`"${raw}" is not a month; write it as YYYY-MM (e.g. 2026-10).`);
    out.add(month);
  }
  if (out.size > MAX_BUDGET_MONTHS) throw new Error(`At most ${MAX_BUDGET_MONTHS} months per call; ${out.size} were given.`);
  return [...out].sort();
}

/** `YYYY-MM` of a date, in UTC (the computed forecast takes the current month in UTC). */
export function utcMonth(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** The latest month any forecast can use: twelve months after the month in progress. */
export function lastUsableMonth(now: Date): string {
  const y = now.getUTCFullYear() + 1;
  return `${y}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Months past the furthest a forecast reaches (a 12-month horizon). */
export function beyondHorizon(months: readonly string[], now: Date): string[] {
  const last = lastUsableMonth(now);
  return months.filter((m) => m > last);
}

/** Months before the month in progress: a budget there cannot move a forecast. */
export function pastMonths(months: readonly string[], now: Date): string[] {
  const current = utcMonth(now);
  return months.filter((m) => m < current);
}

// ---------------------------------------------------------------------------
// Month rows
// ---------------------------------------------------------------------------

/** A stored month row as the docs endpoint returns it. */
export interface StoredMonthRow {
  key: string;
  version: number;
  doc: Record<string, unknown>;
  updated_at?: string | null;
  updated_by?: string | null;
}

export function monthKey(scopeId: string, month: string): string {
  return `fb:override:${scopeId}:${month}-01`;
}

export function monthPrefix(scopeId: string): string {
  return `fb:override:${scopeId}:`;
}

const INHERIT = { mode: 'inherit', value: null, sourceObserved: null } as const;
/** Fields the gateway stamps on a row; never sent back. */
const STAMPED = new Set(['version', 'updatedAt', 'actor']);

/** The budget a stored row holds, or null when it inherits (no budget entered). */
export function budgetOf(doc: Record<string, unknown> | null | undefined): number | null {
  const b = doc?.adBudget as { mode?: unknown; value?: unknown } | undefined;
  return b && b.mode === 'replace' && typeof b.value === 'number' ? b.value : null;
}

/** One write for the batch endpoint; `doc: null` deletes the row. */
export interface MonthRowWrite {
  key: string;
  expected_version: number;
  doc: Record<string, unknown> | null;
}

/** The month a key holds when it is exactly a month row of this scope (not a sub-brand's), else null. */
export function monthOfKey(scopeId: string, key: string): string | null {
  const prefix = monthPrefix(scopeId);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  return /^\d{4}-(0[1-9]|1[0-2])-01$/.test(rest) ? rest.slice(0, 7) : null;
}

function withoutStamps(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (!STAMPED.has(k)) out[k] = v;
  return out;
}

/**
 * The writes that set each month's budget, keeping every other field of a stored
 * row. A month whose stored budget and note already equal the request is left
 * out (nothing to write). `note` undefined keeps the stored note; a string
 * replaces it.
 */
export function planBudgetSet(
  scopeId: string,
  stored: ReadonlyMap<string, StoredMonthRow>,
  entries: readonly BudgetEntry[],
  note?: string,
): { writes: MonthRowWrite[]; unchanged: string[]; notesKept: string[] } {
  const writes: MonthRowWrite[] = [];
  const unchanged: string[] = [];
  const notesKept: string[] = [];
  for (const e of entries) {
    const key = monthKey(scopeId, e.month);
    const row = stored.get(key);
    if (row) {
      // A month's note usually explains another correction (a stockout, a one-off);
      // the app's change log does not record a note that changes beside a budget, so
      // an existing note is never overwritten here (red team 2026-10-08, P1).
      const storedNote = typeof row.doc.note === 'string' && row.doc.note.trim() !== '' ? row.doc.note : null;
      const writeNote = note !== undefined && storedNote === null;
      if (note !== undefined && storedNote !== null && storedNote !== note) notesKept.push(e.month);
      const sameBudget = budgetOf(row.doc) === e.amount;
      if (sameBudget && !writeNote) {
        unchanged.push(e.month);
        continue;
      }
      const storedBudget = row.doc.adBudget && typeof row.doc.adBudget === 'object' ? (row.doc.adBudget as Record<string, unknown>) : {};
      writes.push({
        key,
        expected_version: row.version,
        doc: {
          ...withoutStamps(row.doc),
          // Keep any field the app keeps on the budget that this build does not know.
          adBudget: { ...storedBudget, mode: 'replace', value: e.amount },
          ...(writeNote ? { note } : {}),
        },
      });
    } else {
      writes.push({
        key,
        expected_version: 0,
        doc: {
          scopeId,
          month: `${e.month}-01`,
          sales: { ...INHERIT },
          adSpend: { ...INHERIT },
          adBudget: { mode: 'replace', value: e.amount },
          status: 'auto',
          note: note ?? null,
        },
      });
    }
  }
  return { writes, unchanged, notesKept };
}

/** A row that, with its budget cleared, holds nothing: every field the default and no other key. */
function isEmptyAfterClear(doc: Record<string, unknown>): boolean {
  const inherit = (f: unknown): boolean => f === undefined || (!!f && typeof f === 'object' && (f as { mode?: unknown }).mode === 'inherit');
  const known = new Set(['scopeId', 'month', 'sales', 'units', 'adSpend', 'adBudget', 'dspSpend', 'status', 'note', ...STAMPED]);
  if (Object.keys(doc).some((k) => !known.has(k))) return false;
  return (
    inherit(doc.sales) &&
    inherit(doc.units) &&
    inherit(doc.adSpend) &&
    inherit(doc.dspSpend) &&
    doc.status === 'auto' &&
    (doc.note === null || doc.note === undefined || doc.note === '')
  );
}

/**
 * The writes that take each month's budget back to the forecast's own estimate
 * (`adBudget` inherit), keeping every other field. A month with no stored budget is
 * reported, not written.
 */
export function planBudgetClear(
  scopeId: string,
  stored: ReadonlyMap<string, StoredMonthRow>,
  months: readonly string[],
): { writes: MonthRowWrite[]; notSet: string[] } {
  const writes: MonthRowWrite[] = [];
  const notSet: string[] = [];
  for (const month of months) {
    const key = monthKey(scopeId, month);
    const row = stored.get(key);
    if (!row || budgetOf(row.doc) === null) {
      notSet.push(month);
      continue;
    }
    // A row that held only this budget is removed rather than left as an empty row.
    writes.push({
      key,
      expected_version: row.version,
      doc: isEmptyAfterClear(row.doc) ? null : { ...withoutStamps(row.doc), adBudget: { mode: 'inherit', value: null } },
    });
  }
  return { writes, notSet };
}

/** The budget rows of a scope, in month order, for `show`. */
export function budgetRows(stored: ReadonlyMap<string, StoredMonthRow>): Array<{
  month: string;
  sponsored_budget: number;
  note: string | null;
  updated_at: string | null;
  updated_by: string | null;
}> {
  const out = [];
  for (const row of stored.values()) {
    const amount = budgetOf(row.doc);
    if (amount === null) continue;
    const month = typeof row.doc.month === 'string' ? row.doc.month.slice(0, 7) : row.key.slice(-10, -3);
    out.push({
      month,
      sponsored_budget: amount,
      note: typeof row.doc.note === 'string' ? row.doc.note : null,
      updated_at: row.updated_at ?? null,
      updated_by: row.updated_by ?? null,
    });
  }
  return out.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type BudgetFailureKind =
  // --- gateway ---
  | 'conflict' // a row changed between the read and the write; nothing written
  | 'state_home_elsewhere' // the database's forecast state lives under a login this one cannot use
  | 'scope_not_yours' // the scope names another database or a seller not connected here
  | 'merchant_not_connected'
  | 'insufficient_scope' // the sign-in lacks corrections:write (an older connector session)
  | 'bad_params'
  | 'too_large'
  | 'not_found'
  | 'throttled'
  | 'unavailable' // the gateway could not check the database's home login; retry
  // --- local ---
  | 'not_authenticated'
  | 'session_expired'
  | 'host_unreachable'
  | 'unknown';

const KNOWN: ReadonlySet<string> = new Set<BudgetFailureKind>([
  'conflict',
  'state_home_elsewhere',
  'scope_not_yours',
  'merchant_not_connected',
  'insufficient_scope',
  'bad_params',
  'too_large',
  'not_found',
  'throttled',
  'unavailable',
]);

export interface BudgetFailure {
  ok: false;
  kind: BudgetFailureKind;
  /** Safe to print verbatim. */
  friendly: string;
  httpStatus?: number;
  /** Set when the gateway sent a kind this build does not know. */
  unrecognizedKind?: string;
}

export interface BudgetClientOptions {
  dataDirOverride?: string;
  apiBaseOverride?: string;
  tokenProvider?: (forceRefresh?: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE = 500;
/** The change-log reason the app shows beside each field this writes. */
export const BUDGET_REASON = 'Budget entered with the MixShift plugin';

function friendlyFor(kind: BudgetFailureKind): string {
  switch (kind) {
    case 'conflict':
      return 'A month row changed while this was being saved; nothing was written. Run the command again.';
    case 'state_home_elsewhere':
      return "This account's forecast state lives under another MixShift login that this sign-in cannot write through. Ask MixShift support to check the account's logins.";
    case 'scope_not_yours':
    case 'merchant_not_connected':
      return 'That forecast scope is not one of the accounts this sign-in reaches. Use the scope_id from the forecast answer for an account you are signed in to.';
    case 'insufficient_scope':
      return 'This sign-in cannot write forecast budgets. Sign in again (`mixshift auth login`), or reconnect the MixShift connector, to pick up the permission.';
    case 'bad_params':
      return 'The gateway refused the budget rows as malformed.';
    case 'too_large':
      return 'Too many months in one call.';
    case 'not_found':
      return 'Nothing is stored for that month.';
    case 'throttled':
      return 'The MixShift service is rate limiting requests; try again in a minute.';
    case 'unavailable':
      return 'The MixShift service could not check where this account\'s forecast state lives; nothing was written. Try again in a minute.';
    case 'not_authenticated':
      return "You're not signed in to MixShift. Run `mixshift auth login` first.";
    case 'session_expired':
      return 'Your MixShift session expired. Run `mixshift auth login` to re-authenticate.';
    case 'host_unreachable':
      return 'The MixShift service is unreachable. Check your network or try again in a minute.';
    default:
      return 'The MixShift service answered with an error.';
  }
}

function failure(kind: BudgetFailureKind, extra: Partial<BudgetFailure> = {}): BudgetFailure {
  return { ok: false, kind, friendly: friendlyFor(kind), ...extra };
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown> | undefined,
  opts: BudgetClientOptions,
): Promise<{ ok: true; json: Record<string, unknown> } | BudgetFailure> {
  let apiBase = opts.apiBaseOverride;
  if (!apiBase) {
    const { credentials } = await loadCredentials(opts.dataDirOverride);
    apiBase = credentials?.datahub?.api_base ?? credentials?.service?.api_base;
    if (!apiBase) return failure('not_authenticated');
  }
  const tokenProvider =
    opts.tokenProvider ?? ((force?: boolean) => getValidAccessToken(opts.dataDirOverride, force));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const send = async (bearer: string): Promise<{ res: Response } | { fail: BudgetFailure }> => {
    try {
      const res = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...intentHeader(),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { res };
    } catch (err) {
      return { fail: failure('host_unreachable', { friendly: networkErrorMessage(err, resolveApiBaseHost(apiBase)) }) };
    }
  };

  let token: string;
  try {
    token = await tokenProvider(false);
  } catch (err) {
    return failure(/expired|refresh/i.test(err instanceof Error ? err.message : String(err)) ? 'session_expired' : 'not_authenticated');
  }
  let sent = await send(token);
  if ('fail' in sent) return sent.fail;
  let response = sent.res;
  // A mid-session 401: refresh once and retry, as every other gateway surface does.
  if (response.status === 401) {
    try {
      token = await tokenProvider(true);
    } catch {
      return failure('session_expired');
    }
    sent = await send(token);
    if ('fail' in sent) return sent.fail;
    response = sent.res;
    if (response.status === 401) return failure('session_expired', { httpStatus: 401 });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return failure(response.status === 429 ? 'throttled' : 'unknown', { httpStatus: response.status });
  }
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (obj.ok === false || !response.ok) {
    const raw = typeof obj.kind === 'string' ? obj.kind : '';
    const known = KNOWN.has(raw);
    const kind: BudgetFailureKind = known ? (raw as BudgetFailureKind) : response.status === 429 ? 'throttled' : 'unknown';
    const serverFriendly = typeof obj.friendly === 'string' ? obj.friendly : undefined;
    return {
      ok: false,
      kind,
      // The gateway's own sentence is specific (which field, which key); prefer it.
      friendly: serverFriendly ?? friendlyFor(kind),
      httpStatus: response.status,
      ...(known ? {} : { unrecognizedKind: raw || '(absent)' }),
    };
  }
  return { ok: true, json: obj };
}

/** Every stored month row of a scope, keyed by row key. */
export async function readMonthRows(
  scopeId: string,
  opts: BudgetClientOptions = {},
): Promise<{ ok: true; rows: Map<string, StoredMonthRow> } | BudgetFailure> {
  const rows = new Map<string, StoredMonthRow>();
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ prefix: monthPrefix(scopeId), limit: String(PAGE) });
    if (after) q.set('after', after);
    const r = await request('GET', `/api/app-state/forecasting/docs?${q.toString()}`, undefined, opts);
    if (!r.ok) return r;
    const docs = Array.isArray(r.json.docs) ? (r.json.docs as StoredMonthRow[]) : [];
    for (const d of docs) {
      // The prefix also matches a sub-brand's rows (`<scope>:scope:<key>:<month>`); only this scope's months count.
      if (d && typeof d.key === 'string' && monthOfKey(scopeId, d.key) && typeof d.version === 'number' && d.doc && typeof d.doc === 'object') rows.set(d.key, d);
    }
    after = typeof r.json.next_after === 'string' && r.json.next_after ? r.json.next_after : null;
    if (!after || docs.length === 0) return { ok: true, rows };
  }
  return { ok: true, rows };
}

/** Write a batch: all or nothing. */
export async function writeMonthRows(
  writes: readonly MonthRowWrite[],
  opts: BudgetClientOptions = {},
): Promise<{ ok: true; results: Array<{ key: string; version: number | null; changed: boolean }> } | BudgetFailure> {
  const r = await request('POST', '/api/app-state/forecasting/batch', { writes, reason: BUDGET_REASON }, opts);
  if (!r.ok) return r;
  const results = Array.isArray(r.json.results) ? (r.json.results as Array<{ key: string; version: number | null; changed: boolean }>) : [];
  return { ok: true, results };
}

/**
 * Read, plan and write; on a conflict (a row changed between the read and the
 * write: the app or another session saved meanwhile) read again and re-plan ONCE,
 * so the other fields are taken from the fresh row and only the budget changes.
 */
export async function applyBudgetPlan<T extends { writes: MonthRowWrite[] }>(
  scopeId: string,
  plan: (rows: ReadonlyMap<string, StoredMonthRow>) => T,
  opts: BudgetClientOptions & { dryRun?: boolean } = {},
): Promise<{ ok: true; plan: T; written: number; current: Map<string, number | null> } | BudgetFailure> {
  let firstBudgets: Map<string, number | null> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await readMonthRows(scopeId, opts);
    if (!read.ok) return read;
    const planned = plan(read.rows);
    const current = new Map(planned.writes.map((w) => [w.key, budgetOf(read.rows.get(w.key)?.doc)]));
    if (firstBudgets) {
      // A retry only re-takes the OTHER fields from the fresh row; if the budget itself
      // changed meanwhile (someone saved one in the app), stop and say so.
      for (const [key, before] of firstBudgets) {
        const now = budgetOf(read.rows.get(key)?.doc);
        if (now !== before) {
          return failure('conflict', {
            friendly: `The budget for ${key.slice(-10, -3)} was changed while this was being saved (now ${now === null ? 'none' : now.toLocaleString('en-US')}); nothing was written. Check it and run the command again.`,
          });
        }
      }
    }
    if (opts.dryRun || planned.writes.length === 0) return { ok: true, plan: planned, written: 0, current };
    const w = await writeMonthRows(planned.writes, opts);
    if (w.ok) return { ok: true, plan: planned, written: w.results.filter((x) => x.changed).length, current };
    if (w.kind !== 'conflict' || attempt === 1) return w;
    firstBudgets = current;
  }
  return failure('conflict');
}
