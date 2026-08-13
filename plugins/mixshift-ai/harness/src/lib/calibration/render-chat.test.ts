import { describe, it, expect } from 'vitest';
import {
  renderConfirmationCard,
  joinCard,
  renderPersistenceFooter,
} from './render-chat.js';
import type {
  ConfirmationPayload,
  ConfirmationFieldEntry,
  ApplyResult,
} from './confirm-flow.js';
import type { CalibrationField } from './manifest-schema.js';

function pctField(
  id: string,
  label: string,
  seed_from?: string,
  required = false,
): CalibrationField {
  return {
    id,
    label,
    prompt: `${label}?`,
    type: 'percent',
    range: { min: 0.05, max: 1 },
    seed_from,
    required,
    deprecated: false,
  } as CalibrationField;
}

function entry(
  field: CalibrationField,
  source: ConfirmationFieldEntry['source'],
): ConfirmationFieldEntry {
  return {
    field,
    stored_value: undefined,
    seed_value: undefined,
    default_value: undefined,
    effective_value: undefined,
    source,
    display: '(not set)',
  };
}

function payload(
  is_first_run: boolean,
  fields: ConfirmationFieldEntry[],
): ConfirmationPayload {
  const missing_keys = fields
    .filter((e) => e.field.required && e.source === 'missing')
    .map((e) => e.field.id);
  return {
    skill_id: 'mx-keyword-bid-health',
    brand_slug: 'summit',
    brand_name: 'Summit',
    is_first_run,
    fields,
    extras: {},
    blocking: {
      has_missing_required: missing_keys.length > 0,
      missing_keys,
    },
  };
}

describe('renderConfirmationCard — first-run capture nudge', () => {
  it('surfaces the nudge on first run, tagging each field with its tier', () => {
    const p = payload(true, [
      // seed maps to a registered brand-context field -> shared.
      entry(
        pctField('acos_target', 'ACoS target', 'context.management.acos_target_pct'),
        'missing',
      ),
      // seed not registered -> this skill.
      entry(
        pctField(
          'scale_threshold_pct',
          'Scale threshold',
          'context.bid_health.scale_threshold_pct',
        ),
        'missing',
      ),
    ]);
    const card = renderConfirmationCard(p, { skill_display_name: 'KBH' });
    expect(card.capture_note).not.toBeNull();
    const text = joinCard(card);
    expect(text).toContain('First run for Summit');
    expect(text).toContain('ACoS target  (shared brand context)');
    expect(text).toContain('Scale threshold  (this skill)');
  });

  it('omits the nudge on subsequent runs', () => {
    const p = payload(false, [
      entry(
        pctField('acos_target', 'ACoS target', 'context.management.acos_target_pct'),
        'missing',
      ),
    ]);
    const card = renderConfirmationCard(p, { skill_display_name: 'KBH' });
    expect(card.capture_note).toBeNull();
    expect(joinCard(card)).not.toContain('First run for');
  });

  it('omits the nudge when nothing is unset (all seeded)', () => {
    const e = entry(
      pctField('acos_target', 'ACoS target', 'context.management.acos_target_pct'),
      'seed',
    );
    e.effective_value = 0.22;
    e.display = '22%';
    const card = renderConfirmationCard(payload(true, [e]), {
      skill_display_name: 'KBH',
    });
    expect(card.capture_note).toBeNull();
  });

  it('caps the nudge at 3 fields', () => {
    const fields = ['a', 'b', 'c', 'd'].map((id) =>
      entry(pctField(id, `Field ${id}`, 'context.management.acos_target_pct'), 'missing'),
    );
    const card = renderConfirmationCard(payload(true, fields), {
      skill_display_name: 'KBH',
    });
    const bullets = (card.capture_note ?? '')
      .split('\n')
      .filter((l) => l.trim().startsWith('- '));
    expect(bullets).toHaveLength(3);
  });
});

// F5 (red-team review): a bound sub-brand's ACCOUNT-WIDE brain
// pre-fill must be visibly labeled at the confirm step — never presented as
// an ordinary pre-fill the same way an unbound brand's own value would be.
describe('renderSourceHint (via renderConfirmationCard) — F5 account-wide seed', () => {
  it('gets a LOUD, distinct hint when the seed is an account-wide brain pre-fill', () => {
    const e = entry(
      pctField('acos_target', 'ACoS target', 'context.management.acos_target_pct'),
      'seed',
    );
    e.effective_value = 0.25;
    e.display = '25%';
    e.account_wide = true;
    const text = joinCard(renderConfirmationCard(payload(false, [e]), { skill_display_name: 'KBH' }));
    expect(text).toContain('ACCOUNT-WIDE');
    expect(text).toContain("not this sub-brand's own number");
    // Must NOT also print the ordinary provenance-neutral hint.
    expect(text).not.toContain('pre-filled from your brand context');
  });

  it('gets the ORDINARY seed hint (unchanged) when the seed is this brand\'s own', () => {
    const e = entry(
      pctField('acos_target', 'ACoS target', 'context.management.acos_target_pct'),
      'seed',
    );
    e.effective_value = 0.25;
    e.display = '25%';
    // account_wide left undefined — the unbound / properly-scoped case.
    const text = joinCard(renderConfirmationCard(payload(false, [e]), { skill_display_name: 'KBH' }));
    expect(text).toContain('pre-filled from your brand context');
    expect(text).not.toContain('ACCOUNT-WIDE');
  });
});

describe('renderPersistenceFooter — end-of-run "I learned X"', () => {
  const persisted = (
    captured?: ApplyResult['captured'],
    account_wide_fields?: ApplyResult['account_wide_fields'],
  ): ApplyResult => ({
    status: 'ok',
    effective_config: {},
    did_persist: true,
    saved_to: '/x/config.yaml',
    validation_issues: [],
    captured,
    account_wide_fields,
  });

  it('names captured shared fields after a persisted edit', () => {
    const out = renderPersistenceFooter(
      persisted([{ label: 'ACoS target', value: '22%' }]),
      'Summit',
      'KBH',
    );
    expect(out).toContain("Saved your edits to Summit's KBH config.");
    expect(out).toContain('Learned for Summit: ACoS target = 22%');
    expect(out).toContain('apply across your skills');
  });

  it('omits the learned line when no shared field was captured', () => {
    const out = renderPersistenceFooter(persisted([]), 'Summit', 'KBH');
    expect(out).toContain('Saved your edits');
    expect(out).not.toContain('Learned for');
  });

  it('is empty on a use-once run (no persist)', () => {
    const out = renderPersistenceFooter(
      {
        status: 'ok',
        effective_config: {},
        did_persist: false,
        saved_to: null,
        validation_issues: [],
      },
      'Summit',
      'KBH',
    );
    expect(out).toBe('');
  });

  it('F5: names account-wide fields that rode into this save unedited', () => {
    const out = renderPersistenceFooter(
      persisted([], ['acos_target']),
      'Summit',
      'KBH',
    );
    expect(out).toContain('acos_target');
    expect(out).toContain("account-wide brain pre-fill");
    expect(out).toContain("not a number specific to this sub-brand");
  });

  it('omits the account-wide note when nothing account-wide rode into the save', () => {
    const out = renderPersistenceFooter(persisted([]), 'Summit', 'KBH');
    expect(out).not.toContain('account-wide');
  });
});
