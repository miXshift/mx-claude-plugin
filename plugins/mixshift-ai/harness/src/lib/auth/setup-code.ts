/**
 * Exchange a one-time admin-minted setup code for a service credential.
 *
 * The no-secret-handling path: the admin creates a SETUP CODE at
 * {api_base}/admin (single-use, 10-minute TTL); the user pastes the code in
 * chat; this helper exchanges it at POST /oauth/service-setup/exchange. The
 * server creates the credential AT EXCHANGE TIME and returns id+secret
 * exactly once; the caller persists it straight into credentials.json. The
 * secret never renders in a browser, never lands in a user-managed file,
 * never crosses chat.
 *
 * Passing the code itself via argv is fine by design: it is single-use,
 * short-lived, and burned by this call.
 */

const EXCHANGE_TIMEOUT_MS = 30_000;

export interface ExchangedCredential {
  client_id: string;
  client_secret: string;
  label?: string;
  scopes?: string[];
}

export async function exchangeSetupCode(
  apiBase: string,
  setupCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangedCredential> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase}/oauth/service-setup/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_code: setupCode.trim() }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach ${apiBase}/oauth/service-setup/exchange: ${message}. ` +
        `Check your network and retry.`,
    );
  }

  if (res.status === 429) {
    throw new Error('Too many attempts at the exchange endpoint. Wait a minute and retry.');
  }
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'invalid_setup_code') {
      throw new Error(
        'That setup code is unknown, expired, or already used. Codes are ' +
          'single-use and last 10 minutes; ask your admin to mint a fresh ' +
          'one at /admin and try again.',
      );
    }
    throw new Error('The exchange endpoint rejected the request (invalid_request).');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `/oauth/service-setup/exchange returned HTTP ${res.status}: ${body.slice(0, 300)}`,
    );
  }

  const json = (await res.json()) as {
    client_id?: string;
    client_secret?: string;
    label?: string;
    scopes?: string[];
  };
  if (!json.client_id || !json.client_secret) {
    throw new Error('Exchange succeeded but the response carried no credential.');
  }
  return {
    client_id: json.client_id,
    client_secret: json.client_secret,
    ...(json.label ? { label: json.label } : {}),
    ...(json.scopes ? { scopes: json.scopes } : {}),
  };
}
