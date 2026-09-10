import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BidiConnection, bidiError } from './bidi.mjs';
import { dataHome, EXTENSION_ID } from './paths.mjs';

export async function recommendedPreferencesDisabled(profile) {
  let disabled=false;
  for(const name of ['prefs.js','user.js']) {
    let source;
    try {source=await readFile(path.join(profile,name),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const match of source.matchAll(/^\s*user_pref\(\s*["']remote\.prefs\.recommended["']\s*,\s*(true|false)\s*\)\s*;/gm)) disabled=match[1]==='false';
  }
  return disabled;
}

export async function launchZen({binary,profile,home=dataHome(),extension=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../extension'),hidden=false,headless=false}) {
  if(process.platform!=='win32')throw bidiError('UNSUPPORTED_PLATFORM','The Zen launcher currently supports Windows.');
  binary=await realpath(binary);profile=await realpath(profile);extension=await realpath(extension);
  if(!(await stat(profile)).isDirectory())throw bidiError('INVALID_PROFILE','Choose an existing Zen profile directory.');
  await promisify(execFile)('pwsh.exe',['-NoProfile','-File',path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../scripts/check-profile-idle.ps1'),'-ProfilePath',profile],{windowsHide:true});
  if(!await recommendedPreferencesDisabled(profile))throw bidiError('PROFILE_SETUP_REQUIRED','Native input requires remote.prefs.recommended=false in this profile so Firefox does not apply its automation preferences. Nothing was changed. See scripts/configure-native-profile.ps1 for the explicit, reversible setup.');
  const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
  if(manifest.browser_specific_settings?.gecko?.id!==EXTENSION_ID)throw bidiError('WRONG_EXTENSION','Only the bundled Zen Browser extension may be loaded.');
  const reserve=net.createServer();await new Promise((resolve,reject)=>{reserve.once('error',reject);reserve.listen(0,'127.0.0.1',resolve);});
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const dir=path.join(home,'launches');await mkdir(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,randomUUID()+'.json'),endpoint='ws://127.0.0.1:'+port+'/session';
  const args=['--no-remote','--profile',profile,'--remote-debugging-port',String(port)];if(headless)args.push('--headless');
  // No signature bypass, system access, or user-profile mutation is performed here.
  let startupLog='';
  const child=spawn(binary,args,{windowsHide:hidden,detached:true,stdio:['ignore','ignore','pipe'],env:{...process.env,ZEN_BROWSER_LAUNCH:file}});
  child.stderr.on('data',chunk=>{startupLog=(startupLog+chunk.toString()).slice(-4000);});child.stderr.unref();
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  const record={version:1,browserPid:child.pid,profile,endpoint,ready:false,extensionVersion:manifest.version};
  await writeFile(file,JSON.stringify(record),{flag:'wx',mode:0o600});
  let connection;
  for(let i=0;i<80;i++) {
    if(child.exitCode!==null && child.exitCode!==0)throw bidiError('PROFILE_IN_USE','Zen did not start. Close this profile before using the launcher; it does not terminate existing browsers.');
    try {connection=await new BidiConnection(endpoint,{connectTimeout:500}).connect();break;}catch{await new Promise(resolve=>setTimeout(resolve,150));}
  }
  if(!connection)throw bidiError('NATIVE_UNAVAILABLE','Zen did not expose the requested loopback endpoint. Launcher exit: '+child.exitCode+'. '+startupLog.slice(-1600));
  try {
    const session=await connection.request('session.new',{capabilities:{alwaysMatch:{acceptInsecureCerts:false,webSocketUrl:true}}});
    if(path.resolve(session.capabilities['moz:profile']).toLowerCase()!==profile.toLowerCase())throw bidiError('WRONG_BROWSER','The endpoint belongs to another profile. No extension was installed.');
    const reportedPid=session.capabilities['moz:processID'];
    if(!Number.isInteger(reportedPid))throw bidiError('WRONG_BROWSER','Zen did not report a valid process identity.');
    await promisify(execFile)('pwsh.exe',['-NoProfile','-File',path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../scripts/verify-browser-process.ps1'),'-CandidatePid',String(reportedPid),'-LauncherPid',String(child.pid),'-Binary',binary,'-ProfilePath',profile],{windowsHide:true});
    record.browserPid=reportedPid;
    record.sessionUrl=session.capabilities.webSocketUrl;await writeFile(file,JSON.stringify(record),{mode:0o600});
    const installed=await connection.request('webExtension.install',{extensionData:{type:'path',path:extension}});
    if(installed.extension!==EXTENSION_ID)throw bidiError('WRONG_EXTENSION','Zen returned an unexpected extension identity.');
    await connection.request('session.end');
    delete record.sessionUrl;
    record.ready=true;await writeFile(file,JSON.stringify(record),{mode:0o600});
    return {pid:record.browserPid,profile,extensionVersion:manifest.version,extensionId:installed.extension,launchRecord:file,nativeInput:true,automaticTemporaryLoad:true};
  } finally {connection.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), get=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  launchZen({binary:get('--binary'),profile:get('--profile'),hidden:args.includes('--hidden'),headless:args.includes('--headless')})
    .then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error((error.code||'LAUNCH_ERROR')+': '+error.message);process.exitCode=1;});
}
