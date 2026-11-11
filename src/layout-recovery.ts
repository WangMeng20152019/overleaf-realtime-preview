// One recovery per monotonically advancing source/generation; never triggered by repaint count.
export class LayoutRecovery {
 private revision=-1;private generation=-1;private pending:Promise<boolean>|null=null;
 request(revision:number,generation:number,schedule:()=>Promise<void>):Promise<boolean>{
  if(!Number.isSafeInteger(revision)||revision<0||!Number.isSafeInteger(generation)||generation<0)return Promise.reject(Error('Invalid recovery version'));
  if(generation<this.generation||generation===this.generation&&revision<=this.revision)return this.pending??Promise.resolve(false);
  this.revision=revision;this.generation=generation;
  const pending=Promise.resolve().then(schedule).then(()=>true);
  this.pending=pending;void pending.finally(()=>{if(this.pending===pending)this.pending=null;}).catch(()=>{});
  return pending;
 }
}

type CapturePair={source_revision:number;engine_generation:number};
const validCapturePair=(revision:number,generation:number)=>Number.isSafeInteger(revision)&&revision>=0&&Number.isSafeInteger(generation)&&generation>=0;
const compareCapturePair=(a:CapturePair,b:CapturePair)=>a.engine_generation-b.engine_generation||a.source_revision-b.source_revision;
/** Coalesce source-lineage demand with a proven engine-scheduled full capture.
 * This gate never handles geometry recovery and never certifies page admission.
 * Only the bridge's successful edit result and admitted engine captures may feed
 * it. A lost/failed capture releases the wait; waiting is bounded independently
 * of LayoutRecovery's existing explicit-request idempotency. */
export class CaptureDemandGate {
 private automatic:(CapturePair&{since:number})|null=null;
 private covered:CapturePair|null=null;
 private now:()=>number;private pendingMs:number;
 constructor(options:{now?:()=>number;pendingMs?:number}={}){this.now=options.now??Date.now;this.pendingMs=options.pendingMs??30000;if(!Number.isFinite(this.pendingMs)||this.pendingMs<=0)throw Error('Positive capture wait required');}
 noteAutomatic(revision:number,generation:number){
  if(!validCapturePair(revision,generation))throw Error('Invalid automatic capture version');
  const pair={source_revision:revision,engine_generation:generation};
  if(this.covered&&compareCapturePair(pair,this.covered)<=0||this.automatic&&compareCapturePair(pair,this.automatic)<=0)return;
  this.automatic={...pair,since:this.now()};
 }
 noteCapture(revision:number,generation:number,result:{accepted:boolean;compileState:string}){
  if(!validCapturePair(revision,generation))throw Error('Invalid capture version');
  const pair={source_revision:revision,engine_generation:generation};
  if(result.accepted&&['Ok','CompiledWithErrors'].includes(result.compileState)){
   if(!this.covered||compareCapturePair(pair,this.covered)>0)this.covered=pair;
  }
  // Rejected/failed captures cannot establish coverage. They also must not keep
  // a source request suppressed for the remaining automatic-capture timeout.
  if(this.automatic&&compareCapturePair(pair,this.automatic)>=0)this.automatic=null;
 }
 sourceDemand(revision:number,generation:number):{request:boolean;reason:'captured'|'automatic-pending'|null;retryAfterMs?:number}{
  if(!validCapturePair(revision,generation))throw Error('Invalid source demand version');
  if(this.covered?.engine_generation===generation&&this.covered.source_revision>=revision)return{request:false,reason:'captured'};
  const pending=this.automatic;
  if(pending?.engine_generation===generation&&pending.source_revision>=revision){
   const remaining=this.pendingMs-Math.max(0,this.now()-pending.since);
   if(remaining>0)return{request:false,reason:'automatic-pending',retryAfterMs:remaining};
   this.automatic=null;
  }
  return{request:true,reason:null};
 }
}
