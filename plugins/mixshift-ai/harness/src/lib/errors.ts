/**
 * Typed, user-facing errors.
 *
 * A `UserFacingError` is a condition the user can act on (a bad/legacy file, a
 * missing prerequisite) rather than a bug in the plugin. The top-level CLI catch
 * (see cli.ts) recognizes these and, instead of framing them as an
 * `unhandled_exception` crash with a raw stack-flavored message, prints the
 * clean `message` and tags the telemetry crash event with the specific
 * `errorClass` plus `user_facing: true`. That keeps a recoverable, expected
 * failure out of the "real crash" bucket in the error-aggregate sweep while
 * still giving the user an actionable message.
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
