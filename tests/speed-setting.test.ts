import {expect,it} from 'vitest';
import {fastThreads} from '../src/portable/engine.js';
it('Fast mode uses every logical CPU from 2 up to 8; Light stays at 2',()=>{
 expect([1,2,4,6,8,12,32].map(n=>fastThreads(n))).toEqual([2,2,4,6,8,8,8]);
});
