# Harness Rewrite

**Status:** Draft v0.1
**Scope:** Replace the legacy Python harness (the 13 scripts dropped during the fork) with a Node/TypeScript implementation that works across Cowork, Claude Code, and a future Claude.ai chat path.
**Out of scope:** Skill prompt changes, SQL changes, brand management UX (covered in BRAND-MANAGEMENT.md).

> **Auth status (shipped 0.5.x):** The token-based sign-in path (sketched below as the "v2 Data Hub" `DataHubTokenProvider`) shipped early and is now the default. `mixshift auth login` runs a browser PKCE / device-code flow against the mx-legacy-auth service and stores access + refresh tokens locally. The raw-MySQL-creds provider is legacy (still reachable via `mixshift auth setup`). The shipped auth code lives in `src/lib/auth/` (`login-flow.ts`, `credentials.ts`, `client-id.ts`, `schema.ts`) as functional modules, which diverged from the `mysql-creds.ts` / `keychain.ts` class sketch in this draft. See `docs/auth-setup.md`.

---

## Why rewrite

The harness is the deterministic substrate between Claude and the warehouse. The legacy Python implementation served the original operator well but doesn't fit the productized release:

- Adds a Python interpreter dependency at user install time
- Mixes user-machine paths (`~/.openclaw/...`) with plugin-relative paths (`shared/clients/...`)
- Single-surface (CLI-on-laptop) — no clean path to Cowork sandbox or chat-surface MCP
- No test infrastructure
- Several scripts duplicate logic that could share modules

Rewrite goals:

1. Zero install-time dependencies beyond Node (which the plugin runtime already provides)
2. Single source of truth for harness logic, exposed through multiple transports (CLI for Code/Cowork, MCP for chat)
3. Surface-aware behavior (output adapters, edit UI fallback)
4. Test-friendly module structure
5. Stable command interface that Claude can invoke deterministically from SKILL.md

---

## Architecture

Three layers, one core:

```
┌────────────────────────────────────────────────────────────┐
│ Claude (running a skill)                                   │
└─────────────┬───────────────────────┬──────────────────────┘
              │                       │
   Bash tool  │                       │  MCP tool call
   (Code +    │                       │  (chat — future)
    Cowork)   │                       │
              ▼                       ▼
   ┌──────────────────┐   ┌──────────────────────┐
   │ CLI wrapper      │   │ MCP server wrapper   │
   │ (Node binary)    │   │ (Node, same package) │
   └────────┬─────────┘   └──────────┬───────────┘
            │                        │
            └────────────┬───────────┘
                         ▼
   ┌─────────────────────────────────────────┐
   │ Core harness library (TypeScript)       │
   │                                         │
   │  auth/        — credential providers    │
   │  discovery/   — seller table querying   │
   │  context/     — read/write/validate     │
   │  sql/         — query loader + executor │
   │  prefetch/    — data artifact builder   │
   │  render/      — output adapters         │
   │  audit/       — sidecar + drift         │
   │  surface/     — surface detection       │
   └─────────────────────────────────────────┘
```

Same functions, two transports. CLI for today (Bash-invokable). MCP for the future chat path. We build the core library first, the CLI wrapper second, the MCP wrapper when we need it.

---

## Directory layout

```
plugins/mixshift-ai/
  harness/                              ← new top-level
    package.json                        ← workspace, scripts, deps
    tsconfig.json
    src/
      cli.ts                            ← CLI entry point (bin)
      mcp-server.ts                     ← MCP wrapper (later)
      lib/
        auth/
          login-flow.ts                 ← token sign-in: PKCE + device-code [shipped]
          credentials.ts                ← read/write/refresh tokens, v2 schema [shipped]
          client-id.ts                  ← surface attribution [shipped]
          schema.ts                     ← credentials file schema + guards [shipped]
          mysql-creds.ts                ← legacy raw-MySQL provider
          keychain.ts                   ← optional OS keychain (opt-in)
        context/
          read.ts                       ← load context.yaml
          write.ts                      ← write + atomic
          validate.ts                   ← schema validation
          index.ts                      ← portfolio index.yaml ops
        discovery/
          seller-query.ts               ← list seller table
          brand-grouping.ts             ← auto-cluster across multi-account
        sql/
          loader.ts                     ← load .sql from sql-library/
          executor.ts                   ← run against the MCP/MySQL conn
          drift-check.ts                ← compare to tables.yaml
        prefetch/
          batch-runner.ts               ← parallel rounds per manifest
          artifact.ts                   ← write tmp/<brand>-<skill>-<date>.data.json
        render/
          adapter.ts                    ← Renderer interface
          local-html.ts                 ← Claude Code default
          inline-markdown.ts            ← Cowork default
          google-doc.ts                 ← cross-surface narrative reports
          csv.ts                        ← list outputs
          terminal.ts                   ← stdout
        audit/
          sidecar.ts                    ← run sidecar writer
          compare-sidecars.ts           ← drift detection
        surface/
          detect.ts                     ← CLAUDE_SURFACE env / heuristic
        profile/
          load.ts                       ← ~/.mixshift/profile.yaml
        paths/
          resolve.ts                    ← MIXSHIFT_DATA_DIR with default
      commands/
        bootstrap.ts                    ← `mixshift bootstrap`
        validate.ts                     ← `mixshift validate`
        prefetch.ts                     ← `mixshift prefetch`
        render.ts                       ← `mixshift render`
        brand.ts                        ← `mixshift brand <list|add|...>`
        ui.ts                           ← `mixshift ui` (Claude Code only)
    tests/
      fixtures/
      unit/
      snapshots/
      evals/
```

---

## CLI surface (commands Claude invokes)

```
mixshift bootstrap                      Create brand context shell
  --brand <slug>                          required
  --brand-name <name>                     required
  --seller-id <id>                        required (can repeat)
  --account-type <SC|VC>                  required (matches each seller-id)
  --date <YYYY-MM-DD>

mixshift validate                       Validate context.yaml against schema
  --brand <slug>                          required
  [--strict]                              fail on warnings, default off

mixshift prefetch                       Run SQL batches for a skill
  --brand <slug>                          required
  --skill <skill-id>                      required
  --date <YYYY-MM-DD>                     default: today

mixshift render                         Render skill output via adapter
  --brand <slug>                          required
  --skill <skill-id>                      required
  --sidecar-path <path>                   required (JSON sidecar from skill)
  [--adapter <name>]                      override profile default
  --date <YYYY-MM-DD>                     default: today

mixshift sidecar write                  Write run sidecar (called post-skill)
  --brand <slug>                          required
  --skill <skill-id>                      required
  --headline-json <path>                  required

mixshift sidecar compare                Drift check against prior run
  --brand <slug>                          required
  --skill <skill-id>                      required

mixshift brand list                     Portfolio table
mixshift brand add <slug>               Trigger cold-start
mixshift brand status <slug>            Show context + freshness
mixshift brand update <slug>            Conversational edit entry point
mixshift brand refresh <slug>           Re-run cold-start (structure change)
mixshift brand archive <slug>           Move to archived
mixshift brand rename <old> <new>       Folder move + index patch
mixshift brand discover                 Re-query seller table
mixshift brand validate <slug>          Schema-check after manual edit

mixshift ui                             Local web UI (Claude Code only)
  [--port 8080]
  [--password <set>]                      one-time, stored in profile

mixshift profile show                   Print ~/.mixshift/profile.yaml
mixshift profile set <key> <value>      Edit profile fields safely
mixshift auth login                     Token sign-in (browser PKCE / device-code) [default]
  --person-label <email>                  self-attested actor email
  [--mode <auto|pkce|device>]             default auto: PKCE, device fallback
  [--api-base <url>] [--client-id <id>]   dev overrides
mixshift auth setup                     Legacy raw-MySQL onboarding (creds, IP whitelist)
```

All commands:
- Exit 0 on success, non-zero on failure
- Print JSON to stdout when `--json` flag passed (machine-readable for Claude)
- Print human-readable to stderr otherwise
- Respect `MIXSHIFT_DATA_DIR` env override (default `~/.mixshift/`)
- Respect `CLAUDE_SURFACE` env var (`code` | `cowork` | `chat`) for adapter routing; fall back to heuristic

---

## Surface detection

The harness needs to know which Claude surface it's running in to pick output adapters correctly.

Detection priority:
1. `CLAUDE_SURFACE` env var if set (explicit)
2. Heuristic: check `process.env.CLAUDE_CODE_VERSION` or similar (Claude Code sets known env vars)
3. Heuristic: filesystem checks (Cowork sandboxes have different shape than Claude Code installs)
4. Default: assume `claude_code` (least restrictive — falls back to local file output)

Surface affects:
- Default output adapter selection (`local-html` vs `inline-markdown`)
- Whether `mixshift ui` is available (Claude Code only)
- Output paths (Cowork may not support `file://` links)
- Some telemetry fields (we want to know which surface is the source)

---

## Output adapter interface

Every adapter implements the same shape:

```typescript
interface RendererAdapter {
  name: string;
  surfaces: Surface[];           // which surfaces support this adapter
  render(input: {
    skill_id: string;
    brand_slug: string;
    sidecar: SkillSidecar;       // structured JSON from the skill
    template_dir?: string;       // user template override
  }): Promise<RendererResult>;
}

interface RendererResult {
  type: 'file' | 'inline' | 'url';
  path?: string;                 // for file output
  content?: string;              // for inline output
  url?: string;                  // for URL output (e.g. Google Doc)
  mime_type?: string;
}
```

The skill produces a structured sidecar. The adapter consumes the sidecar. Skills never produce raw HTML or markdown — that's the renderer's job. Drift in presentation = template update, not skill update.

---

## AuthProvider interface

Same shape, three implementations over time:

```typescript
interface AuthProvider {
  getDbConnection(): Promise<DbConnection>;
  getUserContext(): Promise<UserContext>;
  isReady(): Promise<boolean>;      // has the user completed auth setup?
  setupInteractive(): Promise<void>; // walk through onboarding
}

// shipped default — token sign-in against mx-legacy-auth
// (implemented as functional modules in src/lib/auth/, not this exact class)
class DataHubTokenProvider implements AuthProvider { ... }

// legacy — raw-MySQL creds, still supported via `auth setup`
class MysqlCredsProvider implements AuthProvider { ... }

// optional opt-in
class OsKeychainProvider implements AuthProvider { ... }
```

Skills never see credentials. They call `auth.getDbConnection()`. Swapping providers is invisible to skills.

---

## First milestones

Order is intentional — each builds on the previous and is independently testable.

1. **CLI skeleton + `mixshift --help`**. Empty commands, no logic. Validates the build / packaging / Bash invocation path. ~2 hours.

2. **`mixshift profile show` + `mixshift profile set`**. Reads / writes `~/.mixshift/profile.yaml`. First end-to-end file I/O. Tests path resolution + env overrides. ~3 hours.

3. **`mixshift auth login`** (shipped) **+ legacy `mixshift auth setup`**. Token sign-in is the default onboarding step: browser PKCE / device-code against mx-legacy-auth, tokens stored locally at `~/.mixshift/auth/credentials`. The legacy raw-MySQL `auth setup` flow (creds + IP-whitelist requests emitted as telemetry and fanned to the ops Discord channel server-side) remains for the raw-MySQL path. ~6 hours.

4. **`mixshift validate <brand>`**. Loads `_template/context.yaml` or a real brand context, validates against `_schema/context.schema.yaml`. First skill-relevant function. Test with the template + intentionally broken fixtures. ~4 hours.

5. **`mixshift brand discover`**. Connects to the warehouse via the auth provider (token path: queries route through mx-legacy-auth's `/api/query`), queries `seller` table, writes `index.yaml`. First warehouse-touching step. **Sam tests this against dashamazon.** ~5 hours.

6. **`mixshift bootstrap` + `mixshift prefetch` for `account-cold-start`**. End-to-end cold-start path. Sam onboards one of his real brands. ~1 day.

7. **`mixshift render` with the `local-html` and `inline-markdown` adapters**. Plumbs structured sidecar → HTML/markdown output. Replaces the old "skill writes HTML" pattern. ~1 day.

8. **`mixshift brand list` / `status` / `update`** — completes the conversational edit surface. ~half day.

9. **`mixshift ui`** — Claude Code only Express+Vite UI. ~2-3 days, deferred until after we have working skill execution.

Milestones 1-6 are the critical path to "Sam runs `account-cold-start` end-to-end against his real warehouse and gets a populated `~/.mixshift/clients/<slug>/` directory." That's the first acceptance gate.

---

## Test approach (matches Q2 strategy)

For each commit:

- **Static** (CI, milliseconds): TypeScript typecheck, ESLint, schema validation on `_template/context.yaml`, SQL drift check against `tables.yaml`, scrub-target grep (regression on the migration scrub).
- **Unit** (CI, seconds): Vitest tests on individual modules. Path resolution, schema validators, sidecar diff, etc.
- **Snapshot** (CI, seconds): Fixed input → fixed output, golden files in `tests/snapshots/`. Catches accidental output format changes.
- **Integration** (manual at first, automated later): Sam runs against dashamazon. Real-data end-to-end.
- **Eval** (deferred to after first real-data runs): LLM-judge criteria per skill.

Model version is pinned in CI for snapshot stability. Bumping models = re-baseline snapshots in a dedicated PR.

---

## Open questions

1. **Single repo or workspace?** Should the harness be its own workspace inside the plugin (`harness/package.json` with own `node_modules`), or just a folder of TypeScript that the plugin runtime transpiles on demand? Workspace is cleaner; on-demand is lighter. Lean workspace.
2. **Compile step for plugin distribution?** Do we ship compiled JS, or expect the plugin runtime to transpile TS at install? Affects user install time vs CI complexity. Lean compile in CI, ship JS.
3. **MySQL client.** `mysql2` is the standard. Any reason to prefer the existing `mysql-mcp-server` shim (call MCP instead of speaking MySQL directly)? Probably yes for v1 — reuses the existing MCP config and surfaces queries through the same audit channel. Decision: route through MCP. **(Resolved by the token path: queries now route through mx-legacy-auth's `/api/query` over HTTPS with a Bearer token; the harness no longer opens a direct `mysql2` socket on the token path.)**
4. **Where does `mixshift` get installed?** Likely as a `bin` entry in the harness package, made available via the plugin's runtime path resolution. Need to test in both Claude Code and Cowork.
5. **Backward compat with legacy SKILL.md `python scripts/X.py` invocations.** Every SKILL.md needs updating to call `mixshift X ...` instead. One coordinated commit once the CLI surface is settled. Track which skills are updated in this doc as we go.

---

## What I'm starting with

Milestone 1 + 2 as the first concrete deliverable: a CLI that prints help and reads/writes a profile.yaml. Validates the entire build path before we get anywhere near SQL or skill execution. Once that's green, milestone 3 (auth setup) follows.
