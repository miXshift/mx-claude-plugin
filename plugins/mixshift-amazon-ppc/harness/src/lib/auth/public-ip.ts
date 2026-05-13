/**
 * Look up the caller's public IP address.
 *
 * Used by `auth setup` when constructing an IP whitelist request — the
 * local interface IP is useless (NAT-internal); we need the public IP
 * that the MySQL host will see.
 *
 * Best-effort: if the lookup endpoint is unreachable, returns null and
 * the caller falls back to asking the user manually.
 */

export async function fetchPublicIp(
  endpoint: string,
  timeoutMs = 5_000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (body && typeof body === 'object' && 'ip' in body && typeof (body as { ip: unknown }).ip === 'string') {
      return (body as { ip: string }).ip;
    }
    // Fallback: ipify in plain-text mode returns just the IP string.
    if (typeof body === 'string') return body;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
