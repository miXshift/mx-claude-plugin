/**
 * Typed, user-facing errors.
 *
 * A `UserFacingError` is a condition the user can act on (a bad/legacy file, a
 * missing prerequisite) rather than a bug in the plugin. The top-level CLI
 * catch (lib/cli/top-level-error.ts) recognizes these and, instead of framing
 * them as an `unhandled_exception` crash with a raw stack-flavored message,
 * prints the clean `message` and tags the telemetry crash event with the
 * specific `errorClass` plus `user_facing: true`. That keeps a recoverable,
 * expected failure out of the "real crash" bucket in the error-aggregate
 * sweep while still giving the user an actionable message.
 *
 * `message` is shown verbatim to the user, so keep it clean and actionable
 * (what happened + the exact command to recover). No stack traces, no Zod dumps
 * beyond a short summary.
 */
export class UserFacingError extends Error {
  /** Stable, low-cardinality classifier surfaced as telemetry `error_class`. */
  readonly errorClass: string;

  constructor(message: string, errorClass: string) {
    super(message);
    this.name = 'UserFacingError';
    this.errorClass = errorClass;
  }
}

/**
 * The brand registry (`~/.mixshift/clients/index.yaml`) exists but is malformed
 * YAML or fails schema validation (e.g. a partial write, or a file written by a
 * plugin version that predates the current schema). Recoverable: the user
 * re-runs discovery, which rewrites a schema-valid file.
 */
export class RegistryInvalidError extends UserFacingError {
  constructor(message: string) {
    super(message, 'registry_invalid');
    this.name = 'RegistryInvalidError';
  }
}

/**
 * The shape of a rejected flag value, recorded in telemetry in place of the
 * value itself. Flag values can be seller-level business data (ids, ASINs,
 * query parameters), so the crash event names the flag and this shape, never
 * the value. Keep the set small: it is a telemetry dimension.
 */
export type OptionValueShape =
  | 'json_object'
  | 'json_array'
  | 'merchant_token'
  | 'missing_equals'
  | 'empty_key'
  | 'not_integer'
  | 'below_minimum';

/**
 * A flag was given a value in the wrong shape: JSON to a `key=value` flag, an
 * AmazonSellerID to a numeric-id flag, text to an integer flag. Thrown by the
 * commander option parsers in lib/cli/option-parsers.ts, so a mistyped flag is
 * a usage error the caller can fix in one step rather than an
 * `unhandled_exception` crash (mx-ops#86).
 *
 * `message` names the flag and the fix and may echo the rejected value; it is
 * printed to the user only. `telemetryMessage` carries the flag name and the
 * value shape and is the only text the crash event records.
 */
export class InvalidOptionValueError extends UserFacingError {
  readonly flag: string;
  readonly valueShape: OptionValueShape;

  constructor(flag: string, valueShape: OptionValueShape, message: string) {
    super(message, 'invalid_argument');
    this.name = 'InvalidOptionValueError';
    this.flag = flag;
    this.valueShape = valueShape;
  }

  get telemetryMessage(): string {
    return `invalid value for ${this.flag} (${this.valueShape})`;
  }
}
