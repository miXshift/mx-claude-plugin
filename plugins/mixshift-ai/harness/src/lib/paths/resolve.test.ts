import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import {
  resolveDataDir,
  profilePath,
  brandDir,
  contextPath,
} from './resolve.js';

describe('resolveDataDir', () => {
  const originalEnv = process.env.MIXSHIFT_DATA_DIR;

  beforeEach(() => {
    delete process.env.MIXSHIFT_DATA_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MIXSHIFT_DATA_DIR;
    } else {
      process.env.MIXSHIFT_DATA_DIR = originalEnv;
    }
  });

  it('defaults to ~/.mixshift when nothing is set', () => {
    expect(resolveDataDir()).toBe(join(homedir(), '.mixshift'));
  });

  it('uses MIXSHIFT_DATA_DIR env var when set', () => {
    process.env.MIXSHIFT_DATA_DIR = '/tmp/test-mixshift';
    expect(resolveDataDir()).toBe('/tmp/test-mixshift');
  });

  it('explicit override beats env var', () => {
    process.env.MIXSHIFT_DATA_DIR = '/tmp/from-env';
    expect(resolveDataDir('/tmp/explicit')).toBe('/tmp/explicit');
  });

  it('resolves relative paths to absolute', () => {
    const result = resolveDataDir('./relative/path');
    expect(isAbsolute(result)).toBe(true);
  });
});

describe('path helpers', () => {
  const dataDir = '/tmp/test-mixshift';

  it('profilePath puts profile.yaml at the data root', () => {
    expect(profilePath(dataDir)).toBe(join(dataDir, 'profile.yaml'));
  });

  it('brandDir nests under clients/', () => {
    expect(brandDir('acmecorp', dataDir)).toBe(
      join(dataDir, 'clients', 'acmecorp'),
    );
  });

  it('contextPath drills into brand dir', () => {
    expect(contextPath('acmecorp', dataDir)).toBe(
      join(dataDir, 'clients', 'acmecorp', 'context.yaml'),
    );
  });
});
