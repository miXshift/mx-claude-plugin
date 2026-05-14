/**
 * Set a value at a dot-path inside a nested object, creating intermediate
 * objects as needed. Used by `mixshift profile set <dot.path> <value>`.
 *
 * Behavior:
 *   - Path "a.b.c" walks into obj.a.b.c
 *   - If a.b is missing, creates {} for it
 *   - If a.b is a non-object (string, number, null), throws to prevent
 *     accidental data destruction
 *   - The leaf value is set as-is (use coerceValue to type-coerce strings
 *     from CLI args before passing here)
 */

export function setNested(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (path.length === 0) {
    throw new Error('Path cannot be empty.');
  }

  const keys = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next = current[key];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      current[key] = created;
      current = created;
    } else if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new Error(
        `Cannot set "${path}" — "${keys.slice(0, i + 1).join('.')}" is ${
          Array.isArray(next) ? 'an array' : typeof next
        }, not an object. ` +
          `Remove or rename the existing value first.`,
      );
    } else {
      current = next as Record<string, unknown>;
    }
  }

  current[keys[keys.length - 1]!] = value;
}

/**
 * Best-effort type coercion for string args from the CLI.
 *   "true" → true, "false" → false
 *   "8080" → 8080, "3.14" → 3.14
 *   "null" → null
 *   anything else → returned as the raw string
 *
 * Uses JSON parsing because it gives clean semantics for booleans, numbers,
 * and explicit null. Bare strings (unquoted) fall through to the raw return.
 */
export function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
