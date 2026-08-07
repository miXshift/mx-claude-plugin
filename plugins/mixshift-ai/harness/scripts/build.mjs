// Build script — bundles src/cli.ts into a single dist/cli.js file
// that the plugin runtime can invoke directly via Bash tool.
//
// Usage: npm run build
// Output: dist/cli.js (executable, with shebang)

import * as esbuild from 'esbuild';
import { chmod, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const entryPoint = join(rootDir, 'src', 'cli.ts');
const outDir = join(rootDir, 'dist');
const outFile = join(outDir, 'cli.js');

await mkdir(outDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [entryPoint],
  // Pin the directory esbuild resolves relative paths against (module-path
  // comments, CJS wrapper keys) to the harness root, NOT process.cwd(). Without
  // this, running `npm run build` from the repo root (rather than from
  // plugins/mixshift-ai/harness/) embeds `plugins/mixshift-ai/harness/src/...`
  // module paths instead of `src/...`, which diffs the entire bundle against
  // what CI produces (CI always builds with harness/ as the working directory)
  // and fails the release-tag `git diff --exit-code -- dist/cli.js` gate.
  absWorkingDir: rootDir,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: outFile,
  // Banner adds shebang so users can run dist/cli.js directly when chmod +x.
  // The `globalThis.__filename` shim lets ESM-bundled code use CJS-style paths
  // (needed by some deps; safe to ship even when unused).
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
const __filename = (await import('node:url')).fileURLToPath(import.meta.url);
const __dirname = (await import('node:path')).dirname(__filename);
`,
  },
  sourcemap: true,
  minify: false, // keep readable for debugging; bundle is small
  metafile: true,
  logLevel: 'info',
});

// Make it executable so `./dist/cli.js` works in addition to `node dist/cli.js`
await chmod(outFile, 0o755);

// Also chmod the harness/bin/mixshift wrapper so the hook-PATH-registered
// entry stays executable across rebuilds. On Windows the mode is informational
// (Bash on Windows reads the shebang directly), but on POSIX it matters.
const binPath = join(rootDir, 'bin', 'mixshift');
try {
  await chmod(binPath, 0o755);
} catch (err) {
  // bin/mixshift might not exist yet during the very first build
  if (err && err.code !== 'ENOENT') throw err;
}

// Write a tiny metadata snapshot for build-time auditing
await writeFile(
  join(outDir, 'build-meta.json'),
  JSON.stringify(
    {
      built_at: new Date().toISOString(),
      node_version: process.version,
      entry: 'src/cli.ts',
      output_bytes: (await readFile(outFile)).length,
    },
    null,
    2,
  ),
);

console.log(`✓ built ${outFile}`);
