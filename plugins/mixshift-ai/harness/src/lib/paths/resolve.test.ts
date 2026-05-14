import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
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
    expect(resolveDataDir()).toBe(resolve(join(homedir(), '.mixshift')));
  });

  it('uses MIXSHIFT_DATA_DIR env var when set', () => {
    process.env.MIXSHIFT_DATA_DIR = '/tmp/test-mixshift';
    // resolve() normalizes platform quirks — on Windows a drive-relative
    // absolute like "/tmp/x" becomes "C:\tmp\x"; on POSIX it stays "/tmp/x".
    expect(resolveDataDir()).toBe(resolve('/tmp/test-mixshift'));
  });

  it('explicit override beats env var', () => {
    process.env.MIXSHIFT_DATA_DIR = '/tmp/from-env';
    expect(resolveDataDir('/tmp/explicit')).toBe(resolve('/tmp/explicit'));
  });

  it('resolves relative paths to absolute', () => {
    const result = resolveDataDir('./relative/path');
    expect(isAbsolute(result)).toBe(true);
  });

  it('normalizes drive-relative absolute paths on Windows', () => {
    const result = resolveDataDir('/tmp/mx');
    expect(isAbsolute(result)).toBe(true);
    if (process.platform === 'win32') {
      // Windows: must have a drive letter prefix, no leading slash.
      expect(result).toMatch(/^[A-Z]:\\/);
    } else {
      expect(result).toBe('/tmp/mx');
    }
  });
});

describe('path helpers', () => {
  // Path helpers route their dataDir arg through resolveDataDir(), which
  // normalizes on Windows. Tests use resolve(dataDir) in expectations so
  // they're platform-portable.
  const dataDir = '/tmp/test-mixshift';
  const resolvedRoot = resolve(dataDir);

  it('profilePath puts profile.yaml at the data root', () => {
    expect(profilePath(dataDir)).toBe(join(resolvedRoot, 'profile.yaml'));
  });

  it('brandDir nests under clients/', () => {
    expect(brandDir('acmecorp', dataDir)).toBe(
      join(resolvedRoot, 'clients', 'acmecorp'),
    );
  });

  it('contextPath drills into brand dir', () => {
    expect(contextPath('acmecorp', dataDir)).toBe(
      join(resolvedRoot, 'clients', 'acmecorp', 'context.yaml'),
    );
  });
});
