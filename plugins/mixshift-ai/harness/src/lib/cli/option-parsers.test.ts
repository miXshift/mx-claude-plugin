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
    expect(err.message).toContain('JSON goes in --body');
    expect(err.message).toContain('--query maxResults=10 --query stateFilter=enabled');
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
