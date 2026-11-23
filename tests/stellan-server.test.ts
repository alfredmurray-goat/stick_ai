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
