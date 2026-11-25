import {expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {hashFile} from '../src/portable/integrity.js';
import {readExtensionJson,writeExtensionJson,useHostSettings,closeHostSettings} from '../src/portable/extension-store.js';
const host=process.env.STELLAN_TEST_HOST??resolve(`native-host-app/${process.platform==='win32'?'Release/stellan-host.exe':'stellan-host'}`);
it.skipIf(!existsSync(host))('settings live in Stellan-Host and older files are carried over once',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stick-settings-'));
 try{
  await mkdir(join(root,'logs','extensions'),{recursive:true});
  await writeFile(join(root,'logs','extensions','preferences.json'),JSON.stringify({format:1,longContext:true}));
  const sha256=(await hashFile(host)).sha256;
  useHostSettings(root,{executable:host,sha256});
  expect(await readExtensionJson(root,'preferences.json')).toEqual({format:1,longContext:true});
  await writeExtensionJson(root,'preferences.json',{format:1,longContext:false,personal:{name:'Zoë 🦈'}});
  await writeExtensionJson(root,'hooks.json',{format:1,hooks:[]});
  expect(await readExtensionJson(root,'missing.json')).toBeUndefined();
  await closeHostSettings(root);
  // The old file is untouched; the new value comes back from Host after a restart.
  expect(JSON.parse(await readFile(join(root,'logs','extensions','preferences.json'),'utf8'))).toEqual({format:1,longContext:true});
  expect(existsSync(join(root,'logs','extensions','hooks.json'))).toBe(false);
  useHostSettings(root,{executable:host,sha256});
  expect(await readExtensionJson(root,'preferences.json')).toEqual({format:1,longContext:false,personal:{name:'Zoë 🦈'}});
  expect(await readExtensionJson(root,'hooks.json')).toEqual({format:1,hooks:[]});
  await closeHostSettings(root);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5});}
},30000);
