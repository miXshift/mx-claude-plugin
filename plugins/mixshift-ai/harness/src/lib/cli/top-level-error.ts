/**
 * The body of cli.ts's top-level catch, kept here so it can be tested: cli.ts
 * itself cannot be imported by a test (it parses the real argv and calls
 * process.exit at module scope).
 *
 * Every error that escapes a command lands here exactly once: a crash, a
 * UserFacingError, an option parser's InvalidOptionValueError, and, because
 * cli.ts applies exitOverride to the whole command tree, commander's own
 * usage errors (unknown option, missing required option) and its help and
 * version exits. This prints the error (a `{status:'error', error_class,
 * message}` envelope on stdout under --json, `error: <message>` on stderr
 * otherwise), records one plugin.crashed event, and returns the exit code.
 * cli.ts's `finally` then flushes telemetry and exits (see the exit contract
 * at the top of cli.ts).
 */

import { CommanderError, type Command } from 'commander';
import { InvalidOptionValueError, UserFacingError } from '../errors.js';
import { track, EventName } from '../telemetry/index.js';
import { redactArgs } from '../telemetry/redact.js';

/** commander exits that print help or the version: not errors. */
const DISPLAY_CODES = new Set(['commander.helpDisplayed', 'commander.help', 'commander.version']);

/**
 * Make commander throw a CommanderError instead of calling process.exit() on
 * `cmd` and every command under it. commander copies the setting only to
 * commands created after it is set, so it is applied to the finished tree.
 */
export function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub);
}

export interface TopLevelErrorContext {
  /** The root --json flag was set. */
  json: boolean;
  /** process.argv.slice(2); redacted before it reaches telemetry. */
  argv: readonly string[];
}

export interface TopLevelErrorIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  track: typeof track;
}

const defaultIo: TopLevelErrorIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  track,
};

/** Report an error that escaped the command, and return the exit code. */
export async function handleTopLevelError(
  err: unknown,
  ctx: TopLevelErrorContext,
  io: TopLevelErrorIo = defaultIo,
): Promise<number> {
  if (err instanceof CommanderError && DISPLAY_CODES.has(err.code)) {
    // commander already printed the help or version. `commander.help` with
    // exit code 1 is a command group run without a subcommand; that was never
    // an event, and still is not.
    return err.exitCode;
  }

  let message: string;
  let errorClass: string;
  let telemetryMessage: string;
  let extra: Record<string, unknown> = {};
  // commander has already written its own "error: ..." line to stderr.
  let alreadyPrinted = false;

  if (err instanceof CommanderError) {
    message = err.message.replace(/^error: /, '');
    errorClass = err.code === 'commander.invalidArgument' ? 'invalid_argument' : 'usage_error';
    telemetryMessage = scrubCommanderMessage(err.message);
    extra = { user_facing: true, commander_code: err.code };
    alreadyPrinted = true;
  } else if (err instanceof InvalidOptionValueError) {
    // The message can echo the rejected value; telemetry gets the flag name
    // and the value's shape only.
    message = err.message;
    errorClass = err.errorClass;
    telemetryMessage = err.telemetryMessage;
    extra = { user_facing: true, flag: err.flag, value_shape: err.valueShape };
  } else if (err instanceof UserFacingError) {
    // An expected, recoverable condition (a bad/legacy file, a missing
    // prerequisite), not a plugin bug. Its own error_class plus
    // user_facing:true keeps it out of the real-crash bucket in the
    // error-aggregate sweep.
    message = err.message;
    errorClass = err.errorClass;
    telemetryMessage = err.message;
    extra = { user_facing: true };
  } else {
    message = err instanceof Error ? err.message : String(err);
    errorClass = 'unhandled_exception';
    telemetryMessage = message;
  }

  if (ctx.json) {
    io.stdout(JSON.stringify({ status: 'error', error_class: errorClass, message }, null, 2) + '\n');
  } else if (!alreadyPrinted) {
    io.stderr(`error: ${message}\n`);
  }

  // Awaited so the event is on disk before cli.ts's `finally` flushes the
  // queue. This runs at most once per process, so each failure is reported
  // exactly once.
  await io.track({
    event_name: EventName.PluginCrashed,
    outcome: 'failed',
    error_class: errorClass,
    payload: {
      message: telemetryMessage,
      argv: redactArgs(ctx.argv),
      ...extra,
    },
  });

  return err instanceof CommanderError ? err.exitCode : 1;
}

/**
 * Drop flag values from a commander message before it reaches telemetry:
 * `unknown option '--x=VALUE'` keeps the flag, and `argument 'VALUE' is
 * invalid` loses the value. Other commander messages carry no values.
 */
function scrubCommanderMessage(message: string): string {
  return message
    .replace(/unknown option '([^'=]*)=[^']*'/, "unknown option '$1'")
    .replace(/argument '[^']*' is invalid/, 'argument is invalid')
    .replace(/value '[^']*' is invalid/, 'value is invalid');
}
