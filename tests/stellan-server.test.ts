import {expect,it,vi} from 'vitest';
import {chatPrompt,startStellanServer} from '../portable/stellan-server.mjs';

it('formats text chats explicitly for Lite and Max without rewriting earlier turns',()=>{
 const messages=[{role:'system',content:'Guide'},{role:'user',content:'Task'},{role:'assistant',content:'Answer'},{role:'user',content:'Next'}];
 expect(chatPrompt(messages,'stellan-1-lite')).toBe('<s>[INST] Guide\n\nTask [/INST] Answer</s>[INST] Next [/INST]');
 expect(chatPrompt(messages,'stellan-1-max')).toBe('<s>[SYSTEM_PROMPT]Guide[/SYSTEM_PROMPT][INST] Task [/INST] Answer</s>[INST] Next [/INST]');
 expect(()=>chatPrompt([{role:'user',content:[]}],'stellan-1-lite')).toThrow();
});
it('serves authenticated native streaming, reports capabilities and bounds concurrent requests',async()=>{
 let finish:()=>void=()=>{};let entered:()=>void=()=>{};const began=new Promise<void>(resolve=>{entered=resolve;});
 const native={active:true,close:vi.fn(async()=>{}),generate:vi.fn(async(_prompt:string,options:any)=>{entered();await new Promise<void>(resolve=>{finish=resolve;});options.onEvent({event:'prompt_progress',completed:2,total:2});options.onEvent({event:'token',text:'<done>Ready</done>'});return {text:'<done>Ready</done>',tokens:[1],metrics:{reused_tokens:0,evaluated_prompt_tokens:2}};})};
 const running=await startStellanServer({key:'x'.repeat(64),port:0,context:128,modelName:'stellan-1-lite'},async()=>native);
 const address=running.server.address();const url='http://127.0.0.1:'+address.port,headers={Authorization:'Bearer '+'x'.repeat(64),'Content-Type':'application/json'};
 try{
  expect((await fetch(url+'/v1/models')).status).toBe(401);
  expect((await fetch(url+'/v1/models',{headers:{...headers,Origin:'https://example.com'}})).status).toBe(403);
  expect((await (await fetch(url+'/capabilities',{headers})).json()).grammar).toBe(false);
  const response=fetch(url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({messages:[{role:'user',content:'Ready?'}],max_tokens:2})});
  await began;
  expect((await fetch(url+'/completion',{method:'POST',headers,body:JSON.stringify({prompt:'Wait',n_predict:1})})).status).toBe(409);
  finish();const text=await (await response).text();expect(text).toContain('<done>Ready</done>');expect(text).toContain('[DONE]');expect(text).toContain('prompt_tokens');
  expect((await fetch(url+'/slots/0?action=save',{method:'POST',headers})).status).toBe(501);
 }finally{finish();await running.close();}
 expect(native.close).toHaveBeenCalledOnce();
});


it('preserves a generated leading space when formatting the next exact prefix',()=>{
 const prompt=chatPrompt([{role:'user',content:'Task'}],'stellan-1-lite');
 const answer=' <tool_call>{}</tool_call>';
 expect(chatPrompt([{role:'user',content:'Task'},{role:'assistant',content:answer},{role:'user',content:'Result'}],'stellan-1-lite')).toSatisfy((value:string)=>value.startsWith(prompt+answer+'</s>'));
});
it('settles tagged generation before flushing its final streaming fragment',async()=>{
 let settled=false;let aborted=false;
 const native={active:true,close:async()=>{},generate:async(_prompt:string,options:any)=>{
  options.signal.addEventListener('abort',()=>{aborted=true;});
  options.onEvent({event:'token',text:'<done>Ready'});options.onEvent({event:'token',text:'</done>'});
  await new Promise(resolve=>setTimeout(resolve,20));settled=true;
  return {text:'<done>Ready</done>',tokens:[10,11],metrics:{reused_tokens:0,evaluated_prompt_tokens:2,stop_reason:'tagged'}};
 }};
 const open=vi.fn(async()=>native);const running=await startStellanServer({key:'x'.repeat(64),port:0,context:128,modelName:'stellan-1-lite'},open);
 try{
  const {Ollama}=await import('../src/model/ollama.js');const client=new Ollama('stellan-1-lite','http://127.0.0.1:'+running.server.address().port,false,undefined,{apiKey:'x'.repeat(64)});
  expect((await client.complete([{role:'user',content:'Ready?'}],new AbortController().signal,()=>{})).content).toBe('<done>Ready</done>');
  expect(settled).toBe(true);expect(aborted).toBe(false);expect(open.mock.calls[0]?.[0]).toMatchObject({tagged:true});
 }finally{await running.close();}
});
