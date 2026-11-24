#!/usr/bin/env python3
"""hdigest.py <run dir>: a Hyperexperimental run in brief: result, grade, steps, and how braces fared in translate replies."""
import json, os, re, sys
rd = sys.argv[1]
short = lambda s: re.sub(r'/private/tmp/claude-501/\S*?/app', '$APP', str(s)).replace('\n', ' / ')
r = json.load(open(rd + '/record/result.json'))
g = json.load(open(rd + '/grade.json'))
print('RESULT', {k: r.get(k) for k in ('status', 'timedOut', 'guard', 'error', 'modelCalls', 'roles', 'steps', 'retries')})
print('GRADE', g['summary'])
for l in open(rd + '/grade.log', errors='replace'):
    if l.startswith('E '): print('  ', short(l.strip())[:260])
rows = [json.loads(l) for l in open(rd + '/record/traces.jsonl')] if os.path.exists(rd + '/record/traces.jsonl') else []
tr = [d for d in rows if d.get('role') == 'translate']
br = [d for d in tr if '{' in d['reply'] or '}' in d['reply']]
fenced = [d for d in tr if '```' in d['reply']]
# braces the plan had (inside its fences) that the action lines lost: a plan with braces, a reply without
lost = [d for d in tr if ('{' in d['input'].split('PLAN:')[-1]) and '{' not in d['reply'] and re.search(r'^(RUN|WRITE)', d['reply'], re.M)]
unbal = [d for d in tr if d['reply'].count('{') != d['reply'].count('}')]
print(f'TRANSLATE {len(tr)} replies | with braces {len(br)} | with a fence left in {len(fenced)} | plan had braces but reply none {len(lost)} | unbalanced {len(unbal)}')
for d in (fenced + lost + unbal)[:4]: print('   ?? PLAN:', short(d['input'].split('PLAN:')[-1])[:300], '\n      REPLY:', short(d['reply'])[:400])
for d in br[:2]: print('   ok-sample:', short(d['reply'])[:260])
for d in rows:
    if d.get('type') == 'model' and d['role'] in ('think',): print(' T', d['promptChars'], f"{d['ms']//1000}s |", short(d['reply'])[:170])
t = json.load(open(rd + '/record/turn.json'))
items = t.get('items', [])
for it in items[-7:]:
    s = it.get('command') or it.get('text') or ''
    print('  ', it['type'][:10], it.get('exitCode'), '|', short(s)[:230], ('=> ' + short(it.get('aggregatedOutput') or '')[-110:]) if it.get('aggregatedOutput') else '')
