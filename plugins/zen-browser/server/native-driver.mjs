import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BidiConnection, bidiError, localEndpoint } from './bidi.mjs';

const KEY = { Enter:'\uE007',Tab:'\uE004',Escape:'\uE00C',Backspace:'\uE003',Delete:'\uE017',ArrowLeft:'\uE012',ArrowUp:'\uE013',ArrowRight:'\uE014',ArrowDown:'\uE015',Home:'\uE011',End:'\uE010' };
const flatten = contexts => contexts.flatMap(context => [context, ...flatten(context.children || [])]);
export const nativeKey = key => KEY[key] || ([...key].length === 1 ? key : (()=>{throw bidiError('UNSUPPORTED_KEY','Unsupported native key.');})());

export async function readLaunchRecord(file, home) {
  const expected = path.join(path.resolve(home), 'launches');
  if (!file || path.dirname(path.resolve(file)).toLowerCase() !== expected.toLowerCase() || !/^[\da-f-]{36}\.json$/i.test(path.basename(file))) throw bidiError('NATIVE_UNAVAILABLE','Use the launcher to enable native input for this exact Zen instance.');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value.version !== 1 || !Number.isInteger(value.browserPid) || value.browserPid <= 0 || typeof value.profile !== 'string') throw bidiError('INVALID_ENDPOINT','Invalid Zen launch record.');
  localEndpoint(value.endpoint); if (value.sessionUrl) localEndpoint(value.sessionUrl);
  process.kill(value.browserPid, 0);
  return value;
}

export class NativeDriver {
  constructor({ file, home, Connection = BidiConnection, probePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'zen-input-probe.exe') }) {
    this.file=file; this.home=home; this.Connection=Connection; this.probePath=probePath;
    this.jobs=new Map(); this.bindings=new Map(); this.inputCounter=0; this.probe=null; this.connection=null;
    this.probeSamples=new Map();this.sampleId=0;
  }
  async ensure() {
    if (this.closed) throw bidiError('NATIVE_DISCONNECTED', 'The native host is closing.');
    if (this.connection?.socket?.readyState === 1) return;
    if (!this.initializing) this.initializing = this.connect().finally(() => { this.initializing = null; });
    return this.initializing;
  }
  async connect() {
    const record=await readLaunchRecord(this.file,this.home);
    if (!record.ready) throw bidiError('NATIVE_UNAVAILABLE','The Zen launcher is still loading the extension.');
    let connection;
    if (record.sessionUrl) {
      try { connection=await new this.Connection(record.sessionUrl,{connectTimeout:1500}).connect(); await connection.request('session.status'); }
      catch { connection?.close(); connection=null; }
    }
    if (!connection) {
      connection=await new this.Connection(record.endpoint).connect();
      let session;
      try { session=await connection.request('session.new',{capabilities:{alwaysMatch:{acceptInsecureCerts:false,webSocketUrl:true}}}); }
      catch(error){connection.close();if(error.message.includes('Maximum number of active sessions'))throw bidiError('NATIVE_SESSION_BUSY','Zen retained an earlier native session after an unexpected interruption. Close this profile and start it with the launcher again; no action was replayed.');throw error;}
      if (session.capabilities['moz:processID'] !== record.browserPid || path.resolve(session.capabilities['moz:profile']).toLowerCase() !== path.resolve(record.profile).toLowerCase()) {
        connection.close(); throw bidiError('WRONG_BROWSER','The endpoint is not the Zen process and profile started by this launcher.');
      }
      record.sessionUrl=session.capabilities.webSocketUrl;
      if (record.sessionUrl) await writeFile(this.file,JSON.stringify(record),{mode:0o600});
    }
    this.record=record;this.connection=connection;this.bindings.clear();
  }
  async startProbe() {
    if(this.probe?.exitCode===null)return;
    const child=spawn(this.probePath,[String(this.record.browserPid)],{windowsHide:true,stdio:['pipe','pipe','ignore']});this.probe=child;
    await new Promise((resolve,reject)=>{
      let buffer='';let ready=false;
      const timer=setTimeout(()=>{child.kill();reject(bidiError('INPUT_PROBE_UNAVAILABLE','Physical keyboard detection did not start. Reinstall the native host.'));},3000);
      child.stdout.on('data',data=>{buffer+=data.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const message=JSON.parse(line);if(Number.isSafeInteger(message.counter))this.inputCounter=message.counter;const sample=this.probeSamples.get(message.sample);if(sample){clearTimeout(sample.timer);this.probeSamples.delete(message.sample);sample.resolve(message);}if(message.ready){ready=true;clearTimeout(timer);resolve();}}catch{}}});
      child.once('error',()=>{clearTimeout(timer);reject(bidiError('INPUT_PROBE_UNAVAILABLE','The native keyboard provenance helper is missing. Reinstall the native host.'));});
      child.stdin.on('error',()=>{for(const sample of this.probeSamples.values()){clearTimeout(sample.timer);sample.reject(bidiError('INPUT_PROBE_UNAVAILABLE','Physical keyboard detection disconnected.'));}this.probeSamples.clear();});
      child.once('exit',()=>{clearTimeout(timer);if(!ready)reject(bidiError('INPUT_PROBE_UNAVAILABLE','The native keyboard provenance helper failed.'));});
    });
  }
  samplePhysical() {
    const id=++this.sampleId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.probeSamples.delete(id);reject(bidiError('INPUT_PROBE_UNAVAILABLE','Physical input detection stopped responding.'));},1000);
      this.probeSamples.set(id,{resolve,reject,timer});
      this.probe.stdin.write(id+'\n',error=>{if(error){clearTimeout(timer);this.probeSamples.delete(id);reject(bidiError('INPUT_PROBE_UNAVAILABLE','Physical input detection disconnected.'));}});
    });
  }
  cancel(id) { const job=this.jobs.get(id);if(job)job.aborted=true; }
  async readBinding(binding) {
    const response=await this.connection.request('script.callFunction',{functionDeclaration:'function(meta){return JSON.stringify({connected:meta.isConnected,value:meta.getAttribute("content"),visible:!document.hidden,focused:document.hasFocus()})}',target:{context:binding.context,sandbox:'reasonw6-native'},arguments:[{sharedId:binding.sharedId}],awaitPromise:false});
    if(response.type!=='success'||response.result.type!=='string')throw bidiError('NAVIGATION_CHANGED','The native target document changed. Observe again.');
    const state=JSON.parse(response.result.value);state.value=JSON.parse(state.value);return state;
  }
  async binding(lease) {
    let binding=this.bindings.get(lease.documentId);
    if(binding)return binding;
    const tree=await this.connection.request('browsingContext.getTree',{maxDepth:10});
    const matches=[];
    for(const context of flatten(tree.contexts).filter(c=>c.url===lease.url).slice(0,256)){
      const result=await this.connection.request('script.evaluate',{expression:'Array.from(document.querySelectorAll("zen-ai-control")).slice(0,20)',target:{context:context.context,sandbox:'reasonw6-native'},awaitPromise:false,serializationOptions:{maxDomDepth:3,includeShadowTree:'all'}});
      for(const host of result.result?.value||[])for(const child of host.value?.shadowRoot?.value?.children||[]){
        if(child.value?.localName!=='meta'||child.value.attributes?.name!=='zen-native-binding')continue;
        try { const value=JSON.parse(child.value.attributes.content);if(value.documentId===lease.documentId)matches.push({context:context.context,sharedId:child.sharedId}); } catch {}
      }
    }
    if(matches.length!==1)throw bidiError('NATIVE_BINDING','The exact controlled document could not be identified. Observe again; matching URLs alone are never used to choose a tab.');
    binding=matches[0];this.bindings.set(lease.documentId,binding);return binding;
  }
  async execute(id, lease, plan, deadline) {
    if(this.jobs.has(id))throw bidiError('DUPLICATE_NATIVE_ACTION','This native action is already pending.');
    const job={aborted:false};this.jobs.set(id,job);
    let binding, inputUsed = false;
    const alive=()=>{if(job.aborted)throw bidiError('CONTROL_CHANGED','Native action stopped; completed input is not undone.');if(Date.now()>=deadline)throw bidiError('NATIVE_TIMEOUT','Native action expired. Observe the partial result before another action.');};
    try {
      if(plan.command==='fill'&&/[\u0000-\u001f\u007f\uE000-\uE05D]/u.test(plan.text))throw bidiError('NATIVE_LITERAL_REQUIRED','Literal control characters are not sent as native keys.');
      await this.ensure();alive();
      if(plan.command==='fill'||plan.command==='press')await this.startProbe();
      const typing=plan.command==='fill'||plan.command==='press';
      let physicalCounter=typing?(await this.samplePhysical()).counter:0;
      const startedAt=Date.now();
      binding=await this.binding(lease);
      const guard=async()=>{alive();const state=await this.readBinding(binding);const value=state.value;
        if(!state.connected||!value.controlled||value.documentId!==lease.documentId||value.epoch!==lease.epoch||value.token!==lease.token)throw bidiError('CONTROL_CHANGED','The native input permit is no longer valid.');
        if(typing){
          if(this.probe?.exitCode!==null)throw bidiError('INPUT_PROBE_UNAVAILABLE','Physical keyboard detection stopped.');
          const sample=await this.samplePhysical(),changed=sample.counter!==physicalCounter;physicalCounter=sample.counter;
          if(changed&&sample.at>=startedAt&&state.visible&&state.focused){
            const current=await this.readBinding(binding);
            if(current.visible&&current.focused&&sample.at>=Math.max(current.value.visibleSince||0,current.value.focusedSince||0))throw bidiError('USER_INPUT','Physical keyboard input detected in the watched page. Native typing stopped.');
          }
        }
      };
      const perform=async(actions, expected)=>{await guard();const armed=await this.connection.request('script.callFunction',{functionDeclaration:'function(meta,expected,token,epoch){const value=JSON.parse(meta.content);if(!meta.isConnected||!value.controlled||value.token!==token||value.epoch!==epoch)throw Error("Native permit changed");value.expected=expected;meta.content=JSON.stringify(value)}',target:{context:binding.context,sandbox:'reasonw6-native'},arguments:[{sharedId:binding.sharedId},{type:'string',value:JSON.stringify(expected)},{type:'string',value:lease.token},{type:'number',value:lease.epoch}],awaitPromise:false});
        if(armed.type!=='success')throw bidiError('CONTROL_CHANGED','The native permit changed before input was dispatched.');
        alive();inputUsed=true;await this.connection.request('input.performActions',{context:binding.context,actions},Math.max(1,Math.min(15000,deadline-Date.now())));alive();};
      const keys=async(key,{ctrl=false,shift=false}={})=>{
        const actions=[];if(ctrl)actions.push({type:'keyDown',value:'\uE009'});if(shift)actions.push({type:'keyDown',value:'\uE008'});
        actions.push({type:'keyDown',value:nativeKey(key)},{type:'keyUp',value:nativeKey(key)});
        if(shift)actions.push({type:'keyUp',value:'\uE008'});if(ctrl)actions.push({type:'keyUp',value:'\uE009'});
        await perform([{type:'key',id:'reasonw6-keyboard',actions}],{type:'key',key,ctrl,shift});
      };
      if(plan.command==='click'||plan.command==='drag'){
        const actions=[{type:'pointerMove',x:plan.x,y:plan.y,duration:0},{type:'pointerDown',button:0}];
        if(plan.command==='drag')actions.push({type:'pointerMove',x:plan.toX,y:plan.toY,duration:Math.min(plan.duration??180,300)});
        actions.push({type:'pointerUp',button:0});
        await perform([{type:'pointer',id:'reasonw6-mouse',parameters:{pointerType:'mouse'},actions}],{type:'pointer',x:plan.x,y:plan.y,drag:plan.command==='drag',toX:plan.toX,toY:plan.toY});
      } else if(plan.command==='press'){await keys(plan.key,{shift:plan.shift});await guard();}
      else if(plan.command==='fill'){
        if([...plan.text].length>2000)throw bidiError('NATIVE_TEXT_TOO_LONG','Native typing is limited to 2000 characters per call. Use explicit DOM fill for larger replacements.');
        await keys('a',{ctrl:true});await keys('Backspace');
        for(const character of plan.text){alive();await keys(character==='\n'?'Enter':character);}
        await guard();
      } else throw bidiError('UNSUPPORTED_NATIVE_ACTION','Unsupported native input action.');
      return {native:true,dispatched:true};
    } finally {
      // Release only this context's BiDi input state; this is cleanup, not a replay.
      if(inputUsed&&binding&&this.connection?.socket?.readyState===1)await this.connection.request('input.releaseActions',{context:binding.context},1500).catch(()=>{});
      this.jobs.delete(id);
    }
  }
  async close() {
    this.closed = true;
    for(const job of this.jobs.values())job.aborted=true;
    await this.initializing?.catch(()=>{});
    if(this.probe?.exitCode===null)this.probe.kill();
    if(this.connection?.socket?.readyState===1)await this.connection.request('session.end',{},1500).catch(()=>{});
    this.connection?.close();
  }
}
