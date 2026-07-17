# Skill author guide

Internal authoring conventions for `skills/*/SKILL.md` files in this
plugin. Read this before adding a new skill or modifying telemetry on
an existing one.

---

## CLI invocation: always have a node fallback

Skills call the bundled CLI as `mixshift <cmd>`. Since 0.8.3 that name is put on the session PATH by the plugin's SessionStart hook (hooks/session-start.mjs), which is NOT guaranteed to have run on every surface. Observed in the field even before the hook era: macOS Cowork sandboxes where `mixshift` returns `command not found` (exit 127). Every skill that runs a CLI command must be able to fall back:

```bash
# Preferred:
mixshift <cmd> <args>
# Fallback 1 - hook-exported absolute entrypoint:
node "$MIXSHIFT_CLI" <cmd> <args>
# Fallback 2 - no hook ran at all: resolve the plugin root from the skill's
# own base directory (it is <plugin root>/skills/<skill name>) and run:
node "<plugin root>/harness/dist/cli.js" <cmd> <args>
```

Do NOT use `$CLAUDE_PLUGIN_ROOT` in SKILL.md fallbacks: the host sets it for hook/MCP processes but it is EMPTY in the session's Bash environment (verified 2026-07-16). For auth-critical and first-run skills (`mx-welcome`, `mx-auth-login`), state the fallback inline at the first CLI call so a missing PATH never strands a brand-new user. For other skills, one note near the first CLI call is enough.

---

## Telemetry: the three required emits

Every skill MUST emit three lifecycle telemetry events so we can
analyze the beta funnel:

| Event | When | Why |
|---|---|---|
| `skill.invoked` | At the START of skill execution, before any meaningful work | Counts how often the skill ran. The denominator for "skill completion rate." |
| `skill.trigger_phrase_matched` | ONLY when the skill was triggered by a natural-language phrase (not `/<skill>` slash command) | Measures which trigger phrases work and which need iteration. Skipped when the user typed `/<skill>` directly. |
| `skill.completed` | At the END of skill execution, with an `--outcome` | Counts successful completions. Drives the funnel rate alongside `skill.invoked`. |

The Edge Function does NOT fan these out to Discord — they're analytics
events only. Volume would be too high for human attention.

### Canonical block (copy into every SKILL.md)

Path is `../../../../docs/productization/SKILL-AUTHOR-GUIDE.md` because every SKILL.md sits four levels deep (`plugins/mixshift-ai/skills/<id>/SKILL.md`).

```markdown
## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

\`\`\`bash
mixshift telemetry emit skill.invoked --skill <skill-id>
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill <skill-id> --trigger-phrase "<the user's exact phrase>"
\`\`\`

At the END of this skill, run:

\`\`\`bash
mixshift telemetry emit skill.completed --skill <skill-id> --outcome <ok|failed|deferred|skipped>
\`\`\`

Outcomes: `ok` (skill ran cleanly), `failed` (couldn't complete — CLI error, missing prereq), `deferred` (paused waiting for user input that didn't come back this turn), `skipped` (user opted out mid-flow or prereq guard fired).
```

Replace `<skill-id>` with the actual skill's `name` from the frontmatter
(matches the parent directory name by convention). The fenced code
blocks are what Claude sees and executes — keep them verbatim.

### Why not "just put it in the harness"

Skills are LLM-orchestrated in chat. Many turns, many bash calls, the
shape varies per skill. There's no single "skill entry point" the
harness could wrap. The harness already auto-fires `cli.command_run`
on every invocation, but that's per-command not per-skill — a single
skill might make 0 to 10 CLI calls. We need a skill-scoped envelope,
and Claude is the only thing that knows when a skill begins and ends.

### Why three separate emits instead of one wrap

`skill.invoked` fires unconditionally at start. `skill.completed` fires
at end with the outcome. The gap between them is where the skill's
real work happens. Decoupling them means:
- We can compute "abandoned skills" (invoked but no completed within
  N minutes).
- We can compute outcome distribution (`ok` vs `failed` per skill).
- We can compute mean-time-in-skill from `skill.invoked.ts` to
  `skill.completed.ts` for the same install_id + skill_id pair.

A single combined event would lose the duration signal.

---

## Lint: `npm run check-skills`

`harness/scripts/check-skill-telemetry.mjs` enforces the convention.
Run via:

```bash
cd plugins/mixshift-ai/harness && npm run check-skills
```

The script scans every `skills/*/SKILL.md` and checks:

1. The skill's SKILL.md contains `mixshift telemetry emit skill.invoked --skill <skill-id>` where `<skill-id>` matches the directory name.
2. The skill's SKILL.md contains `mixshift telemetry emit skill.completed --skill <skill-id> --outcome` (any outcome value).
3. The standard "Telemetry (required" header is present.

Exits 0 on clean pass, non-zero with a list of offenders on failure.
Wire into CI before promoting any unenforced skill set out of pre-beta.

### Bypassing intentionally

Don't. If a skill is genuinely exempt (e.g., it's a one-shot utility
that nobody triggers and we don't care about analytics for), still
add the block — it costs nothing and protects against future
"actually we do care about this one" reversals.

---

## Drift signal: invoked-but-not-completed ratio

Even with lint in place, Claude might still skip the close-emit
sometimes (it does what SKILL.md says, but LLMs aren't deterministic).
The signal that this is happening is:

```sql
WITH funnel AS (
  SELECT
    skill_id,
    COUNT(*) FILTER (WHERE event_name='skill.invoked') AS invoked,
    COUNT(*) FILTER (WHERE event_name='skill.completed') AS completed
  FROM events
  WHERE ts >= NOW() - INTERVAL '14 days'
    AND skill_id IS NOT NULL
  GROUP BY skill_id
)
SELECT skill_id, invoked, completed,
       ROUND(100.0 * completed / NULLIF(invoked, 0), 1) AS completion_pct
FROM funnel
ORDER BY (invoked - completed) DESC;
```

A skill that consistently shows `completion_pct < 90%` either:
- Has a real failure mode (users abandon it), OR
- Has Claude skipping the close-emit on `--outcome` branches

If the discrepancy is large, audit that skill's SKILL.md and verify
Claude reliably hits the close-emit in observed sessions (Cowork
transcripts).

---

## What NOT to put in SKILL.md telemetry calls

- **Customer query results.** Never. Per `docs/privacy.md`, we don't
  log query content or results. The `query.executed` event lifts
  metadata (`query_id`, `query_table`, `row_count`, `duration_ms`) but
  not the SQL or rows.
- **MySQL passwords.** Never. The auth-setup flow has explicit
  guards; don't undo them by putting password text into a payload.
- **Full argv with potentially-sensitive strings.** The harness's
  `cli.command_run` already logs `cmd` + `subcmd` only for this
  reason. SKILL.md emits should follow the same restraint — payloads
  should be structural (skill_id, outcome, duration) not literal.
- **Email addresses other than the user's own.** If the skill
  references someone else's email (rare), don't lift it into telemetry.
  The base event already carries `email` (the install owner's) — that's
  the only PII we want.

---

## Adding a new event type

If a skill needs a new telemetry event (not just `skill.invoked` /
`skill.trigger_phrase_matched` / `skill.completed`), add it to:

1. `harness/src/lib/telemetry/events.ts::EventName` enum.
2. If the event should fan out to Discord: update both the
   `DISCORD_EVENTS` set in `supabase/functions/fanout-discord/index.ts`
   AND the `events_to_discord_fanout` DB trigger's `WHEN` clause —
   see `internal/SUPABASE-SETUP.md` §10 for the two-layer warning.
3. Document the event in `internal/SUPABASE-SETUP.md` if it's
   payload-rich (so dashboard queries can rely on the shape).
