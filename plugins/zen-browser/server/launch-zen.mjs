import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BidiConnection, bidiError } from './bidi.mjs';
import { dataHome, EXTENSION_ID } from './paths.mjs';
import { runPlatform, platformExecutable } from './windows.mjs';

export async function recommendedPreferencesDisabled(profile) {
  let disabled=false;
  for(const name of ['prefs.js','user.js']) {
    let source;
    try {source=await readFile(path.join(profile,name),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const match of source.matchAll(/^\s*user_pref\(\s*["']remote\.prefs\.recommended["']\s*,\s*(true|false)\s*\)\s*;/gm)) disabled=match[1]==='false';
  }
  return disabled;
}

export async function launchZen({binary,profile,home=dataHome(),extension=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../extension'),worker=platformExecutable,hidden=false,headless=false,onWaitingForBrowser,checkCancelled=()=>{}}) {
  if(process.platform!=='win32')throw bidiError('UNSUPPORTED_PLATFORM','The Zen launcher currently supports Windows.');
  binary=path.resolve(binary);profile=path.resolve(profile);extension=await realpath(extension);
  const profileState = await runPlatform({ action: 'profile-state', profile });
  if (!profileState.exists) throw bidiError('INVALID_PROFILE', 'Choose an existing Zen profile directory.');
  if (profileState.locked) throw bidiError('PROFILE_IN_USE', 'The selected Zen profile is still running. Nothing was closed.');
  if(!profileState.recommendedPreferencesDisabled)throw bidiError('PROFILE_SETUP_REQUIRED','The confirmed profile setting changed before startup. Open Connect Zen and confirm the current setup again.');
  const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
  const firstRun=!profileState.welcomeSeen;
  if(manifest.browser_specific_settings?.gecko?.id!==EXTENSION_ID)throw bidiError('WRONG_EXTENSION','Only the bundled Zen Browser extension may be loaded.');
  const reserve=net.createServer();await new Promise((resolve,reject)=>{reserve.once('error',reject);reserve.listen(0,'127.0.0.1',resolve);});
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const dir=path.join(home,'launches');await mkdir(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,randomUUID()+'.json'),endpoint='ws://127.0.0.1:'+port+'/session';
  // The desktop owns the browser's lifetime; Codex owns its control channel.
  const environment=Object.fromEntries(['APPDATA','LOCALAPPDATA','TEMP','TMP','PATH'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  checkCancelled();
  const child=await runPlatform({action:'launch-browser',binary,profile,launchRecord:file,port,hidden,headless,environment,diagnostics:process.env.ZEN_BRIDGE_DIAGNOSTICS==='1'}, {executable:worker,timeoutMs:20000});
  const record={version:1,browserPid:child.pid,profile,endpoint,ready:false,extensionVersion:manifest.version,independentLifecycle:child.independentLifecycle};
  await writeFile(file,JSON.stringify(record),{flag:'wx',mode:0o600});
  let connection;
  for(let i=0;i<80;i++) {
    try {connection=await new BidiConnection(endpoint,{connectTimeout:500}).connect();break;}catch{await new Promise(resolve=>setTimeout(resolve,150));}
  }
  if(!connection)throw bidiError('NATIVE_UNAVAILABLE','Zen did not expose its requested loopback control endpoint. Check the browser window and retry the connection.');
  let sessionRequested = false, sessionEnded = false, browserAcknowledged = false;
  try {
    sessionRequested = true;
    const creation=connection.request('session.new',{capabilities:{alwaysMatch:{acceptInsecureCerts:false,webSocketUrl:true}}},5*60*1000);
    creation.catch(()=>{});
    let startupTimer;
    const early=await Promise.race([creation.then(session=>({session})),new Promise(resolve=>{startupTimer=setTimeout(()=>resolve({waiting:true}),7000);})]).finally(()=>clearTimeout(startupTimer));
    let session=early.session;
    if(early.waiting) {
      if(!onWaitingForBrowser)throw bidiError('BROWSER_STARTUP_INTERACTION_REQUIRED','Zen 正在等待窗口启动。请从连接页继续，按提示打开 Zen 窗口；没有重放任何网页操作。');
      await onWaitingForBrowser({launchRecord:file,pid:record.browserPid,reason:firstRun?'onboarding':'activate'});
      browserAcknowledged=true;checkCancelled();
      let completionTimer;
      session=await Promise.race([creation,new Promise((_,reject)=>{completionTimer=setTimeout(()=>reject(bidiError('BROWSER_NOT_READY','Zen 还没有完成窗口启动。请打开所选配置的 Zen 窗口，再重试连接。')),45000);})]).finally(()=>clearTimeout(completionTimer));
    }
    if(path.resolve(session.capabilities['moz:profile']).toLowerCase()!==profile.toLowerCase())throw bidiError('WRONG_BROWSER','The endpoint belongs to another profile. No extension was installed.');
    const reportedPid=session.capabilities['moz:processID'];
    if(!Number.isInteger(reportedPid))throw bidiError('WRONG_BROWSER','Zen did not report a valid process identity.');
    await runPlatform({ action: 'verify-process', pid: reportedPid, launcherPid: child.pid, binary, profile });
    record.browserPid=reportedPid;
    record.sessionUrl=session.capabilities.webSocketUrl;await writeFile(file,JSON.stringify(record),{mode:0o600});
    const installed=await connection.request('webExtension.install',{extensionData:{type:'path',path:extension}});
    if(installed.extension!==EXTENSION_ID)throw bidiError('WRONG_EXTENSION','Zen returned an unexpected extension identity.');
    // An empty Zen start screen can hide every content document. A visible
    // existing webpage is not a prerequisite for opening an AI background tab.
    // session.new has completed browser startup; the manager separately checks
    // the extension handshake. The browser's first-run wizard still needs the
    // user's explicit acknowledgement and is never completed by automation.
    if(firstRun&&!browserAcknowledged) {
      if(!onWaitingForBrowser)throw bidiError('BROWSER_SETUP_REQUIRED','请先完成 Zen 自身的首次引导，再从连接界面继续。');
      await onWaitingForBrowser({launchRecord:file,pid:record.browserPid,reason:'onboarding'});
    }
    checkCancelled();
    await connection.request('session.end');
    sessionEnded = true;
    delete record.sessionUrl;
    record.ready=true;await writeFile(file,JSON.stringify(record),{mode:0o600});
    return {pid:record.browserPid,profile,extensionVersion:manifest.version,extensionId:installed.extension,launchRecord:file,nativeInput:true,automaticTemporaryLoad:true};
  } finally {
    if (sessionRequested && !sessionEnded) await connection.request('session.end', {}, 1500).catch(() => {});
    connection.close();
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), get=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  launchZen({binary:get('--binary'),profile:get('--profile'),hidden:args.includes('--hidden'),headless:args.includes('--headless')})
    .then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error((error.code||'LAUNCH_ERROR')+': '+error.message);process.exitCode=1;});
}
