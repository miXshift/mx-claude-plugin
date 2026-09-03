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
    python3 helpers/prose-lint.py <report.html> [more.html ...]

Exit code 0 = clean, 1 = findings. Run before Step 6 delivery.
"""
import io, re, sys, collections

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
                        r'|fix|replenish|diagnose|get|rebalance|redirect|cap|drop|push|defend|escalate'
                        r'|negotiate|reorder|restock)\b', re.I)

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

CHECKS = [check_bold_openers, check_rest_fragments, check_template_repetition,
          check_dash_density, check_no_dashes, check_ambiguous_metrics,
          check_number_precision, check_unitless_signed_deltas, check_sentence_length]

def lint(path, role=None):
    body = body_of(io.open(path, encoding='utf-8').read())
    findings = []
    if role == 'client':
        findings.extend(check_client_has_no_internal(body))
    for c in CHECKS:
        findings.extend(c(body))
    return findings

def main(argv):
    role = None
    if '--role' in argv:
        k = argv.index('--role')
        role = argv[k + 1] if k + 1 < len(argv) else None
        argv = argv[:k] + argv[k + 2:]
    if len(argv) < 2:
        print(__doc__); return 2
    total = 0
    for path in argv[1:]:
        f = lint(path, role=role)
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
