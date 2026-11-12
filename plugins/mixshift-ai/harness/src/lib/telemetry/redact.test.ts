import { describe, expect, it } from 'vitest';
import { redactArgs } from './redact.js';

describe('redactArgs', () => {
  it('forecast budget: keeps the month, drops the amount and the note, in both flag forms (red team 2026-10-08)', () => {
    expect(
      redactArgs(['--json', 'forecast', 'budget', 'set', '--scope', 'src:fake_db:42', '--set', '2026-10=50,000', '--set=2026-11=40000', '--note', 'from the sheet', '--note=link']),
    ).toEqual(['--json', 'forecast', 'budget', 'set', '--scope', 'src:fake_db:42', '--set', '2026-10=<redacted>', '--set=2026-11=<redacted>', '--note', '<redacted>', '--note=<redacted>']);
    // A value that is not a month pair is dropped whole; a following flag is never swallowed.
    expect(redactArgs(['forecast', 'budget', 'set', '--set', 'oops', '--set', '--scope', 'x'])).toEqual(['forecast', 'budget', 'set', '--set', '<redacted>', '--set', '--scope', 'x']);
    // Elsewhere --set and --note mean something else and are left alone.
    expect(redactArgs(['ads', 'call', 'x', '--note', 'keep me'])).toEqual(['ads', 'call', 'x', '--note', 'keep me']);
  });

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

  it('does not leak a following flag’s value when a secret flag has no value (review CRITICAL)', () => {
    // `--token` here has no value (empty/optional, or a typo). It must NOT
    // swallow `--password` as its value, or `--password`’s real value
    // (`hunter2`) slips through unredacted into telemetry.
    expect(redactArgs(['--token', '--password', 'hunter2'])).toEqual([
      '--token',
      '--password',
      '<redacted>',
    ]);
    // Secret flag followed by a NON-secret flag: that flag + its value are
    // preserved (a bare secret flag with no value redacts nothing).
    expect(redactArgs(['--secret', '--client-id', 'svc_public_123'])).toEqual([
      '--secret',
      '--client-id',
      'svc_public_123',
    ]);
    // Secret flag followed by a secret --flag=value form.
    expect(redactArgs(['--token', '--password=hunter2'])).toEqual([
      '--token',
      '--password=<redacted>',
    ]);
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

describe('forecast sub-brand (red team 2026-10-12 on #215)', () => {
  it('drops the name and the labels, in both flag forms, and keeps the seller and the flags', () => {
    expect(
      redactArgs(['forecast', 'sub-brand', 'add', '--seller', '42', '--name', 'Northwind Outdoors', '--item-label', 'Northwind', '--campaign-label=northwind', '--item-group']),
    ).toEqual(['forecast', 'sub-brand', 'add', '--seller', '42', '--name', '<redacted>', '--item-label', '<redacted>', '--campaign-label=<redacted>', '--item-group']);
    // Outside `forecast sub-brand`, a --name value is not a brand's business value and is kept.
    expect(redactArgs(['brand', 'add', '--name', 'Northwind'])).toEqual(['brand', 'add', '--name', 'Northwind']);
  });
});

describe('labels search', () => {
  it('drops the --value text in both flag forms, and keeps the account, field key and the flags', () => {
    expect(
      redactArgs(['--json', 'labels', 'search', '--account', '42', '--field', 'item_group', '--value', 'Example Line', '--limit', '10']),
    ).toEqual(['--json', 'labels', 'search', '--account', '42', '--field', 'item_group', '--value', '<redacted>', '--limit', '10']);
    expect(redactArgs(['labels', 'search', '--account', '42', '--field=tag_1', '--value=Spring Promo', '--all'])).toEqual([
      'labels',
      'search',
      '--account',
      '42',
      '--field=tag_1',
      '--value=<redacted>',
      '--all',
    ]);
    // Elsewhere a --value is not a label and is kept.
    expect(redactArgs(['ads', 'call', 'x', '--value', 'keep me'])).toEqual(['ads', 'call', 'x', '--value', 'keep me']);
    // The other labels commands carry ids and a time, not label text.
    expect(redactArgs(['labels', 'get', '--account', '42', '--ids', 'B0EXAMPLE01,B0EXAMPLE02'])).toEqual(['labels', 'get', '--account', '42', '--ids', 'B0EXAMPLE01,B0EXAMPLE02']);
  });
});

describe('value flags in every argv form the parser accepts (review of #268)', () => {
  const R = '<redacted>';

  it('labels search: root options between `labels` and `search` do not hide the command', () => {
    expect(redactArgs(['labels', '--json', 'search', '--account', '42', '--value', 'Secret Line'])).toEqual(['labels', '--json', 'search', '--account', '42', '--value', R]);
    expect(redactArgs(['--json', 'labels', '--data-dir', 'x', 'search', '--value=Secret Line'])).toEqual(['--json', 'labels', '--data-dir', 'x', 'search', `--value=${R}`]);
    expect(redactArgs(['labels', '--verbose', '--json', 'search', '--account', '42', '--field', 'tag_1', '--value', 'Secret Line', '--all'])).toEqual(['labels', '--verbose', '--json', 'search', '--account', '42', '--field', 'tag_1', '--value', R, '--all']);
  });

  it('labels search: a value that starts with a dash is still the value (commander takes it)', () => {
    expect(redactArgs(['labels', 'search', '--value', '-Secret Line'])).toEqual(['labels', 'search', '--value', R]);
    expect(redactArgs(['labels', 'search', '--value', '--promo', '--account', '42'])).toEqual(['labels', 'search', '--value', R, '--account', '42']);
    expect(redactArgs(['labels', 'search', '--value', '-5'])).toEqual(['labels', 'search', '--value', R]);
    expect(redactArgs(['labels', 'search', '--value=-Secret'])).toEqual(['labels', 'search', `--value=${R}`]);
    // A trailing bare --value has nothing to redact and nothing to leak.
    expect(redactArgs(['labels', 'search', '--account', '42', '--value'])).toEqual(['labels', 'search', '--account', '42', '--value']);
  });

  it('labels: other subcommands and other groups keep --value', () => {
    expect(redactArgs(['labels', 'get', '--account', '42', '--ids', 'B0EXAMPLE01'])).toEqual(['labels', 'get', '--account', '42', '--ids', 'B0EXAMPLE01']);
    expect(redactArgs(['search', '--value', 'keep'])).toEqual(['search', '--value', 'keep']);
  });

  it('forecast sub-brand: root options in between, and dash-leading values, in both flag forms', () => {
    expect(redactArgs(['forecast', '--json', 'sub-brand', 'add', '--seller', '42', '--name', 'Northwind Outdoors'])).toEqual(['forecast', '--json', 'sub-brand', 'add', '--seller', '42', '--name', R]);
    expect(redactArgs(['--json', 'forecast', '--data-dir', 'x', 'sub-brand', 'add', '--item-label=Northwind', '--campaign-label', 'north'])).toEqual(['--json', 'forecast', '--data-dir', 'x', 'sub-brand', 'add', `--item-label=${R}`, '--campaign-label', R]);
    expect(redactArgs(['forecast', 'sub-brand', 'add', '--name', '-Northwind', '--item-label', '--promo', '--campaign-label=-x'])).toEqual(['forecast', 'sub-brand', 'add', '--name', R, '--item-label', R, `--campaign-label=${R}`]);
    expect(redactArgs(['brand', 'add', '--name', '-Northwind'])).toEqual(['brand', 'add', '--name', '-Northwind']);
  });
});
