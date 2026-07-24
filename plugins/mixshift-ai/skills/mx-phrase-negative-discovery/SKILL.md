---
name: mx-phrase-negative-discovery
description: "Discovers phrase negative candidates by decomposing search term corpus into n-grams, aggregating performance per sequence, and surfacing sequences with combined spend and zero conversion history. Applies conflict detection, semantic clustering, and brand context filtering. Phrase negatives have blast radius — all candidates require validation before application."
---

# ST Phrase Negative Discovery

> Invocation note: run `mixshift` commands via the Bash tool. The command is normally on PATH, registered by the plugin session hook. If `mixshift` is not found, run the same arguments through `node "$MIXSHIFT_CLI"`. If that variable is also unset (normal in Cowork, which does not run the session hook), resolve the bundled CLI by scanning for it once and reuse the path: `MIXSHIFT_CLI="$(find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1)"`, then run every command as `node "$MIXSHIFT_CLI" <args>`. If both `mixshift` and `$MIXSHIFT_CLI` come back empty that does NOT mean the plugin is missing. Its CLI ships inside the plugin directory (an ID-named folder that a PATH or npm check will not reveal), which the scan locates; never report it as not installed.


## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** Brand context comes exclusively from `context.yaml` and `narrative.md`.
- **Do NOT supplement with general Amazon or e-commerce knowledge**, industry benchmarks, or assumed platform dynamics not present in the data.
- **Do NOT echo full data tables or raw query output** in your model response. The harvest output is the deliverable.
- **Begin output immediately.** Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.

---

## Preflight — Risk Tier 3 (Required)

Complete this checklist before Step 0. Stop and surface the failure if any item cannot be checked off.

```
PREFLIGHT — mx-phrase-negative-discovery — <brand> — <date>
[ ] context.yaml loaded from ~/.mixshift/clients/<brand>/context.yaml
[ ] Load these fields (default + label when missing — do NOT stop; phrase negatives are recommendation-only and validated before apply):
      accounts[*].seller_id   (the only hard requirement — from `mixshift brand add`)
      management.acos_target_pct   (if absent: observational, no vs-target flagging)
      negation.protected_terms   (if absent: default [] and WARN — without protected anchors, review candidates carefully before applying)
      negation.lane_rules   (if absent: default {} and cluster/filter conservatively; label "uncalibrated")
      brand_terms, sub_brands, campaign_structure.naming_pattern, paused_campaigns (may be empty)
[ ] Upstream mx-search-term-data-pull artifact present
    *** HARD GATE: if absent, STOP. Cannot build n-gram corpus without ST data pull. ***
[ ] Prior-run sidecar loaded: ~/.mixshift/clients/<brand>/runs/mx-phrase-negative-discovery/ (most recent)
    (if absent: continue — no baseline yet)
[ ] No active escalation conditions:
      - verdict regresses GREEN→RED without structural_events explanation → surface before delivering
```

---

Phrase negatives have blast radius. One phrase negative can suppress dozens of legitimate search term variants simultaneously. This skill finds the right phrases to negate and prevents accidentally blocking terms that convert.

The methodology mirrors commercial n-gram tools but goes further: semantic clustering, brand context filtering, and collision detection before any candidate surfaces for validation.

---

## What This Adds

Standard n-gram tools: computational rollup → static filter UI → manual review.

This skill adds:
1. **Semantic clustering:** "without laces" + "laceless" + "no lace" = one concept, one decision
2. **Brand context filtering:** candidate that looks irrelevant by data might be known converting adjacency
3. **Collision detection:** before surfacing, verify the n-gram doesn't appear in converting STs
4. **Gap analysis:** flag where phrase negative already exists in some campaigns but not others

---

## Blast Radius Rule (Critical)

A phrase negative recommendation must never be issued without:
1. Completing the conflict check (does this n-gram appear in any converting ST?)
2. Stating the blast radius (how many unique STs would this phrase negative suppress?)
3. Validation — phrase negatives are never auto-applied

---

## Execution

**Step 0 — Load inputs:**
- Data artifact: ST data pull output (JSON)
- **Tier-3 brand context** at `~/.mixshift/clients/<brand-slug>/context.yaml` (schema-validated by `mixshift brand validate <brand-slug>`). Extract:
  - `accounts[].seller_id`
  - `management.acos_target_pct`
  - `negation.protected_terms` — anchors that must never be exact- or phrase-negated
  - `negation.lane_rules` — per-lane `relevant`/`mismatch` term dictionaries (drives semantic clustering and brand-context filtering)
  - `brand_terms` — canonical + variant brand tokens for collision detection
  - `sub_brands[]` and `campaign_structure.naming_pattern` — for item-group conflict checks
  - `structural_events[]` — flag candidates that overlap an active event window
  - `paused_campaigns` — exclude from recommendations and blast-radius counts
- `~/.mixshift/clients/<brand-slug>/narrative.md` — prose interpretation only (lane judgment, blast-radius philosophy). Do not extract numbers from this file.

**Brand context is optional — never fail closed on it.** Run on whatever context is present (`context.yaml`, Tier-2 Brand Brain as fallback); discovery sharpens as context accrues but never requires full brand setup. The only hard requirement is `accounts[].seller_id` (from `mixshift brand add`) plus the upstream ST data-pull artifact (a data dependency, gated above). When `negation.protected_terms` / `negation.lane_rules` are missing, default + label per the preflight rather than stopping — phrase negatives are recommendation-only and never auto-applied (the Blast Radius Rule + validation are the safety net). Do not infer fields from prose. Load the brand-context fields in one call via `mixshift brand context resolve <brand-slug> --json` — each carries `{value, source, fetched_at}` (`source: context` = ✓ confirmed, `brain` = ⊙ pre-filled; `null` = use the default).

**Paused campaign rule (mandatory):**
- Include STs from paused campaigns in the n-gram corpus and conflict check (real conversion signal)
- Exclude paused campaign STs from the recommendations output and from blast radius counts (phrase negative applied to paused campaign has no effect)
- Before surfacing any recommendation, verify the target campaign is active
- If all campaigns containing the bleeding STs for a given phrase candidate are paused: remove that candidate from output entirely

**Granularity slices from artifact:**
- `lifetime_keyword_aggregate` — the n-gram corpus
- `lifetime_keyword_by_item_group` — conflict check at item group level
- `stream1_keyword` — window location data for recency signal

---

## Phase 1 — N-Gram Decomposition

For every unique search term in the lifetime corpus:

```python
import re
from itertools import combinations
from collections import defaultdict

def tokenize(search_term):
    """Lowercase, strip punctuation, split on whitespace."""
    return re.sub(r"[^a-z0-9\s]", "", search_term.lower()).split()

def generate_ngrams(tokens, max_n=3):
    """Generate all n-grams from 1 to max_n."""
    ngrams = []
    for n in range(1, min(max_n + 1, len(tokens) + 1)):
        for i in range(len(tokens) - n + 1):
            ngrams.append(" ".join(tokens[i:i+n]))
    return ngrams

# Build n-gram performance index
ngram_index = defaultdict(lambda: {
    "count": 0,              # unique STs containing this ngram
    "lifetime_spend": 0.0,
    "lifetime_sales": 0.0,
    "lifetime_orders": 0,
    "source_sts": []         # which STs contain this ngram
})

for st, perf in lifetime_corpus.items():
    tokens = tokenize(st)
    for ngram in generate_ngrams(tokens, max_n=3):
        ngram_index[ngram]["count"] += 1
        ngram_index[ngram]["lifetime_spend"] += perf["lifetime_spend"]
        ngram_index[ngram]["lifetime_sales"] += perf["lifetime_sales"]
        ngram_index[ngram]["lifetime_orders"] += perf["lifetime_orders"]
        ngram_index[ngram]["source_sts"].append(st)
```

---

## Phase 2 — Candidate Filtering

Apply thresholds to surface candidates:

```python
phrase_spend_threshold = brand_context.get("phrase_spend_threshold", 10.0)  # default $10
min_st_count = 3  # must appear in at least 3 unique STs

candidates = [
    (ngram, data)
    for ngram, data in ngram_index.items()
    if data["count"] >= min_st_count
    and data["lifetime_spend"] >= phrase_spend_threshold
    and data["lifetime_orders"] == 0
]

# Sort by combined lifetime spend DESC
candidates.sort(key=lambda x: x[1]["lifetime_spend"], reverse=True)
```

---

## Phase 3 — Conflict Check (Critical)

For every candidate n-gram, check whether it appears in any converting ST in the lifetime corpus:

```python
def conflict_check(ngram, lifetime_corpus, min_orders=1):
    """
    Returns (has_conflict, converting_sts).
    has_conflict = True if any ST containing this ngram has lifetime orders >= min_orders.
    """
    converting_sts = [
        st for st, perf in lifetime_corpus.items()
        if ngram in st.lower() and perf["lifetime_orders"] >= min_orders
    ]
    return bool(converting_sts), converting_sts
```

**If conflict found:** Suppress phrase negative entirely. Do not downgrade to exact-only. The correct path is exact negation at the specific bleeding locations (handled by the exact negation skill). A phrase negative where the root term converts anywhere is the wrong tool.

**Item group conflict check (second pass):** Even if aggregate conflict check passes, run the item group slice check. A phrase negative applied at campaign level affects all ad groups in that campaign. If the n-gram converts in item group A's campaigns but not item group B's, a campaign-level phrase negative in item group B is safe — but a campaign-level phrase negative in item group A is not. State which campaigns the phrase negative is safe to apply to and which it is not.

```python
for ngram, data in candidates:
    has_conflict, converting_sts = conflict_check(ngram, lifetime_corpus)
    if has_conflict:
        # Remove from candidates
        # Add to conflict log with converting_sts list
        pass
```

---

## Phase 4 — Semantic Clustering

Group semantically similar candidates to avoid redundant negation recommendations:

```python
semantic_groups = defaultdict(list)

# Example clusters:
# "without [material]", "no [material]", "[material] free" → one concept
# "fake [material]", "[material] imitation", "[material] replica" → one concept
# "[competitor]", "[competitor] copy", "[competitor] knockoff" → one concept

def semantic_key(ngram):
    """Extract semantic concept from n-gram."""
    # Simple pattern matching — can be replaced with embeddings-based clustering
    tokens = ngram.split()
    
    # Rule 1: "X-free", "no X", "without X" → "no [X]"
    if any(t in tokens for t in ['free', 'without']):
        root = [t for t in tokens if t not in ['free', 'without']][0] if len(tokens) > 1 else None
        return f"no-{root}"
    
    # Rule 2: "fake X", "X replica", "imitation X" → "fake [X]"
    if any(t in tokens for t in ['fake', 'replica', 'imitation', 'knockoff']):
        root = [t for t in tokens if t not in ['fake', 'replica', 'imitation', 'knockoff']][0] if len(tokens) > 1 else None
        return f"fake-{root}"
    
    return ngram

for ngram, data in candidates:
    key = semantic_key(ngram)
    semantic_groups[key].append((ngram, data))
```

For each semantic cluster, recommend the highest-spend n-gram and note the cluster as a single decision unit.

---

## Phase 5 — Brand Context Filtering

Before surfacing a candidate:
1. Check against `known_converting_adjacencies` — if the n-gram appears there, suppress
2. Check against `brand_term_dictionary` — core brand terms should never be phrase-negated
3. Check against `known_irrelevant_categories` — align the candidate with categories the AM has confirmed as out-of-scope

---

## Output Structure

### Section 1: Phrase Negative Candidates (by lifetime spend DESC)

For each candidate:
```
N-Gram | Unique Search Terms | Lifetime Spend | Zero Conversions | Avg ACOS |
Blast Radius | Campaigns Affected | Item Group Conflict Check | Recommended Level |
Semantic Cluster | Rationale
```

### Section 2: Conflict Log

Candidates suppressed due to converting ST collisions:
```
N-Gram | Appears in Conversions | Converting STs | Why Suppressed
```

### Section 3: Brand Context Filter Suppressions

Candidates suppressed due to brand context rules:
```
N-Gram | Reason | Related Known Adjacency or Brand Term
```

### Section 4: Gap Analysis

Phrase negatives already applied in some campaigns but missing in others:
```
N-Gram | Current Coverage | Recommended Expansion | Campaigns Currently Missing
```

---

## Validation Process

Before implementation:

1. **Business case calculation** — annual waste if not negated (lifetime_spend * seasonal_factor)
2. **Blast radius validation** — confirm the candidate suppresses only intended irrelevant STs
3. **Campaign-level placement** — which campaigns/ad groups should the phrase negative be applied to
4. **AM feedback** — send candidate list with top 3 recommendations to account manager for final approval

---

## Integration with Other Skills

- **Harvest extraction** consumes same data artifact — phrase candidates must not suppress harvest terms
- **Exact negation** consumes this output — phrase negatives are resolved first, then exact negatives fill any gaps at specific locations
- **Data pull** runs first — this skill depends on accurate lifetime corpus

---

## Run Time Expectation

Total execution time (all phases): 30 seconds to 2 minutes depending on account size and n-gram corpus complexity.

---

## Key Rules

- **Phrase negatives require manual review** — never auto-apply
- **Conflict check is mandatory** — suppressed candidates must be logged and reviewed
- **Semantic clustering reduces decision fatigue** — group similar candidates
- **Brand context is the final gate** — known adjacencies are never phrase-negated
- **Paused campaigns excluded from recommendations** — but included in conflict checks

---

## Step: Emit Run Sidecar (canonical, drift-detection input)

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. Sidecars live at `~/.mixshift/clients/<brand-slug>/runs/mx-phrase-negative-discovery/<data-date>-<run-id>.json`. Schema source of truth: `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`.

Use the **window end date** of the upstream search-term data pull for `data_date`, not the run wall-clock date.

Compose the input JSON (write to a temp file, then invoke the harness):

```jsonc
// /tmp/pnd-sidecar-input.json
{
  "skill": "mx-phrase-negative-discovery",
  "skill_version": "1.2.0",
  "brand_slug": "<brand-slug>",
  "run_kind": "per_account",
  "data_date": "YYYY-MM-DD",
  "verdict": "GREEN|YELLOW|RED|OBSERVATIONAL",
  "context_snapshot": {
    "account_type": "SC|VC",
    "seller_id": 0,
    "primary_metric": "ACOS",
    "acos_target_pct": 20,
    "attribution_window_days": 14,
    "protected_terms_count": 0,
    "lane_rules_present": true,
    "brand_terms_count": 0
  },
  "headline_metrics": {
    "candidates_surfaced": 0,
    "candidates_above_threshold": 0,
    "total_zero_conv_spend_protected": 0,
    "protected_terms_blocked": 0
  },
  "sql_calls": [
    {"id": "UPSTREAM:mx-search-term-data-pull",
     "params": {"sidecar_path": "runs/<brand-slug>/mx-search-term-data-pull/<latest>.json",
                "ngram_min": 2, "ngram_max": 4, "min_spend": 50}}
  ],
  "artifacts": {
    "report_html_path": "<path-to-rendered-output>"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/pnd-sidecar-input.json
```

**Verdict rule:** `GREEN` = <10 candidates surfaced (routine maintenance pass). `YELLOW` = 10–50 candidates (worth a careful review pass; phrase-negatives have blast radius). `RED` = >50 candidates (corpus saturation — likely a campaign-targeting drift upstream; do not bulk-apply without an upstream relevance/structure review). `OBSERVATIONAL` = corpus too small or window too short to produce stable n-gram aggregates.

`mixshift sidecar compare` will surface drift against the prior run once implemented; until then, sidecars accumulate read-only for retrospective inspection.

---

*Skill version: 1.2.0 — phrase negative discovery with full conflict detection*
*Ported from upstream with full domain logic preserved*

## Telemetry (required)

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill mx-phrase-negative-discovery
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill mx-phrase-negative-discovery --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill mx-phrase-negative-discovery --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
