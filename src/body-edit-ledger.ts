import {verifyNativeProof,type NativeProof} from './native-edits.ts';
import {singleBodyReplacementEvidence} from './body-replacement-evidence.ts';
import type {Versions} from '../vendor/src/protocol';
type Span={id:number;kind:string;range:{start:number;end:number}};
const keys=['source_revision','engine_generation','context_revision','layout_version'] as const;
/** Private, bounded journal. Each step is proven against the immediately prior
 * authoritative source; the immutable capture is never relabelled as current. */
export class BodyEditLedger {
 readonly path:string;readonly docId:string;readonly versions:Versions;
 private baseline:string;private initial:Span[];private current:string;private spans:Span[];private epoch:string|null=null;private transaction:number|null=null;private revision:number;private equivalentSourceRevision:number;private count=0;private bytes=0;private live=true;
 private dirty=new Map<number,{parId:number;sourceRevision:number;editId:number;beforeParId:number;afterParId:number}>();
 constructor(path:string,docId:string,text:string,spans:Span[],versions:Versions,currentSourceRevision=versions.source_revision){this.path=path;this.docId=docId;this.baseline=text;this.current=text;this.initial=structuredClone(spans);this.spans=structuredClone(spans);this.versions={...versions};this.revision=currentSourceRevision;this.equivalentSourceRevision=currentSourceRevision;}
 matchesLayout(v:any){return this.live&&keys.every(k=>v?.[k]===this.versions[k]);}
 append(input:{path:string;docId:string;before:string;after:string;afterSpans:Span[];proof:NativeProof;result:any}){
  const retire=()=>{this.live=false;this.dirty.clear();return null;};if(!this.live)return null;
  try{const {proof,result}=input;if(input.path!==this.path||input.docId!==this.docId||input.before!==this.current||result?.source_revision<=this.revision||this.epoch!==null&&(proof.viewEpoch!==this.epoch||proof.baseTransactionId!==this.transaction))return retire();
   verifyNativeProof(input.before,input.after,proof);const size=JSON.stringify(proof.records).length;if(this.count+proof.records.length>256||this.bytes+size>1500000)return retire();
   // Per-step proof includes complete maps/gaps and restricts every intermediate
   // native edit to this one existing Body. Its revision is only a proof frame;
   // the emitted baseline below remains the genuine original capture.
   const step=singleBodyReplacementEvidence({before:input.before,after:input.after,beforeSpans:this.spans,afterSpans:input.afterSpans,proof,baseVersions:{...this.versions,source_revision:this.revision},beforeSourceRevision:this.revision,result});if(!step)return retire();
   if(this.initial.length!==input.afterSpans.length||this.initial.some((s,i)=>s.id!==input.afterSpans[i].id||s.kind!==input.afterSpans[i].kind))return retire();
   const old=this.initial.find(s=>s.id===step.parId)!,now=input.afterSpans.find(s=>s.id===step.parId)!;const slice=(text:string,s:Span)=>Buffer.from(text).subarray(s.range.start,s.range.end).toString('utf8');
   if(slice(this.baseline,old)===slice(input.after,now))this.dirty.delete(step.parId);else this.dirty.set(step.parId,{parId:step.parId,sourceRevision:result.source_revision,editId:result.edit_id,beforeParId:step.beforeParId,afterParId:step.afterParId});if(this.dirty.size>8)return retire();
   this.current=input.after;this.spans=structuredClone(input.afterSpans);this.epoch=proof.viewEpoch;this.transaction=proof.transactionId;this.revision=result.source_revision;this.count+=proof.records.length;this.bytes+=size;
   return{...step,kind:'body-set-replacement' as const,baseVersions:{...this.versions},capturedSourceRevision:this.versions.source_revision,equivalentSourceRevision:this.equivalentSourceRevision,dirtyUnits:[...this.dirty.values()].sort((a,b)=>this.initial.findIndex(s=>s.id===a.parId)-this.initial.findIndex(s=>s.id===b.parId)),reverted:!this.dirty.has(step.parId)};
  }catch{return retire();}
 }
}
