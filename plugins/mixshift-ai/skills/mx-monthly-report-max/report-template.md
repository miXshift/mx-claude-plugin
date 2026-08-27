# Report Max — the report template (v1)

The canonical structure of a Monthly Performance Report Max document. The
section order and the tabular/prose split are the engine author's v1 ruling
(2026-08-26); the v1 scope cut — what ships now versus what layers in later —
is MixShift's product decision. Per-brand deviations will arrive via a
reporting-style layer in a later version; **do not deviate from this order by
editing the default.**

The composition rules in SKILL.md still govern every claim and figure. This
file adds structure: which sections exist, their order, what each contains,
and which render as tables or cards via the `presentation` object.

**The membership rule (contract-level, do not bend):** a `presentation` object
is layout ONLY. Every figure id it names MUST also be in the section's own
`figure_refs`. PRES-1 enforces this and it blocks the render door. The rule
exists because a second referencing channel would let figures silently escape
TRACE-1 and the CAVEAT-1 blocking-caveat guarantee.

## Canonical section order (v1)

Sections marked **[v1]** ship now from gateway-served data. **[dormant]**
sections are defined and render only when their gating data exists — never
fake the gate. **[v1.1]** sections wait on extractor support and MUST NOT be
approximated from account totals.

1. **`title_block`** [v1] — brand display name, report month, and a window
   note naming the exact date ranges compared, the channel, and the revenue
   basis (e.g. ordered). The window note is not decoration: every downstream
   figure inherits its meaning from it.
2. **`bottom_line`** [v1] — prose executive summary (conclusion first,
   mechanism second) plus anchor pills: the 2-4 figures the month turns on,
   rendered as the default chip strip. Causal claims here quote served
   evidence statements as their `mechanism` (see SKILL.md).
3. **`kpi_heroes`** [v1] — `presentation.kind: kpi_cards`. One card per
   headline metric: value, signed delta, % change. Standard set: ordered
   revenue (OPS), units, conversion, ASP (ops_per_unit), ad spend, ACOS.
   Drop a card when the run does not serve the metric; never substitute.
4. **`performance_snapshot_mom`** [v1] — `presentation.kind: metric_table`.
   Every served ops metric as rows; columns Prior / Current / Change /
   % change from the `mom.ops.*` figure families. The ads account totals
   (`mom.ads.*`: spend, sales, ACOS, ROAS, clicks, orders) render as a second
   table in the same section or an adjacent one titled for advertising.
5. **`performance_snapshot_yoy`** [v1] — same shape from `yoy.ops.*`, and
   `yoy.ads.*` when the year-ago ads leg produced figures. When the served
   YoY limitation says the year-ago window had no advertising activity,
   render the retail table alone and let the limitation say why — never a
   table of n/a cells.
6. **`campaign_type_mom` / `campaign_type_yoy`** [v1.1] — SP / SB / SD
   rollup tables. The engine sidecar carries the campaign-type rollups but
   the extractor does not emit them yet. DO NOT approximate these from
   account totals; ship the section only when typed figures exist for it.
7. **`item_group_highlights`** [v1.1] — grouped performance table at the
   run's grouping (item_group / sub_brand), with per-line deep-dive PROSE
   only for lines that earn it. Waits on grouped-row extraction. When a
   grouping resolves no labels, the served limitation already explains it.
8. **Narrative blocks** [v1] — up to three prose sections: Volume & Traffic,
   Advertising Efficiency, YoY Context. Model-composed under the claim
   rules; drivers are named as findings ("BP drove most of the decline"),
   never dumped as rankings.
9. **`forecast_anchor_cards` / `forecast_table`** [dormant] — render ONLY
   when the document's forecast state is provided-current (`kind:
   'forecast'` sections; the gate already exists and fails closed). The
   gateway serves no forecast source today, so these do not render. Do not
   simulate them.
10. **`looking_ahead`** [v1] — forward risks and watchpoints as short
    labeled paragraphs. Each watchpoint names its metric and figure, states
    the trigger, and proposes the next check — not a promise of outcomes,
    and no forecast vocabulary (the fail-closed guard applies).
11. **`footer`** [v1] — provenance: engine version, insight id and revision,
    periods compared, revenue basis, computed-at, and the run's limitations
    verbatim. Limitations are part of the report, not an appendix to hide.

## Hard exclusions (the engine author's, learned in front of clients)

- No process talk or restatement narration; at most a neutral model-refit
  footnote.
- No raw ASIN codes client-facing — nicknames from brand context.
- No internal tool references.
- Signed deltas with units on every change figure.
- One basis per label; never mix bases in a table.
- No superlatives without a complete population (POP-1/POP-2 enforce this).
- The full topDrivers ranking is evidence, not content: the reader wants the
  finding. Cap any driver table and only when typed figures exist for it.
- The entity census is drill data, never client-facing.

## What was deliberately left out of v1 (and where it returns)

- **Forecast sections** — gated on a forecast source the gateway does not
  have. Returns when one exists; the render gate is already built.
- **Campaign-type and item-group tables** — return with extractor support
  (the sidecar already carries the data).
- **Task highlights** (the applied-changes journal in the reference report)
  — operator-instance data today. Returns when sourced from an auditable
  shared record (the ads-change audit log or timeline stakes), not from
  prose memory.
- **Per-brand style variants** (unified metrics table, section omissions,
  voice) — returns as a reporting-style layer; until then the canonical
  order above is the only order.
- **Google Doc insertion** — out of scope for this renderer; the HTML
  artifact is the deliverable.

## Authoring mechanics

- Tables and cards are authored per section via `presentation`
  (`metric_table` | `kpi_cards`), with every referenced id ALSO in that
  section's `figure_refs` (PRES-1).
- Unknown `presentation.kind` values degrade to the chip strip; missing
  figures render as "n/a" cells. Corrections go to the report-data JSON —
  the HTML is never edited by hand.
- Period-namespaced ids keep MoM and YoY apart in every section
  (`mom.ops.*` vs `yoy.ops.*`, `mom.evidence.*` vs `yoy.evidence.*`).
  Never quote a `mom.*` figure or statement in a YoY section, or the
  reverse.
