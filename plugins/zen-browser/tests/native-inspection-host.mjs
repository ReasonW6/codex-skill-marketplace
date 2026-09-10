// Test-only adapter installed into the isolated test host. Production launchers
// never include or activate this pipe. Firefox's direct BiDi session supports one
// socket, so test observations share the driver's socket without adding a public tool.
import net from 'node:net';
import { startHost } from './native-host-core.mjs';
import { NativeDriver } from './native-driver.mjs';
import { LineDecoder, NativeDecoder, nativeFrame, MAX_RESPONSE, writeLine } from './wire.mjs';
const home=process.argv[process.argv.indexOf('--data-dir')+1];
const driver=new NativeDriver({file:process.env.ZEN_BROWSER_LAUNCH,home});
const token=process.env.ZEN_TEST_INSPECT_TOKEN,endpoint=process.env.ZEN_TEST_INSPECT_PIPE;
if(!token||!endpoint?.startsWith('\\\\.\\pipe\\zen-native-test-'))throw new Error('An isolated inspection configuration is required.');
// The core must attach its decoder before another listener makes stdin flow.
await startHost({home,nativeDriver:driver});
const sockets=new Set();
const acknowledgements=new Map(),nativeDecoder=new NativeDecoder();
process.stdin.on('data',data=>nativeDecoder.push(data));
nativeDecoder.on('message',message=>{if(message.type==='test-result'){const ack=acknowledgements.get(message.id);if(ack){clearTimeout(ack.timer);acknowledgements.delete(message.id);ack.resolve({});}}});
const server=net.createServer(socket=>{
  sockets.add(socket);const decoder=new LineDecoder(MAX_RESPONSE);
  socket.on('data',data=>{try{decoder.push(data);}catch{socket.destroy();}});
  socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  decoder.on('message',async message=>{
    if(message.token!==token){socket.destroy();return;}
    try{
      let result;
      if(['test.selectTab','test.closeBrowser'].includes(message.method)){
        result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{acknowledgements.delete(message.id);reject(new Error('Test UI request timed out'));},3000);acknowledgements.set(message.id,{resolve,reject,timer});process.stdout.write(nativeFrame({type:message.method==='test.selectTab'?'test-select-tab':'test-close-browser',id:message.id,tabId:message.params.tabId}));});
      }else{await driver.ensure();result=await driver.connection.request(message.method,message.params);}
      writeLine(socket,{id:message.id,result});
    }
    catch(error){writeLine(socket,{id:message.id,error:{code:error.code,message:error.message}});}
  });
});
server.listen(endpoint);
process.stdin.on('end',()=>{for(const socket of sockets)socket.destroy();server.close();});
