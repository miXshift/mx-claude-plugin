import { describe, expect, it } from 'vitest';
import { redactArgs } from './redact.js';

describe('redactArgs', () => {
  it('preserves ordinary business args (subcommand + SQL + flags)', () => {
    expect(
      redactArgs(['data', 'query', 'SELECT * FROM campaignmetric WHERE SellerID = 683']),
    ).toEqual(['data', 'query', 'SELECT * FROM campaignmetric WHERE SellerID = 683']);
    expect(redactArgs(['ads', 'operations', '--family', 'Reporting'])).toEqual([
      'ads',
      'operations',
      '--family',
      'Reporting',
    ]);
    expect(redactArgs(['data', 'sample', 'mws_items', '--json'])).toEqual([
      'data',
      'sample',
      'mws_items',
      '--json',
    ]);
  });

  it('redacts the value of a space-separated secret flag', () => {
    expect(redactArgs(['ads', 'call', '--client-secret', 'ssh-super-secret-value'])).toEqual([
      'ads',
      'call',
      '--client-secret',
      '<redacted>',
    ]);
    for (const flag of ['--secret', '--password', '--token', '--api-key', '--setup-code', '--credential']) {
      expect(redactArgs([flag, 'THE-VALUE'])).toEqual([flag, '<redacted>']);
    }
  });

  it('redacts the value of a --flag=value secret', () => {
    expect(redactArgs(['--secret=abc123def456'])).toEqual(['--secret=<redacted>']);
    expect(redactArgs(['auth', '--client-secret=zzz'])).toEqual(['auth', '--client-secret=<redacted>']);
  });

  it('redacts a setup-code-shaped positional anywhere (SVC-XXXX defense-in-depth)', () => {
    expect(redactArgs(['auth', 'service-setup', 'SVC-1234-5678'])).toEqual([
      'auth',
      'service-setup',
      '<redacted>',
    ]);
  });

  it('redacts the setup code in the real --setup-code flag form (red-team #10 CRITICAL regression)', () => {
    // `mixshift auth service-setup --setup-code SVC-XXXX` is the PRIMARY path.
    // The `service-setup` positional trigger must NOT consume the `--setup-code`
    // flag token and leak the actual code as the trailing positional.
    expect(redactArgs(['auth', 'service-setup', '--setup-code', 'SVC-1234-5678'])).toEqual([
      'auth',
      'service-setup',
      '--setup-code',
      '<redacted>',
    ]);
    expect(redactArgs(['auth', 'service-setup', '--setup-code=SVC-1234-5678'])).toEqual([
      'auth',
      'service-setup',
      '--setup-code=<redacted>',
    ]);
  });

  it('preserves non-secret service-setup args (public client id + secret FILE path)', () => {
    // --client-secret-file is a PATH (the secret lives on disk, never in argv)
    // and --client-id is the public svc_ id; neither is a secret to redact.
    expect(
      redactArgs([
        'auth',
        'service-setup',
        '--client-id',
        'svc_abcdefgh',
        '--client-secret-file',
        '/etc/mx/secret.txt',
      ]),
    ).toEqual([
      'auth',
      'service-setup',
      '--client-id',
      'svc_abcdefgh',
      '--client-secret-file',
      '/etc/mx/secret.txt',
    ]);
  });

  it('redacts JWTs and prefixed API secrets anywhere', () => {
    const jwt = 'eyJhbGciOiJIUzI1Ni000.eyJzdWIiOiI0MjIyMjIi0.abc_DEF-123ghiJKL';
    expect(redactArgs(['x', jwt, 'y'])).toEqual(['x', '<redacted>', 'y']);
    expect(redactArgs(['--body', 'sk_live_0123456789abcdefXYZ'])).toEqual([
      '--body',
      '<redacted>',
    ]);
  });

  it('does NOT over-redact: non-secret flags whose name merely contains "key"', () => {
    // `--table-key` is not the `key` flag — anchored regex must not match it.
    expect(redactArgs(['--table-key', 'mws_items'])).toEqual(['--table-key', 'mws_items']);
    // brand slugs, table names, ASINs, seller ids: all preserved.
    expect(redactArgs(['brand', 'config', 'further-food'])).toEqual([
      'brand',
      'config',
      'further-food',
    ]);
    expect(redactArgs(['--seller-id', 'A1B2C3D4E5'])).toEqual(['--seller-id', 'A1B2C3D4E5']);
  });

  it('does not treat a negative number as a flag', () => {
    expect(redactArgs(['scan', '--limit', '-5'])).toEqual(['scan', '--limit', '-5']);
  });

  it('preserves SQL text even when it contains a literal (query text is intended capture)', () => {
    const sql = "SELECT * FROM t WHERE note = 'call me at 5'";
    expect(redactArgs(['data', 'query', sql])).toEqual(['data', 'query', sql]);
  });

  it('handles an empty argv', () => {
    expect(redactArgs([])).toEqual([]);
  });
});
