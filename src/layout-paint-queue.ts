type Versions={source_revision:number;engine_generation:number;layout_version:number;context_revision:number};
const fields=['source_revision','engine_generation','layout_version','context_revision'] as const;
const valid=(v:any):v is Versions=>Boolean(v&&fields.every(k=>Number.isSafeInteger(v[k])&&v[k]>=0));
const equal=(a:Versions,b:Versions)=>fields.every(k=>a[k]===b[k]);

/** Give one genuine same-source capture a chance to paint before advancing its
 * convergence context. The caller keeps the original resource/geometry pairing:
 * queued events are returned unchanged, never restamped or merged here. */
export class LayoutPaintQueue {
 private active:Versions|null=null;private pending:any[]=[];private bytes=0;private options:{maxEvents?:number;maxBytes?:number};
 constructor(options:{maxEvents?:number;maxBytes?:number}={}){
  if(![options.maxEvents??8,options.maxBytes??16000000].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('Invalid layout paint queue budget');
  this.options=options;
 }
 begin(versions:any){
  if(this.pending.length)throw Error('Drain queued captures before starting another paint');
  this.active=valid(versions)?{...versions}:null;
 }
 /** False means apply the normal admission/cancellation path. On a newer source
  * or generation the caller must first drain() pending deltas into that capture. */
 defer(event:any){
  const a=this.active,v=event?.versions;
  if(!a||event.event!=='LayoutUpdate'||!valid(v)||v.engine_generation!==a.engine_generation||v.source_revision!==a.source_revision||v.layout_version<=a.layout_version||v.context_revision<a.context_revision)return false;
  const size=JSON.stringify(event).length*2;
  if(this.pending.length>=(this.options.maxEvents??8)||this.bytes+size>(this.options.maxBytes??16000000))return false;
  this.pending.push(event);this.pending.sort((a,b)=>a.versions.layout_version-b.versions.layout_version||a.versions.context_revision-b.versions.context_revision);this.bytes+=size;return true;
 }
 /** Only the exact active canvas can release the hold. An old canvas, merely
  * completed PDF parse, or staged geometry is not a visible paint receipt. */
 painted(versions:any){
  if(!this.active||!valid(versions)||!equal(this.active,versions))return null;
  return this.drain();
 }
 /** Also use on a terminal load failure, pause/reset, or an immediate newer
  * source/generation: none may leave convergence events waiting forever. */
 drain(){const events=this.pending;this.pending=[];this.bytes=0;this.active=null;return events;}
 get waiting(){return Boolean(this.active);}
 get size(){return this.pending.length;}
}
