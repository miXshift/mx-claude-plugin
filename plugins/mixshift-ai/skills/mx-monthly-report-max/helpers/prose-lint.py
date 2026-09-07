#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prose-lint.py — mechanical prose checks for a rendered monthly report.

Why this exists
---------------
Every failure mode this skill encodes as a rule stopped recurring. Prose quality was
never encoded, and it was critiqued in every single review round of the Brand A, July 2026
build: clunky constructions, template-shaped paragraphs, and label-fragment openers that
are not sentences. A rule that says "write naturally" is unenforceable and model-dependent.
These checks are enforceable by any model.

This does NOT try to judge good writing. It catches the specific, detectable failures that
have actually shipped.

Usage
-----
    python3 helpers/prose-lint.py [--role client|internal] [--marketplace US] [--exec <one-pager.html>]
                                  [--voice-lint <voice-lint.json>] [--first-run] <report.html> [more.html ...]

    --role client       the client brief: no internal section, client register, instructions become questions
    --role internal     the internal companion: the commitments section (i03) is REQUIRED unless --first-run
    --marketplace <X>   the run's marketplace code; <title> and <footer> must carry it and no other
    --exec <html>       the executive read (one-pager); the report's Bottom Line must not be thinner
    --voice-lint <json> the brand's reporting.voice_lint as JSON (see references/voice-lint-seed.json)
    --first-run         no prior run exists, so no commitments section is expected

Exit code 0 = clean, 1 = findings. Run before Step 6 delivery.
"""
import io, re, sys, collections, json

# Finite verbs that appear in this report genre. This is a WHITELIST, deliberately generous:
# the goal is to catch clauses with NO verb at all, not to parse English. A false positive
# means the verb is simply missing from this list -- add it, rather than rewording good prose.
VERB = re.compile(r"""\b(
 is|are|was|were|be|been|being|has|have|had|will|would|can|could|should|may|might|do|does|did
|rose|rise|rises|fell|fall|falls|grew|grow|grows|moved?|moves|came|come|comes|took|take|takes
|sits?|sat|carr(?:y|ies|ied)|convert(?:s|ed)?|account(?:s|ed)?|dr(?:o|e)ve|drives?|drew|draws?
|cut|cuts|ran|runs?|hit|hits|land(?:s|ed)?|settl(?:e|es|ed)|held|holds?|stay(?:s|ed)?|remain(?:s|ed)?
|matter(?:s|ed)?|work(?:s|ed)?|need(?:s|ed)?|show(?:s|ed)?|read(?:s)?|point(?:s|ed)?|pull(?:s|ed)?
|gave|give|gives|remov(?:e|es|ed)|add(?:s|ed)?|contribut(?:e|es|ed)|decompos(?:e|es)|split|splits
|reflect(?:s|ed)?|assum(?:e|es|ed)|project(?:s|ed)?|step(?:s|ped)?|post(?:s|ed)?|record(?:s|ed)?
|recover(?:s|ed)?|clos(?:e|es|ed)|went|goes?|fed|feeds?|bought|buys?|sold|sells?|deliver(?:s|ed)?
|reallocat(?:e|es|ed)|generat(?:e|es|ed)|return(?:s|ed)?|kept|keeps?|miss(?:es|ed)?|beat|beats
|track(?:s|ed)?|respond(?:s|ed)?|persist(?:s|ed)?|pric(?:e|es|ed)|report(?:s|ed)?|sell|buy
|eas(?:e|es|ed)|climb(?:s|ed)?|slip(?:s|ped)?|widen(?:s|ed)?|narrow(?:s|ed)?|lost|lose|loses
|explain(?:s|ed)?|answer(?:s|ed)?|left|leaves?|sits|stand(?:s)?|hold|bring(?:s)?|brought
|worth|expect(?:s|ed)?|face(?:s|d)?|reframe(?:s|d)?|suggest(?:s|ed)?|indicat(?:e|es|ed)
|impl(?:y|ies|ied)|rul(?:e|es|ed)|plac(?:e|es|ed)|mean(?:s|t)?|cover(?:s|ed)?|span(?:s|ned)?
|rest(?:s|ed)?|hinge(?:s|d)?|turn(?:s|ed)?|shar(?:e|es|ed)|mask(?:s|ed)?|offset(?:s)?
|absorb(?:s|ed)?|pay(?:s)?|paid|cost(?:s)?|earn(?:s|ed)?|spend(?:s)?|spent
|contain(?:s|ed)?|produc(?:e|es|ed)
)\b""", re.I | re.X)

# Action bullets legitimately open with a bare imperative ("Watch conversion.", "Put spend back behind X.")
IMPERATIVE = re.compile(r'^\s*(watch|review|read|flag|protect|decide|restore|re-examine|reexamine|stop|start'
                        r'|confirm|establish|check|consider|hold|keep|cut|raise|lower|put|move|shift|add'
                        r'|reduce|increase|pause|resume|rebuild|replace|investigate|understand|prioritize'
                        r'|prioritise|treat|avoid|expect|plan|leave|let|make|take|give|find|set|run'
                        # cap/drop/push/reorder/restock stay OUT: they are common NOUNS in
                        # this register, and whitelisting them silenced genuine label-fragments.
                        r'|fix|replenish|diagnose|get|rebalance|redirect|defend|escalate'
                        r'|negotiate)\b', re.I)

def strip(html_frag):
    t = re.sub(r'<[^>]+>', ' ', html_frag)
    t = (t.replace('&mdash;', '--').replace('&minus;', '-').replace('&nbsp;', ' ')
          .replace('&amp;', '&').replace('&rsquo;', "'").replace('&euro;', 'EUR')
          .replace('&plusmn;', '+/-').replace('&times;', 'x').replace('&ndash;', '-')
          .replace('&Delta;', 'D').replace('&rarr;', '->'))
    return re.sub(r'\s+', ' ', t).strip()

def body_of(html):
    # everything after the last </style>, i.e. the rendered document
    return html.split('</style>')[-1]

def first_clause(text):
    """First sentence, with decimals protected so 5.16 does not split."""
    t = re.sub(r'(\d)\.(\d)', r'\1․\2', text)
    return t.split('.')[0].replace('․', '.').strip()

def check_bold_openers(body):
    """
    Two distinct failures:

    1. LABEL-DASH-FRAGMENT — the signature template. `<strong>Entity -- noun phrase.</strong>`
       The give-away is that the text BEFORE the dash has no verb, so the bold lead is a
       label with an apposition hung off it rather than a clause. A plain verb search misses
       these whenever the fragment contains a subordinate clause ("the reallocation that
       worked", "drawing traffic it does not convert"), which is why the dash is the anchor.
    2. VERBLESS LEAD — no dash, and no finite verb anywhere.
    """
    out = []
    for m in re.finditer(r'<(p|li)\b[^>]*>\s*<strong>(.*?)</strong>', body, re.S):
        lead = strip(m.group(2))
        if not lead or IMPERATIVE.match(lead):   # "Watch conversion." is a legitimate imperative
            continue
        if lead.rstrip().endswith(':'):          # "Month-over-month:" is a label, a valid device
            continue
        parts = re.split(r'\s--\s|\s-\s', lead, maxsplit=1)
        if len(parts) == 2:
            if not VERB.search(parts[0]):
                out.append(('label-dash-fragment', lead[:100]))
            continue
        if not VERB.search(lead):
            out.append(('verbless-lead', lead[:100]))
    return out

def check_rest_fragments(body):
    """
    The sentence immediately after a bold LEAD-IN must also be a sentence. Skipped when the
    continuation opens with punctuation or a lowercase word, because that means the bold was
    inline emphasis inside a sentence rather than a lead-in -- as in
    "...the business is flat**, against a headline of -32.5%."
    """
    out = []
    for m in re.finditer(r'<(p|li)\b[^>]*>\s*<strong>.*?</strong>(.*?)</\1>', body, re.S):
        raw = strip(m.group(2))
        if not raw or not raw[0].isupper():
            continue
        rest = first_clause(raw)
        if rest and not VERB.search(rest):
            out.append(('post-bold-fragment', rest[:100]))
    return out

def check_template_repetition(body):
    """
    N sibling paragraphs opening with the same construction = a filled template,
    not composed prose. Signature = first 3 words with numbers/entities masked.
    """
    out = []
    sigs = collections.Counter()
    examples = {}
    for m in re.finditer(r'<p\b[^>]*>(.*?)</p>', body, re.S):
        txt = strip(m.group(1))
        if len(txt) < 40:
            continue
        words = re.sub(r'[0-9][\d,.%$]*', '#', txt).split()[:3]
        if not words:
            continue
        sig = ' '.join(w.strip('.,:;').lower() for w in words)
        sigs[sig] += 1
        examples.setdefault(sig, txt[:70])
    for sig, n in sigs.items():
        if n >= 3:
            out.append(('repeated-opening x%d' % n, '%s ... (e.g. "%s")' % (sig, examples[sig])))
    return out

def check_dash_density(body):
    """Em-dashes carrying the load that commas and full stops should."""
    out = []
    ps = re.findall(r'<p\b[^>]*>(.*?)</p>', body, re.S)
    words = sum(len(strip(p).split()) for p in ps)
    dashes = sum(p.count('&mdash;') for p in ps)
    if words and dashes and words / dashes < 45:
        out.append(('em-dash-density', '1 per %.0f words across %d words (target: >45)'
                    % (words / dashes, words)))
    for p in ps:
        if p.count('&mdash;') >= 3:
            out.append(('em-dashes-in-one-paragraph', strip(p)[:90]))
    return out

AMBIGUOUS = [
    (r'return per (euro|dollar)', 'Rule 28: say "attributed sales per euro/dollar of spend" or name the model coefficient'),
    (r'(revenue|of revenue) per (advertising dollar|\$1 of ad spend|euro of advertising)',
     'Rule 28: if this is the model coefficient say "total revenue for each additional dollar/euro of ad spend"'),
    (r'advertising return', 'Rule 28: ambiguous - ROAS, ACOS, or the model coefficient?'),
]

def check_ambiguous_metrics(body):
    """Overloaded metric names that have already shipped meaning two different things (Rule 28)."""
    out = []
    txt = strip(body)
    for pat, msg in AMBIGUOUS:
        for m in re.finditer(pat, txt, re.I):
            out.append(('ambiguous-metric', '"%s" -- %s' % (m.group(0), msg)))
    return out

def check_number_precision(body):
    """
    Rule 30: percentages and points never render at three or more decimals, and CTR
    specifically must be 2dp to match the H-Bridge UI. Three decimals is the tell that a
    formatter was picked rather than checked against the source system.
    """
    out = []
    txt = strip(body)
    for m in re.finditer(r'\d+\.\d{3,}\s*(?:%|pts)', txt):
        out.append(('over-precise-percent', '%s -- Rule 30: percentages/points render at 1dp (2dp for CTR '
                    'and near-zero deltas), never 3+' % m.group(0)))
    for m in re.finditer(r'CTR[^|<]{0,40}?(\d+\.\d+)%', txt):
        dec = len(m.group(1).split('.')[1])
        if dec != 2:
            out.append(('ctr-precision', '%s%% has %ddp -- Rule 30: CTR is 2dp to match the H-Bridge UI'
                        % (m.group(1), dec)))
    return out

def check_sentence_length(body):
    out = []
    for m in re.finditer(r'<p\b[^>]*>(.*?)</p>', body, re.S):
        t = re.sub(r'(\d)\.(\d)', r'\1․\2', strip(m.group(1)))
        for s in re.split(r'(?<=[.!?]) ', t):
            n = len(s.split())
            if n > 60:
                out.append(('sentence-over-60-words', '%d words: %s' % (n, s[:80])))
    return out

def check_unitless_signed_deltas(body):
    """A signed decimal in prose with NO unit marker (%, pts, $, EUR, K, M) is a
    delta that lost its unit — "(-3.1)" where "(−3.1%)" was meant. Shipped in the
    July 2026 v2 rebuild (two sites, caught by an independent diff, not the
    build). Sign required + decimal required keeps false positives out
    (unsigned ratios like "(1.03)" don't fire)."""
    out = []
    txt = strip(body)
    for m in re.finditer(r'\(\s*[-+]\d+(?:\.\d+)?\s*\)', txt):
        out.append(('paren-delta-missing-unit', txt[max(0, m.start()-50):m.end()+10]))
    for m in re.finditer(r'[-+]\d+\.\d+(?=\s+(?!pts?\b|points\b|x\b|times\b|items?\b|days?\b|units?\b|sessions?\b|orders?\b|clicks?\b|rows?\b|servings?\b|per\b|wks?\b|weeks?\b|hrs?\b|hours?\b)[a-z])', txt):
        out.append(('signed-delta-missing-unit', txt[max(0, m.start()-50):m.end()+15]))
    return out

def check_no_dashes(body):
    """The 2.0 house rule for these documents is NO em or en dashes at all (ranges are
    "A to B", asides take commas or parentheses). The density check above tolerates a
    few and only sees the &mdash; entity; this one is the ban, and it catches the
    literal characters the entity checks miss."""
    out = []
    for name, ch in (('em-dash', u'—'), ('en-dash', u'–'),
                     ('figure-dash', u'‒'), ('horizontal-bar', u'―')):
        n = body.count(ch)
        if n:
            k = body.find(ch)
            out.append(('literal-%s x%d' % (name, n),
                        body[max(0, k-45):k+45].replace('\n', ' ')))
    for ent in ('&mdash;', '&ndash;'):
        n = body.count(ent)
        if n:
            out.append(('%s x%d' % (ent.strip('&;'), n),
                        'write the range or aside without a dash'))
    return out

# Markers that must never appear in the CLIENT document (enabled via --role client).
# The template carries both documents in one file, split at the INTERNAL COMPANION
# marker; publishing the unsplit file as the client brief is the single worst failure
# this skill can produce, so it gets a mechanical check, not just prose.
INTERNAL_MARKERS = [
    r'INTERNAL COMPANION ONLY',
    r'class="internal-banner"',
    r'<span class="n">i0[1-9]</span>',
    r'class="say"',
    r'Numbers not to quote',
    r'What to tell ',
]

def check_client_has_no_internal(body):
    out = []
    for pat in INTERNAL_MARKERS:
        m = re.search(pat, body, re.I)
        if m:
            out.append(('internal-content-in-client-doc',
                        'matched %r near "%s"' % (pat, body[max(0, m.start()-30):m.end()+30].replace('\n', ' '))))
    return out

# Register phrases that must never appear in the CLIENT document (--role client):
# the client brief is the account manager presenting to the client's executive team,
# so tooling nouns, process narration and basis talk are findings there. Multi-word
# phrases and schema-shaped tokens ONLY: banning bare common nouns ("engine",
# "warehouse") false-positives on product titles, the same trap the imperative-verb
# whitelist hit. The finding survives in client copy; the apparatus moves internal.
CLIENT_REGISTER = [
    r'settled[- ]window',
    r'page[- ]view[- ]?weight\w*',
    r'\bPV-weighted',
    r'\bSellerID\b',
    r'completeness trim',
    r'\baccount mode\b',
    r"\bengine's\b",
    r'intelligence engine',
    r'MixShift Intelligence',
    r'\bengine ?[Vv]ersion\b',
    r'\bcross-check\w*',
    r'\bmatches ours\b|\bour read matches\b',
    r'\bthe scope bar\b|\bmethod notes\b',
]

# MACHINERY vocabulary is banned from BOTH documents: the internal reader is the
# AGENCY's Amazon manager (fluent in Amazon operations, unaware of MixShift
# implementation), so table names, internal system names, versions and internal
# file names never render. Product names the reader bought ("MixShift
# Intelligence", "brand context") are allowed internally and stay in the
# client-only list above. Query-level provenance lives in the run record.
MACHINERY = [
    r'\bHCAM\b',
    r'\b(?:business_reports_\w+|campaignmetric|sellermonthmetric|mws_\w+)\b',
    r'warehouse (?:table|batter|quer)\w*',
    r'\bengine ?[Vv]ersion\b',
    r'\b(?:claims\.json|context\.yaml|sidecar)\b',
    r'intelligence envelope',
]

def check_machinery(body):
    out = []
    for pat in MACHINERY:
        m = re.search(pat, body, re.I)
        if m:
            out.append(('machinery-vocabulary',
                        'matched %r near "%s" (reader is the agency manager; implementation names live in the run record)'
                        % (pat, body[max(0, m.start()-30):m.end()+30].replace('\n', ' '))))
    return out

def check_client_register(body):
    out = []
    for pat in CLIENT_REGISTER:
        m = re.search(pat, body, re.I)
        if m:
            out.append(('internal-register-in-client-doc',
                        'matched %r near "%s"' % (pat, body[max(0, m.start()-30):m.end()+30].replace('\n', ' '))))
    # MoM/YoY are furniture for tables, tiles and chips; client PROSE labels deltas
    # with words ("up 5.3% on July"). Strip the furniture, then scan what remains.
    prose = re.sub(r'<table\b.*?</table>', ' ', body, flags=re.S | re.I)
    prose = re.sub(r'<p class="d [^"]*">.*?</p>', ' ', prose, flags=re.S)
    prose = re.sub(r'<span class="chip[^"]*">.*?</span>', ' ', prose, flags=re.S)
    m = re.search(r'\b(MoM|YoY)\b', prose)
    if m:
        out.append(('mom-yoy-in-client-prose',
                    'client prose labels deltas with words ("up 5.3%% on July"); MoM/YoY is table/tile/chip furniture. Near "%s"'
                    % prose[max(0, m.start()-40):m.end()+40].replace('\n', ' ')))
    return out

def sentences(body):
    """Prose sentences only: paragraphs, list items and headings. Tables, tiles and chips
    are furniture and are read by the figure checks, not the prose checks."""
    for m in re.finditer(r'<(p|li|h1|h2|h3)\b[^>]*>(.*?)</\1>', body, re.S):
        t = re.sub(r'(\d)\.(\d)', r'\1․\2', strip(m.group(2)))
        for s in re.split(r'(?<=[.!?]) ', t):
            s = s.replace('․', '.').strip()
            if s:
                yield s

# A3 (2026-09-06): six comparison / superlative claims survived figure-level QA in one
# month ("most efficient campaign type" while another type ran lower ACOS; "largest
# step in the plan" while a later month was larger; "the only line where..." while two
# others did the same). The rule is not "no superlatives": it is that a superlative
# sentence carries the figure that backs it, so the reader (and the figures walk) can
# check the claim against the table instead of reading past it.
SUPERLATIVE = re.compile(
    r'\b(only|most|least|largest|biggest|smallest|best|worst|highest|lowest|strongest|weakest'
    r'|record|never|every|first time|all of|all (?:three|four|five|six|seven|eight|nine|ten)'
    r'|all (?:\w+ )?(?:lines|levers|items|campaigns|types|channels|markets|segments|listings))\b', re.I)

def check_superlatives(body):
    out = []
    for s in sentences(body):
        m = SUPERLATIVE.search(s)
        if m and not re.search(r'\d', s):
            out.append(('superlative-without-figure',
                        '"%s" claims a comparison with no figure in the sentence; add the figure that backs it '
                        'or degrade the claim to an observation. In: %s' % (m.group(0), s[:110])))
    return out

# A4 (2026-09-06): "9.1% less spend", "about 12% off" and "0.21 pts of improvement"
# all shipped; each hides the sign, the basis, or both. A percentage never takes a
# comparative word after it, and a signed figure or a pts value sits in a sentence
# that names its basis.
COMPARATIVE_AFTER_PCT = re.compile(r'\d+(?:\.\d+)?\s*%\s+(less|fewer|more|off|lower|higher|below|above)\b', re.I)
BASIS = re.compile(
    r'\b(MoM|YoY|vs\.?|versus|against|than|compared|month[- ]over[- ]month|year[- ]over[- ]year'
    r'|last year|prior month|prior year|a year ago|year earlier|the forecast|forecast|plan'
    r'|on (?:January|February|March|April|May|June|July|August|September|October|November|December)'
    r'|from (?:January|February|March|April|May|June|July|August|September|October|November|December))\b', re.I)

def check_change_basis(body):
    out = []
    for s in sentences(body):
        m = COMPARATIVE_AFTER_PCT.search(s)
        if m:
            out.append(('comparative-after-percent',
                        '"%s": write the signed change with its basis ("on spend -9.1%% MoM" in tables, '
                        '"spend down 9.1%% on July" in client prose). In: %s' % (m.group(0), s[:100])))
        if re.search(r'[-+]\d+(?:\.\d+)?\s*(?:%|pts?\b|points\b)', s) and not BASIS.search(s):
            out.append(('signed-figure-without-basis',
                        'a signed change with no MoM | YoY | vs forecast | on <month> basis in the sentence. In: %s' % s[:110]))
        elif re.search(r'\d+(?:\.\d+)?\s*(?:pts?\b|points\b)', s) and not BASIS.search(s):
            out.append(('pts-without-basis',
                        'a points value with no MoM | YoY | vs forecast | on <month> basis in the sentence. In: %s' % s[:110]))
    return out

# A4: an instruction addressed to nobody ("Ask where the traffic is coming from") is
# not a client sentence; an unknown reads as a question to the brand ("Where is the
# traffic coming from?" / "Confirm whether UMF 5+ has been discontinued").
INSTRUCTION_TO_NOBODY = re.compile(r'^(Ask|Find out|Investigate|Look into|Dig into|Understand)\b', re.I)

def check_instructions_to_nobody(body):
    out = []
    for s in sentences(body):
        if INSTRUCTION_TO_NOBODY.match(s):
            out.append(('instruction-to-nobody',
                        'phrase the unknown as a question to the brand ("Confirm whether..." / "Where is...?"). In: %s' % s[:110]))
    return out

# A5 mechanical asserts (2026-09-06): each of these shipped at least once.
def check_literal_double_percent(body):
    n = body.count('%%')
    return [('literal-double-percent x%d' % n, 'a named-placeholder formatter left a literal %s in the output' % '%%')] if n else []

CURRENCY_NO_SEPARATOR = re.compile(r'(?:EUR|USD|GBP|CAD|AUD|JPY|MXN|SEK|PLN|\$|€|£)\s?\d{4,}(?:\.\d+)?\b')

def check_thousands_separators(body):
    out = []
    txt = strip(body)
    for m in re.finditer(CURRENCY_NO_SEPARATOR, txt):
        out.append(('currency-missing-thousands-separator', m.group(0)))
    return out

def check_campaign_table_columns(body):
    """The campaign-type table is 8 columns (type, value / change x3, CPC). A 10-column
    variant overflowed the container."""
    out = []
    for m in re.finditer(r'<table\b.*?</table>', body, re.S):
        head = re.search(r'<thead\b.*?</thead>', m.group(0), re.S)
        if not head or not re.search(r'campaign[- ]type', strip(head.group(0)), re.I):
            continue
        first_row = re.search(r'<tr\b.*?</tr>', head.group(0), re.S)
        n = len(re.findall(r'<th\b', first_row.group(0))) if first_row else 0
        if n != 8:
            out.append(('campaign-table-columns', '%d columns; the campaign-type table is 8 (type, value and change for three figures, CPC)' % n))
    return out

def check_tile_delta_classes(body):
    """A KPI tile colours each figure on its own merit: a favourable MoM and an
    unfavourable YoY on the same tile take different classes, so one `.d` line
    carrying both labels is wrong by construction."""
    out = []
    for m in re.finditer(r'<p class="d[^"]*">(.*?)</p>', body, re.S):
        txt = strip(m.group(1))
        if re.search(r'\bMoM\b', txt) and re.search(r'\bYoY\b', txt):
            out.append(('tile-one-class-two-deltas', 'MoM and YoY on one coloured line; give each its own `.d` line and class: "%s"' % txt[:80]))
    return out

MARKETPLACE_CODES = r'US|CA|MX|BR|UK|DE|FR|IT|ES|NL|SE|PL|BE|TR|EG|SA|AE|IN|JP|AU|SG'

def check_marketplace_label(html, label):
    """The IT report shipped with "(DE)" in its title and footer from the DE template."""
    out = []
    for where, pat in (('title', r'<title>(.*?)</title>'), ('footer', r'<footer\b[^>]*>(.*?)</footer>')):
        m = re.search(pat, html, re.S | re.I)
        if not m:
            continue
        txt = strip(m.group(1))
        others = set(c for c in re.findall(r'\((%s)\)' % MARKETPLACE_CODES, txt) if c != label)
        if others:
            out.append(('marketplace-label-mismatch', '%s carries (%s) but this run is %s' % (where, ', '.join(sorted(others)), label)))
        elif label not in txt:
            out.append(('marketplace-label-missing', '%s does not name the marketplace (%s): "%s"' % (where, label, txt[:80])))
    return out

def bottom_line_words(html):
    m = re.search(r'<div class="bottomline">(.*?)</div>', body_of(html), re.S)
    return len(strip(m.group(1)).split()) if m else 0

def check_bottom_line_vs_exec(html, exec_path):
    """The full document's Bottom Line is never thinner than the executive read's;
    this slipped two months running before it was caught."""
    full = bottom_line_words(html)
    exec_words = bottom_line_words(io.open(exec_path, encoding='utf-8').read())
    if exec_words and full < exec_words:
        return [('bottom-line-thinner-than-executive-read', '%d words here vs %d in %s' % (full, exec_words, exec_path))]
    return []

def check_commitments_section(body):
    """Grading last month's commitments is a REQUIRED section of the internal companion
    when a prior run exists (Italy's most valuable sentence of the month came from grading
    July's "traffic is the only lever" against August's +40.5% sessions at 1.8%)."""
    heads = [strip(h) for h in re.findall(r'<h2\b[^>]*>(.*?)</h2>', body, re.S)]
    if not any(re.search(r'open items carried|commitments', h, re.I) for h in heads):
        return [('commitments-section-missing', 'no "Open items carried from <date>" (i03) section; pass --first-run only when no prior run exists')]
    return []

def load_voice_lint(path):
    """reporting.voice_lint as JSON: a list of banned phrases, or an object with
    `banned` (list) and/or `cut` (list of {cut, use}). references/voice-lint-seed.json
    is the seed."""
    data = json.load(io.open(path, encoding='utf-8'))
    rules = []
    if isinstance(data, list):
        rules = [(str(x), None) for x in data]
    else:
        rules = [(str(x), None) for x in data.get('banned', [])]
        rules += [(str(r.get('cut', '')), r.get('use')) for r in data.get('cut', []) if r.get('cut')]
    return rules

def check_voice_lint(body, rules):
    out = []
    txt = strip(body)
    for cut, use in rules:
        pat = r'\b' + re.sub(r'\s+', r'\\s+', re.escape(cut.strip())) + r'\b'
        m = re.search(pat, txt, re.I)
        if m:
            out.append(('voice-lint', '"%s"%s' % (m.group(0), (' -> use "%s"' % use) if use else ' is on the brand\'s banned list')))
    return out

CHECKS = [check_bold_openers, check_rest_fragments, check_template_repetition,
          check_dash_density, check_no_dashes, check_ambiguous_metrics,
          check_number_precision, check_unitless_signed_deltas, check_sentence_length,
          check_superlatives, check_change_basis, check_literal_double_percent,
          check_thousands_separators, check_campaign_table_columns, check_tile_delta_classes]

def lint(path, role=None, opts=None):
    opts = opts or {}
    html = io.open(path, encoding='utf-8').read()
    body = body_of(html)
    findings = []
    if role == 'client':
        findings.extend(check_client_has_no_internal(body))
        findings.extend(check_client_register(body))
        findings.extend(check_instructions_to_nobody(body))
    if role in ('client', 'internal'):
        findings.extend(check_machinery(body))
    if role == 'internal' and not opts.get('first_run'):
        findings.extend(check_commitments_section(body))
    for c in CHECKS:
        findings.extend(c(body))
    if opts.get('marketplace'):
        findings.extend(check_marketplace_label(html, opts['marketplace']))
    if opts.get('exec'):
        findings.extend(check_bottom_line_vs_exec(html, opts['exec']))
    if opts.get('voice_rules'):
        findings.extend(check_voice_lint(body, opts['voice_rules']))
    return findings

def take_flag(argv, flag):
    if flag not in argv:
        return argv, None
    k = argv.index(flag)
    value = argv[k + 1] if k + 1 < len(argv) else None
    return argv[:k] + argv[k + 2:], value

def main(argv):
    argv, role = take_flag(argv, '--role')
    argv, marketplace = take_flag(argv, '--marketplace')
    argv, exec_path = take_flag(argv, '--exec')
    argv, voice_path = take_flag(argv, '--voice-lint')
    first_run = '--first-run' in argv
    argv = [a for a in argv if a != '--first-run']
    if len(argv) < 2:
        print(__doc__); return 2
    opts = {
        'marketplace': marketplace,
        'exec': exec_path,
        'first_run': first_run,
        'voice_rules': load_voice_lint(voice_path) if voice_path else None,
    }
    total = 0
    for path in argv[1:]:
        f = lint(path, role=role, opts=opts)
        total += len(f)
        print('\n%s: %s' % (path, 'CLEAN' if not f else '%d finding(s)' % len(f)))
        # Informational, never a finding: section word counts, so an over-long section
        # is visible without pretending there is a correct length (the cold-read pass
        # owns the judgment; past ~500 words usually hides a restatement).
        body = body_of(io.open(path, encoding='utf-8').read())
        for sm in re.finditer(r'<h2\b[^>]*>(.*?)</h2>(.*?)(?=<h2\b|<footer|$)', body, re.S):
            words = len(strip(sm.group(2)).split())
            if words > 400:
                print('  [info] section "%s": %d words' % (strip(sm.group(1))[:50], words))
        for kind, detail in f:
            print('  [%s] %s' % (kind, detail))
    print('\n%s' % ('PASS' if total == 0 else 'FAIL: %d finding(s)' % total))
    return 0 if total == 0 else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv))
