import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDriver } from '../server/native-driver.mjs';
import { localEndpoint, BidiConnection } from '../server/bidi.mjs';

const lease={documentId:'document-a',epoch:7,token:'permit-a',url:'https://example.com/form'};
function fixture(){
  const driver=new NativeDriver({file:'unused',home:'unused'}),actions=[];
  const state={connected:true,visible:true,focused:true,value:{controlled:true,...lease,visibleSince:0,focusedSince:0}};
  let physical=0,at=0,onAction=()=>{};
  driver.ensure=async()=>{};driver.binding=async()=>({context:'context-a',sharedId:'private-binding'});
  driver.readBinding=async()=>structuredClone(state);
  driver.startProbe=async()=>{driver.probe={exitCode:null};};
  driver.samplePhysical=async()=>({counter:physical,at});
  driver.connection={socket:{readyState:1},request:async(method,params)=>{actions.push({method,params});if(method==='input.performActions')await onAction(params);return method==='script.callFunction'?{type:'success'}:{};}};
  return{driver,state,actions,physical(){physical++;at=Date.now();},onAction(fn){onAction=fn;},run(plan){return driver.execute('request-a',lease,plan,Date.now()+5000);},inputs(){return actions.filter(a=>a.method==='input.performActions');}};
}
test('native endpoints accept only launcher-created loopback session URLs',()=>{
  assert.equal(localEndpoint('ws://127.0.0.1:9222/session'),'ws://127.0.0.1:9222/session');
  for(const url of ['ws://example.com:9222/session','wss://127.0.0.1:9222/session','ws://user:secret@127.0.0.1:9222/session','ws://127.0.0.1:9222/other','ws://127.0.0.1:9222/session?x=1'])assert.throws(()=>localEndpoint(url),{code:'INVALID_ENDPOINT'});
});
test('a stopped native document never receives an input primitive',async()=>{
  const f=fixture();f.state.value.controlled=false;
  await assert.rejects(f.run({command:'click',x:10,y:20}),{code:'CONTROL_CHANGED'});assert.equal(f.inputs().length,0);
});
test('native typing stops between primitives after control changes',async()=>{
  const f=fixture();f.onAction(()=>{f.state.value.epoch++;});
  await assert.rejects(f.run({command:'fill',text:'must not type'}),{code:'CONTROL_CHANGED'});
  assert.equal(f.inputs().length,1);assert.equal(f.actions.at(-1).method,'input.releaseActions');
});
test('cancelling an in-flight native primitive prevents all subsequent typing',async()=>{
  const f=fixture();let release,started;const ready=new Promise(r=>started=r);
  f.onAction(()=>new Promise(r=>{release=r;started();}));
  const result=f.run({command:'fill',text:'do not replay'});const rejected=assert.rejects(result,{code:'CONTROL_CHANGED'});
  await ready;f.driver.cancel('request-a');release();await rejected;assert.equal(f.inputs().length,1);
});
test('real keyboard provenance stops even an otherwise matching expected key',async()=>{
  const f=fixture();f.onAction(()=>f.physical());
  await assert.rejects(f.run({command:'press',key:'a'}),{code:'USER_INPUT'});assert.equal(f.inputs().length,1);
});
test('keyboard activity in another tab does not stop background typing',async()=>{
  const f=fixture();f.state.visible=false;f.state.focused=false;f.onAction(()=>f.physical());
  assert.equal((await f.run({command:'fill',text:'ab'})).native,true);assert.equal(f.inputs().length,4);
});
test('DOM binding identity cannot be substituted by an identical URL',async()=>{
  const f=fixture();f.driver.bindings.clear();
  const node=(documentId,sharedId)=>({value:{shadowRoot:{value:{children:[{sharedId,value:{localName:'meta',attributes:{name:'zen-native-binding',content:JSON.stringify({documentId})}}}]}}}});
  f.driver.connection.request=async(method,params)=>method==='browsingContext.getTree'?{contexts:[{context:'wrong',url:lease.url},{context:'right',url:lease.url}]}:{result:{value:[node(params.target.context==='right'?lease.documentId:'another-document',params.target.context+'-node')]}};
  const binding=await NativeDriver.prototype.binding.call(f.driver,lease);assert.deepEqual(binding,{context:'right',sharedId:'right-node'});
});
test('native connection initialization is shared by concurrent tab requests',async()=>{
  const driver=new NativeDriver({file:'unused',home:'unused'});let count=0,resolve;
  driver.connect=()=>{count++;return new Promise(r=>resolve=r);};
  const a=driver.ensure(),b=driver.ensure();assert.equal(count,1);resolve();await Promise.all([a,b]);
});
test('a native transport timeout does not resend the operation',async()=>{
  const client=new BidiConnection('ws://127.0.0.1:9222/session',{timeout:15});const sent=[];
  client.socket={readyState:1,send:payload=>sent.push(JSON.parse(payload)),close:()=>{}};
  await assert.rejects(client.request('input.performActions',{context:'one',actions:[]}),{code:'NATIVE_TIMEOUT'});assert.equal(sent.length,1);assert.equal(client.pending.size,0);
});
test('literal control characters never become native form-submitting keys',async()=>{
  const f=fixture();await assert.rejects(f.run({command:'fill',text:'first\nsecond'}),{code:'NATIVE_LITERAL_REQUIRED'});assert.equal(f.inputs().length,0);
});
test('an expired permit returned by the browser prevents native dispatch',async()=>{
  const f=fixture();f.driver.connection.request=async()=>({type:'exception'});
  await assert.rejects(f.run({command:'click',x:10,y:20}),{code:'CONTROL_CHANGED'});assert.equal(f.inputs().length,0);
});
