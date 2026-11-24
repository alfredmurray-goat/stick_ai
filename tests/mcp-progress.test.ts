import {afterEach,expect,it,vi} from 'vitest';
import {McpProgress} from '../src/portable/mcp-progress.js';
afterEach(()=>vi.useRealTimers());
it('bounds a burst to the first and latest UI update without an idle polling timer',()=>{
 vi.useFakeTimers();const emit=vi.fn(),progress=new McpProgress(emit);
 for(let i=0;i<10000;i++)progress.push(String(i));
 expect(emit.mock.calls).toEqual([['0']]);expect(vi.getTimerCount()).toBe(1);
 vi.advanceTimersByTime(100);expect(emit.mock.calls).toEqual([['0'],['9999']]);
 vi.advanceTimersByTime(100);expect(vi.getTimerCount()).toBe(0);
 progress.push('next');expect(emit).toHaveBeenLastCalledWith('next');progress.close();
});
it('discards pending UI text on disconnect and ignores later updates',()=>{
 vi.useFakeTimers();const emit=vi.fn(),progress=new McpProgress(emit);
 progress.push('first');progress.push('pending');progress.close();progress.push('late');
 vi.runAllTimers();expect(emit.mock.calls).toEqual([['first']]);expect(vi.getTimerCount()).toBe(0);
});
