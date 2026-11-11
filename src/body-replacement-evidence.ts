import {verifyNativeProof,type NativeProof} from './native-edits.ts';
import type {Versions} from '../vendor/src/protocol';
type Span={id:number;kind:string;range:{start:number;end:number}};
type Input={before:string;after:string;beforeSpans:Span[];afterSpans:Span[];proof:NativeProof;baseVersions:Versions;beforeSourceRevision:number;result:any;paragraph?:any};
const versionKeys=['source_revision','engine_generation','context_revision','layout_version'] as const;
const validVersion=(v:any):v is Versions=>v&&versionKeys.every(k=>Number.isSafeInteger(v[k])&&v[k]>=0);
function mapped(text:string,spans:Span[]){
 if(!Array.isArray(spans)||spans.length<3||spans.length>20000)throw Error('Invalid replacement span map');
 const needed=new Set(spans.flatMap(s=>[s.range?.start,s.range?.end])),positions=new Map<number,number>();let bytes=0;
 for(let i=0;i<=text.length;){if(needed.has(bytes))positions.set(bytes,i);if(i===text.length)break;const cp=text.codePointAt(i)!;bytes+=cp<128?1:cp<2048?2:cp<65536?3:4;i+=cp>65535?2:1;}
 let last=0;const ids=new Set<number>();return spans.map(s=>{const from=positions.get(s.range?.start),to=positions.get(s.range?.end);if(!Number.isSafeInteger(s.id)||s.id<=0||ids.has(s.id)||!['Preamble','Body','Heading','Env','Trailer'].includes(s.kind)||from===undefined||to===undefined||from<last||to<from)throw Error('Replacement span ownership differs');ids.add(s.id);last=to;return{...s,from,to,text:text.slice(from,to)};});
}
/** Source/PG certificate only, NOT permission to splice pixels. The caller must
 * supply authenticated engine maps/result and a truly captured before buffer;
 * renderer still proves complete ownership, resources, geometry and neighbours.
 * No dirty-source rebasing or remote/history/intermediate-IME admission.
 */
export function singleBodyReplacementEvidence(input:Input){
 const {before,after,beforeSpans,afterSpans,proof,baseVersions:base,beforeSourceRevision,result,paragraph:pg}=input;
 if(typeof before!=='string'||typeof after!=='string'||before===after||!validVersion(base)||beforeSourceRevision!==base.source_revision)return null;
 const verified=verifyNativeProof(before,after,proof);
 if(verified.origins.length!==1||verified.origins[0]!=='local'||proof.records.some(r=>!r.changes.length||r.composition?.phase!=='none'&&r.composition?.phase!=='committed'))return null;
 const old=mapped(before,beforeSpans),next=mapped(after,afterSpans);
 if(old.length!==next.length||old.some((s,i)=>s.id!==next[i].id||s.kind!==next[i].kind))return null;
 const changed=old.filter((s,i)=>s.text!==next[i].text);if(changed.length!==1||changed[0].kind!=='Body')return null;
 const unit=changed[0],index=old.indexOf(unit),current=next[index],limit=65536;
 if(!unit.text.trim()||!current.text.trim()||new TextEncoder().encode(unit.text).length>limit||new TextEncoder().encode(current.text).length>limit)return null;
 if(before.slice(0,unit.from)!==after.slice(0,current.from)||before.slice(unit.to)!==after.slice(current.to))return null;
 // Track the original Body envelope through every exact intermediate change;
 // edits to another unit later undone still do not earn this certificate.
 let end=unit.to;
 for(const record of proof.records){for(const c of record.changes)if(c.fromA<unit.from||c.toA>end||c.fromA>c.toA)return null;end+=record.changes.reduce((sum,c)=>sum+c.inserted.length-(c.toA-c.fromA),0);}
 if(current.from!==unit.from||current.to!==end)return null;
 const previous=old.slice(0,index).reverse().find(s=>['Body','Env','Heading'].includes(s.kind)),following=old.slice(index+1).find(s=>['Body','Env','Heading'].includes(s.kind));if(!previous||!following)return null;
 const outcome=result?.outcome;
 if(result?.routed!=='fast'||!Number.isSafeInteger(result.source_revision)||result.source_revision<=base.source_revision||!Number.isSafeInteger(result.edit_id)||result.edit_id<=0||!outcome||outcome.preamble_changed!==false||!Array.isArray(outcome.added)||outcome.added.length||!Array.isArray(outcome.removed)||outcome.removed.length||!Array.isArray(outcome.touched)||outcome.touched.length!==1||outcome.touched[0]!==unit.id)return null;
 const evidence={verified:true as const,kind:'single-body-replacement' as const,parId:unit.id,beforeParId:previous.id,afterParId:following.id,baseVersions:{...base},sourceRevision:result.source_revision,editId:result.edit_id,viewEpoch:proof.viewEpoch,baseTransactionId:proof.baseTransactionId,transactionId:proof.transactionId,origins:verified.origins};
 if(pg!==undefined&&!replacementParagraphMatches(evidence,pg))return null;
 return evidence;
}

/** A source certificate alone never authorizes painting. */
export function replacementParagraphMatches(evidence:any,pg:any):boolean{
 const base=evidence?.baseVersions;
 if(evidence?.kind==='body-set-replacement'){
  const units=evidence.dirtyUnits;if(!Array.isArray(units)||units.length>8||new Set(units.map((u:any)=>u?.parId)).size!==units.length||units.some((u:any)=>!Number.isSafeInteger(u?.parId)||u.parId<=0||!Number.isSafeInteger(u.sourceRevision)||u.sourceRevision<=base?.source_revision||u.sourceRevision>evidence.sourceRevision||!Number.isSafeInteger(u.editId)||u.editId<=0||![u.beforeParId,u.afterParId].every(id=>Number.isSafeInteger(id)&&id>0)||new Set([u.parId,u.beforeParId,u.afterParId]).size!==3))return false;
  const target=units.find((u:any)=>u.parId===evidence.parId);if(evidence.reverted===true?!!target:!target||target.sourceRevision!==evidence.sourceRevision||target.editId!==evidence.editId)return false;
 }
 return evidence?.verified===true&&['single-body-replacement','body-set-replacement'].includes(evidence.kind)&&validVersion(base)&&Number.isSafeInteger(evidence.sourceRevision)&&evidence.sourceRevision>base.source_revision&&[evidence.parId,evidence.beforeParId,evidence.afterParId,evidence.editId].every(id=>Number.isSafeInteger(id)&&id>0)&&new Set([evidence.parId,evidence.beforeParId,evidence.afterParId]).size===3&&pg?.event==='ParagraphUpdate'&&pg.status==='ok'&&pg.par_id===evidence.parId&&pg.edit_id===evidence.editId&&validVersion(pg.versions)&&pg.versions.source_revision===evidence.sourceRevision&&versionKeys.slice(1).every(k=>pg.versions[k]===base[k]);
}

/** One bounded local replacement history against an immutable captured source.
 * A failed/unsupported append retires the instance; callers cannot rebase it. */
export class BodyReplacementEvidence{
 private current:string;private epoch:string|null=null;private transaction:number|null=null;private firstTransaction:number|null=null;private records:NativeProof['records']=[];private lastRevision:number;private live=true;private parId:number|null=null;
 readonly path:string;readonly docId:string;private baseline:string;private spans:Span[];readonly versions:Versions;private equivalentSourceRevision:number;
 constructor(path:string,docId:string,baseline:string,spans:Span[],versions:Versions,equivalentSourceRevision=versions.source_revision){
  this.path=path;this.docId=docId;this.baseline=baseline;this.current=baseline;this.spans=structuredClone(spans);this.versions={...versions};this.lastRevision=equivalentSourceRevision;this.equivalentSourceRevision=equivalentSourceRevision;
 }
 matchesLayout(versions:any){return this.live&&validVersion(versions)&&versionKeys.every(k=>this.versions[k]===versions[k]);}
 append(input:{path:string;docId:string;before:string;after:string;afterSpans:Span[];proof:NativeProof;result:any}){
  if(!this.live)return null;
  const retire=()=>{this.live=false;this.records=[];return null;};
  const {path,docId,before,after,afterSpans,proof,result}=input;
  if(path!==this.path||docId!==this.docId||before!==this.current||!Number.isSafeInteger(result?.source_revision)||result.source_revision<=this.lastRevision||this.epoch!==null&&(proof?.viewEpoch!==this.epoch||proof?.baseTransactionId!==this.transaction))return retire();
  try{
   verifyNativeProof(before,after,proof);
   const records=[...this.records,...structuredClone(proof.records)];if(records.length>256||JSON.stringify(records).length>1500000)return retire();
   const combined:NativeProof={version:1,coordinateSpace:'codemirror-utf16',viewEpoch:proof.viewEpoch,baseTransactionId:this.firstTransaction??proof.baseTransactionId,transactionId:proof.transactionId,records};
   const evidence=singleBodyReplacementEvidence({before:this.baseline,after,beforeSpans:this.spans,afterSpans,proof:combined,baseVersions:this.versions,beforeSourceRevision:this.versions.source_revision,result});
   if(!evidence||this.parId!==null&&evidence.parId!==this.parId)return retire();
   this.current=after;this.epoch=proof.viewEpoch;this.transaction=proof.transactionId;this.firstTransaction=combined.baseTransactionId;this.records=records;this.lastRevision=result.source_revision;this.parId=evidence.parId;
   return{...evidence,capturedSourceRevision:this.versions.source_revision,equivalentSourceRevision:this.equivalentSourceRevision};
  }catch{return retire();}
 }
}

/** One reusable certificate, seeded only while current engine source is exactly
 * an admitted capture. Text equality never changes the capture's revision. */
export class ReusableBodyBaseline{
 readonly path:string;readonly docId:string;readonly versions:Versions;private texts:Map<string,string>;private spans:Span[];private inventory:string;private environment:string;
 constructor(input:{path:string;docId:string;texts:Map<string,string>;spans:Span[];versions:Versions;currentSourceRevision:number;environment:string}){
  if(!validVersion(input.versions)||input.currentSourceRevision!==input.versions.source_revision||!input.environment||!input.texts.has(input.path))throw Error('Fresh captured source required');
  let bytes=0;for(const [name,text]of input.texts){if(typeof name!=='string'||typeof text!=='string'||(bytes+=new TextEncoder().encode(text).length)>20000000)throw Error('Captured source snapshot budget');}
  mapped(input.texts.get(input.path)!,input.spans);this.path=input.path;this.docId=input.docId;this.versions={...input.versions};this.texts=new Map(input.texts);this.spans=structuredClone(input.spans);this.inventory=JSON.stringify(input.spans.map(s=>[s.id,s.kind,s.range.start,s.range.end]));this.environment=input.environment;
 }
 matchesLayout(v:any){return validVersion(v)&&versionKeys.every(k=>v[k]===this.versions[k]);}
 authorize(input:{path:string;docId:string;texts:Map<string,string>;spans:Span[];versions:Versions;currentSourceRevision:number;environment:string}){
  if(input.path!==this.path||input.docId!==this.docId||!this.matchesLayout(input.versions)||!Number.isSafeInteger(input.currentSourceRevision)||input.currentSourceRevision<this.versions.source_revision||input.environment!==this.environment||input.texts.size!==this.texts.size)return null;
  for(const [name,text]of this.texts)if(input.texts.get(name)!==text)return null;
  try{mapped(this.texts.get(this.path)!,input.spans);}catch{return null;}
  if(JSON.stringify(input.spans.map(s=>[s.id,s.kind,s.range.start,s.range.end]))!==this.inventory)return null;
  return{baseline:this.texts.get(this.path)!,spans:structuredClone(this.spans),versions:{...this.versions},capturedSourceRevision:this.versions.source_revision,equivalentSourceRevision:input.currentSourceRevision};
 }
}
