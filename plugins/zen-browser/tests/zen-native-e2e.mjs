import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BidiConnection } from '../server/bidi.mjs';
import { launchZen } from '../server/launch-zen.mjs';
import { runPlatform } from '../server/windows.mjs';
import { ConnectionManager } from '../server/connection-manager.mjs';
import { LineDecoder, MAX_RESPONSE } from '../server/wire.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run=path.join(root,'.artifacts','zen-native-'+Date.now()),profile=path.join(run,'profile'),home=path.join(run,'native-home 空格%'),extension=path.join(run,'extension');
await mkdir(profile,{recursive:true});await mkdir(extension,{recursive:true});
const checks=[],report={startedAt:new Date().toISOString(),checks,isolatedProfile:true};
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const prefs={'remote.prefs.recommended':false,'browser.tabs.warnOnClose':false,'browser.shell.checkDefaultBrowser':false,'browser.startup.page':3,'browser.startup.homepage':'about:blank','browser.aboutwelcome.enabled':false,'zen.welcome-screen.seen':true,'zen.welcome-screen.enabled':false,'datareporting.policy.dataSubmissionEnabled':false,'toolkit.telemetry.enabled':false};
await writeFile(path.join(profile,'user.js'),Object.entries(prefs).map(([k,v])=>`user_pref(${JSON.stringify(k)},${JSON.stringify(v)});`).join('\n'));
for(const file of await readdir(path.join(root,'extension'))){
  let content=await readFile(path.join(root,'extension',file));
  if(file==='background.js')content=Buffer.from(content.toString().replace("'io.github.reasonw6.zen_browser'","'io.github.reasonw6.zen_browser_test'").replace('receive(message, port) {',`receive(message, port) {
    if(message?.type==='test-select-tab'){this.api.tabs.update(message.tabId,{active:true}).then(()=>port.postMessage({type:'test-result',id:message.id}));return;}
    if(message?.type==='test-close-browser'){port.postMessage({type:'test-result',id:message.id});this.api.windows.getAll({windowTypes:['normal']}).then(ws=>Promise.all(ws.map(w=>this.api.windows.remove(w.id))));return;}`));
  await writeFile(path.join(extension,file),content);
}
const fixture=(await readFile(path.join(root,'tests/fixtures/page.html'),'utf8')).replace('<div id="spacer">','<div id="drop" style="height:90px;background:#cdded8" ondragover="event.preventDefault()" ondrop="if(event.isTrusted){this.textContent=\'原生拖放完成\';event.preventDefault()}">拖放目标</div><div id="spacer">');
const http=createServer((req,res)=>{
  res.setHeader('content-type','text/html;charset=utf-8');
  if(req.url==='/foreground')res.setHeader('set-cookie','zen_native_session=retained; Max-Age=86400; HttpOnly; SameSite=Lax; Path=/');
  if(req.url==='/session')res.end('<html><title>会话</title><p>'+((req.headers.cookie||'').includes('zen_native_session=retained')?'原有会话仍在':'会话不存在')+'</p></html>');
  else if(req.url==='/frame')res.end('<html><label>内嵌输入<input id="frame-input"></label><p id="frame-result">等待</p><button onclick="if(event.isTrusted)document.querySelector(\'p\').textContent=\'原生内嵌点击\'">内嵌按钮</button></html>');
  else res.end(fixture);
});
await new Promise(r=>http.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+http.address().port;
let mcp,connectionId,inspection,launched,receipt,focus,worker;
const initial=await runPlatform({action:'inspect',profiles:[],hostName:'io.github.reasonw6.zen_browser_test'});
const productionBefore=(await runPlatform({action:'inspect',profiles:[]})).currentManifest;
const logs=[];
process.env.ZEN_TEST_INSPECT_PIPE='\\\\.\\pipe\\zen-native-test-'+randomUUID();
process.env.ZEN_TEST_INSPECT_TOKEN=randomUUID();
async function idle(){const deadline=Date.now()+90000;while(Date.now()<deadline){if(!(await runPlatform({action:'profile-state',profile})).locked)return;await new Promise(r=>setTimeout(r,100));}throw Error('The isolated test browser did not close normally.');}
let startupAcknowledgements=0;
async function onWaitingForBrowser(details){
  const file=path.join(run,'operator-startup-'+(++startupAcknowledgements)+'.json');
  const current=(await runPlatform({action:'inspect',profiles:[profile]})).processes.find(item=>item.profile===profile);
  console.log('OPERATOR_STARTUP '+JSON.stringify({file,reason:details.reason,pid:current?.pid,window:current?.window,profile}));
  const deadline=Date.now()+180000;
  while(Date.now()<deadline&&!await stat(file).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,150));
  const record=JSON.parse(await readFile(file,'utf8'));report.startupConfirmations||=[];report.startupConfirmations.push(record);
}
function client(){
  const child=spawn(process.execPath,[path.join(root,'server/mcp.mjs')],{cwd:root,env:{...process.env,ZEN_BRIDGE_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map(),decoder=new LineDecoder(MAX_RESPONSE);let next=0;child.stderr.on('data',d=>logs.push(d.toString()));
  child.stdout.on('data',d=>decoder.push(d));decoder.on('message',message=>{const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);});
  return {child,rpc(method,params={}){const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout '+method));},40000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}};
}
async function call(name,args={},expectedError){const r=await mcp.rpc('tools/call',{name:'zen_'+name,arguments:{...(connectionId?{connectionId}:{}),...args}});const value=JSON.parse(r.content.find(c=>c.type==='text').text);if(expectedError){assert.ok(r.isError);assert.equal(value.code,expectedError);return value;}if(r.isError)throw Object.assign(new Error(name+': '+JSON.stringify(value)),{code:value.code});return value;}
async function connected(){for(let i=0;i<60;i++){const status=await call('status');if(status.connected){connectionId=status.connections[0].connectionId;return status;}await new Promise(r=>setTimeout(r,100));}throw new Error('Native extension did not connect.');}
async function inspect(){
  inspection?.close();const socket=net.createConnection(process.env.ZEN_TEST_INSPECT_PIPE);await new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j);});
  const pending=new Map(),decoder=new LineDecoder(MAX_RESPONSE);let next=0;
  socket.on('data',data=>decoder.push(data));decoder.on('message',m=>{const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);});
  socket.on('error',()=>{});socket.on('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Test inspection ended'));}pending.clear();});
  inspection={request(method,params={},timeout=20000){const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Inspection timeout '+method));},timeout);pending.set(id,{resolve,reject,timer});socket.write(JSON.stringify({id,token:process.env.ZEN_TEST_INSPECT_TOKEN,method,params})+'\n');});},close(){socket.destroy();}};
}
async function read(context,expression){const r=await inspection.request('script.evaluate',{expression:'JSON.stringify('+expression+')',target:{context},awaitPromise:true});if(r.type!=='success')throw new Error(JSON.stringify(r.exceptionDetails));return JSON.parse(r.result.value);}
const nodes=node=>[node,...(node.value?.children||[]).flatMap(nodes),...(node.value?.shadowRoot?[node.value.shadowRoot].flatMap(nodes):[])];
async function element(context,selector){const r=await inspection.request('script.evaluate',{expression:'document.querySelector('+JSON.stringify(selector)+')',target:{context},awaitPromise:false});return r.result.sharedId;}
async function uiNode(context,action){const r=await inspection.request('script.evaluate',{expression:'document.querySelector("zen-ai-control")',target:{context},awaitPromise:false,serializationOptions:{maxDomDepth:6,includeShadowTree:'all'}});const found=nodes(r.result).find(n=>n.value?.attributes?.['data-action']===action);if(!found)throw new Error('Missing page control '+action);return found.sharedId;}
async function point(context,id){const r=await inspection.request('script.callFunction',{functionDeclaration:'function(e){const r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,disabled:e.disabled})}',target:{context},arguments:[{sharedId:id}],awaitPromise:false});return JSON.parse(r.result.value);}
async function clickAt(context,p){await inspection.request('input.performActions',{context,actions:[{type:'pointer',id:'test-user',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',x:p.x,y:p.y,duration:0},{type:'pointerDown',button:0},{type:'pointerUp',button:0}]}]});await inspection.request('input.releaseActions',{context});}
async function ui(context,action){const id=await uiNode(context,action);let p;for(let i=0;i<60;i++){p=await point(context,id);if(!p.disabled)break;await new Promise(r=>setTimeout(r,50));}assert.ok(!p.disabled,'Control enabled: '+action);await clickAt(context,p);}
async function control(tabId){return(await call('tabs')).tabs.find(t=>t.tabId===tabId).control;}
async function resume(context,tabId){await ui(context,'resume');return call('snapshot',{tabId});}
async function screenshot(context,name){const r=await inspection.request('browsingContext.captureScreenshot',{context,origin:'viewport'});await writeFile(path.join(run,name),Buffer.from(r.data,'base64'));}
async function startFocus(phase){const output=path.join(run,'focus-'+phase+'.json'),stop=path.join(run,'stop-'+phase);const child=spawn('pwsh.exe',['-NoProfile','-File',path.join(root,'tests/focus-monitor.ps1'),'-OutputFile',output,'-StopFile',stop],{windowsHide:true,stdio:'ignore'});focus={child,output,stop,phase};for(let i=0;i<80;i++){try{await readFile(output+'.ready');return;}catch{await new Promise(r=>setTimeout(r,50));}}throw new Error('Focus monitor not ready');}
async function stopFocus(){if(!focus)return;await writeFile(focus.stop,'stop');if(focus.child.exitCode===null)await new Promise(r=>focus.child.once('exit',r));const samples=JSON.parse((await readFile(focus.output,'utf8')).replace(/^\uFEFF/,''));report.focusRuns||=[];const result={phase:focus.phase,samples:samples.length,handles:[...new Set(samples.map(s=>s.handle))]};report.focusRuns.push(result);focus=null;check('Windows foreground preserved during '+result.phase,samples.length>10&&samples.every(s=>s.handle!==0)&&result.handles.length===1);}
try{
  const buildId=await new ConnectionManager({source:root,home}).buildId();
  const install=await runPlatform({action:'install',source:root,home,hostName:'io.github.reasonw6.zen_browser_test',buildId},{timeoutMs:30000});
  receipt=install.receipt;worker=install.platformPath;
  await writeFile(path.join(install.runtimePath,'native-host-core.mjs'),await readFile(path.join(install.runtimePath,'native-host.mjs')));
  const adapter=await readFile(path.join(root,'tests/native-inspection-host.mjs'),'utf8');
  await writeFile(path.join(install.runtimePath,'native-host.mjs'),adapter.replace('process.env.ZEN_TEST_INSPECT_TOKEN',JSON.stringify(process.env.ZEN_TEST_INSPECT_TOKEN)).replace('process.env.ZEN_TEST_INSPECT_PIPE',JSON.stringify(process.env.ZEN_TEST_INSPECT_PIPE)));
  launched=await launchZen({binary:process.env.ZEN_BINARY,profile,home,extension,worker,hidden:true,onWaitingForBrowser});report.launch={...launched};
  check('production launcher automatically loads the unsigned extension',launched.automaticTemporaryLoad);
  mcp=client();await mcp.rpc('initialize',{protocolVersion:'2025-11-25'});const status=await connected();
  check('MCP discovers native mode from the launched browser',status.connections[0].nativeInput);
  await inspect();
  const front=(await inspection.request('browsingContext.create',{type:'tab',background:false})).context;
  await inspection.request('browsingContext.navigate',{context:front,url:base+'/foreground',wait:'complete'});
  await read(front,'(()=>{const e=document.querySelector("#foreground");e.focus();e.setSelectionRange(2,5);return true})()');
  const tabId=(await call('open',{url:base+'/ai',taskTitle:'原生输入与自动加载验收'})).tabId;
  await call('wait',{tabId,selector:'#trusted'});await call('snapshot',{tabId});
  const clicked=await call('click',{tabId,selector:'#trusted'});
  check('the actual MCP click produces trusted page behavior',clicked.native&&(await call('snapshot',{tabId})).text.includes('已收到真实点击'));
  let tree=(await inspection.request('browsingContext.getTree')).contexts;
  const ai=tree.find(c=>c.url===base+'/ai').context;
  check('native MCP input keeps its tab in the background',await read(ai,'document.hidden')&&!await read(front,'document.hidden'));
  const frontState=()=>read(front,'({hidden:document.hidden,focus:document.activeElement.id,text:document.querySelector("#foreground").value,start:document.querySelector("#foreground").selectionStart,end:document.querySelector("#foreground").selectionEnd})');
  const before=await frontState();
  await startFocus('native-background');
  const typed=await call('fill',{tabId,selector:'#name',text:'Zen 原生雨瑶 123'});
  check('native typing replaces text with real keyboard input',typed.native&&typed.value==='Zen 原生雨瑶 123');
  await call('click',{tabId,selector:'#submit'});await call('wait',{tabId,text:'已收到 Zen 原生雨瑶 123'});
  check('native form input and submission update the application',true);
  assert.deepEqual(await frontState(),before);check('native background work preserves front focus, text and selection',true);
  check('native events are not falsely classified as takeover',(await control(tabId)).controlled);
  const beforeMultiline=await read(ai,'document.querySelector("#output").textContent');
  const literal=await call('fill',{tabId,selector:'#message',text:'第一行\n第二行'});
  check('multiline fill remains literal and cannot press Enter to submit',!literal.native&&(await read(ai,'document.querySelector("#message").value'))==='第一行\n第二行'&&(await read(ai,'document.querySelector("#output").textContent'))===beforeMultiline);
  const frame=(await call('snapshot',{tabId})).frames.find(f=>f.url.endsWith('/frame'));await call('snapshot',{tabId,frameId:frame.frameId});
  await call('click',{tabId,frameId:frame.frameId,selector:'button'});await call('wait',{tabId,frameId:frame.frameId,text:'原生内嵌点击'});
  check('native input binds to the exact iframe document',true);
  const duplicate=(await call('open',{url:base+'/ai'})).tabId;await call('wait',{tabId:duplicate,selector:'#name'});await call('snapshot',{tabId:duplicate});
  await call('fill',{tabId:duplicate,selector:'#name',text:'另一个同网址标签'});
  const originalSnapshot=await call('snapshot',{tabId});const duplicateSnapshot=await call('snapshot',{tabId:duplicate});
  check('identical URLs cannot confuse native target identity',originalSnapshot.elements.find(e=>e.id==='name').value==='Zen 原生雨瑶 123'&&duplicateSnapshot.elements.find(e=>e.id==='name').value==='另一个同网址标签');
  await stopFocus();
  await inspection.request('test.selectTab',{tabId});
  check('selecting the tab enters watching without changing ownership',!await read(ai,'document.hidden')&&(await control(tabId)).controlled);
  await startFocus('native-watching');
  await call('fill',{tabId,selector:'#name',text:'正在观看原生操作'});await call('press',{tabId,selector:'#name',key:'Enter'});
  check('watching retains control during trusted typing and Enter',(await control(tabId)).controlled&&(await read(ai,'document.querySelector("#output").textContent')).includes('正在观看原生操作'));
  await call('fill',{tabId,selector:'#message',text:'连续观看原生输入123 '.repeat(8)});
  check('continuous watched input remains owned and complete',(await control(tabId)).controlled&&(await read(ai,'document.querySelector("#message").value'))==='连续观看原生输入123 '.repeat(8));
  await screenshot(ai,'native-watching.png');
  await stopFocus();
  await call('fill',{tabId,selector:'#message',text:''});
  const pending=call('fill',{tabId,selector:'#name',text:'持续原生输入'.repeat(150)}).then(value=>({value}),error=>({error}));
  for(let i=0;i<80;i++){if((await read(ai,'document.querySelector("#name").value')).startsWith('持续'))break;await new Promise(r=>setTimeout(r,20));}
  const stale=call('fill',{tabId,selector:'#message',text:'不得重放'}).then(value=>({value}),error=>({error}));
  await ui(ai,'pause');await ui(ai,'resume');const stopped=await pending,queued=await stale;
  check('pause stops native typing before the remaining characters',!!stopped.error&&(await read(ai,'document.querySelector("#name").value')).length<900);
  check('Continue cannot replay an old queued native write',!!queued.error&&(await read(ai,'document.querySelector("#message").value'))==='');
  await call('fill',{tabId,selector:'#name',text:'must observe'},'OBSERVATION_REQUIRED');await call('snapshot',{tabId});
  await call('fill',{tabId,selector:'#name',text:'恢复后的原生操作'});
  await clickAt(ai,await point(ai,await element(ai,'#message')));
  check('actual page input still takes over native mode',(await control(tabId)).state==='user_control');
  await call('click',{tabId,selector:'#submit'},'CONTROL_STOPPED');await resume(ai,tabId);
  await call('scroll',{tabId,selector:'#drag',y:0});
  await read(ai,'(()=>{document.querySelector("#drag").scrollIntoView({block:"center"});return true})()');
  const drop=await point(ai,await element(ai,'#drop'));
  await call('drag',{tabId,selector:'#drag',toX:Math.round(drop.x),toY:Math.round(drop.y),duration:180});
  check('native drag reaches the page without a false takeover',(await control(tabId)).controlled&&(await read(ai,'document.querySelector("#drag").dataset.dragStarted'))==='true');
  const other=client();await other.rpc('initialize',{protocolVersion:'2025-11-25'});const wrong=await other.rpc('tools/call',{name:'zen_attach',arguments:{connectionId,tabId}});other.child.stdin.end();
  check('another MCP connection cannot take the native tab',wrong.isError&&JSON.parse(wrong.content[0].text).code==='TAB_BUSY');
  await call('task',{tabId,outcome:'completed',message:'原生输入结果已核对'});await screenshot(ai,'native-completed.png');
  check('native completion retains the real result page',(await control(tabId)).state==='completed');
  await inspection.request('test.closeBrowser');inspection.close();inspection=null;
  await idle();
  launched=await launchZen({binary:process.env.ZEN_BINARY,profile,home,extension,worker,hidden:true,onWaitingForBrowser});connectionId=undefined;await connected();
  check('a restart automatically reloads the unsigned extension',true);
  const restored=(await call('open',{url:base+'/session'})).tabId;await call('wait',{tabId:restored,text:'原有会话仍在'});
  check('restarting the same profile preserves its login session',true);
  const last=(await call('open',{url:base+'/ai'})).tabId;await call('wait',{tabId:last,selector:'#trusted'});await call('snapshot',{tabId:last});await call('click',{tabId:last,selector:'#trusted'});
  check('native input reconnects after browser restart',(await call('snapshot',{tabId:last})).text.includes('已收到真实点击'));
  await inspect();report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;console.error(error.stack);process.exitCode=1;}
finally{
  if(focus){await writeFile(focus.stop,'stop');if(focus.child.exitCode===null)await new Promise(r=>focus.child.once('exit',r));}
  if(inspection){await inspection.request('test.closeBrowser',{},3000).catch(()=>{});inspection.close();}
  else if(launched){try{await inspect();await inspection.request('test.closeBrowser',{},3000);}catch{}finally{inspection?.close();}}
  mcp?.child.stdin.end();http.close();
  try{const info=(await runPlatform({action:'inspect',profiles:[profile]})).processes.find(item=>item.profile===profile);if(info){await runPlatform({action:'close-profile',profile,binary:info.binary,pid:info.pid,started:info.started},{timeoutMs:45000});await idle();}}catch(error){report.browserCleanupError=error.message;process.exitCode=1;}
  if(receipt){try{await runPlatform({action:'restore-host',receipt,hostName:'io.github.reasonw6.zen_browser_test'});report.registrationRestored=true;}catch(error){report.registrationRestored=false;report.cleanupError=error.message;process.exitCode=1;}}
  const after=await runPlatform({action:'inspect',profiles:[],hostName:'io.github.reasonw6.zen_browser_test'});
  report.testRegistrationRestored=after.currentManifest===initial.currentManifest;
  report.productionRegistrationUnchanged=(await runPlatform({action:'inspect',profiles:[]})).currentManifest===productionBefore;
  report.otherBrowsersPreserved=initial.processes.every(before=>after.processes.some(item=>item.pid===before.pid&&item.started===before.started));
  if(!report.testRegistrationRestored||!report.productionRegistrationUnchanged||!report.otherBrowsersPreserved)process.exitCode=1;
  report.finishedAt=new Date().toISOString();await writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await writeFile(path.join(run,'mcp.log'),logs.join(''));console.log('Evidence: '+run);
}
