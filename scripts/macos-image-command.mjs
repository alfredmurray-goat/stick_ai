import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const exec=promisify(execFile);
// DiskImages can retain a device briefly after detach. Retry only that transient
// failure; never bypass image verification or hide other hdiutil errors.
export async function imageCommand(args, run=exec, pause=()=>delay(5000)) {
  for(let attempt=0;attempt<3;attempt++) {
    try { return await run('hdiutil',args,{maxBuffer:4000000}); }
    catch(error) {
      if(attempt===2 || !/Resource busy|temporarily unavailable/i.test(String(error.stderr)))throw error;
      console.log(`DiskImages is busy; retrying native image operation (${attempt+2}/3)`);
      await pause();
    }
  }
}

// Detach the device identity returned by attach, since mount paths may disappear
// during an OS-initiated unmount. Never let cleanup replace a verification error.
export async function verifyMountedImage({image,mount,verifyMounted,run=exec,attach=imageCommand}) {
 const {stdout}=await attach(['attach','-readonly','-nobrowse','-mountpoint',mount,image]);
 const device=stdout.split(/\r?\n/).map(line=>line.trim().split(/\s+/)[0]).find(value=>/^\/dev\/disk\d+$/.test(value));
 if(!device)throw new Error('hdiutil attach did not report a disk device: '+stdout);
 let failure;
 try {await verifyMounted();} catch(error) {failure=error;}
 try {
  try {await run('hdiutil',['detach',device]);}
  catch {await run('hdiutil',['detach','-force',device]);}
 } catch(cleanupError) {
  if(failure)console.error('Disk-image cleanup also failed:',cleanupError);
  else throw cleanupError;
 }
 if(failure)throw failure;
}
