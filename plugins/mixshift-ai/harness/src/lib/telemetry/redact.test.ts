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

describe('value flags in every argv form the parser accepts (review of #268)', () => {
  const R = '<redacted>';

  it('forecast sub-brand: root options in between, and dash-leading values, in both flag forms', () => {
    expect(redactArgs(['forecast', '--json', 'sub-brand', 'add', '--seller', '42', '--name', 'Northwind Outdoors'])).toEqual(['forecast', '--json', 'sub-brand', 'add', '--seller', '42', '--name', R]);
    expect(redactArgs(['--json', 'forecast', '--data-dir', 'x', 'sub-brand', 'add', '--item-label=Northwind', '--campaign-label', 'north'])).toEqual(['--json', 'forecast', '--data-dir', 'x', 'sub-brand', 'add', `--item-label=${R}`, '--campaign-label', R]);
    expect(redactArgs(['forecast', 'sub-brand', 'add', '--name', '-Northwind', '--item-label', '--promo', '--campaign-label=-x'])).toEqual(['forecast', 'sub-brand', 'add', '--name', R, '--item-label', R, `--campaign-label=${R}`]);
    expect(redactArgs(['brand', 'add', '--name', '-Northwind'])).toEqual(['brand', 'add', '--name', '-Northwind']);
  });
});

// ---------------------------------------------------------------------------
// labels command lines are redacted by ALLOWLIST (third review of #270)
// ---------------------------------------------------------------------------

describe('labels lines: an allowlist, from the first `labels` token on', () => {
  const R = '<redacted>';
  const SECRET = 'S3cret';
  const ID = '11111111-2222-4333-8444-555555555555';
  const HASH = 'ab'.repeat(32);

  it('keeps what makes telemetry useful on a normal line', () => {
    expect(redactArgs(['--json', 'labels', 'preview', '--account', '42', '--entity', 'item', '--scope', 'region', '--field', 'item_group', '--limit', '10', '--all'])).toEqual([
      '--json', 'labels', 'preview', '--account', '42', '--entity', 'item', '--scope', 'region', '--field', 'item_group', '--limit', '10', '--all',
    ]);
    expect(redactArgs(['labels', 'commit', ID, '--commit'])).toEqual(['labels', 'commit', ID, '--commit']);
    expect(redactArgs(['labels', 'sets', '--account', '42', '--before', '2026-11-12T10:00:00.000000Z', '--limit=20'])).toEqual(['labels', 'sets', '--account', '42', '--before', '2026-11-12T10:00:00.000000Z', '--limit=20']);
    expect(redactArgs(['labels', 'preview', '--account', '42', '--clear', 'tag_1', '--rename', 'item_group'])).toEqual(['labels', 'preview', '--account', '42', '--clear', 'tag_1', '--rename', 'item_group']);
  });

  it('redacts ids, values, names, where clauses, file paths, cursors, data dirs and hashes', () => {
    expect(
      redactArgs(['labels', 'preview', '--account', '42', '--ids', 'B0EXAMPLE01', '--ids-file', 'ids.txt', '--file', 'c.csv', '--set', 'item_group=Example', '--where', 'brand=Acme', '--from', 'Old', '--to', 'New', '--name', 'Pattern', '--cursor', 'abc', '--data-dir', 'C:/x', '--approval-hash', HASH]),
    ).toEqual(['labels', 'preview', '--account', '42', '--ids', R, '--ids-file', R, '--file', R, '--set', R, '--where', R, '--from', R, '--to', R, '--name', R, '--cursor', R, '--data-dir', R, '--approval-hash', R]);
    expect(redactArgs(['labels', 'search', '--account=42', '--field=tag_1', '--value=Spring Promo', '--file=c.csv'])).toEqual(['labels', 'search', '--account=42', '--field=tag_1', `--value=${R}`, `--file=${R}`]);
  });

  it('a value that does not have its flag shape is redacted too', () => {
    expect(redactArgs(['labels', 'preview', '--account', 'Secret Co', '--entity', SECRET, '--scope', SECRET, '--field', 'has space', '--limit', SECRET])).toEqual(['labels', 'preview', '--account', R, '--entity', R, '--scope', R, '--field', R, '--limit', R]);
    expect(redactArgs(['labels', 'sets', '--before', SECRET, `--account=${SECRET}`])).toEqual(['labels', 'sets', '--before', R, `--account=${R}`]);
  });

  it('the lines the third review found', () => {
    const lines: string[][] = [
      ['--profile', 'p', 'labels', 'search', '--value', SECRET],
      ['-o', 'x', 'labels', 'search', '--value', SECRET],
      ['--format', 'json', 'labels', 'preview', '--set', `item_group=${SECRET}`],
      ['labels', 'set', '--account', '42', '--ids', 'B0A', '--set', `item_group=${SECRET}`],
      ['labels', 'get', '--value', SECRET],
      ['labels', '--from', 'get', '--to', SECRET, 'preview'],
      ['labels', 'preview', '--to', 'Brand', `Defense${SECRET}`],
      // the second review's lines, and the first's
      ['labels', '--account', '42', 'search', '--field', 'brand', '--value', SECRET],
      ['labels', '--account', '42', 'preview', '--set', `item_group=${SECRET}`],
      ['--surface', 'labels', 'labels', 'search', '--value', SECRET],
      ['--data-dir', 'labels', 'labels', 'preview', '--set', `item_group=${SECRET}`],
      ['labels', 'previw', '--set', `item_group=${SECRET}`],
      ['labels', 'preview', '--account', '42', '--rename', 'objective', '--from', 'search', '--to', SECRET],
      ['labels', 'preview', '--account', '42', '--ids-file', 'search', '--set', `item_group=${SECRET}`],
      ['data', 'query', '--name', 'labels', 'search', '--value', SECRET],
    ];
    for (const argv of lines) expect(redactArgs(argv).join(' '), argv.join(' ')).not.toContain(SECRET);
    expect(redactArgs(['labels', 'preview', '--to', 'Brand', `Defense${SECRET}`])).toEqual(['labels', 'preview', '--to', R, R]);
    expect(redactArgs(['labels', '--from', 'get', '--to', SECRET, 'preview'])).toEqual(['labels', '--from', R, '--to', R, 'preview']);
  });

  it('property: no flag off the allowlist, in either form, at any position, with stray positionals, ever shows the secret', () => {
    const offList = ['value', 'set', 'where', 'from', 'to', 'name', 'ids', 'ids-file', 'file', 'cursor', 'approval-hash', 'data-dir', 'bogus', 'x'];
    const subs: Array<string | null> = ['state', 'fields', 'get', 'search', 'drift', 'changes', 'preview', 'commit', 'undo', 'sets', 'set', 'cancel', 'field-name', 'previw', null];
    const secrets = [SECRET, `item_group=${SECRET}`, `-${SECRET}`, `--${SECRET}`];
    for (const flag of offList) {
      for (const sub of subs) {
        for (const secret of secrets) {
          const forms: string[][] = [[`--${flag}`, secret], [`--${flag}=${secret}`], [`-${flag[0]}`, secret]];
          for (const form of forms) {
            const mid = [...(sub ? [sub] : [])];
            const argvs = [
              ['labels', ...mid, '--account', '42', ...form],
              ['labels', ...form, ...mid, '--account', '42'],
              ['--json', 'labels', '--data-dir', 'x', ...mid, ...form, 'stray', SECRET],
              ['--profile', 'p', 'labels', ...form, 'Brand', SECRET, ...mid],
            ];
            for (const argv of argvs) {
              const out = redactArgs(argv).join(' ');
              // The stray positional and the flag value are always secret; the flag name itself is never the secret.
              expect(out, argv.join(' ')).not.toContain(SECRET);
            }
          }
        }
      }
    }
  });

  it('lines with no labels token are exactly what they were before (other command groups)', () => {
    expect(redactArgs(['brand', 'add', '--name', 'Northwind', '--seller-id', '42'])).toEqual(['brand', 'add', '--name', 'Northwind', '--seller-id', '42']);
    expect(redactArgs(['ads', 'call', 'sp.list_campaigns', '--profile-id', '123', '--query', 'maxResults=10', '--token', 'abc123', '--value', 'keep me'])).toEqual(['ads', 'call', 'sp.list_campaigns', '--profile-id', '123', '--query', 'maxResults=10', '--token', R, '--value', 'keep me']);
    expect(redactArgs(['amazon', 'report', 'run', '--type', 'GET_X', '--option', 'reportPeriod=DAY', '--client-secret', 'shh'])).toEqual(['amazon', 'report', 'run', '--type', 'GET_X', '--option', 'reportPeriod=DAY', '--client-secret', R]);
    expect(redactArgs(['forecast', 'budget', '--set', '2026-12=5000', '--note', 'Q4 push'])).toEqual(['forecast', 'budget', '--set', `2026-12=${R}`, '--note', R]);
    expect(redactArgs(['forecast', 'sub-brand', 'add', '--seller', '42', '--name', 'Northwind Outdoors', '--item-label', 'North'])).toEqual(['forecast', 'sub-brand', 'add', '--seller', '42', '--name', R, '--item-label', R]);
    expect(redactArgs(['shelf', 'featured-offer-check', '--asins', 'B0EXAMPLE01,B0EXAMPLE02', '--marketplace', 'US'])).toEqual(['shelf', 'featured-offer-check', '--asins', 'B0EXAMPLE01,B0EXAMPLE02', '--marketplace', 'US']);
    expect(redactArgs(['auth', 'service-setup', '--setup-code', 'SVC-ABCD-EFGH', '--client-id', 'svc_public'])).toEqual(['auth', 'service-setup', '--setup-code', R, '--client-id', 'svc_public']);
    expect(redactArgs(['data', 'query', '--sql', 'select 1', '--name', 'x'])).toEqual(['data', 'query', '--sql', 'select 1', '--name', 'x']);
  });

  it('tokens before the first labels token: only the root flags the CLI has survive', () => {
    expect(redactArgs(['--token', 'abc', 'labels', 'state'])).toEqual([R, R, 'labels', 'state']);
    expect(redactArgs(['--json', '--verbose', '--surface', 'cli', '--data-dir', 'C:/x', 'labels', 'state'])).toEqual(['--json', '--verbose', '--surface', 'cli', '--data-dir', R, 'labels', 'state']);
  });
});

describe('labels lines: two passes, most redacted wins (fourth review of #270)', () => {
  const R = '<redacted>';
  const SECRET = 'S3cret';

  it('secrets BEFORE the labels token, case variants and =labels triggers are redacted', () => {
    const lines: string[][] = [
      ['--value', SECRET, 'labels', 'search'],
      ['--set', `item_group=${SECRET}`, 'labels', 'preview'],
      [SECRET, 'labels', 'search'],
      ['Labels', 'search', '--value', SECRET],
      ['LABELS', 'preview', '--set', `a=${SECRET}`],
      ['--x=labels', 'search', '--value', SECRET],
      ['labels', 'preview', '--clear', SECRET],
      ['labels', 'preview', '--rename', SECRET],
      ['labels', 'search', '--field', SECRET],
      ['labels', 'preview', '--account', '12345678901'],
    ];
    for (const argv of lines) expect(redactArgs(argv).join(' '), argv.join(' ')).not.toContain(SECRET);
    expect(redactArgs(['labels', 'preview', '--account', '12345678901'])).toEqual(['labels', 'preview', '--account', R]);
    expect(redactArgs(['labels', 'preview', '--account', '1234567890'])).toEqual(['labels', 'preview', '--account', '1234567890']);
    expect(redactArgs([SECRET, 'labels', 'search'])).toEqual([R, 'labels', 'search']);
  });

  it('field keys are the enumerated label fields and nothing else', () => {
    for (const key of ['item_group', 'nickname', 'brand', 'parent_asin', 'label_1', 'label_2', 'tag_1', 'tag_4', 'manager', 'objective']) {
      expect(redactArgs(['labels', 'search', '--field', key])).toEqual(['labels', 'search', '--field', key]);
    }
    expect(redactArgs(['labels', 'search', '--field', 'my_brand_x', '--clear', 'Tag_1'])).toEqual(['labels', 'search', '--field', R, '--clear', R]);
  });

  it('other command groups are byte-identical to before, including a bare `labels` as a value', () => {
    expect(redactArgs(['forecast', '--name', SECRET, '--note', 'labels', 'sub-brand', 'add'])).toEqual(['forecast', '--name', R, '--note', 'labels', 'sub-brand', 'add']);
    expect(redactArgs(['auth', 'service-setup', '--client-secret', 'labels'])).toEqual(['auth', 'service-setup', '--client-secret', R]);
    expect(redactArgs(['brand', 'add', '--name', 'labels'])).toEqual(['brand', 'add', '--name', 'labels']);
    expect(redactArgs(['data', 'query', '--name', 'labels', 'search', '--value', SECRET])).toEqual(['data', 'query', '--name', 'labels', 'search', '--value', R]);
    expect(redactArgs(['forecast', 'sub-brand', 'add', '--name', 'labels', '--item-label', SECRET])).toEqual(['forecast', 'sub-brand', 'add', '--name', R, '--item-label', R]);
  });

  it('property: secrets placed before the labels token, in every case variant, never appear', () => {
    const triggers = ['labels', 'Labels', 'LABELS', '--x=labels', '--x=LABELS'];
    const befores: string[][] = [
      [SECRET],
      ['--value', SECRET],
      [`--value=${SECRET}`],
      ['--bogus', SECRET],
      ['-o', SECRET],
      ['--profile', 'p', '--set', `item_group=${SECRET}`],
      ['--data-dir', SECRET],
      ['--surface', SECRET],
      ['--json', SECRET],
    ];
    const afters: string[][] = [['search', '--value', SECRET], ['preview', '--set', `a=${SECRET}`], ['previw', SECRET], [], ['get', '--ids', SECRET]];
    for (const t of triggers) for (const bf of befores) for (const af of afters) {
      const argv = [...bf, t, ...af];
      expect(redactArgs(argv).join(' '), argv.join(' ')).not.toContain(SECRET);
    }
  });
});
