import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { successfulDesktopBuild } from './release-build.mjs';
import { dmgVariants, validateDmgMetadata } from './dmg-release.mjs';
import { hashFile } from '../dist/portable/integrity.js';
import { uploadSplitArchive } from './upload-release-parts.mjs';
import { joinHelper } from './release-parts.mjs';
const exec = promisify(execFile), repo = process.env.GITHUB_REPOSITORY, runId = process.env.PACKAGING_RUN;
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^\d+$/.test(runId ?? '')) { throw new Error('Invalid DMG publication parameters'); }
async function gh(...args) { return (await exec('gh',args,{ maxBuffer: 4000000 })).stdout; }
let packaging;
for(let i=0;i<61;i++) {
  packaging = JSON.parse(await gh('api',`repos/${repo}/actions/runs/${runId}`));
  if(packaging.path !== '.github/workflows/macos-dmg.yml' || packaging.head_branch !== 'main' || packaging.event !== 'workflow_dispatch' || packaging.head_repository?.full_name !== repo) { throw new Error('Untrusted DMG packaging run'); }
  if(packaging.status === 'completed') { if(packaging.conclusion !== 'success') throw new Error('Native DMG checks failed'); break; }
  if(i===60) throw new Error('DMG packaging is still running; retry after completion');
  await delay(2000);
}
const artifacts = JSON.parse(await gh('api',`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`)).artifacts;
const tag = `macos-dmg-${runId}`, temporary = await mkdtemp(join(tmpdir(),'stick-dmg-release-'));
try {
  let release; try { release=JSON.parse(await gh('release','view',tag,'--repo',repo,'--json','isDraft')); } catch(e) { if(!/release not found|HTTP 404/i.test(String(e.stderr))) throw e; }
  if(release && !release.isDraft) { console.log(`Already published https://github.com/${repo}/releases/tag/${tag}`); }
  else {
    const notes=join(temporary,'notes.md');
    await writeFile(notes,`Three genuine macOS disk images: full Lite + Max for Apple Silicon and Intel, plus Intel Lite with the Max GGUF file picker.\n\nGitHub has a 2 GiB per-file limit. Download all .dmg.part files and the matching Join helper ZIP for your variant into one folder. Extract the helper ZIP there and open its .command file (right-click → Open if needed). It verifies every part and reconstructs the final .dmg. Open that disk image, then drag the entire **Stick AI folder** onto Applications or your USB stick. Open Stick AI.app inside the copied folder. Keep the folder together; do not run from the read-only image. The helper uses a terminal during this one-time preparation.\n\nFull images include both models (~18.5 GB). Intel Lite includes Lite (~4.2 GB); use “Use a Max file already on your stick” to link your existing single GGUF without copying. Existing app users can use Check for updates to get the picker without downloading models again: https://github.com/${repo}/releases .\n\nmacOS 13.5+. Lite requires 8 GiB reported RAM; Max requires at least 16 GiB. Images passed native hdiutil verification, read-only mounted file hashes, native app dry-run and file-picker helper checks. Unsigned builds; clean-machine GUI launch and hardware performance need manual qualification. Model licenses and notices are included.\n\n[Native packaging checks](https://github.com/${repo}/actions/runs/${runId}). DMG_CHECKSUMS.json records image and part SHA-256 hashes.\n`);
    if(!release) await gh('release','create',tag,'--repo',repo,'--target',packaging.head_sha,'--title','Stick AI — Mac DMGs: Intel, Apple Silicon + Intel Lite picker','--draft','--prerelease','--notes-file',notes);
    const records=[]; let desktopBuild;
    for(const expected of dmgVariants) {
      const artifact=artifacts.find(a=>a.name===`stick-ai-dmg-${expected.platform}-${expected.variant}` && !a.expired);
      if(!artifact) throw new Error(`Missing ${expected.name} native artifact`);
      const folder=join(temporary,expected.name);
      console.log(`Downloading verified native image ${expected.name}`);
      await gh('run','download',runId,'--repo',repo,'--name',artifact.name,'--dir',folder);
      const files=await readdir(folder);
      if(files.length!==2 || !files.includes(expected.name) || !files.includes(expected.name+'.json')) throw new Error('Unexpected DMG artifact files');
      const metadata=JSON.parse(await readFile(join(folder,expected.name+'.json'),'utf8'));
      if(!/^\d+$/.test(metadata.run ?? '')) throw new Error('Invalid source build');
      const build=await successfulDesktopBuild(repo,metadata.run,gh);
      if(desktopBuild && desktopBuild!==metadata.run) throw new Error('Mixed source builds'); desktopBuild=metadata.run;
      validateDmgMetadata(metadata,expected,repo,build);
      const actual=await hashFile(join(folder,expected.name));
      if(actual.size!==metadata.size || actual.sha256!==metadata.sha256) throw new Error('Native image hash mismatch');
      const partsFolder=join(folder,'parts');
      const record=await uploadSplitArchive(join(folder,expected.name),partsFolder,paths=>gh('release','upload',tag,...paths,'--repo',repo,'--clobber'));
      if(record.size!==metadata.size || record.sha256!==metadata.sha256) throw new Error('Image changed during upload');
      const helper=await joinHelper(record,partsFolder,expected.platform);
      await exec('zip',['-j',join(partsFolder,helper+'.zip'),join(partsFolder,helper)]);
      await gh('release','upload',tag,join(partsFolder,helper+'.zip'),join(folder,expected.name+'.json'),'--repo',repo,'--clobber');
      records.push({...record,platform:expected.platform,variant:expected.variant,source:metadata.source});
      await rm(folder,{recursive:true,force:true});
    }
    const checksums=join(temporary,'DMG_CHECKSUMS.json'); await writeFile(checksums,JSON.stringify({packagingRun:runId,buildRun:desktopBuild,images:records},null,2)+'\n');
    await gh('release','upload',tag,checksums,'--repo',repo,'--clobber');
    // Verify the dedicated assets endpoint; the embedded release asset list may be stale.
    const info=JSON.parse(await gh('release','view',tag,'--repo',repo,'--json','apiUrl'));
    const prefix=`https://api.github.com/repos/${repo}/releases/`;
    if(!info.apiUrl.startsWith(prefix) || !/^\d+$/.test(info.apiUrl.slice(prefix.length)))throw new Error('Invalid draft release identity');
    const assets=JSON.parse(await gh('api',info.apiUrl+'/assets?per_page=100'));
    for(const record of records) for(const part of record.parts) {
      const asset=assets.find(a=>a.name===part.name);
      if(!asset || asset.state!=='uploaded' || asset.size!==part.size || asset.digest!==`sha256:${part.sha256}`) throw new Error('Uploaded DMG part did not verify');
    }
    await gh('release','edit',tag,'--repo',repo,'--notes-file',notes,'--draft=false');
    console.log(`Published https://github.com/${repo}/releases/tag/${tag}`);
  }
} finally { await rm(temporary,{recursive:true,force:true}); }
