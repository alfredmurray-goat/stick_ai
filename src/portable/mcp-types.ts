/** Stellan-Link's tool-client protocol surface. */
export type RpcId = string | number;
export type JSONRPCMessage =
 | {jsonrpc:'2.0';method:string;id?:RpcId;params?:Record<string,unknown>}
 | {jsonrpc:'2.0';id:RpcId;result:Record<string,unknown>}
 | {jsonrpc:'2.0';id?:RpcId;error:{code:number;message:string;data?:unknown}};
export interface Transport {
 start():Promise<void>;
 send(message:JSONRPCMessage):Promise<void>;
 close():Promise<void>;
 onmessage?:((message:JSONRPCMessage)=>void)|undefined;
 onerror?:((error:Error)=>void)|undefined;
 onclose?:(()=>void)|undefined;
 setProtocolVersion?:(version:string)=>void;
}
export interface Tool extends Record<string,unknown> {name:string;description?:string;inputSchema:Record<string,unknown>&{type:'object'}}
export function defaultMcpEnvironment():Record<string,string>{
 const env:Record<string,string>={};
 for(const name of ['HOME','USER','LOGNAME','PATH','SHELL','TERM','TMPDIR','TMP','TEMP','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','SystemRoot','SYSTEMROOT','COMSPEC','PATHEXT','USERPROFILE']) {
  const value=process.env[name];if(value!==undefined&&!value.startsWith('()'))env[name]=value;
 }
 return env;
}
