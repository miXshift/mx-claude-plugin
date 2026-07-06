/**
 * Deadline racing for best-effort operations.
 *
 * The context-sync / timeline clients bound their FETCHES with AbortSignal
 * timeouts, but authedRequest first awaits getValidAccessToken, and a
 * token refresh/mint goes through the GLOBAL fetch with its own 30s
 * timeout — outside any per-module budget. Best-effort paths (autosync,
 * ads timeline emission, key-brand mirroring) therefore race the WHOLE
 * operation against a wall-clock deadline: on expiry the caller returns
 * its quiet no-op outcome immediately, and the underlying operation is
 * left to finish detached (its errors are already swallowed by the
 * result-envelope contract; any late side effect only freshens local
 * state for a later read).
 */

/** Sentinel returned by raceDeadline when the deadline fires first. */
export const DEADLINE: unique symbol = Symbol('deadline');

/**
 * Race an operation against a wall-clock deadline. Resolves with the
 * operation's value, or DEADLINE when `ms` elapses first. The timer never
 * keeps the event loop alive and is cleared when the operation wins.
 *
 * Rejection semantics: if `op` rejects BEFORE the deadline, the rejection
 * propagates to the caller (whose catch-all owns it). If `op` rejects
 * AFTER the deadline fired, Promise.race has already attached handlers to
 * it, so the late rejection is observed and discarded — never an
 * unhandled-rejection warning.
 */
export async function raceDeadline<T>(
  op: Promise<T>,
  ms: number,
): Promise<T | typeof DEADLINE> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
