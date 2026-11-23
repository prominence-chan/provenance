import json,urllib.request,collections,sys
B='/private/tmp/claude-501/-Users-yufan/9e37ff0b-60f0-4144-b9a3-f4cc70335caf/scratchpad/bench'
job=open(B+'/runs/cancel-async-tasks--experimental/job.txt').read()
suffix=sys.argv[1] if len(sys.argv)>1 else ''
body={"model":"solstice","instructions":"You direct a coding job one small step at a time. Say in plain words what to do next."+suffix,"input":[{"role":"user","content":[{"type":"input_text","text":"JOB:\n"+job+"\n\nThis is step 1. What is the next step?"}]}],"stream":True,"store":False,"max_output_tokens":3000}
req=urllib.request.Request("http://127.0.0.1:4141/v1/responses",data=json.dumps(body).encode(),headers={"content-type":"application/json","accept":"text/event-stream","x-pcore-session":"orc-probe-0000"})
r=urllib.request.urlopen(req,timeout=150)
c=collections.Counter(); text=''; usage=None
for line in r:
    line=line.decode().strip()
    if not line.startswith('data:') or line[5:].strip()=='[DONE]': continue
    ev=json.loads(line[5:])
    c[ev.get('type')]+=1
    if ev.get('type')=='response.output_text.delta': text+=ev.get('delta','')
    if ev.get('type')=='response.completed': usage=ev['response'].get('usage',{}).get('output_tokens'); n=len(ev['response'].get('output',[]))
print('served',r.headers.get('x-pcore-model'),'| text len',len(text),'| out tokens',usage,'| items',n,'|',text[:120].replace('\n',' '))
