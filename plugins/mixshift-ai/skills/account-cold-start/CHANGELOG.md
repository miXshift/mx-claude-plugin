# account-cold-start changelog

*v2.5.2 (in progress, plugin 0.5.0) — Phase A recovery from drift audit. Restored: trigger phrase list in skill description (fixes Cowork natural-language activation), no-questions rule nuance ("no-preamble, not no-questions" — Phase 2 AMA is required procedure), brand intelligence quality rules (proof points status enum, neutral review labels, proof point vs internal metric distinction, TACOS-primary sales-target rule, readiness status rule), Phase 1.5 enrichment phase (settlement curve / stockout candidates / brand-name typo clusters — analysis ported from v2.3.x Python to TypeScript in Phase C work), Phase 2 Reporting Style Intake sub-step (extracts reporting-style.yaml when AM uploads a reference report), Brand Context page source contract (per-section source map), standardized gap text for label_completeness, target-refresh discipline in kickoff.md, Discoveries emit (typed observations as promotion proposals). brand-intelligence migrated back from .json to .yaml (matches v2.4.0+ convention). Manifest restored: post_execution block declaring renderer + headline + review paths, enrichment: true tags on CS-28-31 for delta-mode filtering, context_freshness_max_days: null exemption. HTML rendering pipeline (Phase B), enrichment processing + delta mode (Phase C) still ahead.*

*v2.5.1 — Tier 1 context-freshness preflight rolled out universally. Every context-consuming skill now reads `context.yaml::last_updated` against the per-skill `context_freshness_max_days` threshold declared in its manifest; cold-start declares `context_freshness_max_days: null` (exempt — this skill sets freshness rather than consuming it). The canonical procedure lives at `shared/preflight-context-freshness.md`. The `context_freshness_state` field (fresh | confirmed_stale | skipped | exempt) is now recorded in every run sidecar; cold-start always records `exempt`. The comparator treats `exempt` as a stable state and does not flag transitions to/from it.*

*v2.5.0 — Phase 2 sub-step: Reporting Style Intake. When the AM uploads a reference monthly report during Phase 2, cold-start extracts section list, ordering, render variants, voice notes, and emphasis signals into `~/.mixshift/clients/<brand-slug>/reporting-style.yaml` (schema: `shared/clients/_schema/reporting-style.schema.yaml`). `monthly-performance-report` consults this file when present and falls back to canonical defaults when absent. This is the per-brand customization mechanism that lets a brand's first monthly run match the AM's prior reports rather than a generic template; absent a reference, the canonical defaults apply.*

*v2.4.12 — Readiness cleanup: renderer treats runtime forecast/default delivery/voice-lint/future-market notes as non-blocking, accepts `brand-intelligence.yaml::source_map`, treats skill-owned/defaultable fields as ready for readiness checks, and Cold Start must data-check stockout/promo questions before asking the AM.*

*v2.4.11 — Phase 2 QA hard gate: fresh Cold Starts must ask numbered AM questions immediately when unresolved operating decisions or data anomalies remain, and may not stop after a YELLOW/OBSERVATIONAL draft render as if complete.*

*v2.4.10 — Buyer-language autopopulation contract: fresh Cold Starts must build a compact customer-language corpus from official/support/review/forum surfaces plus bounded CS-31 converting search-term aggregation, write it to `narrative.md` and `brand-intelligence.yaml::customer_language_corpus`, and avoid leaving Brand Voice partial when evidence is available.*

*v2.4.9 — Brand Identity fallback bugfix: stub narrative with no brand-intelligence hero now renders the intended missing-input stub instead of taking the source-backed fallback path.*

*v2.4.8 — Skill-readiness semantics cleanup: upstream skill/data-pull dependencies no longer downgrade Brand Context readiness; they are execution orchestration unless a manual runtime upload or real missing context exists.*

*v2.4.7 — TACOS-primary readiness cleanup: explicit no-sales-target accounts no longer show stale monthly/quarterly sales-target manifest warnings; empty paused_campaigns lists are treated as "none known"; stockout checks may close gaps with automated sales/session evidence when inventory snapshots are unavailable.*

*v2.4.6 — Competitive dictionary contract: Cold Start now carries source-backed competitor/reference brands in `negation.competitor_brands`, renders them separately from protected brand terms/misspellings, and treats ASIN-target corpora as valid competitive-set evidence.*

*v2.4.5 — Cold Start coverage contract: intake now asks for website, Amazon storefront, social/review surfaces, runtime forecast/bridge artifacts, and brand-manager wow facts; `brand-intelligence.yaml` is expected for fresh starts; renderer emits a source map for Brand Context page sections.*

*v2.4.4 — TACOS-primary target cleanup: Brand Context pages now lead with the true TACOS goal and label ACOS thresholds as bid-math proxies only, preventing ACOS proxy values from being misread as TACOS targets.*

*v2.4.3 — Brand Context polish: proof cards now style partial/needs-capture evidence honestly, enrichment advisories use neutral review-action language instead of raw follow-up prompts, and single-brand accounts are not penalized for intentionally empty `sub_brands`.*

*v2.4.2 — Identity readiness cleanup: CS-01 identity now uses the account-level `seller` table and prefetch hard-stops on empty identity; readiness treats manifest/context-contract drift as caveats instead of false "Blocked by Context" statuses where safe defaults exist.*

*v2.4.1 — Brand intelligence polish: proof chips are source-linked, the Brand Identity section can fall back to `brand-intelligence.yaml`, and Brand Voice gaps distinguish missing customer-language corpus from missing source-backed narrative.*

*v2.4.0 — Source-backed brand intelligence sidecar: Cold Start can write optional `brand-intelligence.yaml` for public web/social proof points, source map, PPC implications, and open research gaps without bloating `context.yaml` or requiring downstream skills to ingest HTML.*

*v2.3.6 — Brand Brain narrative refresh: the top "What I Know About This Brand" section now opens with a brand-intelligence paragraph, surfaces structural milestones and search-boundary knowledge from `context.yaml`, and uses `narrative.md` Brand Identity prose when available.*

*v2.3.5 — Brand Brain review refresh: renderer separates true missing context from manual runtime inputs, groups gaps into review buckets, adds skill-readiness status, and emits `review.json` for targeted machine consumption.*

*v2.3.4 — Token-efficiency cleanup: CS-28/29/30/31 enrichment rows stay in canonical `.data.json` and are omitted from model-facing `.data.md`; the model reads only synthesis-needed CS-01 through CS-27 tables in fresh mode and skips `.data.md` in delta mode.*

*v2.3.3 — Added deterministic bootstrap-context handoff for true fresh starts so the model no longer hand-writes the first context shell.*

*v2.3.2 — Execution-contract cleanup: explicit bootstrap context shell for true fresh starts, fresh vs delta sequence split, prefetch wording clarified as the only approved data path, commands standardized, and validation moved before final Bottom Line.*

*v2.3.1 — Typo clustering + plural/competitor-brand filters + multi-seller binding (fixes latent CS-25/26 bug; CS-28/29/30/31 now span all `accounts[].seller_id`s); removed retroactive change-point detection; renderer shows "insufficient data" instead of null for low-volume settlement-curve cells.*

*v2.3.0 — Automated enrichment (settlement curve, stockout candidates, typo candidates) + delta-update mode for re-running on existing accounts without overwriting AM-edited context.*
