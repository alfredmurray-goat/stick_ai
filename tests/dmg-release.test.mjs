import { expect,it } from 'vitest';
import { dmgVariants,validateDmgMetadata } from '../scripts/dmg-release.mjs';
import { bundledMax } from '../src/portable/max-release.ts';
const lite={path:'models/stellan-1-lite-q4_k_m.gguf',size:4147481440,sha256:'84328c452ddef6122b35702f754935ebd7c8bf95a8a9f2b718392cc68968453e'};
const build={id:123,head_sha:'a'.repeat(40)}, repo='owner/repo';
function metadata(expected) { return {format:1,repository:repo,run:'123',source:build.head_sha,...expected,size:expected.variant==='full'?18553940784:4232495113,sha256:'b'.repeat(64),models:expected.variant==='full'?[lite,bundledMax]:[lite],checks:['hdiutil verify','read-only mounted file hashes','native app dry-run','Max file picker helper']}; }
it('requires all three exact native image variants and pinned model sets',()=> {
  for(const expected of dmgVariants) {
    const data=metadata(expected); expect(validateDmgMetadata(data,expected,repo,build)).toBe(data);
    for(const change of [{source:'c'.repeat(40)},{run:'456'},{checks:[]},{models:[]},{name:'other.dmg'},{size:1000},{sha256:'invalid'}]) expect(()=>validateDmgMetadata({...data,...change},expected,repo,build)).toThrow();
  }
  expect(()=>validateDmgMetadata({...metadata(dmgVariants[0]),models:[lite]},dmgVariants[0],repo,build)).toThrow();
  expect(()=>validateDmgMetadata({...metadata(dmgVariants[2]),models:[lite,bundledMax]},dmgVariants[2],repo,build)).toThrow();
});
