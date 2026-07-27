import { describe, expect, it } from 'vitest';
import { decodeAccessTokenClaims } from './token-claims.js';

/** Build a JWT-shaped string with the given payload claims. */
function makeJwt(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(claims)}.signature`;
}

describe('decodeAccessTokenClaims', () => {
  it('decodes actor, email, and sub from a well-formed token', () => {
    const token = makeJwt({
      sub: 'user-777',
      email: 'ops@acmeco.com',
      actor: 'jordan.lee@example.com',
    });
    expect(decodeAccessTokenClaims(token)).toEqual({
      user_id: 'user-777',
      email: 'ops@acmeco.com',
      actor: 'jordan.lee@example.com',
    });
  });

  it('falls back to a legacy user_id claim when sub is absent', () => {
    const token = makeJwt({ user_id: 'user-42', email: 'a@b.com', actor: 'c@b.com' });
    expect(decodeAccessTokenClaims(token).user_id).toBe('user-42');
  });

  it('prefers sub over user_id when both are present', () => {
    const token = makeJwt({ sub: 'sub-1', user_id: 'legacy-2', actor: 'x@y.com' });
    expect(decodeAccessTokenClaims(token).user_id).toBe('sub-1');
  });

  it('ignores non-string / empty claim values', () => {
    const token = makeJwt({ sub: 123, email: '', actor: null });
    expect(decodeAccessTokenClaims(token)).toEqual({
      user_id: undefined,
      email: undefined,
      actor: undefined,
    });
  });

  it('returns {} for undefined / null / empty input', () => {
    expect(decodeAccessTokenClaims(undefined)).toEqual({});
    expect(decodeAccessTokenClaims(null)).toEqual({});
    expect(decodeAccessTokenClaims('')).toEqual({});
  });

  it('returns {} for an opaque (non-JWT) token with no payload segment', () => {
    expect(decodeAccessTokenClaims('opaque-not-a-jwt')).toEqual({});
    expect(decodeAccessTokenClaims('only.two')).toBeDefined();
  });

  it('returns {} when the payload segment is not valid base64/JSON', () => {
    expect(decodeAccessTokenClaims('header.%%%notb64%%%.sig')).toEqual({});
    expect(decodeAccessTokenClaims('header..sig')).toEqual({});
  });

  it('never throws on arbitrary garbage', () => {
    expect(() => decodeAccessTokenClaims('....')).not.toThrow();
    expect(() => decodeAccessTokenClaims('a.b')).not.toThrow();
  });
});
