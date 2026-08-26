import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('../lib/auth/actor-email.js', () => ({
  resolveActorEmail: vi.fn(async () => undefined),
}));

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual,
    track: vi.fn(async () => {}),
    maybeFlush: vi.fn(async () => ({ status: 'sent', events_sent: 1 })),
  };
});

import { registerFeedbackCommand } from './feedback.js';
import { track } from '../lib/telemetry/index.js';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerFeedbackCommand(program);
  return program;
}

describe('feedback command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('preserves a report beyond the former 2,000-character client cap', async () => {
    const report = `capture-integrity:${'x'.repeat(2_001)}`;

    await buildProgram().parseAsync(['node', 'mixshift', 'feedback', report]);

    expect(track).toHaveBeenCalledOnce();
    expect(vi.mocked(track).mock.calls[0][0]).toMatchObject({
      payload: { message: report },
    });
  });

  it('carries capability_gap through to the event payload', async () => {
    // The category the AGENT files, not the user: a step of the user's task had
    // no MixShift operation, so the work left MixShift. It is the only record
    // of that class of miss -- an uncataloged operation id is refused before
    // any request is issued, so a gap the agent routes around emits nothing at
    // all. If this stops reaching the payload, the gap goes back to invisible.
    await buildProgram().parseAsync([
      'node',
      'mixshift',
      'feedback',
      'No SB ad-creation operation; placed 12 video creatives by hand in the console.',
      '--category',
      'capability_gap',
      '--skill',
      'mx-amazon-ads',
    ]);

    expect(track).toHaveBeenCalledOnce();
    expect(vi.mocked(track).mock.calls[0][0]).toMatchObject({
      // skill_id rides INSIDE payload, alongside category, not at the top
      // level of the event.
      payload: { category: 'capability_gap', skill_id: 'mx-amazon-ads' },
    });
  });

  it('still defaults to comment when no category is given', async () => {
    await buildProgram().parseAsync(['node', 'mixshift', 'feedback', 'just a note']);

    expect(vi.mocked(track).mock.calls[0][0]).toMatchObject({
      payload: { category: 'comment' },
    });
  });
});
