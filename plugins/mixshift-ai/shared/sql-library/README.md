# Canonical SQL Library

Single source of truth for parameterized SQL used by skills. Each query lives
in its own `.sql` file and is referenced by ID from a skill's SQL-REFERENCE.md
or SKILL.md (e.g., `[SQL-LIBRARY: DHC-01]`). Skills should not embed full SQL
inline once a canonical version exists here — they call the ID and pass
parameters.

## Why a library

- **Drift defense.** When `business_reports_dpst_date` adds a column or
  `campaignmetric` is renamed, we patch one file, not 13.
- **Verifiability.** Every fenced ```sql block is scanned by
  `scripts/check-sql-drift.py` against `shared/tables.yaml`. Inline SQL drifts
  silently; library SQL fails the gate.
- **Determinism.** Two runs of the same skill on the same date emit the same
  query text. Model variation cannot rewrite a JOIN.

## File conventions

```
shared/sql-library/
  README.md                  # this file
  catalog.yaml               # ID → file → purpose index
  <id>.sql                   # one query per file, parameterized
```

Each `.sql` file MUST:

1. Begin with a header comment block:
   ```
   -- ID: DHC-01
   -- Purpose: Campaign-level metrics across T-1/T-7/T-30/MTD windows
   -- Params: :seller_id, :account_type, :run_date
   -- Consumers: daily-health-check (Batch A)
   -- Tier: 1 (data)
   ```
2. Use `:named_params` (not `?` positional). Parameter names must match the
   `Params:` header.
3. Be schema-clean against `shared/tables.yaml` — every `FROM`/`JOIN` table and
   every `table.column` reference must exist there.
4. Use `[bracketed_placeholders]` only for genuinely dynamic fragments
   (e.g., a date list assembled at runtime). The drift checker strips these
   before scanning.

## ID convention

`<SKILL-PREFIX>-<NN>` where SKILL-PREFIX is the canonical short code:

| Skill | Prefix |
|---|---|
| account-cold-start | CS |
| daily-health-check | DHC |
| keyword-bid-health | KBH |
| runaway-spend-check | RSC |
| monthly-performance-report | MPR |
| search-term-harvest | STH |
| search-term-negation | STN |
| phrase-negative-discovery | PND |
| asin-target-negation | ANEG |
| ppc-relevance-check | PRC |
| portfolio-quick-scan | PQS |
| competitive-analysis | COMP |
| search-term-data-pull | STDP |

Cross-skill / shared queries get the prefix `LIB`.

## How a skill calls a library query

In `references/SQL-REFERENCE.md`:

```markdown
### Batch A — Campaign metrics

[SQL-LIBRARY: DHC-01]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:account_type` from `context.yaml::accounts[0].account_type`
- `:run_date` from runtime
```

The skill loads `shared/sql-library/DHC-01.sql`, substitutes parameters, and
executes. Inline SQL is permitted only for one-off exploratory queries that
are not yet promoted to the library; promote on second use.

## Drift gate

`scripts/check-sql-drift.py` runs across `skills/**/*.md` AND
`shared/sql-library/*.sql`. Any unknown table or `table.column` reference
fails the gate. Run before commit; CI runs it on every PR.
