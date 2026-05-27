import { describe, it, expect } from 'vitest';
import {
  credentialsSchema,
  datahubCredsSchema,
  isDatahubCreds,
  mysqlCredsSchema,
  newCredentials,
} from './schema.js';

describe('newCredentials', () => {
  it('returns a v2 skeleton', () => {
    const c = newCredentials();
    expect(c.schema_version).toBe(2);
    expect(c.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(c.mysql).toBeUndefined();
    expect(c.datahub).toBeUndefined();
  });
});

describe('credentialsSchema', () => {
  it('accepts a v1 envelope (legacy mysql-only)', () => {
    const parsed = credentialsSchema.parse({
      schema_version: 1,
      created_at: '2026-05-27T10:00:00.000Z',
      mysql: {
        host: 'db.example.com',
        port: 3306,
        user: 'tester',
        password: 'sekret',
        database: 'testdb',
      },
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.mysql?.host).toBe('db.example.com');
  });

  it('accepts a v2 envelope with mysql + datahub coexisting', () => {
    const parsed = credentialsSchema.parse({
      schema_version: 2,
      created_at: '2026-05-27T10:00:00.000Z',
      mysql: {
        host: 'db.example.com',
        port: 3306,
        user: 'tester',
        password: 'sekret',
        database: 'testdb',
      },
      datahub: validDatahubFixture(),
    });
    expect(parsed.schema_version).toBe(2);
    expect(parsed.mysql).toBeDefined();
    expect(parsed.datahub).toBeDefined();
  });

  it('rejects schema_version 0 / 3 / strings', () => {
    for (const bad of [0, 3, '2', null]) {
      expect(() =>
        credentialsSchema.parse({
          schema_version: bad,
          created_at: '2026-05-27T10:00:00.000Z',
        }),
      ).toThrow();
    }
  });
});

describe('datahubCredsSchema', () => {
  it('round-trips a valid datahub block', () => {
    const fx = validDatahubFixture();
    expect(datahubCredsSchema.parse(fx)).toEqual(fx);
  });

  it('rejects person_label that is not an email', () => {
    const bad = { ...validDatahubFixture(), person_label: 'sam' };
    expect(() => datahubCredsSchema.parse(bad)).toThrow();
  });

  it('rejects a non-slug client_id', () => {
    for (const bad of ['Has Spaces', 'UPPER', 'too:long:with:colons', '']) {
      const fx = { ...validDatahubFixture(), client_id: bad };
      expect(() => datahubCredsSchema.parse(fx)).toThrow();
    }
  });

  it('rejects a 65-char client_id (slug max is 64)', () => {
    const fx = { ...validDatahubFixture(), client_id: 'a'.repeat(65) };
    expect(() => datahubCredsSchema.parse(fx)).toThrow();
  });

  it('accepts a 64-char client_id (slug max boundary)', () => {
    const fx = { ...validDatahubFixture(), client_id: 'a'.repeat(64) };
    expect(() => datahubCredsSchema.parse(fx)).not.toThrow();
  });

  it('rejects non-URL api_base', () => {
    const fx = { ...validDatahubFixture(), api_base: 'not-a-url' };
    expect(() => datahubCredsSchema.parse(fx)).toThrow();
  });
});

describe('isDatahubCreds', () => {
  it('distinguishes datahub from mysql creds', () => {
    const mysql = mysqlCredsSchema.parse({
      host: 'h',
      port: 3306,
      user: 'u',
      password: 'p',
      database: 'd',
    });
    const datahub = datahubCredsSchema.parse(validDatahubFixture());

    expect(isDatahubCreds(mysql)).toBe(false);
    expect(isDatahubCreds(datahub)).toBe(true);
  });
});

function validDatahubFixture() {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: 'eyJhbGciOiJIUzI1NiJ9.token',
    refresh_token: 'r'.repeat(48),
    expires_at: '2026-05-28T15:23:13.000Z',
    refresh_expires_at: '2026-06-26T15:23:13.000Z',
    user_id: '3',
    email: 'amazon+clients@dashapplications.com',
    person_label: 'sam.hager@mixshift.io',
    device_label: 'laptop-sam',
    client_id: 'mx-claude-plugin',
  };
}
