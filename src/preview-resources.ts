/** Bounded binary loading, independent of the ordered preview event lane.
 * Descriptors are leased to their registering revision. A late fetch can fill an
 * immutable binary cache, but can never install a superseded descriptor itself.
 */
export type ResourceKind='fonts'|'images';
export type ResourceOwner={kind:ResourceKind;key:string;value:any;identity:string;version:number[];introducedVersion:number[];epoch:number;state:'pending'|'ready'|'installed';job?:BinaryJob};
type BinaryJob={ref:string;bytes:number;epoch:number;state:'queued'|'running'|'ready';data?:Uint8Array};
type Options={signal:AbortSignal;load:(ref:string,bytes:number,signal:AbortSignal)=>Promise<Uint8Array>;changed:()=>void;failed:(error:any)=>void;concurrency?:number;maxEntries?:number;maxJobs?:number;maxBytes?:number;attempts?:number;timeoutMs?:number;retryMs?:number};
const version=(v:any)=>['engine_generation','source_revision','layout_version','context_revision'].map(k=>Number.isSafeInteger(v?.[k])&&v[k]>=0?v[k]:0);
const compare=(a:number[],b:number[])=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;};
const abortError=()=>new DOMException('Aborted','AbortError');
export class PreviewResources{
 private owners=new Map<string,ResourceOwner>();private jobs=new Map<string,BinaryJob>();private queue:BinaryJob[]=[];private controller=new AbortController();private running=0;private allocated=0;private epoch=0;private stopped=false;
 constructor(private options:Options){options.signal.addEventListener('abort',()=>this.stop(),{once:true});if(options.signal.aborted)this.stop();}
 private key(kind:ResourceKind,key:string){return kind+':'+key;}
 register(event:any){
  if(this.stopped)throw abortError();
  for(const kind of ['fonts','images'] as const)for(const [key,value]of Object.entries(event[kind]??{}) as [string,any][]){
   if(!key||key.length>4096||!value||typeof value!=='object')throw Error('Invalid preview resource descriptor');
   const id=this.key(kind,key),old=this.owners.get(id),v=version(event.versions);
   if(old&&compare(v,old.version)<0)continue;
   const identity=JSON.stringify(value);
   if(old&&old.identity===identity){if(compare(v,old.version)>0)old.version=v;continue;}
   if(!old&&this.owners.size>=(this.options.maxEntries??4096))throw Error('Preview resource descriptor budget exceeded');
   const cost=identity.length*2;let job:BinaryJob|undefined;
   if(value.resourceRef!==undefined){
    if(typeof value.resourceRef!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(value.resourceRef)||!Number.isSafeInteger(value.byteLength)||value.byteLength<0)throw Error('Invalid preview binary resource');
    job=this.jobs.get(value.resourceRef);
    if(job&&job.bytes!==value.byteLength)throw Error('Immutable preview resource size changed');
    if(!job){
     if(this.jobs.size>=(this.options.maxJobs??256)||this.allocated+cost+value.byteLength>(this.options.maxBytes??64000000))throw Error('Preview binary resource budget exceeded');
     job={ref:value.resourceRef,bytes:value.byteLength,epoch:this.epoch,state:'queued'};this.jobs.set(job.ref,job);this.queue.push(job);this.allocated+=job.bytes;
    }
   }
   if(this.allocated+cost>(this.options.maxBytes??64000000))throw Error('Preview resource memory budget exceeded');
   // Charge every descriptor allocation in this epoch, including superseded
   // owners still leased by old DLs. Replacing a key does not reset the budget.
   this.allocated+=cost;
   this.owners.set(id,{kind,key,value,identity,version:v,introducedVersion:[...v],epoch:this.epoch,state:job&&job.state!=='ready'?'pending':'ready',job});
  }
  this.pump();
 }
 owner(kind:ResourceKind,key:string){return this.owners.get(this.key(kind,key));}
 current(owner:ResourceOwner){return !this.stopped&&owner.epoch===this.epoch&&this.owner(owner.kind,owner.key)===owner;}
 compatible(owner:ResourceOwner,v:any){const before=owner.introducedVersion,after=version(v);return before[0]<after[0]||before[0]===after[0]&&before.slice(1).every((value,index)=>value<=after[index+1]);}
 ready(){return [...this.owners.values()].filter(owner=>owner.state==='ready');}
 materialize(owner:ResourceOwner){if(!this.current(owner)||owner.state!=='ready')throw Error('Preview resource owner is obsolete');return owner.job?{...owner.value,data:owner.job.data}:owner.value;}
 installed(owner:ResourceOwner){if(this.current(owner)&&owner.state==='ready')owner.state='installed';}
 prioritize(owner:ResourceOwner){if(!this.current(owner)||owner.job?.state!=='queued')return;const index=this.queue.indexOf(owner.job);if(index>0){this.queue.splice(index,1);this.queue.unshift(owner.job);}}
 reset(){if(this.stopped)return;this.controller.abort();this.controller=new AbortController();this.epoch++;this.owners.clear();this.jobs.clear();this.queue=[];this.running=0;this.allocated=0;}
 stop(){if(this.stopped)return;this.stopped=true;this.controller.abort();this.queue=[];}
 status(){return {epoch:this.epoch,owners:this.owners.size,jobs:this.jobs.size,queued:this.queue.length,running:this.running,allocated:this.allocated,stopped:this.stopped};}
 private pump(){while(!this.stopped&&this.running<(this.options.concurrency??4)&&this.queue.length){const job=this.queue.shift()!;job.state='running';this.running++;void this.run(job,this.controller.signal);}}
 private async run(job:BinaryJob,signal:AbortSignal){
  try{
   let data:Uint8Array|undefined;
   for(let attempt=0;attempt<(this.options.attempts??3);attempt++){
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),(this.options.timeoutMs??30000)*Math.max(1,Math.ceil(job.bytes/524288)));
    try{data=await this.options.load(job.ref,job.bytes,AbortSignal.any([signal,deadline.signal]));if(signal.aborted||job.epoch!==this.epoch)throw abortError();if(!(data instanceof Uint8Array)||data.length!==job.bytes)throw Object.assign(Error('Preview resource data is incomplete'),{permanent:true});break;}
    catch(error:any){if(signal.aborted||job.epoch!==this.epoch)throw abortError();if(error?.permanent||attempt+1===(this.options.attempts??3))throw error;await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(wait);signal.removeEventListener('abort',abort);reject(abortError());};const wait=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},(this.options.retryMs??250)*2**attempt);signal.addEventListener('abort',abort,{once:true});});}
    finally{clearTimeout(timer);}
   }
   if(signal.aborted||job.epoch!==this.epoch||this.stopped)return;
   job.data=data!;job.state='ready';for(const owner of this.owners.values())if(owner.job===job&&owner.state==='pending')owner.state='ready';this.options.changed();
  }catch(error:any){if(!signal.aborted&&job.epoch===this.epoch&&!this.stopped){if([401,403].includes(error?.status)||[...this.owners.values()].some(owner=>owner.job===job)){this.stop();this.options.failed(error);}else if(this.jobs.get(job.ref)===job)this.jobs.delete(job.ref);}}
  finally{if(job.epoch===this.epoch){this.running--;this.pump();}}
 }
}
