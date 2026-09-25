/**
 * Unit tests for the commander option parsers (mx-ops#86). Each failure must
 * be an InvalidOptionValueError (error_class `invalid_argument`) whose message
 * names the flag and the fix, and whose telemetry text carries the flag and
 * the value's shape but never the value.
 */

import { describe, it, expect } from 'vitest';
import { integerOption, keyValueOption } from './option-parsers.js';
import { InvalidOptionValueError, UserFacingError } from '../errors.js';

function thrown(fn: () => unknown): InvalidOptionValueError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidOptionValueError);
    expect(err).toBeInstanceOf(UserFacingError);
    return err as InvalidOptionValueError;
  }
  throw new Error('expected the parser to throw');
}

describe('keyValueOption', () => {
  const query = keyValueOption('--query', { bodyFlag: '--body' });

  it('accumulates pairs, keeps a value that contains "=", and a repeated key keeps its last value', () => {
    let acc = query('alpha=1', {});
    acc = query('beta=x=y', acc);
    acc = query('alpha=2', acc);
    expect(acc).toEqual({ alpha: '2', beta: 'x=y' });
  });

  it('does not mutate the default object commander passes on the first call', () => {
    const defaults = {};
    query('alpha=1', defaults);
    expect(defaults).toEqual({});
  });

  it('JSON object: names the flag, says to repeat key=value, points JSON at --body, and spells the corrected flags', () => {
    const err = thrown(() => query('{"maxResults":10,"stateFilter":"enabled"}', {}));
    expect(err.errorClass).toBe('invalid_argument');
    expect(err.flag).toBe('--query');
    expect(err.valueShape).toBe('json_object');
    expect(err.message).toContain('--query key=value');
    expect(err.message).toContain('A JSON request body, for an operation that takes one, goes in --body.');
    expect(err.message).toContain('--query maxResults=10 --query stateFilter=enabled');
  });

  it('a list of scalars is spelled as the comma-separated value', () => {
    const err = thrown(() => query('{"includedData":["summaries","attributes"],"keywords":"x"}', {}));
    expect(err.message).toContain('--query includedData=summaries,attributes --query keywords=x');
  });

  it('a list with a comma in an item, or with a non-scalar item, gets no corrected flags', () => {
    expect(thrown(() => query('{"k":["a,b"]}', {})).message).not.toContain('For this value');
    expect(thrown(() => query('{"k":[{"a":1}]}', {})).message).not.toContain('For this value');
    expect(thrown(() => query('{"k":[]}', {})).message).not.toContain('For this value');
  });

  it('a value with a single quote gets no corrected flags (no quoting works in both bash and PowerShell)', () => {
    const err = thrown(() => query(`{"keywords":"it's here"}`, {}));
    expect(err.message).toContain('--query key=value');
    expect(err.message).not.toContain('For this value');
  });

  it('JSON object containing "=" is still rejected as JSON, not split into a bogus key', () => {
    const err = thrown(() => query('{"filter":"a=b"}', {}));
    expect(err.valueShape).toBe('json_object');
  });

  it('nested JSON gets the instruction but no corrected flags', () => {
    const err = thrown(() => query('{"filter":{"state":"enabled"}}', {}));
    expect(err.message).not.toContain('For this value');
  });

  it('shell-quotes a corrected pair whose value has a space', () => {
    const err = thrown(() => query('{"name":"two words"}', {}));
    expect(err.message).toContain("--query 'name=two words'");
  });

  it('JSON array is json_array', () => {
    expect(thrown(() => query('[1,2]', {})).valueShape).toBe('json_array');
  });

  it('no "=" is missing_equals; an empty key is empty_key', () => {
    expect(thrown(() => query('maxResults', {})).valueShape).toBe('missing_equals');
    expect(thrown(() => query('=10', {})).valueShape).toBe('empty_key');
    expect(thrown(() => query('  =10', {})).valueShape).toBe('empty_key');
  });

  it('omits the --body hint when the command has no body flag, and shows the example when given', () => {
    const option = keyValueOption('--option', { example: 'reportPeriod=WEEK' });
    const err = thrown(() => option('reportPeriod', {}));
    expect(err.message).toContain('--option reportPeriod=WEEK');
    expect(err.message).not.toContain('--body');
  });

  it('telemetryMessage names the flag and shape and never the value', () => {
    const err = thrown(() => query('{"sku":"SYNTH-SKU-001"}', {}));
    expect(err.telemetryMessage).toBe('invalid value for --query (json_object)');
    expect(err.telemetryMessage).not.toContain('SYNTH-SKU-001');
  });

  describe('parameters joined with "&" in one value', () => {
    it('is ampersand_joined, says why, and spells one flag per parameter', () => {
      const err = thrown(() =>
        query('details=true&granularityType=Marketplace&nextToken=SYNTH+/SYNTH=', {}),
      );
      expect(err.errorClass).toBe('invalid_argument');
      expect(err.flag).toBe('--query');
      expect(err.valueShape).toBe('ampersand_joined');
      expect(err.message.startsWith('--query takes one key=value pair per flag')).toBe(true);
      expect(err.message).toContain('--query key=value');
      expect(err.message).toContain(
        'For this value: --query details=true --query granularityType=Marketplace --query nextToken=SYNTH+/SYNTH=',
      );
    });

    it('splits only where a name= follows, keeping a bare "&" and an "=" inside a value', () => {
      const err = thrown(() => query('sku=SYNTH&SKU&filter=a=b', {}));
      expect(err.message).toContain("For this value: --query 'sku=SYNTH&SKU' --query filter=a=b");
    });

    it('a PascalCase name (SP-API v0: QueryType, NextToken) counts as a join', () => {
      const err = thrown(() => query('QueryType=SHIPMENT&NextToken=SYNTHTOKEN', {}));
      expect(err.valueShape).toBe('ampersand_joined');
      expect(err.message).toContain('For this value: --query QueryType=SHIPMENT --query NextToken=SYNTHTOKEN');
    });

    it('drops URL leftovers from the corrected flags: a doubled "&&", a trailing "&", a leading "?"', () => {
      for (const v of ['details=true&&nextToken=x', 'details=true&nextToken=x&', '?details=true&nextToken=x']) {
        expect(thrown(() => query(v, {})).message).toContain(
          'For this value: --query details=true --query nextToken=x',
        );
      }
    });

    it('a key given twice gets no corrected flags, since the last would silently win', () => {
      const err = thrown(() => query('marketplaceIds=SYNTHMKT1&marketplaceIds=SYNTHMKT2', {}));
      expect(err.valueShape).toBe('ampersand_joined');
      expect(err.message).not.toContain('For this value');
    });

    it('JSON whose value would itself be rejected as joined gets no corrected flags', () => {
      const err = thrown(() => query('{"sku":"SYNTH&QTY=2"}', {}));
      expect(err.valueShape).toBe('json_object');
      expect(err.message).not.toContain('For this value');
    });

    it('uses the trimmed key in the corrected flags', () => {
      const err = thrown(() => query(' details =true&nextToken=x', {}));
      expect(err.message).toContain('For this value: --query details=true --query nextToken=x');
    });

    it('a pair with a single quote gets the instruction but no corrected flags', () => {
      const err = thrown(() => query("keywords=it's&details=true", {}));
      expect(err.valueShape).toBe('ampersand_joined');
      expect(err.message).not.toContain('For this value');
    });

    it('telemetryMessage carries the shape and none of the values', () => {
      const err = thrown(() => query('sku=SYNTH-SKU-001&nextToken=SYNTHTOKEN', {}));
      expect(err.telemetryMessage).toBe('invalid value for --query (ampersand_joined)');
      expect(err.telemetryMessage).not.toContain('SYNTH');
    });

    it('a literal "&" inside a value is accepted', () => {
      for (const v of ['SALT&PEPPER', 'salt & pepper', 'a&', 'a&&b', 'a&1=b', 'a& b=c', 'a&=b', 'a&amp;b']) {
        expect(query(`keywords=${v}`, {})).toEqual({ keywords: v });
      }
    });

    it('an "&" in the key, before the first "=", is left alone', () => {
      expect(query('a&b=c', {})).toEqual({ 'a&b': 'c' });
      expect(thrown(() => query('a&b=c&d=e', {})).message).toContain(
        "For this value: --query 'a&b=c' --query d=e",
      );
    });

    it('--path accepts a SKU with "&" in it', () => {
      const path = keyValueOption('--path', { bodyFlag: '--body' });
      expect(path('sellerSku=SYNTH&SKU-01', {})).toEqual({ sellerSku: 'SYNTH&SKU-01' });
      expect(path('sellerSku=R&D-KIT', {})).toEqual({ sellerSku: 'R&D-KIT' });
    });

    it('--option (amazon report) is checked the same way', () => {
      const option = keyValueOption('--option', { example: 'reportPeriod=WEEK' });
      const err = thrown(() => option('reportPeriod=WEEK&distributorView=MANUFACTURING', {}));
      expect(err.valueShape).toBe('ampersand_joined');
      expect(err.message).toContain(
        'For this value: --option reportPeriod=WEEK --option distributorView=MANUFACTURING',
      );
      expect(option('sellingProgram=R&D', {})).toEqual({ sellingProgram: 'R&D' });
    });
  });
});

describe('integerOption', () => {
  it('parses integers with parseInt leniency', () => {
    expect(integerOption('--limit')('25')).toBe(25);
    expect(integerOption('--limit')('-3')).toBe(-3);
  });

  it('non-integer is not_integer and names the flag', () => {
    const err = thrown(() => integerOption('--limit')('ten'));
    expect(err.errorClass).toBe('invalid_argument');
    expect(err.valueShape).toBe('not_integer');
    expect(err.message).toContain('--limit expects an integer');
  });

  it('below the floor is below_minimum', () => {
    const err = thrown(() => integerOption('--interval-ms', { min: 0 })('-5'));
    expect(err.valueShape).toBe('below_minimum');
    expect(err.message).toContain('--interval-ms');
    expect(integerOption('--interval-ms', { min: 0 })('0')).toBe(0);
  });

  it('warehouse --seller-id given an AmazonSellerID is merchant_token and points at legacySellerId', () => {
    const err = thrown(() =>
      integerOption('--seller-id', { warehouseSellerId: true })('A1SYNTHETIC0001'),
    );
    expect(err.valueShape).toBe('merchant_token');
    expect(err.message).toContain('--seller-id takes the numeric warehouse SellerID');
    expect(err.message).toContain('legacySellerId');
    expect(err.message).toContain('mixshift amazon merchants');
    expect(err.message).toContain('mixshift ads profiles');
    expect(err.message).toContain('not the AmazonSellerID');
    expect(err.telemetryMessage).toBe('invalid value for --seller-id (merchant_token)');
    expect(err.telemetryMessage).not.toContain('A1SYNTHETIC0001');
  });

  it('warehouse --seller-id given other text is not_integer with the same pointer', () => {
    const err = thrown(() => integerOption('--seller-id', { warehouseSellerId: true })('acme'));
    expect(err.valueShape).toBe('not_integer');
    expect(err.message).toContain('legacySellerId');
    expect(err.message).not.toContain('not the AmazonSellerID');
  });
});
