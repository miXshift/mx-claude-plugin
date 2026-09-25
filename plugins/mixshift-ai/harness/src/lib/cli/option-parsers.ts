/**
 * commander option parsers that fail as usage errors.
 *
 * A parser passed as `.option(flags, description, parser)` runs inside
 * commander's option parsing, before any action handler's try/catch, so
 * whatever it throws lands in cli.ts's top-level catch. A plain `Error` there
 * was filed as an `unhandled_exception` crash, with a message ("Expected k=v")
 * that named neither the flag nor the fix (mx-ops#86).
 *
 * commander calls a parser with only `(value, previous)`, so these factories
 * close over the flag name. They throw InvalidOptionValueError: error_class
 * `invalid_argument`, a message that says what to pass instead, and telemetry
 * that records the value's shape, never the value.
 */

import { InvalidOptionValueError } from '../errors.js';

/** An AmazonSellerID (merchant token): `A` plus 9-15 uppercase alphanumerics. */
const MERCHANT_TOKEN = /^A[0-9A-Z]{9,15}$/;

export interface KeyValueOptionHints {
  /** The command's JSON body flag, when it has one (e.g. `--body`). */
  bodyFlag?: string;
  /** A well-formed pair to show in the message, e.g. `reportPeriod=WEEK`. */
  example?: string;
}

/**
 * Collector for a repeatable `--flag key=value` option. Accumulates into a
 * record; a repeated key keeps its last value. Rejects JSON (the commonest
 * misuse: an agent passing `{"maxResults":10}` to `--query`), a value with no
 * `=`, and an empty key.
 */
export function keyValueOption(
  flag: string,
  hints: KeyValueOptionHints = {},
): (value: string, previous: Record<string, string>) => Record<string, string> {
  const howTo =
    `Pass each parameter as ${flag} key=value, repeating the flag once per parameter` +
    (hints.example ? ` (e.g. ${flag} ${hints.example})` : '') +
    '.';
  // Conditional: most `call` operations are GETs with no body, and a --path
  // placeholder never belongs in one.
  const bodyHint = hints.bodyFlag
    ? ` A JSON request body, for an operation that takes one, goes in ${hints.bodyFlag}.`
    : '';

  return (value, previous) => {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const shape = trimmed.startsWith('{') ? 'json_object' : 'json_array';
      const corrected = correctedKeyValueFlags(flag, trimmed);
      throw new InvalidOptionValueError(
        flag,
        shape,
        `${flag} takes one key=value pair per flag, not JSON. ${howTo}${bodyHint}` +
          (corrected ? `\nFor this value: ${corrected}` : ''),
      );
    }
    const eq = value.indexOf('=');
    if (eq < 0) {
      throw new InvalidOptionValueError(
        flag,
        'missing_equals',
        `${flag} expects key=value, got "${value}". ${howTo}`,
      );
    }
    const key = value.slice(0, eq).trim();
    if (!key) {
      throw new InvalidOptionValueError(
        flag,
        'empty_key',
        `${flag} got "${value}", which has no key before the "=". ${howTo}`,
      );
    }
    return { ...previous, [key]: value.slice(eq + 1) };
  };
}

export interface IntegerOptionHints {
  /** Smallest accepted value, inclusive. Omit for no floor. */
  min?: number;
  /**
   * The flag takes the numeric warehouse SellerID (the `mixshift data`
   * commands), which callers confuse with the AmazonSellerID that
   * `mixshift amazon` and `mixshift ads` take under the same flag name.
   */
  warehouseSellerId?: boolean;
}

/** Parser for an integer option. Same leniency as `Number.parseInt(v, 10)`. */
export function integerOption(
  flag: string,
  hints: IntegerOptionHints = {},
): (value: string) => number {
  return (value) => {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) {
      if (hints.warehouseSellerId) {
        const isToken = MERCHANT_TOKEN.test(value.trim());
        throw new InvalidOptionValueError(
          flag,
          isToken ? 'merchant_token' : 'not_integer',
          `${flag} takes the numeric warehouse SellerID (the legacySellerId column of ` +
            '`mixshift amazon merchants`)' +
            (isToken ? `, not the AmazonSellerID "${value}".` : `, got "${value}".`) +
            ' Run `mixshift amazon merchants` (or `mixshift ads profiles` for a seller' +
            " with Ads only) and pass that merchant's legacySellerId.",
        );
      }
      throw new InvalidOptionValueError(
        flag,
        'not_integer',
        `${flag} expects an integer, got "${value}".`,
      );
    }
    if (hints.min !== undefined && n < hints.min) {
      throw new InvalidOptionValueError(
        flag,
        'below_minimum',
        `${flag} expects an integer of at least ${hints.min}, got "${value}".`,
      );
    }
    return n;
  };
}

/**
 * The corrected flags for a flat JSON object, e.g. `{"a":1,"b":["x","y"]}`
 * becomes `--query a=1 --query b=x,y` (a list is the comma-separated value
 * the flags accept). Null when the JSON does not parse, holds a nested value
 * or a list item with a comma, which have no single key=value spelling, or
 * holds a single quote, which has no quoting that works in both a POSIX
 * shell and PowerShell.
 */
function correctedKeyValueFlags(flag: string, json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const parts: string[] = [];
  for (const [key, v] of Object.entries(parsed)) {
    const value = Array.isArray(v) ? csvValue(v) : scalarValue(v);
    if (value === null) return null;
    const pair = `${key}=${value}`;
    if (pair.includes("'")) return null;
    parts.push(`${flag} ${/^[\w.,:/@%+=-]+$/.test(pair) ? pair : `'${pair}'`}`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function scalarValue(v: unknown): string | null {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
}

function csvValue(items: unknown[]): string | null {
  const values = items.map(scalarValue);
  if (values.length === 0 || values.some((s) => s === null || s.includes(','))) return null;
  return values.join(',');
}
