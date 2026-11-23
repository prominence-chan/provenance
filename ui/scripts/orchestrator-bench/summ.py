import json,sys,os,re
rd=sys.argv[1]; W=int(sys.argv[2]) if len(sys.argv)>2 else 150; N=int(sys.argv[3]) if len(sys.argv)>3 else 45
short=lambda s: re.sub(r'/private/tmp/claude-501/\S*?/app','$APP',str(s)).replace('\n',' / ')
r=json.load(open(rd+'/record/result.json'))
print('RESULT', {k:r.get(k) for k in('status','timedOut','guard','error','modelCalls','roles','workers','workerCalls','workerMaxInputTokens','steps','maxInputTokens','servedBy')})
print('APPROVALS declined:',len(r.get('approvalsDeclined',[])))
tp=rd+'/record/traces.jsonl'
if os.path.exists(tp):
    for l in open(tp):
        d=json.loads(l)
        if d['type']=='model': print(' M',d['role'],d['promptChars'],(d['servedBy'] or '?').split('/')[-1],f"{d['ms']//1000}s |",short(d['reply'])[:W])
        else: print(' WORKER',d['status'],'calls',d['calls'],'maxTok',d['maxInputTokens'],'|',short(d['task'])[:W])
t=json.load(open(rd+'/record/turn.json'))
items=t.get('items',[])
print('ITEMS',len(items))
show=items if len(items)<=N else items[:N//3]+[{'type':'...'}]+items[-(2*N//3):]
for it in show:
    s=it.get('command') or it.get('text') or str([c.get('path') for c in it.get('changes',[])] if it.get('changes') else '')
    o=(it.get('aggregatedOutput') or '')
    print(' ',it['type'][:12],it.get('status'),it.get('exitCode'),'|',short(s)[:W],('=> '+short(o)[-90:]) if o else '')
g=rd+'/grade.log'
print('GRADE', json.load(open(rd+'/grade.json'))['summary'])
for l in open(g,errors='replace'):
    if l.startswith('E ') : print('  ',short(l.strip())[:220])
