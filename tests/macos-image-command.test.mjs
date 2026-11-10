import {expect,it,vi} from 'vitest';
import {imageCommand,verifyMountedImage} from '../scripts/macos-image-command.mjs';
it('retries transient native image contention and still runs the same operation',async()=>{
 const error=Object.assign(new Error('command failed'),{stderr:'hdiutil: create failed - Resource busy'}),run=vi.fn().mockRejectedValueOnce(error).mockResolvedValue({stdout:'created'}),pause=vi.fn();
 expect(await imageCommand(['create','fixture.dmg'],run,pause)).toEqual({stdout:'created'});expect(run).toHaveBeenCalledTimes(2);expect(pause).toHaveBeenCalledOnce();expect(run.mock.calls[0]).toEqual(run.mock.calls[1]);
});
it('does not retry integrity, disk-space or permission failures, and bounds contention retries',async()=>{
 const pause=vi.fn();const fatal=Object.assign(new Error('failed'),{stderr:'No space left on device'}),run=vi.fn().mockRejectedValue(fatal);await expect(imageCommand(['create'],run,pause)).rejects.toBe(fatal);expect(run).toHaveBeenCalledOnce();expect(pause).not.toHaveBeenCalled();
 const busy=Object.assign(new Error('busy'),{stderr:'Resource busy'}),stuck=vi.fn().mockRejectedValue(busy);await expect(imageCommand(['create'],stuck,pause)).rejects.toBe(busy);expect(stuck).toHaveBeenCalledTimes(3);
});

it('detaches the disk identity and preserves the actual mounted verification failure',async()=>{
 const attach=vi.fn(async()=>({stdout:'/dev/disk7 GUID_partition_scheme\n/dev/disk7s1 Apple_HFS /tmp/a-mounted-path\n'}));
 const failure=new Error('Mounted manifest mismatch'),run=vi.fn().mockRejectedValue(new Error('No such file or directory'));const diagnostic=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{await expect(verifyMountedImage({image:'a.dmg',mount:'/tmp/a-mounted-path',attach,run,verifyMounted:async()=>{throw failure;}})).rejects.toBe(failure);expect(run.mock.calls.map(c=>c[1])).toEqual([['detach','/dev/disk7'],['detach','-force','/dev/disk7']]);}finally{diagnostic.mockRestore();}
 const detach=vi.fn(async()=>({stdout:''}));await verifyMountedImage({image:'a.dmg',mount:'/tmp/a-mounted-path',attach,run:detach,verifyMounted:async()=>{}});expect(detach).toHaveBeenCalledOnce();
});
