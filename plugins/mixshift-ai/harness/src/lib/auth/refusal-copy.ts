/**
 * Refusal copy that names the real cause (mx-ops#204 S6).
 *
 * What the gateway sends today:
 *   - 403 insufficient_scope with `friendly` and `required_scopes`. It does NOT send a `reason`
 *     (`member_ceiling` | `role` | `credential_kind`) yet. When it does, this names it; until then
 *     the fallback no longer claims that signed-in users always hold the scope.
 *   - `not_a_member` (403) with an `org` id, but only on the browser sign-in page, never on a
 *     token-bearing API call. The helper is ready for the day an API refusal carries it.
 *   - 401 `session_expired` with `reason: 'reverify'` on /auth/refresh, with its own message.
 */

export function isScopeRefusalReason(v: unknown): v is 'member_ceiling' | 'role' | 'credential_kind' {
  return v === 'member_ceiling' || v === 'role' || v === 'credential_kind';
}

const ASK_ADMIN = 'ask your organization admin';

export function insufficientScopeCopy(reason?: unknown, scopes?: unknown): string {
  const raw = Array.isArray(scopes) ? scopes : typeof scopes === 'string' ? [scopes] : [];
  const list = raw.filter((s): s is string => typeof s === 'string' && /^[a-z0-9:_-]{1,64}$/i.test(s));
  const need = list.length > 0 ? ` (${list.join(' ')})` : '';
  switch (reason) {
    case 'member_ceiling':
      return `Your organization has turned this permission off for you${need}. Please ${ASK_ADMIN} if you need it.`;
    case 'role':
      return `Your role in your organization does not include this${need}. Please ${ASK_ADMIN} if you need it.`;
    case 'credential_kind':
      return (
        `This kind of credential cannot do this${need}. Sign in as yourself with \`mixshift auth login\`, ` +
        'or have an admin issue a credential that includes it.'
      );
    default:
      return (
        `This sign-in is not allowed to do this${need}. The permission may be off for you in your ` +
        `organization, so ${ASK_ADMIN}. For a service credential, the scope has to be granted when ` +
        'the credential is created. `mixshift auth status` shows what you are signed in as.'
      );
  }
}

export function notAMemberCopy(orgName?: unknown): string {
  const org = typeof orgName === 'string' && orgName.trim() !== '' ? orgName.trim() : 'your organization';
  return `You are not a member of ${org}. Ask an owner or admin of ${org} to add you, then sign in again.`;
}

export function reverifyCopy(): string {
  return (
    'Your sign-in needs to be re-verified. Run `mixshift auth login` to sign in again, ' +
    'with Google if your organization uses it.'
  );
}
