/**
 * `mixshift share-skill <path>` — intake for user-built skills.
 *
 * A contributor points this at a skill they wrote (a SKILL.md, or a whole
 * skill directory). The command bundles the text artifact, sends it to the
 * dedicated `skill_submissions` Supabase table (uncapped jsonb — see
 * lib/submissions/submit.ts), and on success emits a small `skill.shared`
 * telemetry event that fans out to the MixShift ops Discord so a human sees
 * it in real time and can fold it into the library.
 *
 * Split of concerns, deliberately:
 *   - ARTIFACT bytes      → skill_submissions table (this is the durable copy).
 *   - SIGNAL + metadata   → skill.shared event → Discord ping (no file bytes).
 *
 * Unlike telemetry, the submit is synchronous with an honest result: we only
 * print "received" (and only ping Discord) when the artifact actually landed.
 *
 * `--dry-run` bundles + reports what WOULD be sent without sending — the
 * mx-share-skill SKILL.md uses it to show the user the exact manifest and get
 * confirmation before the real send.
 */

import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { resolve, join, relative, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadProfile } from '../lib/profile/load.js';
import { loadCredentials } from '../lib/auth/credentials.js';
import { detectSurface } from '../lib/telemetry/surface.js';
import { getPluginVersion } from '../lib/plugin-version.js';
import {
  readInstallId,
  track,
  maybeFlush,
  EventName,
} from '../lib/telemetry/index.js';
import {
  submitSkill,
  type SkillSubmissionFile,
  type SubmissionKind,
} from '../lib/submissions/submit.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

// Text we're willing to bundle. A skill is text (SKILL.md + the odd reference
// doc / helper script); we never pull binaries into a submission.
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.ts', '.tsx', '.js', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.sh', '.py', '.sql', '.csv', '.toml',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__', '.venv']);
const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 1_000_000;
const MAX_FILE_BYTES = 300_000;

const VALID_KINDS = new Set<SubmissionKind>([
  'new_skill',
  'modified_plugin_skill',
  'idea',
]);

interface Bundle {
  files: SkillSubmissionFile[];
  skipped: string[];
  totalBytes: number;
  truncated: boolean;
}

export function registerShareSkillCommand(program: Command): void {
  program
    .command('share-skill <path>')
    .description(
      'Bundle a user-built skill (a SKILL.md or a skill directory) and send it ' +
        'to MixShift for the skill library. Posts the artifact to the ' +
        'skill_submissions store and pings ops via a skill.shared event.',
    )
    .option('--name <name>', 'skill name (default: from SKILL.md frontmatter, then dir name)')
    .option('--description <text>', 'one-line description (default: from SKILL.md frontmatter)')
    .option(
      '--kind <kind>',
      'new_skill | modified_plugin_skill | idea',
      'new_skill',
    )
    .option('--base-skill <id>', 'for modified_plugin_skill: which plugin skill it changes')
    .option('--notes <text>', 'context from the contributor (what it does, why, how to use)')
    .option('--dry-run', 'preview the bundle (name, files, sizes) without sending', false)
    .action(
      async (
        pathArg: string,
        opts: {
          name?: string;
          description?: string;
          kind: string;
          baseSkill?: string;
          notes?: string;
          dryRun?: boolean;
        },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          // Validate kind early.
          const kind = opts.kind as SubmissionKind;
          if (!VALID_KINDS.has(kind)) {
            throw new Error(
              `Invalid --kind "${opts.kind}". Must be one of: ${[...VALID_KINDS].join(', ')}`,
            );
          }

          // Collect the artifact.
          const abs = resolve(pathArg);
          const bundle = await collectBundle(abs);
          if (bundle.files.length === 0) {
            throw new Error(
              `Nothing to share at ${abs}. Point me at a SKILL.md or a skill directory.`,
            );
          }

          // Name + description: explicit flags win, else SKILL.md frontmatter,
          // else fall back to the directory/file name.
          const fm = findFrontmatter(bundle.files);
          const name =
            opts.name ??
            (typeof fm?.name === 'string' ? fm.name : undefined) ??
            basename(abs).replace(/\.md$/i, '');
          const description =
            opts.description ??
            (typeof fm?.description === 'string' ? fm.description.trim() : undefined) ??
            '(no description provided)';

          if (kind === 'modified_plugin_skill' && !opts.baseSkill) {
            throw new Error(
              '--base-skill <id> is required when --kind is modified_plugin_skill ' +
                '(tell us which plugin skill this changes).',
            );
          }

          // Preview-only path: show what would be sent, send nothing, no
          // identity needed. The SKILL.md surfaces this for user confirmation.
          if (opts.dryRun) {
            if (root.json) {
              process.stdout.write(
                JSON.stringify(
                  {
                    status: 'ok',
                    dry_run: true,
                    skill_name: name,
                    kind,
                    base_skill_id: opts.baseSkill ?? null,
                    description,
                    files: bundle.files.map((f) => ({ path: f.path, bytes: f.bytes })),
                    total_bytes: bundle.totalBytes,
                    skipped: bundle.skipped,
                    truncated: bundle.truncated,
                  },
                  null,
                  2,
                ) + '\n',
              );
            } else {
              const lines = [
                '',
                'Preview (nothing sent):',
                `  name:        ${name}`,
                `  kind:        ${kind}${opts.baseSkill ? ` (changes ${opts.baseSkill})` : ''}`,
                `  description: ${description}`,
                `  files (${bundle.files.length}, ${bundle.totalBytes} bytes):`,
                ...bundle.files.map((f) => `    - ${f.path} (${f.bytes} bytes)`),
              ];
              if (bundle.skipped.length > 0) {
                lines.push(`  skipped (${bundle.skipped.length}): ${bundle.skipped.slice(0, 8).join(', ')}${bundle.skipped.length > 8 ? ', ...' : ''}`);
              }
              if (bundle.truncated) lines.push('  note: bundle hit a size/file cap and was truncated.');
              lines.push('', 'To send: re-run without --dry-run.', '');
              process.stdout.write(lines.join('\n'));
            }
            return;
          }

          // Identity — same posture as feedback: we attach a contributor email
          // so submissions are attributable. No email → bounce to sign-in.
          const { profile } = await loadProfile(root.dataDir);
          const email = profile.user?.email;
          if (!email) {
            throw new Error(
              'No user email on file. Sign in first (say "sign me in", or run ' +
                '`mixshift auth login`) so we can attribute your contribution.',
            );
          }
          let personLabel: string | undefined;
          try {
            const { credentials } = await loadCredentials(root.dataDir);
            personLabel = credentials?.datahub?.person_label ?? undefined;
          } catch {
            // no creds is fine; email from profile is enough
          }

          // Send the artifact to the durable store.
          const result = await submitSkill({
            skill_name: name,
            description,
            kind,
            base_skill_id: opts.baseSkill,
            email,
            person_label: personLabel,
            surface: detectSurface(),
            plugin_version: getPluginVersion(),
            install_id: (await readInstallId()) ?? undefined,
            files: bundle.files,
            notes: opts.notes,
          });

          if (result.status !== 'sent') {
            // Honest failure — do NOT emit skill.shared (no Discord ping for a
            // submission that didn't land) and do NOT claim success.
            const reason =
              result.status === 'no_endpoint'
                ? 'the submission endpoint is not configured for this install'
                : result.error ?? 'unknown error';
            if (root.json) {
              process.stdout.write(
                JSON.stringify({ status: 'error', message: reason }, null, 2) + '\n',
              );
            } else {
              process.stderr.write(
                `error: could not send the skill (${reason}).\n` +
                  '  Nothing was lost on your side. Try again in a moment, or send ' +
                  'feedback if it keeps failing.\n',
              );
            }
            process.exitCode = 1;
            return;
          }

          // Landed — ping ops. The event is SIGNAL ONLY: name, description,
          // kind, counts. The bytes are already in skill_submissions.
          await track(
            {
              event_name: EventName.SkillShared,
              email,
              payload: {
                skill_name: name,
                description: description.slice(0, 500),
                kind,
                base_skill_id: opts.baseSkill ?? null,
                file_count: result.file_count ?? bundle.files.length,
                total_bytes: result.total_bytes ?? bundle.totalBytes,
                truncated: bundle.truncated,
              },
            },
            root.dataDir,
          );
          // Force a synchronous flush so the Discord ping fires now (same
          // immediate-confirmation pattern as `mixshift feedback`).
          await maybeFlush(root.dataDir);

          const fileWord = bundle.files.length === 1 ? 'file' : 'files';
          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: 'ok',
                  skill_name: name,
                  kind,
                  file_count: bundle.files.length,
                  total_bytes: bundle.totalBytes,
                  skipped: bundle.skipped,
                  truncated: bundle.truncated,
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stderr.write(
              `\n✓ Shared "${name}" with MixShift (${bundle.files.length} ${fileWord}, ${bundle.totalBytes} bytes). Thanks!\n` +
                '  It is now with the team to review for the skill library.\n' +
                (bundle.skipped.length > 0
                  ? `  Note: skipped ${bundle.skipped.length} item(s) (binary, too large, or in node_modules/.git): ${bundle.skipped.slice(0, 5).join(', ')}${bundle.skipped.length > 5 ? ', ...' : ''}\n`
                  : ''),
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (root.json) {
            process.stdout.write(
              JSON.stringify({ status: 'error', message }, null, 2) + '\n',
            );
          } else {
            process.stderr.write(`error: ${message}\n`);
          }
          process.exitCode = 1;
        }
      },
    );
}

/**
 * Read a skill artifact into a list of text files. `path` may be a single file
 * (shared as-is) or a directory (walked, text-only, with caps so a stray big
 * tree can't blow up the submission). Records what it skipped so the user
 * sees an honest account rather than a silent truncation.
 */
async function collectBundle(path: string): Promise<Bundle> {
  const stat = await fs.stat(path).catch(() => null);
  if (!stat) throw new Error(`Path not found: ${path}`);

  const files: SkillSubmissionFile[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const addFile = async (absFile: string, relPath: string): Promise<void> => {
    if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
      truncated = true;
      skipped.push(relPath);
      return;
    }
    const st = await fs.stat(absFile).catch(() => null);
    if (!st || !st.isFile()) return;
    if (st.size > MAX_FILE_BYTES) {
      skipped.push(`${relPath} (too large)`);
      return;
    }
    const dot = relPath.lastIndexOf('.');
    const ext = dot >= 0 ? relPath.slice(dot).toLowerCase() : '';
    const isSkillMd = basename(relPath).toLowerCase() === 'skill.md';
    if (!isSkillMd && !TEXT_EXT.has(ext)) {
      skipped.push(`${relPath} (not text)`);
      return;
    }
    const content = await fs.readFile(absFile, 'utf8').catch(() => null);
    if (content === null) {
      skipped.push(`${relPath} (unreadable)`);
      return;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      truncated = true;
      skipped.push(`${relPath} (over total cap)`);
      return;
    }
    files.push({ path: relPath, content, bytes });
    totalBytes += bytes;
  };

  if (stat.isFile()) {
    await addFile(path, basename(path));
  } else {
    // Recursive walk, shallow caps applied per-file in addFile.
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
          truncated = true;
          return;
        }
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) {
            skipped.push(`${relative(path, abs).split('\\').join('/')}/ (skipped dir)`);
            continue;
          }
          await walk(abs);
        } else if (e.isFile()) {
          await addFile(abs, relative(path, abs).split('\\').join('/'));
        }
      }
    };
    await walk(path);
  }

  return { files, skipped, totalBytes, truncated };
}

/** Parse YAML frontmatter from whichever bundled file is a SKILL.md. */
function findFrontmatter(
  files: SkillSubmissionFile[],
): Record<string, unknown> | null {
  const skillMd = files.find(
    (f) => basename(f.path).toLowerCase() === 'skill.md',
  );
  if (!skillMd) return null;
  const m = skillMd.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  try {
    const parsed: unknown = parseYaml(m[1]);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
