/**
 * Forecasting-service answers (FCT-TRACK-01, FCT-BASELINE-01, FCT-READINESS-01)
 * as `mixshift intelligence run` / `get` receive them: a one-line summary for
 * the CLI headline, and the fields `intelligence.run_retrieved` adds for them
 * so MixShift can tell what each person's forecast request got.
 *
 * TRACK and BASELINE answers carry no Intelligence `meta` envelope, so the
 * generic headline (headline.ts) can say nothing about them on its own. This
 * module reads the few top-level fields that say what the run got.
 *
 * PRIVACY: every value returned is a short label, a boolean, a count, an id
 * shape we control (scope id, report month) or the served vintage number. It
 * never returns a forecast figure (nothing is read from `report_data` or
 * `figures` beyond whether it is present) and never the service's free text
 * (`friendly`, `limitations`, `detail`). A value that does not match its
 * expected shape is dropped, not truncated.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True for any answer from the forecasting service (`service: 'forecasting'`). */
export function isForecastingAnswer(result: unknown): result is Rec {
  return isRec(result) && result.service === 'forecasting';
}

const LABEL_RE = /^[A-Za-z0-9_-]{1,48}$/;
const SCOPE_ID_RE = /^src:[A-Za-z0-9_]+:[0-9]+(:scope:[a-z0-9]{4,32})?$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A short snake_case label (state, reason, kind, verdict), or undefined. */
export function boundedLabel(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return LABEL_RE.test(t) ? t.toLowerCase().replace(/-/g, '_') : undefined;
}

/** A forecasting scope id (`src:<schema>:<seller>[:scope:<key>]`), or undefined. */
export function boundedScopeId(v: unknown): string | undefined {
  return typeof v === 'string' && SCOPE_ID_RE.test(v) ? v : undefined;
}

/** A report month (`YYYY-MM`), or undefined. */
export function boundedMonth(v: unknown): string | undefined {
  return typeof v === 'string' && MONTH_RE.test(v) ? v : undefined;
}

function boundedCount(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
}

export interface ForecastAnswerSummary {
  /** 'track' | 'baseline' | 'readiness', or another label the service sent. */
  kind?: string;
  /** TRACK: provided_current | stale | not_provided. */
  forecastState?: string;
  /** BASELINE: whether a published baseline was served. */
  available?: boolean;
  /** READINESS: below_floor | floor | recommended. */
  verdict?: string;
  reason?: string;
  metric?: string;
  month?: string;
  scopeId?: string;
  /** The served copy's vintage (published.gateway_revision). */
  vintage?: number;
  /** Age of the served copy in days (published.age_days). */
  vintageAgeDays?: number;
  ytdRunsPastReportMonth?: boolean;
  /** TRACK: whether the answer carried a report_data object. */
  hasReportData?: boolean;
  /** True only when the person got a forecast: TRACK provided_current with
   *  report_data, or BASELINE available. */
  served: boolean;
}

/** Normalise a forecasting answer to bounded fields; undefined for any other answer. */
export function summarizeForecastAnswer(result: unknown): ForecastAnswerSummary | undefined {
  if (!isForecastingAnswer(result)) return undefined;
  const kind = boundedLabel(result.kind);
  const pub = isRec(result.published) ? result.published : undefined;
  const vintage = pub ? boundedCount(pub.gateway_revision, 1_000_000) : undefined;
  const age = pub ? boundedCount(pub.age_days, 100_000) : undefined;
  const s: ForecastAnswerSummary = { served: false };
  if (kind !== undefined) s.kind = kind;
  if (kind === 'track') {
    const state = boundedLabel(result.forecast_state);
    if (state !== undefined) s.forecastState = state;
    s.hasReportData = isRec(result.report_data);
    if (typeof result.ytd_runs_past_report_month === 'boolean') {
      s.ytdRunsPastReportMonth = result.ytd_runs_past_report_month;
    }
    s.served = state === 'provided_current' && s.hasReportData;
  } else if (kind === 'baseline') {
    if (typeof result.available === 'boolean') s.available = result.available;
    s.served = result.available === true;
  } else if (kind === 'readiness') {
    const verdict = boundedLabel(result.verdict);
    if (verdict !== undefined) s.verdict = verdict;
  }
  const reason = boundedLabel(result.reason);
  if (reason !== undefined) s.reason = reason;
  const metric = boundedLabel(result.metric);
  if (metric !== undefined) s.metric = metric;
  const month = boundedMonth(result.month);
  if (month !== undefined) s.month = month;
  const scopeId = boundedScopeId(result.scope_id);
  if (scopeId !== undefined) s.scopeId = scopeId;
  if (vintage !== undefined) s.vintage = vintage;
  if (age !== undefined) s.vintageAgeDays = age;
  return s;
}

/**
 * The fields `intelligence.run_retrieved` adds for a forecasting answer; `{}`
 * for every other answer, so existing events are unchanged. Keys with no
 * value are left out.
 */
export function forecastTelemetryFields(result: unknown): Record<string, unknown> {
  const s = summarizeForecastAnswer(result);
  if (!s) return {};
  const out: Record<string, unknown> = { service: 'forecasting' };
  const put = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  put('kind', s.kind);
  put('forecast_state', s.forecastState);
  put('available', s.available);
  put('verdict', s.verdict);
  put('reason', s.reason);
  put('metric', s.metric);
  put('month', s.month);
  put('scope_id', s.scopeId);
  put('vintage', s.vintage);
  put('vintage_age_days', s.vintageAgeDays);
  put('ytd_runs_past_report_month', s.ytdRunsPastReportMonth);
  out.served = s.served;
  return out;
}

function vintagePhrase(s: ForecastAnswerSummary): string {
  if (s.vintage === undefined) return '';
  let phrase = `, vintage ${s.vintage}`;
  if (s.vintageAgeDays !== undefined) {
    const days = Math.floor(s.vintageAgeDays);
    phrase += days === 0 ? ', under a day old' : `, ${days} day${days === 1 ? '' : 's'} old`;
  }
  return phrase;
}

/**
 * One line for the CLI headline, e.g. `forecast current, vintage 3, 2 days old ·
 * revenue 2026-06 · src:acme:123`. States and labels only, never a figure.
 */
export function renderForecastSummary(s: ForecastAnswerSummary): string {
  const reason = s.reason ? ` (${s.reason})` : '';
  let head: string;
  if (s.kind === 'track') {
    const state = s.forecastState ?? 'state unknown';
    if (state === 'provided_current') {
      head = `forecast current${vintagePhrase(s)}${s.hasReportData ? '' : ' (no report data)'}`;
    } else if (state === 'not_provided') {
      head = `forecast not provided${reason}`;
    } else {
      head = `forecast ${state}${reason}${vintagePhrase(s)}`;
    }
  } else if (s.kind === 'baseline') {
    head =
      s.available === true
        ? `baseline available${vintagePhrase(s)}`
        : s.available === false
          ? `baseline unavailable${reason}`
          : `baseline${reason}`;
  } else if (s.kind === 'readiness') {
    head = `readiness verdict ${s.verdict ?? 'unknown'}`;
  } else {
    head = `forecasting answer (kind ${s.kind ?? 'unknown'})${reason}`;
  }
  const parts = [head];
  const metricMonth = [s.metric, s.month].filter((x): x is string => !!x).join(' ');
  if (metricMonth) parts.push(metricMonth);
  if (s.scopeId) parts.push(s.scopeId);
  return parts.join(' · ');
}
