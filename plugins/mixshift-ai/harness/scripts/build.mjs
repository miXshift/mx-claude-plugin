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
