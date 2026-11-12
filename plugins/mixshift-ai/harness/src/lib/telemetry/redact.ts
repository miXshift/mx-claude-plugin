/**
 * Redact secrets from a captured CLI argument vector before it enters
 * telemetry.
 *
 * Context (feedback #10): during beta we capture the FULL command line on
 * cli.command_run (and plugin.crashed) so reviews can see WHAT users actually
 * run — the ad-hoc SQL, the flags, the subcommands — which the prior
 * "cmd + subcmd only" capture dropped. But argv can also carry SECRETS: a
 * one-time `auth service-setup --setup-code <code>`, a token. Telemetry must
 * NEVER carry those. This redactor is the safety gate: it keeps
 * business-meaningful args (SQL text, IDs, table names, brand slugs) and
 * replaces only credential material with a placeholder.
 *
 * Design — HIGH-PRECISION, context-first (deliberately NOT entropy-based:
 * entropy heuristics false-positive on legitimate long IDs/ASINs and would
 * silently nuke the very business data we want). Two rules:
 *   1. The VALUE of a secret-named flag: `--setup-code X`, `--client-secret X`,
 *      `--token X`, `--password X`, `--api-key X` (and the `--flag=value` form).
 *      Every current CLI secret is a flag value, so this is the primary rule.
 *   2. High-confidence token SHAPES anywhere a positional appears: JWTs
 *      (`a.b.c` base64url), `sk_`/`pk_`/`rk_`-prefixed secrets, and the
 *      service-credential setup-code shape (`SVC-XXXX-XXXX`). Defense-in-depth.
 *
 * NOTE: we deliberately do NOT redact "the next positional after subcommand X".
 * There is no bare-positional secret argument in the CLI (setup codes come via
 * `--setup-code`), and such a state machine both LEAKED the setup code (it
 * consumed the `--setup-code` flag token, exposing the value) and OVER-redacted
 * the public `--client-id` value — the feedback #10 red-team findings.
 *
 * Known limitation: short secret flags (`-p <pw>`) aren't matched — the CLI
 * uses long flags for anything sensitive. String contents aren't sub-parsed
 * (a secret literal embedded inside a quoted `--body` JSON or a `data query`
 * SQL string is preserved as part of the text the user chose to run); that is
 * an accepted trade documented in docs/privacy.md, and users are advised not to
 * inline raw credentials into query/body strings.
 */

import { LABEL_FIELD_KEYS } from '../labels/field-keys.js';

const REDACTED = '<redacted>';

/**
 * Flag names whose VALUE is a secret. Tested case-insensitively against the
 * flag with leading dashes stripped. Anchored so `--table-key` (contains
 * "key") and `--client-secret-file` (a PATH, not the secret) do NOT match —
 * only a flag that IS `key` / `client-secret` / `setup-code` / etc.
 */
const SECRET_FLAG =
  /^(secret|client[-_]?secret|password|passwd|pwd|token|access[-_]?token|refresh[-_]?token|api[-_]?key|apikey|key|credential|credentials|setup[-_]?code|auth[-_]?token|bearer)$/i;

/** High-confidence secret token shapes (exact structure, not entropy). */
function looksLikeSecretToken(s: string): boolean {
  // JWT: three base64url segments joined by dots.
  if (/^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/.test(s)) return true;
  // Common prefixed API secrets (sk_live_..., pk_..., rk_...).
  if (/^(sk|pk|rk)_[A-Za-z0-9_-]{12,}$/.test(s)) return true;
  // Service-credential setup-code shape (SVC-XXXX-XXXX). Case-sensitive and
  // hyphenated, so it never collides with the lowercase underscore `svc_`
  // client_id, which is PUBLIC and must be preserved.
  if (/^SVC-[A-Z0-9]{2,}(-[A-Z0-9]{2,})*$/.test(s)) return true;
  return false;
}

function flagName(arg: string): string {
  return arg.replace(/^-+/, '');
}

/**
 * Business figures, not secrets: inside `forecast budget ...` the VALUE of `--set`
 * (`YYYY-MM=amount`) keeps its month and loses the amount, and `--note` loses its
 * text. A budget is the brand's own figure and the privacy page says it is not
 * collected (red team 2026-10-08, P1: cli.command_run carried both verbatim).
 */
function isForecastBudget(argv: readonly string[]): boolean {
  const i = argv.indexOf('forecast');
  return i >= 0 && argv[i + 1] === 'budget';
}

function redactBudgetValue(name: string, value: string): string {
  if (name === 'note') return REDACTED;
  const m = /^\s*(\d{4}-\d{2})\s*=/.exec(value);
  return m ? `${m[1]}=${REDACTED}` : REDACTED;
}

const BUDGET_VALUE_FLAG = /^(set|note)$/;

/**
 * The same for `forecast sub-brand ...`: the VALUES of `--name`, `--item-label` and
 * `--campaign-label` are the brand's own names and labels, which the privacy page
 * says are not collected (red team 2026-10-12 on #215, P1).
 */
function isForecastSubBrand(argv: readonly string[]): boolean {
  return hasSubcommandLater(argv, 'forecast', 'sub-brand');
}

/**
 * `group` then `sub` anywhere later in argv, not only as the next token: the root options
 * (`--json`, `--data-dir x`, `--verbose`) may sit between them and still parse, so
 * `labels --json search ...` is the same command as `labels search --json ...`.
 */
function hasSubcommandLater(argv: readonly string[], group: string, sub: string): boolean {
  const i = argv.indexOf(group);
  return i >= 0 && argv.indexOf(sub, i + 1) >= 0;
}

const SUB_BRAND_VALUE_FLAG = /^(name|item-label|campaign-label)$/;

/**
 * And for `labels search ...`: the VALUE of `--value` is a label the customer typed on an
 * item or campaign (a product line, a nickname, a tag), which is their own business data
 * and which the privacy page says is not collected. The field key (`--field item_group`),
 * the account and the ids stay, as they do for every other command.
 */
function isLabelsSearch(argv: readonly string[]): boolean {
  return hasSubcommandLater(argv, 'labels', 'search');
}

const LABELS_VALUE_FLAG = /^value$/;

/**
 * Return a copy of `argv` with credential material replaced by `<redacted>`.
 * Pure and cheap (single pass over a small array); safe to call on every
 * invocation and cannot throw.
 */
function redactGeneric(argv: readonly string[]): string[] {
  const out: string[] = [];
  // Set by a secret-named flag: the IMMEDIATE next token is that flag's value.
  let redactNextValue = false;
  const budget = isForecastBudget(argv);
  const subBrand = isForecastSubBrand(argv);
  // The business-value flags of this command, and how a value is redacted.
  const labels = isLabelsSearch(argv);
  const valueFlag = budget ? BUDGET_VALUE_FLAG : subBrand ? SUB_BRAND_VALUE_FLAG : labels ? LABELS_VALUE_FLAG : null;
  const redactValue = (name: string, value: string) => (budget ? redactBudgetValue(name, value) : REDACTED);
  // Under `labels search` and `forecast sub-brand` the token after a bare value flag IS its value
  // whatever it starts with (commander takes `--value -Spring` and `--value --promo` as the value),
  // so it is redacted without the "looks like a flag" exception the budget flags keep.
  const strictValue = subBrand || labels;
  // Set by a business-value flag (`--set` / `--note` under `forecast budget`,
  // `--name` / `--item-label` / `--campaign-label` under `forecast sub-brand`, `--value` under `labels search`).
  let budgetFlag: string | null = null;

  for (const arg of argv) {
    if (budgetFlag !== null) {
      const name = budgetFlag;
      budgetFlag = null;
      if (strictValue || !(arg.startsWith('-') && arg.length > 1 && !isNumericLike(arg))) {
        out.push(redactValue(name, arg));
        continue;
      }
    }
    if (valueFlag !== null && arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = flagName(eq >= 0 ? arg.slice(0, eq) : arg);
      if (valueFlag.test(name)) {
        if (eq >= 0) out.push(`${arg.slice(0, eq)}=${redactValue(name, arg.slice(eq + 1))}`);
        else {
          out.push(arg);
          budgetFlag = name;
        }
        continue;
      }
    }
    if (redactNextValue) {
      redactNextValue = false;
      // Only consume this token as the secret flag's value if it is NOT itself
      // a flag. A secret flag immediately followed by another flag (the first
      // had an empty/optional value, or a typo) must NOT swallow that flag —
      // doing so left the SECOND flag's real value unredacted, e.g.
      // `--token --password hunter2` leaked `hunter2`. Fall through to normal
      // flag handling below so a following secret flag re-arms.
      if (!(arg.startsWith('-') && arg.length > 1 && !isNumericLike(arg))) {
        out.push(REDACTED);
        continue;
      }
    }

    // `--flag=value`
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const name = flagName(arg.slice(0, eq));
      out.push(SECRET_FLAG.test(name) ? `${arg.slice(0, eq)}=${REDACTED}` : arg);
      continue;
    }

    // `--flag` / `-flag`: a secret-named flag arms redaction of its value (the
    // next token). A non-secret flag is preserved and arms nothing, so a
    // following positional-shaped flag value (e.g. `--client-id svc_...`) is
    // NOT swallowed.
    if (arg.startsWith('-') && arg.length > 1 && !isNumericLike(arg)) {
      out.push(arg);
      if (SECRET_FLAG.test(flagName(arg))) redactNextValue = true;
      continue;
    }

    // Positional: redact only if it matches a known secret shape.
    out.push(looksLikeSecretToken(arg) ? REDACTED : arg);
  }

  return out;
}

/** Guard so a negative number (`-5`) isn't treated as a flag. */
function isNumericLike(arg: string): boolean {
  return /^-\d/.test(arg);
}

// ---------------------------------------------------------------------------
// `labels` command lines: a second pass by ALLOWLIST, on top of the baseline
// ---------------------------------------------------------------------------

/**
 * Label commands carry the customer's own label text, item and campaign ids, file paths and approval hashes in
 * their flags and positionals. The captured line is taken BEFORE the arguments are parsed, so a rejected, mistyped
 * or oddly ordered line reaches telemetry too, and every denylist of "which flag holds a value" has leaked on some
 * such line. So the rule is two passes and "most redacted wins":
 *
 *   1. The baseline: `redactGeneric` (what every command line has always had) over the WHOLE line, no splitting.
 *   2. If any token is `labels` (any case) or ends with `=labels`, the allowlist is ALSO applied to the whole line:
 *      before that token only the root flags the CLI has survive (`--json`-style booleans, the name of `--data-dir`
 *      without its path, `--surface` with a valid value), and every other token is redacted; from that token on
 *      only known flag names, a registered labels subcommand as the first positional, a change set id, and the
 *      shape-checked values of a short list of flags survive. A token is kept only if BOTH passes keep it.
 *   3. Exception, so other command groups are not blinded: when the first positional of the line is another
 *      registered top-level command (`forecast`, `auth`, `brand`, ...), the line belongs to that group and has the
 *      baseline only, exactly as before.
 *
 * Over-triggering on an odd line is accepted: over-redaction is safe, exposure is not. The token after a flag
 * that is not a known boolean is always that flag's value, whatever it starts with (commander takes
 * `--to --promo` as the value `--promo`), unless it is itself a known flag name.
 */
const LABELS_SUBCOMMANDS = new Set(['state', 'fields', 'get', 'search', 'drift', 'changes', 'preview', 'commit', 'undo', 'sets', 'set', 'cancel', 'field-name']);

/** The registered top-level commands other than `labels` (cli.ts). A line whose first positional is one of these is that group's. */
const OTHER_TOP_LEVEL_COMMANDS = new Set([
  'profile', 'auth', 'brand', 'validate', 'prefetch', 'render', 'sidecar', 'ui', 'data', 'feedback', 'welcome', 'version', 'whatsnew',
  'update-actions', 'telemetry', 'skill', 'amazon', 'ads', 'dsp', 'walmart', 'shelf', 'intelligence', 'forecast', 'report', 'doctor',
  'guide', 'demo', 'share-skill', 'context', 'timeline', 'task', 'help',
]);

/** Root flags that take no value, and the root flags that do. */
const ROOT_BOOLEAN_FLAGS = new Set(['json', 'verbose', 'help', 'version']);
const LABELS_BOOLEAN_FLAGS = new Set([...ROOT_BOOLEAN_FLAGS, 'all', 'commit', 'remove']);

const FIELD_KEY_SET = new Set<string>(LABEL_FIELD_KEYS);
const fieldKey = { test: (v: string): boolean => FIELD_KEY_SET.has(v) };
const TIME_SHAPE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z)?$/;
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SURFACE_SHAPE = /^(claude_code|cowork|cli|cli_headless)$/;

interface Shape {
  test(v: string): boolean;
}

/** Flags whose value is not sensitive, and the exact shape it must have to be kept. */
const LABELS_VALUE_SHAPES: Record<string, Shape> = {
  account: /^[1-9][0-9]{0,9}$/,
  entity: /^(item|campaign)$/,
  scope: /^(marketplace|region|all)$/,
  field: fieldKey,
  clear: fieldKey,
  rename: fieldKey,
  limit: /^[0-9]{1,4}$/,
  before: TIME_SHAPE,
  since: TIME_SHAPE,
  surface: SURFACE_SHAPE,
};

/** Every flag name a labels line may carry. Anything else is not kept, not even its name. */
const LABELS_KNOWN_FLAGS = new Set([
  ...LABELS_BOOLEAN_FLAGS,
  ...Object.keys(LABELS_VALUE_SHAPES),
  'data-dir', 'ids', 'ids-file', 'where', 'file', 'set', 'from', 'to', 'name', 'value', 'cursor', 'approval-hash',
]);

interface AllowConfig {
  known: ReadonlySet<string>;
  booleans: ReadonlySet<string>;
  shapes: Readonly<Record<string, Shape>>;
  /** Whether a positional is kept: its 1-based position among positionals, and the token. */
  keepPositional(n: number, arg: string): boolean;
}

const isFlagLike = (arg: string): boolean => arg.startsWith('-') && arg.length > 1 && !isNumericLike(arg);

/** One allowlist pass over a run of tokens. Same length out as in. */
function allowlist(tokens: readonly string[], cfg: AllowConfig): string[] {
  const out: string[] = [];
  let pending: string | null | undefined; // undefined: none; null: a value for an unknown or non-allowlisted flag; string: that allowlisted flag
  let positionals = 0;
  for (const arg of tokens) {
    const flag = isFlagLike(arg);
    const name = flag && arg.startsWith('--') && !arg.startsWith('---') ? arg.slice(2).split('=')[0]! : null;
    const knownLong = name !== null && cfg.known.has(name);
    if (pending !== undefined && !knownLong) {
      const shape = pending === null ? undefined : cfg.shapes[pending];
      out.push(shape && shape.test(arg) ? arg : REDACTED);
      pending = undefined;
      continue;
    }
    pending = undefined;
    if (flag) {
      if (!knownLong) {
        out.push(REDACTED); // an unknown or short flag: not even its name; what follows it is taken as its value
        if (!arg.includes('=')) pending = null;
        continue;
      }
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        const shape = cfg.shapes[name!];
        const value = arg.slice(eq + 1);
        out.push(`--${name}=${shape && shape.test(value) ? value : REDACTED}`);
        continue;
      }
      out.push(arg);
      if (!cfg.booleans.has(name!)) pending = cfg.shapes[name!] ? name! : null;
      continue;
    }
    positionals += 1;
    out.push(cfg.keepPositional(positionals, arg) ? arg : REDACTED);
  }
  return out;
}

/** The root flags the CLI really has; every positional before the `labels` token is redacted. */
const ROOT_CONFIG: AllowConfig = {
  known: new Set([...ROOT_BOOLEAN_FLAGS, 'data-dir', 'surface']),
  booleans: ROOT_BOOLEAN_FLAGS,
  shapes: { surface: SURFACE_SHAPE },
  keepPositional: () => false,
};

const LABELS_CONFIG: AllowConfig = {
  known: LABELS_KNOWN_FLAGS,
  booleans: LABELS_BOOLEAN_FLAGS,
  shapes: LABELS_VALUE_SHAPES,
  keepPositional: (n, arg) => (n === 1 && LABELS_SUBCOMMANDS.has(arg)) || UUID_SHAPE.test(arg),
};

/** The first positional of the whole line, skipping flags and the values of the two root flags that take one. */
function firstPositional(argv: readonly string[]): string | null {
  for (let j = 0; j < argv.length; j += 1) {
    const a = argv[j]!;
    if (a === '--data-dir' || a === '--surface') {
      j += 1;
      continue;
    }
    if (isFlagLike(a)) continue;
    return a;
  }
  return null;
}

const isLabelsToken = (a: string): boolean => {
  const l = a.toLowerCase();
  return l === 'labels' || l.endsWith('=labels');
};

/**
 * Return a copy of `argv` with credential material replaced by `<redacted>`.
 * Pure and cheap (single pass over a small array); safe to call on every
 * invocation and cannot throw. See the two-pass rule above for `labels` lines.
 */
export function redactArgs(argv: readonly string[]): string[] {
  const base = redactGeneric(argv);
  const i = argv.findIndex(isLabelsToken);
  if (i < 0) return base;
  const first = firstPositional(argv);
  if (first !== null && OTHER_TOP_LEVEL_COMMANDS.has(first)) return base;
  const trigger = /^labels$/i.test(argv[i]!) ? argv[i]! : REDACTED;
  const allow = [...allowlist(argv.slice(0, i), ROOT_CONFIG), trigger, ...allowlist(argv.slice(i + 1), LABELS_CONFIG)];
  // Most redacted wins: a token is kept only if both passes keep it.
  return argv.map((orig, k) => {
    const b = base[k]!;
    const a = allow[k]!;
    if (b === orig) return a;
    if (a === orig) return b;
    return a === REDACTED || b === REDACTED ? REDACTED : a;
  });
}
