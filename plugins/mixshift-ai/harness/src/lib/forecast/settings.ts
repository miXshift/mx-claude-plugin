/**
 * The account settings a computed forecast stands on, as the gateway's
 * forecasting app state holds them (`fb:account:<scopeId>`, the app's own
 * `Account` record; the settings live under `settings`):
 *
 *   includeDspSpend           the DSP switch: the merchant's DSP spend by month joins
 *                             sponsored spend in the fit (spend_basis ads_plus_dsp)
 *   treatMissingAdSpendAsZero a month with sales and no ad rows trains as zero spend
 *
 * A person writes `{ settings: { <name>: boolean } }` on `corrections:write`; the
 * gateway merges it over the stored record key by key and refuses anything else, so
 * this never touches the app's own fields. Same client as the budget store
 * (`appStateRequest`): the sign-in's token, one refresh on a 401, the same failure
 * kinds and words.
 */
import { appStateRequest, type BudgetClientOptions, type BudgetFailure } from './budget.js';

export const SETTING_NAMES = ['includeDspSpend', 'treatMissingAdSpendAsZero'] as const;
export type SettingName = (typeof SETTING_NAMES)[number];
export type AccountSettings = Partial<Record<SettingName, boolean>>;

/** The change-log reason the app shows beside the change. */
export const SETTINGS_REASON = 'Forecast setting changed with the MixShift plugin';

export function accountKey(scopeId: string): string {
  return `fb:account:${scopeId}`;
}

/** `on`/`off` (also true/false, yes/no, 1/0); anything else is refused with the flag named. */
export function parseOnOff(raw: string, flag: string): boolean {
  const v = raw.trim().toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(v)) return true;
  if (['off', 'false', 'no', '0'].includes(v)) return false;
  throw new Error(`${flag} takes on or off (got "${raw}").`);
}

export interface StoredAccount {
  /** 0 when no record exists yet (the first write creates it). */
  version: number;
  settings: AccountSettings;
  /** Whether a record exists at all (the app writes one when it first publishes). */
  exists: boolean;
}

/** Only the booleans under `settings` with a known name; anything else is not a setting. */
export function settingsOf(doc: unknown): AccountSettings {
  const out: AccountSettings = {};
  const settings = (doc as { settings?: unknown } | null | undefined)?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return out;
  for (const name of SETTING_NAMES) {
    const v = (settings as Record<string, unknown>)[name];
    if (typeof v === 'boolean') out[name] = v;
  }
  return out;
}

/** The scope's account record, or an empty one at version 0. */
export async function readAccountSettings(scopeId: string, opts: BudgetClientOptions = {}): Promise<{ ok: true; account: StoredAccount } | BudgetFailure> {
  const key = accountKey(scopeId);
  // The prefix also matches a sub-brand's record (`<scope>:scope:<key>`); only the exact key counts.
  const q = new URLSearchParams({ prefix: key, limit: '50' });
  const r = await appStateRequest('GET', `/api/app-state/forecasting/docs?${q.toString()}`, undefined, opts);
  if (!r.ok) return r;
  const docs = Array.isArray(r.json.docs) ? (r.json.docs as Array<{ key?: unknown; version?: unknown; doc?: unknown }>) : [];
  const row = docs.find((d) => d && d.key === key);
  if (!row) return { ok: true, account: { version: 0, settings: {}, exists: false } };
  const version = typeof row.version === 'number' && Number.isInteger(row.version) && row.version >= 0 ? row.version : 0;
  return { ok: true, account: { version, settings: settingsOf(row.doc), exists: true } };
}

export interface SettingsPlan {
  /** Names whose value changes; empty means nothing to write. */
  changed: SettingName[];
  /** Names already holding the requested value. */
  unchanged: SettingName[];
  writes: Array<{ key: string; expected_version: number; doc: { settings: AccountSettings } }>;
}

/** What one write would change; only the names in `patch` are sent, so the app's other settings are untouched. */
export function planSettings(scopeId: string, account: StoredAccount, patch: AccountSettings): SettingsPlan {
  const changed: SettingName[] = [];
  const unchanged: SettingName[] = [];
  const settings: AccountSettings = {};
  for (const name of SETTING_NAMES) {
    const want = patch[name];
    if (want === undefined) continue;
    if (account.settings[name] === want) unchanged.push(name);
    else {
      changed.push(name);
      settings[name] = want;
    }
  }
  return { changed, unchanged, writes: changed.length === 0 ? [] : [{ key: accountKey(scopeId), expected_version: account.version, doc: { settings } }] };
}

export interface SettingsResult {
  ok: true;
  before: AccountSettings;
  after: AccountSettings;
  changed: SettingName[];
  unchanged: SettingName[];
  /** The record's version after the write (unchanged on a dry run or when nothing changed). */
  version: number;
  written: boolean;
}

/**
 * Read, plan, write; on a conflict (the app or another session saved the record
 * meanwhile) read again and re-plan ONCE: a setting that already reads the
 * requested value then counts as unchanged, and only the rest is written.
 */
export async function applySettings(scopeId: string, patch: AccountSettings, opts: BudgetClientOptions & { dryRun?: boolean } = {}): Promise<SettingsResult | BudgetFailure> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await readAccountSettings(scopeId, opts);
    if (!read.ok) return read;
    const plan = planSettings(scopeId, read.account, patch);
    const after = { ...read.account.settings, ...patch };
    if (opts.dryRun || plan.writes.length === 0) {
      return { ok: true, before: read.account.settings, after, changed: plan.changed, unchanged: plan.unchanged, version: read.account.version, written: false };
    }
    const w = await appStateRequest('POST', '/api/app-state/forecasting/batch', { writes: plan.writes, reason: SETTINGS_REASON }, opts);
    if (w.ok) {
      const results = Array.isArray(w.json.results) ? (w.json.results as Array<{ key?: unknown; version?: unknown }>) : [];
      const v = results.find((x) => x && x.key === accountKey(scopeId))?.version;
      return { ok: true, before: read.account.settings, after, changed: plan.changed, unchanged: plan.unchanged, version: typeof v === 'number' ? v : read.account.version + 1, written: true };
    }
    if (w.kind !== 'conflict' || attempt === 1) return w;
  }
  return { ok: false, kind: 'conflict', friendly: 'The forecast settings changed while this was being saved; nothing was written. Run the command again.' };
}
