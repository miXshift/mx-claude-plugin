/**
 * Plain-words rendering of a dayparting answer. Summary first: one sentence per proposed
 * window, then what was left out, then (only with --verbose) the hour and weekday tables.
 * Pure: takes the service's snake_case answer and returns text; nothing is read or written.
 *
 * The service's percentages (window_acos, baseline_acos, target_acos) are whole-number percents.
 * Money is in the profile's currency.
 */

import { defaultFriendly, type DaypartingFailure } from './client.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const NOTHING_CHANGED = 'Nothing was changed. This only reads; approving and scheduling windows arrives in a later release.';

/** "$1,200" for USD, "1,200 EUR" for anything else. Large amounts read "about", so they are rounded. */
export function formatMoney(amount: number, currency: string | null): string {
  const rounded = Math.abs(amount) >= 1000 ? Math.round(amount / 100) * 100 : Math.abs(amount) >= 100 ? Math.round(amount / 10) * 10 : Math.round(amount);
  const digits = Math.abs(rounded).toLocaleString('en-US');
  return !currency || currency === 'USD' ? `$${digits}` : `${digits} ${currency}`;
}

const pct = (n: number): string => `${Number.isInteger(n) ? n : Number(n.toFixed(1))}%`;

function sentenceCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** "Every day, midnight to 4 am (00:00 to 04:00)": the service's own words, plus the exact clock. */
function windowLabel(w: Obj | null): string {
  if (!w) return 'A window';
  const when = str(w.when);
  const from = str(w.from);
  const to = str(w.to);
  const clock = from && to ? `${from} to ${to}` : null;
  if (when) return sentenceCase(clock ? `${when} (${clock})` : when);
  const days = arr(w.days).map(String).join(', ');
  return sentenceCase([days, clock].filter(Boolean).join(' ') || 'a window');
}

/** One sentence for one proposed window. */
export function verdictLine(s: Obj, currency: string | null): string {
  const label = windowLabel(isObj(s.window) ? s.window : null);
  const windowAcos = num(s.window_acos);
  const target = num(s.target_acos);
  const baseline = num(s.baseline_acos);
  const multiplier = num(s.multiplier);
  const direction = s.direction === 'raise' ? 'raise' : 'cut';
  const parts: string[] = [];

  if (windowAcos !== null) {
    const against =
      target !== null ? ` against your ${pct(target)}` : baseline !== null ? ` against ${pct(baseline)} for the account overall` : '';
    parts.push(`${label} runs at ${pct(windowAcos)} ACOS${against}`);
  } else {
    parts.push(label);
  }

  if (multiplier !== null && multiplier > 0) {
    const change = Math.round(Math.abs(1 - multiplier) * 100);
    const money = isObj(s.money_at_stake) ? s.money_at_stake : null;
    const touched = money ? num(money.weekly_spend_touched) : null;
    const atRisk = money ? num(money.estimated_weekly_sales_at_risk) : null;
    let move = `a ${change}% bid ${direction}`;
    if (touched !== null) move += ` touches about ${formatMoney(touched, currency)} a week`;
    if (direction === 'cut' && atRisk !== null && atRisk > 0) move += ` and risks about ${formatMoney(atRisk, currency)} of sales`;
    parts.push(move);
  }

  const confidence = str(s.confidence);
  if (confidence) parts.push(`confidence ${confidence}`);
  return parts.join('; ');
}

function pctShare(v: unknown): string | null {
  const n = num(v);
  return n === null ? null : `${Math.round(n * 100)}%`;
}

/** The drivers in plain words, e.g. "conversion rate 60%, cost per click 30%, order value 10%". */
export function driversText(d: unknown): string | null {
  if (!isObj(d)) return null;
  const bits = [
    ['conversion rate', pctShare(d.cvr_share)],
    ['cost per click', pctShare(d.cpc_share)],
    ['order value', pctShare(d.aov_share)],
  ].filter((b): b is [string, string] => b[1] !== null);
  return bits.length > 0 ? bits.map(([name, share]) => `${name} ${share}`).join(', ') : null;
}

function sourceLine(source: unknown): string | null {
  if (!isObj(source)) return null;
  const state = str(source.state);
  const through = str(source.data_through);
  if (state === 'stale') return `The hourly feed is running behind${through ? ` (data through ${through})` : ''}. Windows read days that have matured, so a short lag changes little.`;
  if (state === 'unknown') return 'MixShift could not check how fresh the hourly feed is. The windows below still read the data it holds.';
  return null;
}

export interface RenderOptions {
  verbose?: boolean;
}

/** The whole human answer for `dayparting diagnose`. */
export function renderDiagnose(answer: Obj, opts: RenderOptions = {}): string {
  const out: string[] = [];
  const currency = str(answer.currency);
  const status = str(answer.status);
  const win = isObj(answer.window) ? answer.window : null;
  const zone = str(answer.time_zone);
  const range = win && str(win.from) && str(win.to) ? `${str(win.from)} to ${str(win.to)}` : null;

  if (status === 'no_rows') {
    out.push('No hourly data for this Ads profile in the window, so there is nothing to diagnose.');
  } else if (status === 'mixed_time_zones') {
    out.push('This profile reports in more than one time zone, so hours of the day cannot be compared. No windows were proposed.');
  } else {
    const suggestions = arr(answer.suggestions).filter(isObj);
    const head = `Dayparting diagnosis${range ? ` for ${range}` : ''}${zone ? `, in ${zone} time` : ''}`;
    out.push(head);
    out.push('');
    const proposed = suggestions.filter((s) => s.status !== 'held' && s.status !== 'insufficient_history');
    const held = suggestions.filter((s) => s.status === 'held' || s.status === 'insufficient_history');
    if (proposed.length === 0) {
      out.push(
        held.length > 0
          ? 'No window is ready to propose yet (see what is held, below).'
          : 'No window stands out. No time of day earns clearly less or more than the rest, so there is nothing worth changing.',
      );
    }
    for (const s of proposed) {
      out.push(`- ${verdictLine(s, currency)}`);
      if (opts.verbose) {
        const reason = str(s.reason);
        if (reason) out.push(`    Why: ${reason}`);
        const drivers = driversText(s.drivers);
        if (drivers) out.push(`    What drives it: ${drivers}`);
      }
    }
    if (held.length > 0) {
      out.push('');
      out.push('Held back:');
      for (const s of held) {
        const reason = str(s.held_reason) ?? (s.status === 'insufficient_history' ? 'not enough history yet' : 'held');
        out.push(`- ${windowLabel(isObj(s.window) ? s.window : null)}: ${reason}`);
      }
    }
  }

  const sourceNote = sourceLine(answer.source);
  if (sourceNote) out.push('', sourceNote);

  const unmapped = arr(answer.unmapped).filter(isObj);
  if (unmapped.length > 0) out.push('', `${unmapped.length} campaign${unmapped.length === 1 ? ' was' : 's were'} left out: ${unmapped.map((u) => str(u.reason) ?? 'no reason given').filter((v, i, a) => a.indexOf(v) === i).join(' ')}`);
  const rejected = arr(answer.rejected).filter(isObj);
  const rejectedTotal = rejected.reduce((n, r) => n + (num(r.count) ?? 0), 0);
  if (rejectedTotal > 0) out.push('', `${rejectedTotal} hourly rows were left out because a figure was missing (a missing figure is never read as zero).`);

  if (opts.verbose) {
    const notes = arr(answer.notes).map(String).filter(Boolean);
    if (notes.length > 0) out.push('', 'Notes:', ...notes.map((n) => `- ${n}`));
    const table = renderHourTable(answer);
    if (table) out.push('', table);
  }

  out.push('', NOTHING_CHANGED);
  return out.join('\n');
}

const dash = (v: unknown, f: (n: number) => string): string => {
  const n = num(v);
  return n === null ? '-' : f(n);
};

/** The compact hour and weekday tables (markdown), from the answer's `account` block. */
export function renderHourTable(answer: Obj): string | null {
  const account = isObj(answer.account) ? answer.account : null;
  if (!account) return null;
  const hours = arr(account.hours).filter(isObj);
  const weekdays = arr(account.weekdays).filter(isObj);
  if (hours.length === 0 && weekdays.length === 0) return null;
  const currency = str(answer.currency);
  const money = (n: number) => formatMoneyExact(n, currency);
  const row = (label: string, b: Obj) =>
    `| ${label} | ${dash(b.spend, money)} | ${dash(b.clicks, (n) => String(n))} | ${dash(b.orders, (n) => String(Number(n.toFixed(1))))} | ${dash(b.sales, money)} | ${dash(b.roas, (n) => n.toFixed(2))} | ${dash(b.spend_share, (n) => `${Math.round(n * 100)}%`)} |`;
  const header = (first: string) => `| ${first} | Spend | Clicks | Orders | Sales | ROAS | Share of spend |\n|---|---|---|---|---|---|---|`;
  const out: string[] = [];
  if (hours.length > 0) {
    out.push('By hour of the day:', header('Hour'), ...hours.map((h) => row(`${String(num(h.hour) ?? '?').padStart(2, '0')}:00`, h)));
  }
  if (weekdays.length > 0) {
    if (out.length > 0) out.push('');
    out.push('By day of the week:', header('Day'), ...weekdays.map((d) => row(String(d.weekday ?? '?'), d)));
  }
  out.push('', 'Spend and clicks read every complete day; orders, sales and ROAS read only days old enough for their sales to have arrived.');
  return out.join('\n');
}

function formatMoneyExact(n: number, currency: string | null): string {
  const digits = Math.round(n).toLocaleString('en-US');
  return !currency || currency === 'USD' ? `$${digits}` : `${digits} ${currency}`;
}

/** The human answer for `dayparting hours`: a roll-up by hour of the day over the rows the service returned. */
export function renderHours(answer: Obj): string {
  const rows = arr(answer.rows).filter(isObj);
  const zone = str(answer.time_zone);
  const out: string[] = [];
  out.push(`Hourly Ads data ${String(answer.from ?? '')} to ${String(answer.to ?? '')}${zone ? ` (${zone})` : ''}: ${rows.length} campaign-hour row${rows.length === 1 ? '' : 's'}.`);
  const currencies = [...new Set(rows.map((r) => str(r.currency)).filter((c): c is string => c !== null))];
  const currency = currencies.length === 1 ? currencies[0]! : null;
  if (rows.length > 0) {
    const byHour = new Map<number, { cost: number; clicks: number; sales: number; purchases: number }>();
    for (const r of rows) {
      const h = num(r.report_hour);
      if (h === null) continue;
      const b = byHour.get(h) ?? { cost: 0, clicks: 0, sales: 0, purchases: 0 };
      b.cost += num(r.cost) ?? 0;
      b.clicks += num(r.clicks) ?? 0;
      b.sales += num(r.sales) ?? 0;
      b.purchases += num(r.purchases) ?? 0;
      byHour.set(h, b);
    }
    out.push('', '| Hour | Spend | Clicks | Orders | Sales |', '|---|---|---|---|---|');
    for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
      const b = byHour.get(h)!;
      out.push(`| ${String(h).padStart(2, '0')}:00 | ${formatMoneyExact(b.cost, currency)} | ${b.clicks} | ${Number(b.purchases.toFixed(1))} | ${formatMoneyExact(b.sales, currency)} |`);
    }
    out.push('', 'Sales keep arriving for days after an hour, so the most recent days read lower than they will end up. `mixshift dayparting diagnose` reads only days old enough to be trusted.');
  }
  const source = sourceLine(answer.source);
  if (source) out.push('', source);
  const rejected = arr(answer.rejected).filter(isObj);
  const rejectedTotal = rejected.reduce((n, r) => n + (num(r.count) ?? 0), 0);
  if (rejectedTotal > 0) out.push('', `${rejectedTotal} of these rows would be left out of a diagnosis because a figure is missing.`);
  return out.join('\n');
}

/** What to do next, for a refusal kind. The friendly sentence from the service is printed first. */
export function nextStep(kind: string): string | null {
  switch (kind) {
    case 'source_not_enabled':
      return 'Hourly data comes from Amazon Marketing Stream, which MixShift turns on account by account. To ask for it, say "Using MixShift, ask to turn on Marketing Stream for our account".';
    case 'account_not_in_scope':
      return 'Marketing Stream is on for your organization but not for this Ads profile. To ask for it, say "Using MixShift, ask to add this Ads profile to Marketing Stream".';
    case 'source_not_current':
      return 'The hourly feed has lapsed or has not filled yet. Ask MixShift to check the Marketing Stream activation, then run this again.';
    case 'insufficient_scope':
    case 'account_limited':
    case 'not_a_member':
      return 'Sign in as yourself with `mixshift auth login`, or ask your org admin for access to Ads data.';
    case 'not_authenticated':
    case 'session_expired':
      return 'Run `mixshift auth login`, then try again.';
    case 'mx2_rate_limited':
    case 'mx2_unavailable':
    case 'host_unreachable':
      return 'Try again in a minute.';
    case 'too_many_rows':
      return 'Ask for a shorter window with --from and --to.';
    default:
      return null;
  }
}

/** The text printed to stderr for a refusal. */
export function renderFailure(f: DaypartingFailure): string {
  const next = nextStep(f.kind);
  const lines = [f.friendly || defaultFriendly(f.kind)];
  if (next) lines.push(next);
  return lines.join('\n');
}
