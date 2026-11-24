/** One pending UI update per server. Transport messages and tool results are never delayed. */
export class McpProgress {
 private latest:string|undefined;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private closed=false;
 constructor(private emit:(text:string)=>void,private interval=100){}
 push(text:string){
  if(this.closed)return;
  if(this.timer){this.latest=text;return;}
  this.emit(text);
  this.schedule();
 }
 private schedule(){
  this.timer=setTimeout(()=>{
   this.timer=undefined;
   const text=this.latest;this.latest=undefined;
   if(!this.closed&&text!==undefined){this.emit(text);this.schedule();}
  },this.interval);
  this.timer.unref?.();
 }
 close(){this.closed=true;this.latest=undefined;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
}
