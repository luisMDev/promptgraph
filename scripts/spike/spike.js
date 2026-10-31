const pty=require('node-pty'),http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),{execSync}=require('child_process');
const S=process.env.SPIKE_DIR||__dirname, repo=path.join(S,'repo'); const PORT=4799, TOKEN='tok';
fs.rmSync(repo,{recursive:true,force:true}); fs.mkdirSync(path.join(repo,'.claude/commands'),{recursive:true});
fs.writeFileSync(path.join(repo,'.claude/commands/ping.md'),'Reply with exactly the word PINGED and nothing else.');
execSync('git init -q && git add -A && git -c user.email=a@b -c user.name=a commit -qm init',{cwd:repo});
const hook=path.join(S,'pg-hook');
const settings={hooks:Object.fromEntries([['SessionStart','session-start'],['Stop','stop'],['Notification','notification'],['PreToolUse','activity']].map(([k,v])=>[k,[{hooks:[{type:'command',command:`${hook} ${v}`}]}]]))};
fs.writeFileSync(path.join(S,'hooks.json'),JSON.stringify(settings));
const events=[];
http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{const e={url:req.url,auth:req.headers.authorization,body:JSON.parse(b||'{}')};events.push(e);console.log('HOOK',req.url,JSON.stringify(e.body).slice(0,300));res.end('ok');onHook(e)})}).listen(PORT,'127.0.0.1');
const env={...process.env,TERM:'xterm-256color',PG_PORT:PORT,PG_TOKEN:TOKEN}; delete env.CLAUDECODE; env.CLAUDE_CONFIG_DIR=path.join(S,'cfg'); for(const k of Object.keys(env)) if(/HERMETIC|CLAUDE_CODE_REMOTE_SESSION|CLAUDE_CODE_SESSION_ID|CHILD_SESSION|TEE_SDK|SYNC_SESSION/.test(k)) delete env[k]; env.CLAUDE_CONFIG_DIR=path.join(S,'cfg'); delete env.CLAUDE_CODE_ENTRYPOINT;
let stage=0, p, sid1=crypto.randomUUID(), out='';
function spawn(args,nr){ out=''; console.log('SPAWN',args.join(' ')); p=pty.spawn('claude',args,{cwd:repo,cols:120,rows:40,env:{...env,PG_NODE_RUN_ID:nr}}); p.onData(d=>{out+=d; const plain=out.replace(/\[[0-9;?]*[a-zA-Z]/g,'').replace(/\s/g,''); if(/Itrustthisfolder/.test(plain)&&!p._t){p._t=1;console.log('TRUST DIALOG seen');} fs.appendFileSync(path.join(S,nr+'.log'),d)}); p.onExit(e=>console.log('EXIT',nr,e)); }
function lastAssistant(tp){const lines=fs.readFileSync(tp,'utf8').trim().split('\n').map(l=>JSON.parse(l));for(let i=lines.length-1;i>=0;i--){const l=lines[i];if(l.type==='assistant'){const c=l.message.content;const t=(Array.isArray(c)?c:[]).filter(x=>x.type==='text').map(x=>x.text).join('');if(t)return t}}return null}
function onHook(e){ if(!e.url.endsWith('/stop'))return; console.log('STOPBODY',JSON.stringify(e.body)); let t=e.body.last_assistant_message; try{lastAssistant(e.body.transcript_path);console.log('TRANSCRIPT OK')}catch(err){console.log('NO TRANSCRIPT YET')} setTimeout(()=>{try{console.log('LATER exists:',fs.existsSync(e.body.transcript_path))}catch{}},1500); console.log('LAST MSG:',JSON.stringify(t));
  if(stage===0){stage=1; p.write('/exit\r'); setTimeout(()=>{p.kill(); spawn(['--resume',sid1,'What word did you just say? Reply with it lowercase.','--settings',path.join(S,'hooks.json'),'--permission-mode','acceptEdits'],'nr2')},3000)}
  else if(stage===1){stage=2; p.write('/exit\r'); setTimeout(()=>{p.kill(); spawn(['/ping','--session-id',crypto.randomUUID(),'--settings',path.join(S,'hooks.json')],'nr3')},3000)}
  else {stage=3; p.write('/exit\r'); setTimeout(()=>{p.kill(); fs.writeFileSync(path.join(S,'events.json'),JSON.stringify(events,null,1)); process.exit(0)},3000)}
}
spawn(['Reply with exactly the word PONG and nothing else.','--session-id',sid1,'--name','pg:spike/first','--settings',path.join(S,'hooks.json'),'--permission-mode','acceptEdits'],'nr1');
setTimeout(()=>{console.log('TIMEOUT stage',stage); console.log(out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,'').slice(-2500)); fs.writeFileSync(path.join(S,'events.json'),JSON.stringify(events,null,1)); process.exit(1)},150000);
