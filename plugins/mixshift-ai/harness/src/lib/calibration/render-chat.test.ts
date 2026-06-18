import { describe, it, expect } from 'vitest';
import { renderConfirmationCard, joinCard } from './render-chat.js';
import type {
  ConfirmationPayload,
  ConfirmationFieldEntry,
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
