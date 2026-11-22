/**
 * Synthetic dayparting answers for tests and for the sample output in docs. Every id, figure and
 * date here is made up: this repo is public, so nothing in it comes from a real account.
 */

const hours = Array.from({ length: 24 }, (_, hour) => {
  const overnight = hour < 4;
  const spend = overnight ? 140 : 100;
  const sales = overnight ? 98 : 380;
  return {
    hour,
    spend,
    clicks: overnight ? 140 : 100,
    orders: overnight ? 2.5 : 9.5,
    sales,
    roas: Number((sales / spend).toFixed(4)),
    cpc: 1,
    cvr: overnight ? 0.018 : 0.095,
    spend_share: 0.0417,
  };
});

const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({
  weekday,
  spend: 2400,
  clicks: 2400,
  orders: 150,
  sales: 6000,
  roas: 2.5,
  cpc: 1,
  cvr: 0.0625,
  spend_share: 0.1429,
}));

export const FAKE_PROFILE_ID = '4000000001';
export const FAKE_SELLER_ID = '12345';

export const DIAGNOSE_ANSWER = {
  ok: true,
  profile_id: FAKE_PROFILE_ID,
  time_zone: 'America/Denver',
  window: { from: '2026-09-25', to: '2026-11-19' },
  matured_through: { sp: '2026-11-12', sb: '2026-11-05', sd: '2026-11-05' },
  status: 'ok',
  currency: 'USD',
  source: { state: 'fresh', data_through: '2026-11-21T08:00:00.000Z', last_checked_at: '2026-11-21T08:05:00.000Z' },
  account: { hours, weekdays },
  suggestions: [
    {
      scope: 'account',
      direction: 'cut',
      window: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '04:00', when: 'every day, midnight to 4 am', segments: [] },
      multiplier: 0.7,
      reason: 'Every day, midnight to 4 am: ROAS 0.70 against 3.95 for the account (23% of it), on 1960 clicks. Suggest bids x0.70 (30% lower).',
      window_acos: 34,
      baseline_acos: 25.3,
      target_acos: 21,
      money_at_stake: {
        weekly_spend_touched: 1230,
        estimated_weekly_spend_change: -369,
        estimated_weekly_sales_at_risk: 1105,
        assumption: 'Estimated from the matured days of this window: spend moves in proportion to the multiplier, and sales move in proportion to spend. It is a size, not a promise.',
      },
      drivers: { cvr_share: 0.6, cpc_share: 0.3, aov_share: 0.1 },
      confidence: 'medium',
      status: 'proposed',
    },
    {
      scope: 'account',
      direction: 'raise',
      window: { days: ['sat', 'sun'], from: '09:00', to: '12:00', when: 'Saturday and Sunday, 9 am to noon', segments: [] },
      multiplier: 1.15,
      reason: 'Saturday and Sunday, 9 am to noon: ROAS 5.10 against 3.95 for the account.',
      window_acos: 19.6,
      baseline_acos: 25.3,
      target_acos: 21,
      money_at_stake: { weekly_spend_touched: 300, estimated_weekly_spend_change: 45, estimated_weekly_sales_at_risk: 0, assumption: 'Estimated from the matured days of this window.' },
      confidence: 'low',
      status: 'proposed',
    },
    {
      scope: 'account',
      direction: 'cut',
      window: { days: ['tue'], from: '14:00', to: '16:00', when: 'Tuesday, 2 pm to 4 pm', segments: [] },
      multiplier: 0.8,
      reason: 'Tuesday, 2 pm to 4 pm looks weak.',
      window_acos: 30,
      baseline_acos: 25.3,
      target_acos: 21,
      confidence: 'low',
      status: 'held',
      held_reason: 'the weekday pattern shows in fewer than 6 weeks of data',
    },
  ],
  unmapped: [],
  rejected: [],
  notes: ['Campaign ids are the Marketing Stream ids and campaign names are not read here.'],
  engine: { package_version: '0.0.1', build_sha: '0000000' },
};

export const NO_SUGGESTIONS_ANSWER = { ...DIAGNOSE_ANSWER, suggestions: [] };

export const SOURCE_NOT_ENABLED = {
  ok: false,
  kind: 'source_not_enabled',
  friendly: 'Hourly Ads data (Amazon Marketing Stream) is not turned on for this account yet.',
};

export const HOURS_ANSWER = {
  ok: true,
  profile_id: FAKE_PROFILE_ID,
  time_zone: 'America/Denver',
  from: '2026-11-10',
  to: '2026-11-11',
  rows: [
    { profile_id: FAKE_PROFILE_ID, report_date: '2026-11-10', report_hour: 1, time_zone: 'America/Denver', campaign_id: '9000000001', ad_product: 'SPONSORED_PRODUCTS', impressions: 900, clicks: 40, cost: 40, sales: 28, purchases: 1, currency: 'USD' },
    { profile_id: FAKE_PROFILE_ID, report_date: '2026-11-11', report_hour: 1, time_zone: 'America/Denver', campaign_id: '9000000001', ad_product: 'SPONSORED_PRODUCTS', impressions: 800, clicks: 30, cost: 30, sales: 42, purchases: 2, currency: 'USD' },
    { profile_id: FAKE_PROFILE_ID, report_date: '2026-11-10', report_hour: 14, time_zone: 'America/Denver', campaign_id: '9000000001', ad_product: 'SPONSORED_PRODUCTS', impressions: 1500, clicks: 60, cost: 60, sales: null, purchases: null, currency: null },
  ],
  rejected: [{ reason: 'metric missing', count: 1 }],
  source: { state: 'fresh', data_through: '2026-11-21T08:00:00.000Z', last_checked_at: '2026-11-21T08:05:00.000Z' },
};
