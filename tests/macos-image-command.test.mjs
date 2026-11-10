import {expect,it,vi} from 'vitest';
import {imageCommand} from '../scripts/macos-image-command.mjs';
it('retries transient native image contention and still runs the same operation',async()=>{
 const error=Object.assign(new Error('command failed'),{stderr:'hdiutil: create failed - Resource busy'}),run=vi.fn().mockRejectedValueOnce(error).mockResolvedValue({stdout:'created'}),pause=vi.fn();
 expect(await imageCommand(['create','fixture.dmg'],run,pause)).toEqual({stdout:'created'});expect(run).toHaveBeenCalledTimes(2);expect(pause).toHaveBeenCalledOnce();expect(run.mock.calls[0]).toEqual(run.mock.calls[1]);
});
it('does not retry integrity, disk-space or permission failures, and bounds contention retries',async()=>{
 const pause=vi.fn();const fatal=Object.assign(new Error('failed'),{stderr:'No space left on device'}),run=vi.fn().mockRejectedValue(fatal);await expect(imageCommand(['create'],run,pause)).rejects.toBe(fatal);expect(run).toHaveBeenCalledOnce();expect(pause).not.toHaveBeenCalled();
 const busy=Object.assign(new Error('busy'),{stderr:'Resource busy'}),stuck=vi.fn().mockRejectedValue(busy);await expect(imageCommand(['create'],stuck,pause)).rejects.toBe(busy);expect(stuck).toHaveBeenCalledTimes(3);
});
