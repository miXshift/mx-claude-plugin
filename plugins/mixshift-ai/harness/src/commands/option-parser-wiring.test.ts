/**
 * Every harness option parser rejects a bad value as a usage error, not a
 * crash (mx-ops#86). One case per parser site, dispatched through the real
 * command registration so a site that drifts back to a plain `Error` fails
 * here: `ads call` / `amazon call` --query and --path, `amazon report`
 * --option, `amazon report run` --interval-ms / --max-wait-ms, and the
 * `data` integer flags (--seller-id, --limit, --max-rows, --rows).
 *
 * The parsers run during option parsing, before any action, so nothing here
 * reaches the network.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { registerAdsCommands } from './ads.js';
import { registerAmazonCommands } from './amazon.js';
import { registerDataCommands } from './data.js';
import { InvalidOptionValueError } from '../lib/errors.js';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', 'emit machine-readable JSON to stdout', false);
  registerAdsCommands(program);
  registerAmazonCommands(program);
  registerDataCommands(program);
  return program;
}

async function parseError(...args: string[]): Promise<InvalidOptionValueError> {
  try {
    await buildProgram().parseAsync(['node', 'mixshift', ...args]);
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidOptionValueError);
    return err as InvalidOptionValueError;
  }
  throw new Error(`expected "${args.join(' ')}" to be rejected`);
}

const JSON_QUERY = '{"maxResults":10}';
const JOINED_QUERY = 'details=true&nextToken=SYNTHTOKEN';

describe('option parser sites throw InvalidOptionValueError naming the flag', () => {
  it.each([
    ['ads call --query', ['ads', 'call', 'op.synthetic', '--query', JSON_QUERY], '--query', 'json_object'],
    ['ads call --path', ['ads', 'call', 'op.synthetic', '--path', 'reportId'], '--path', 'missing_equals'],
    ['amazon call --query', ['amazon', 'call', 'op.synthetic', '--query', JSON_QUERY], '--query', 'json_object'],
    ['amazon call --path', ['amazon', 'call', 'op.synthetic', '--path', '=x'], '--path', 'empty_key'],
    ['amazon report start --option', ['amazon', 'report', 'start', '--type', 'T', '--option', '{"a":"b"}'], '--option', 'json_object'],
    ['amazon report run --option', ['amazon', 'report', 'run', '--type', 'T', '--option', 'reportPeriod'], '--option', 'missing_equals'],
    ['ads call --query joined', ['ads', 'call', 'op.synthetic', '--query', JOINED_QUERY], '--query', 'ampersand_joined'],
    ['amazon call --query joined', ['amazon', 'call', 'op.synthetic', '--query', JOINED_QUERY], '--query', 'ampersand_joined'],
    ['amazon call --path joined', ['amazon', 'call', 'op.synthetic', '--path', 'sku=X&marketplaceIds=Y'], '--path', 'ampersand_joined'],
    ['amazon report start --option joined', ['amazon', 'report', 'start', '--type', 'T', '--option', 'a=1&b=2'], '--option', 'ampersand_joined'],
    ['amazon report run --interval-ms', ['amazon', 'report', 'run', '--type', 'T', '--interval-ms', '-5'], '--interval-ms', 'below_minimum'],
    ['amazon report run --max-wait-ms', ['amazon', 'report', 'run', '--type', 'T', '--max-wait-ms', 'soon'], '--max-wait-ms', 'not_integer'],
    ['data sample --seller-id', ['data', 'sample', '--table', 't', '--seller-id', 'A1SYNTHETIC0001'], '--seller-id', 'merchant_token'],
    ['data sample --limit', ['data', 'sample', '--table', 't', '--limit', 'ten'], '--limit', 'not_integer'],
    ['data export --seller-id', ['data', 'export', '--table', 't', '--seller-id', 'A1SYNTHETIC0001'], '--seller-id', 'merchant_token'],
    ['data export --max-rows', ['data', 'export', '--table', 't', '--max-rows', 'lots'], '--max-rows', 'not_integer'],
    ['data query --rows', ['data', 'query', '--sql', 'select 1', '--rows', 'many'], '--rows', 'not_integer'],
    ['data asin-titles --seller-id', ['data', 'asin-titles', '--asins', 'B0SYNTH001', '--seller-id', 'A1SYNTHETIC0001'], '--seller-id', 'merchant_token'],
  ])('%s', async (_label, args, flag, shape) => {
    const err = await parseError(...(args as string[]));
    expect(err.errorClass).toBe('invalid_argument');
    expect(err.flag).toBe(flag);
    expect(err.valueShape).toBe(shape);
    expect(err.message.startsWith(flag as string)).toBe(true);
  });

  it('the --query hint on both call commands points a JSON request body at --body', async () => {
    for (const group of ['ads', 'amazon']) {
      const err = await parseError(group, 'call', 'op.synthetic', '--query', JSON_QUERY);
      expect(err.message).toContain('goes in --body');
      expect(err.message).toContain('--query maxResults=10');
    }
  });

  it('the data --seller-id hint names legacySellerId, `mixshift amazon merchants` and `mixshift ads profiles`', async () => {
    const err = await parseError('data', 'sample', '--table', 't', '--seller-id', 'A1SYNTHETIC0001');
    expect(err.message).toContain('numeric warehouse SellerID');
    expect(err.message).toContain('legacySellerId');
    expect(err.message).toContain('mixshift amazon merchants');
    expect(err.message).toContain('mixshift ads profiles');
  });
});
