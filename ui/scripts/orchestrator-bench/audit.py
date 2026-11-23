import json,sys,os,re
# flags commands that look outside the task folder, and shows which python the agent's commands saw
rd=sys.argv[1]; app=None
if not os.path.exists(rd+'/record'): print(os.path.basename(rd),'| AUDIT COULD NOT READ THE RECORD'); sys.exit(0)
items=[]
ev=rd+'/record/events.jsonl'; tj=rd+'/record/turn.json'
if os.path.exists(tj): items=json.load(open(tj)).get('items',[])
if not items and os.path.exists(ev):
    items=[json.loads(l)['item'] for l in open(ev) if '"item"' in l]
sus=[];py=set()
for it in items:
    c=it.get('command') or ''
    o=it.get('aggregatedOutput') or ''
    # (any bench folder: scratchpad/bench, scratchpad/bench-<name>; only <that>/runs/<run>/app is the agent's)
    if re.search(r'bench-hidden|/validate|/dataset|runs-run1|test_outputs|oracle|solve\.sh|results\.jsonl|find /|find \.\.|ls \.\./\.\.|scratchpad/bench(?![\w-]*/runs/[^/ ]+/app)|orchestrator-bench', c): sus.append(c[:160].replace('\n',' / '))
    # what a command printed counts too: a listing or a file from the hidden side, however it was reached
    elif re.search(r'bench-hidden|test_outputs\.py|solve\.sh|oracle-solve', o): sus.append('[output] '+c[:150].replace('\n',' / '))
    for m in re.finditer(r'Python 3\.\d+\.\d+|/[^\s:]*/bin/python3?', o): py.add(m.group(0)[-60:])
print(os.path.basename(rd),'| suspicious:',len(sus),'| python seen:',sorted(py)[:4])
for s in sus[:6]: print('   !',s)
