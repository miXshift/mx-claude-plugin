import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import {
  resolveDataDir,
  profilePath,
  brandDir,
  contextPath,
  intelligenceOutputPath,
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

  // ---------------------------------------------------------------------
  // brandDir SECURITY: reject anything that would escape clients/ via
  // path.join — every caller is expected to pre-validate with
  // isSafeBrandSlug (lib/context-sync/local.ts), but brandDir must refuse
  // unsafe input unconditionally as a second, unbypassable layer.
  // ---------------------------------------------------------------------
  describe('brandDir safety', () => {
    it('throws on a slug containing ..', () => {
      expect(() => brandDir('../../evil', dataDir)).toThrow();
    });

    it('throws on a slug containing a forward slash', () => {
      expect(() => brandDir('a/b', dataDir)).toThrow();
    });

    it('throws on a slug containing a backslash', () => {
      expect(() => brandDir('a\\b', dataDir)).toThrow();
    });

    it('throws on an absolute-path-shaped slug', () => {
      expect(() => brandDir('/etc/passwd', dataDir)).toThrow();
    });

    it('throws on an empty slug', () => {
      expect(() => brandDir('', dataDir)).toThrow();
    });

    it('still resolves an ordinary slug', () => {
      expect(brandDir('acme-co', dataDir)).toBe(join(resolvedRoot, 'clients', 'acme-co'));
    });
  });
});

// ---------------------------------------------------------------------
// intelligenceOutputPath — filename collision avoidance (nonce)
// ---------------------------------------------------------------------
describe('intelligenceOutputPath', () => {
  const dataDir = '/tmp/test-mixshift-intel';
  const resolvedRoot = resolve(dataDir);

  it('uses the server runId as the filename nonce when provided', () => {
    const p = intelligenceOutputPath('INS-OPS-BRIDGE-01', 'ts1', undefined, dataDir, 'run-abc123');
    expect(p).toBe(join(resolvedRoot, 'intelligence', 'INS-OPS-BRIDGE-01-ts1-run-abc123.json'));
  });

  it('sanitizes an unusual runId before using it as a filename nonce', () => {
    const p = intelligenceOutputPath('INS-OPS-BRIDGE-01', 'ts1', undefined, dataDir, 'run/weird:id');
    const filename = p.split(/[\\/]/).pop()!;
    expect(filename).toBe('INS-OPS-BRIDGE-01-ts1-run_weird_id.json');
  });

  it('falls back to a random 6-hex suffix when no runId is given', () => {
    const p = intelligenceOutputPath('INS-OPS-BRIDGE-01', 'ts1', undefined, dataDir);
    const filename = p.split(/[\\/]/).pop()!;
    expect(filename).toMatch(/^INS-OPS-BRIDGE-01-ts1-[0-9a-f]{6}\.json$/);
  });

  it('two calls with the same id/timestamp and no runId do not collide', () => {
    const a = intelligenceOutputPath('INS-OPS-BRIDGE-01', 'same-ts', undefined, dataDir);
    const b = intelligenceOutputPath('INS-OPS-BRIDGE-01', 'same-ts', undefined, dataDir);
    expect(a).not.toBe(b);
  });

  it('nests under the brand dir when a brand slug is given, nonce included', () => {
    const p = intelligenceOutputPath('INS-OPS-BRIDGE-01', 'ts1', 'acmecorp', dataDir, 'run-1');
    expect(p).toBe(
      join(
        resolvedRoot,
        'clients',
        'acmecorp',
        'runs',
        'intelligence',
        'INS-OPS-BRIDGE-01-ts1-run-1.json',
      ),
    );
  });
});
