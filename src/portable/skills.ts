import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readdir,readFile,lstat,realpath,writeFile,rename,rm} from 'node:fs/promises';
import {join,basename,relative} from 'node:path';
import {homedir} from 'node:os';
import {parse} from 'yaml';
import {Sandbox} from '../sandbox/paths.js';
import {extensionDirectory,readExtensionJson,writeExtensionJson} from './extension-store.js';
export class SkillError extends Error {constructor(message:string){super(message);this.name='SkillError';}}
const builtins=[
 {name:'review-code',description:'Review a project or selected files for concrete bugs, risks and missing checks.',body:'Inspect the relevant files before drawing conclusions. Focus on concrete, reproducible bugs and behavioral regressions. Explain each finding with its file and evidence. Distinguish verified facts from assumptions. Suggest focused fixes. Do not change files unless the user asks. Do not claim tests ran unless a tool actually ran them.'},
 {name:'fix-bug',description:'Investigate a bug, identify its cause and apply a focused fix.',body:'First inspect the project and the failing behavior described by the user. Find evidence for the cause before editing. Preserve existing user changes. Make the smallest coherent correction, explain its effect, and suggest useful verification. Ask for missing reproduction details only when needed. Tool permissions and approval requirements still apply.'},
 {name:'plan-feature',description:'Turn a feature request into a practical implementation plan grounded in the project.',body:'Read the project structure and relevant entry points. Clarify the requested behavior and affected components. Propose a concrete sequence of changes and focused verification. Identify material uncertainties. Produce a plan before editing unless the user explicitly asks to implement it now. Never invent existing APIs or file contents.'}
];
interface Skill {id:string;name:string;description:string;source:string;body:string;digest:string;modelInvocable:boolean;userInvocable:boolean;root?:string;path?:string;editable:boolean}
interface Preferences {format:1;enabled:Record<string,string>;disabledBuiltins:string[]}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function slug(name:string){return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);}
export function parseSkill(text:string,fallback:string){
 if(Buffer.byteLength(text)>65536)throw new SkillError('SKILL.md must be under 64 KiB.');text=text.replace(/^\uFEFF/,'');let meta:Record<string,unknown>={},body=text;
 const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
 if(front){try{const data:unknown=parse(front[1]!,{maxAliasCount:0,uniqueKeys:true});if(data&&typeof data==='object'&&!Array.isArray(data))meta=data as Record<string,unknown>;else throw Error();}catch{throw new SkillError('Invalid SKILL.md frontmatter. Use plain YAML without aliases.');}body=text.slice(front[0].length);}
 const name=typeof meta.name==='string'?meta.name:fallback;if(!slug(name))throw new SkillError('Skill names use lowercase letters, numbers and hyphens (up to 64 characters).');
 const description=typeof meta.description==='string'?meta.description.replace(/\s+/g,' ').trim():body.split(/\r?\n/).find(l=>l.trim())?.replace(/^#+\s*/,'')??name;
 if(!description||description.length>1000||!body.trim())throw new SkillError('Add a description and Markdown instructions.');
 return {name,description,body:body.trim(),modelInvocable:meta['disable-model-invocation']!==true,userInvocable:meta['user-invocable']!==false};
}
export class Skills {
 private project:string;private preferences:Preferences={format:1,enabled:{},disabledBuiltins:[]};private catalog:Skill[]=[];
 constructor(private appRoot:string,project:string){this.project=project;}
 async load(){const saved=await readExtensionJson(this.appRoot,'skills.json');if(saved!==undefined){if(!saved||typeof saved!=='object'||(saved as Preferences).format!==1||!(saved as Preferences).enabled||typeof(saved as Preferences).enabled!=='object'||Array.isArray((saved as Preferences).enabled)||Object.values((saved as Preferences).enabled).some(v=>typeof v!=='string'||!/^([a-f0-9]{64})$/.test(v))||!Array.isArray((saved as Preferences).disabledBuiltins))throw new SkillError('Invalid saved skill preferences.');this.preferences=saved as Preferences;}await this.scan();}
 setProject(project:string){this.project=project;this.catalog=[];}
 private enabled(skill:Skill){return skill.source==='built-in'?!this.preferences.disabledBuiltins.includes(skill.id):this.preferences.enabled[skill.id]===skill.digest;}
 private async read(path:string){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>65536)throw new SkillError('Skills must be regular SKILL.md files under 64 KiB.');return readFile(path,'utf8');}
 async scan(){
  const result:Skill[]=builtins.map(s=>({...s,id:'built-in:'+s.name,source:'built-in',digest:hash(s.body),modelInvocable:true,userInvocable:true,editable:false}));
  const own=join(await extensionDirectory(this.appRoot),'skills');await mkdir(own,{recursive:true});
  const locations=[{path:own,source:'app',editable:true},{path:join(this.project,'.claude/skills'),source:'project',editable:false},{path:join(this.project,'.agents/skills'),source:'project',editable:false},{path:join(homedir(),'.claude/skills'),source:'user',editable:false},{path:join(homedir(),'.agents/skills'),source:'user',editable:false}];
  for(const location of locations){try{const info=await lstat(location.path);if(!info.isDirectory()||info.isSymbolicLink())continue;
   if(location.source==='project'){const project=await Sandbox.create(this.project);await project.path(location.path.slice(this.project.length+1));}
   for(const entry of (await readdir(location.path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(result.length>=200)break;if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    const root=await realpath(join(location.path,entry.name)),path=join(root,'SKILL.md');try{const text=await this.read(path),parsed=parseSkill(text,entry.name);result.push({...parsed,id:location.source+':'+parsed.name+(location.source==='app'?'':':'+hash(location.source==='project'?relative(this.appRoot,path):path).slice(0,8)),source:location.source,digest:hash(text),root,path,editable:location.editable});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')continue;}
   }
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')continue;}}
  this.catalog=result;return this.view();
 }
 view(){return this.catalog.map(({body,root,path,...s})=>({...s,enabled:this.enabled(this.catalog.find(v=>v.id===s.id)!),changed:Boolean(this.preferences.enabled[s.id]&&this.preferences.enabled[s.id]!==s.digest)}));}
 private find(name:string){const matches=this.catalog.filter(s=>s.id===name||s.name===name);const exact=matches.find(s=>s.id===name);const priority=(s:Skill)=>({app:0,project:1,user:2,'built-in':3}[s.source]??4);const selected=exact??matches.filter(s=>this.enabled(s)).sort((a,b)=>priority(a)-priority(b))[0]??matches[0];if(!selected)throw new SkillError('This skill was not found. Refresh Skills in settings.');return selected;}
 async preview(id:string){await this.scan();const s=this.find(id);return {...this.view().find(v=>v.id===s.id),instructions:s.body};}
 async enable(id:string,allow:boolean,digest:string){await this.scan();const s=this.find(id);if(digest!==s.digest)throw new SkillError('The skill changed. Review the current instructions before enabling it.');if(s.source==='built-in'){this.preferences.disabledBuiltins=this.preferences.disabledBuiltins.filter(v=>v!==id);if(!allow)this.preferences.disabledBuiltins.push(id);}else if(allow)this.preferences.enabled[id]=digest;else delete this.preferences.enabled[id];await writeExtensionJson(this.appRoot,'skills.json',this.preferences);}
 async save(name:string,description:string,body:string,flags:{modelInvocable?:boolean;userInvocable?:boolean}={}){
  if(!slug(name)||!description.trim()||description.length>1000||!body.trim()||Buffer.byteLength(body)>60000)throw new SkillError('Enter a skill name, description and Markdown instructions under 60 KiB.');
  const own=join(await extensionDirectory(this.appRoot),'skills');await mkdir(own,{recursive:true});if((await lstat(own)).isSymbolicLink()||await realpath(own)!==own)throw new SkillError('The skills directory is unsafe.');const folder=join(own,name);await mkdir(folder,{recursive:true});const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw new SkillError('The skill directory is unsafe.');
  const path=join(folder,'SKILL.md'),temporary=join(folder,'.skill-'+randomUUID()+'.tmp');const text=`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\ndisable-model-invocation: ${flags.modelInvocable===false}\nuser-invocable: ${flags.userInvocable!==false}\n---\n${body.trim()}\n`;
  try{const file=await lstat(path);if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1)throw new SkillError('The skill file is unsafe.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await writeFile(temporary,text,{flag:'wx',mode:0o600});try{await rename(temporary,path);}finally{await rm(temporary,{force:true});}await this.scan();const saved=this.catalog.find(s=>s.path===path)!;await this.enable(saved.id,true,saved.digest);return saved.id;
 }
 modelCatalog(){return this.catalog.filter(s=>this.enabled(s)&&s.modelInvocable).map(s=>({name:s.id,description:s.description.slice(0,200)})).slice(0,24);}
 async prepare(task:string){await this.scan();const match=/^\/([a-z0-9][a-z0-9:-]*)(?:\s+|$)/.exec(task.trim());if(!match)return {instructions:'',active:[] as string[]};const s=this.find(match[1]!);if(!s.userInvocable)throw new SkillError('This skill is not available as a slash command.');if(!this.enabled(s))throw new SkillError('Review and enable this skill in settings first.');const args=task.trim().slice(match[0].length);const instructions=await this.readSkill(s.id,'',new Set([s.id]));return {instructions:`The user explicitly invoked /${s.name}. Apply this enabled skill as task guidance, subject to the app tool permissions:\n${instructions.replaceAll('$ARGUMENTS',()=>args)}`,active:[s.id]};}
 async readSkill(name:string,resource:string,manual=new Set<string>()){
  await this.scan();const s=this.find(name);if(!this.enabled(s))throw new SkillError('The skill is disabled or changed. Review and enable it in settings.');if(!s.modelInvocable&&!manual.has(s.id))throw new SkillError('This skill requires an explicit /skill invocation by the user.');
  if(resource){if(!s.root)throw new SkillError('Built-in skills have no supporting files.');const box=await Sandbox.create(s.root);const path=await box.path(resource);const text=await this.read(path);return text.slice(0,16000)+(text.length>16000?'\n[Supporting file preview shortened.]':'');}
  return `Skill: ${s.name}\n${s.body.slice(0,16000)}${s.body.length>16000?'\n[Instructions shortened; split large skills into smaller supporting files.]':''}${s.root?'\nRead supporting skill files with use_skill using the same name and a project-relative resource path.':''}`;
 }
}
