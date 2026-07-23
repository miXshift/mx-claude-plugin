/**
 * Pins deriveSubmissionsEndpoint's two accepted endpoint shapes (the shipped
 * gateway default and the PostgREST env-override) and its refuse-everything-
 * else contract. This regex is the ONE place in the harness that assumes a
 * shape for the telemetry endpoint; when the endpoint moves, this file is the
 * canary (the 0.8.6 gateway flip would have silently killed `mixshift
 * share-skill` without it).
 */

import { describe, it, expect } from 'vitest';
import { deriveSubmissionsEndpoint } from './submit.js';

describe('deriveSubmissionsEndpoint', () => {
  it('maps the gateway events endpoint to the gateway submissions endpoint', () => {
    expect(deriveSubmissionsEndpoint('https://mcp.mixshift.io/telemetry/events')).toBe(
      'https://mcp.mixshift.io/telemetry/submissions',
    );
    expect(deriveSubmissionsEndpoint('https://mcp.mixshift.io/telemetry/events/')).toBe(
      'https://mcp.mixshift.io/telemetry/submissions',
    );
  });

  it('maps a PostgREST events endpoint to its skill_submissions sibling', () => {
    expect(
      deriveSubmissionsEndpoint('https://izurufltfnwxsljvtksy.supabase.co/rest/v1/events'),
    ).toBe('https://izurufltfnwxsljvtksy.supabase.co/rest/v1/skill_submissions');
  });

  it('refuses anything that is not a known events-endpoint shape', () => {
    expect(deriveSubmissionsEndpoint('')).toBeNull();
    expect(deriveSubmissionsEndpoint('https://mcp.mixshift.io/telemetry/eventsX')).toBeNull();
    expect(deriveSubmissionsEndpoint('https://example.test/rest/v1/other')).toBeNull();
    expect(deriveSubmissionsEndpoint('https://example.test/events')).toBeNull();
  });
});
