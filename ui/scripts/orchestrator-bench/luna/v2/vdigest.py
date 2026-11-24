#!/usr/bin/env python3
"""vdigest.py <run dir>: any arm's run in brief: result, finish check, grade, lost-text checks, the roles' replies, last items."""
import json, os, re, sys
rd = sys.argv[1]
short = lambda s: re.sub(r'/private/tmp/claude-501/\S*?/app', '$APP', str(s)).replace('\n', ' / ')
r = json.load(open(rd + '/record/result.json'))
g = json.load(open(rd + '/grade.json'))
print('RESULT', {k: r.get(k) for k in ('mode', 'status', 'timedOut', 'guard', 'error', 'modelCalls', 'roles', 'workers', 'workerCalls', 'workerMaxInputTokens', 'steps', 'retries', 'finish', 'maxInputTokens')})
print('APPROVALS declined:', len(r.get('approvalsDeclined', [])))
print('GRADE', g['summary'])
for l in open(rd + '/grade.log', errors='replace'):
    if l.startswith('E '): print('  ', short(l.strip())[:240])
tp = rd + '/record/traces.jsonl'
rows = [json.loads(l) for l in open(tp)] if os.path.exists(tp) else []
ms = [d for d in rows if d.get('type') == 'model']
tr = [d for d in ms if d['role'] == 'translate']
if ms:
    print(f"TEXT plain replies {len(ms)} | with a raw fence left in {sum(1 for d in ms if '```raw' in d['reply'])} | translate {len(tr)}: with braces {sum(1 for d in tr if '{' in d['reply'])}, with any fence {sum(1 for d in tr if '```' in d['reply'])}, unbalanced braces {sum(1 for d in tr if d['reply'].count('{') != d['reply'].count('}'))}, plan had braces but reply none {sum(1 for d in tr if '{' in d['input'].split('PLAN:')[-1] and '{' not in d['reply'])}")
for d in rows:
    if d.get('type') == 'model':
        w = 900 if d['role'] == 'review' else 170
        print(' M', d['role'], d['promptChars'], f"{d['ms']//1000}s |", short(d['reply'])[:w])
    else:
        print(' WORKER', d['status'], 'calls', d['calls'], 'maxTok', d['maxInputTokens'], 'cmds', d.get('commands'), '|', short(d['task'])[:110], '|| REPORT:', short(d.get('report') or '')[-230:])
t = json.load(open(rd + '/record/turn.json'))
items = t.get('items', [])
print('ITEMS', len(items))
for it in items[-(int(sys.argv[2]) if len(sys.argv) > 2 else 8):]:
    s = it.get('command') or it.get('text') or ''
    print('  ', it['type'][:10], it.get('exitCode'), '|', short(s)[:260], ('=> ' + short(it.get('aggregatedOutput') or '')[-110:]) if it.get('aggregatedOutput') else '')
