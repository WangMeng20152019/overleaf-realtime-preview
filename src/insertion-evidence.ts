import {verifyNativeProof,NativeSourceLineage,type NativeProof} from './native-edits.ts';
import {isClosedMathEnvironment} from '../integration/math-construction.js';
type Span={id:number;kind:string;range:{start:number;end:number}};
type Versions={source_revision:number;engine_generation:number;layout_version:number;context_revision:number};
const trim=(s:string)=>s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g,'');
function sourceSpans(text:string,spans:Span[]){
 if(!Array.isArray(spans)||spans.length>20000)throw Error('Invalid span map');
 const needed=new Set(spans.flatMap(s=>[s.range?.start,s.range?.end]));const offsets=new Map<number,number>();let bytes=0;
 for(let i=0;i<=text.length;){if(needed.has(bytes))offsets.set(bytes,i);if(i===text.length)break;const cp=text.codePointAt(i)!;bytes+=cp<=0x7f?1:cp<=0x7ff?2:cp<=0xffff?3:4;i+=cp>0xffff?2:1;}
 let last=0;const ids=new Set<number>();return spans.map(s=>{const start=offsets.get(s.range.start),end=offsets.get(s.range.end);if(!Number.isSafeInteger(s.id)||s.id<=0||ids.has(s.id)||start===undefined||end===undefined||start<last||end<start||!['Preamble','Body','Env','Heading','Trailer'].includes(s.kind))throw Error('Span map differs from source');ids.add(s.id);last=end;return {...s,start,end,text:text.slice(start,end)};});
}
/** Proof is source based: new IDs must contain only inserted text and old whitespace. */
export function insertionLineage(before:string,after:string,beforeSpans:Span[],afterSpans:Span[],proof:NativeProof){
 const verified=verifyNativeProof(before,after,proof);const result=lineageUnits(before,after,beforeSpans,afterSpans,verified,1);if(!result)return null;const unit=result.units[0];return{parId:unit.parId,beforeParId:unit.beforeParId,afterParId:unit.afterParId,origins:result.origins};
}
function lineageUnits(before:string,after:string,beforeSpans:Span[],afterSpans:Span[],verified:{pureInsertions:{at:number;text:string}[]|null;origins:string[]},maxAdded:number){
 if(!verified.pureInsertions?.length||verified.pureInsertions.reduce((sum,p)=>sum+new TextEncoder().encode(p.text).length,0)>65536)return null;
 const old=sourceSpans(before,beforeSpans),next=sourceSpans(after,afterSpans),oldIds=new Set(old.map(s=>s.id));
 // Every original unit must survive with exactly its original non-boundary text.
 for(const span of old){const current=next.find(s=>s.id===span.id);if(!current||current.kind!==span.kind||trim(current.text)!==trim(span.text))return null;}
 const added=next.filter(s=>!oldIds.has(s.id));if(!added.length||added.length>maxAdded||added.some(s=>!trim(s.text)))return null;
 // Explicit AMS math is segmented as Env even when the engine can replay it
 // quickly. Authorize only the finite closed math structures shared with the
 // construction gate; drawable resources and page geometry are checked later.
 if(added.some(s=>s.kind!=='Body'&&(s.kind!=='Env'||!isClosedMathEnvironment(s.text))))return null;
 const pieces:{start:number;end:number;originalStart?:number}[]=[];let source=0,target=0;
 for(const insert of verified.pureInsertions){if(insert.at>source){pieces.push({start:target,end:target+insert.at-source,originalStart:source});target+=insert.at-source;}pieces.push({start:target,end:target+insert.text.length});target+=insert.text.length;source=insert.at;}
 if(source<before.length)pieces.push({start:target,end:target+before.length-source,originalStart:source});
 const units=[];
 for(const fresh of added){let inserted=false;
  for(const piece of pieces){const from=Math.max(piece.start,fresh.start),to=Math.min(piece.end,fresh.end);if(from>=to)continue;if(piece.originalStart===undefined){if(trim(after.slice(from,to)))inserted=true;}else if(trim(before.slice(piece.originalStart+from-piece.start,piece.originalStart+to-piece.start)))return null;}
  if(!inserted)return null;const index=next.indexOf(fresh),previous=next.slice(0,index).reverse().find(s=>oldIds.has(s.id)&&['Body','Env','Heading'].includes(s.kind)),following=next.slice(index+1).find(s=>oldIds.has(s.id)&&['Body','Env','Heading'].includes(s.kind));
  if(!previous||!following)return null;
  units.push({parId:fresh.id,beforeParId:previous.id,afterParId:following.id,text:trim(fresh.text),plainBody:fresh.kind==='Body'&&!/[\\$%_^{}&#~]/.test(trim(fresh.text))});
 }
 // A batch is one contiguous insertion gap in one captured layout. Source
 // anchors never become uncommitted/provisional units.
 if(units.some(unit=>unit.beforeParId!==units[0].beforeParId||unit.afterParId!==units[0].afterParId))return null;
 return{units,origins:verified.origins};
}
/** A pending insertion is always tied to one captured layout and one native view epoch. */
export class InsertionEvidence {
 private lineage:NativeSourceLineage;private current:string;private lastRevision:number;private batchSeen=false;private units=new Map<number,{text:string;sourceRevision:number}>();
 readonly path:string;readonly docId:string;private baseline:string;private spans:Span[];readonly versions:Versions;readonly requiredUnits:{parId:number;sourceRevision:number;path:string}[];readonly baselineSourceRevision:number;
 constructor(path:string,docId:string,baseline:string,spans:Span[],versions:Versions,requiredUnits:{parId:number;sourceRevision:number;path:string}[]=[],baselineSourceRevision=versions.source_revision){this.path=path;this.docId=docId;this.baseline=baseline;this.spans=spans;this.versions={...versions};this.requiredUnits=requiredUnits.map(v=>({...v}));this.baselineSourceRevision=baselineSourceRevision;this.current=baseline;this.lastRevision=baselineSourceRevision;this.lineage=new NativeSourceLineage(baseline);}
 append(before:string,after:string,proof:NativeProof,spans:Span[],sourceRevision=this.lastRevision+1){
  if(before!==this.current)throw Error('Insertion evidence source changed');
  if(!Number.isSafeInteger(sourceRevision)||sourceRevision<=this.lastRevision)throw Error('Insertion evidence revision differs');
  const verified=this.lineage.append(before,after,proof);const result=lineageUnits(this.baseline,after,this.spans,spans,verified,8);this.current=after;this.lastRevision=sourceRevision;if(!result)return null;
  const next=new Map<number,{text:string;sourceRevision:number}>();
  const insertions=result.units.map(unit=>{const old=this.units.get(unit.parId),revision=old?.text===unit.text?old.sourceRevision:sourceRevision;next.set(unit.parId,{text:unit.text,sourceRevision:revision});return{parId:unit.parId,beforeParId:unit.beforeParId,afterParId:unit.afterParId,sourceRevision:revision};});
  const removedParIds=[...this.units.keys()].filter(id=>!next.has(id));this.units=next;
  const current=insertions.filter(unit=>unit.sourceRevision===sourceRevision).at(-1)??insertions.at(-1)!;
  if(insertions.length>1)this.batchSeen=true;
  const plainBodyParIds=result.units.filter(unit=>unit.plainBody).map(unit=>unit.parId);
  const singleton={...(plainBodyParIds.length?{plainBodyParIds}:{}),parId:current.parId,beforeParId:current.beforeParId,afterParId:current.afterParId,origins:result.origins};
  // Keep the original singleton API. Once batched, even a one-unit remainder
  // carries the authoritative list and per-unit minimum source provenance.
  return this.batchSeen?{...singleton,insertions,insertionCount:insertions.length,removedParIds}:singleton;
 }
}
/** Admission proof for captured layouts. Engine source stamps can run ahead of
 * the actual page membership while an older background snapshot is finishing. */
export class InsertionCaptureGuard {
 private units=new Map<number,{born:number;material:number|null;removed:number|null}>();
 private pages=new Map<number,any>();private dirtyPages=new Set<number>();private sizes=new Map<number,number>();private accepted:Versions|null=null;private staged:Versions|null=null;private generation:number|null=null;
 private advance(generation:number){if(!Number.isSafeInteger(generation)||generation<0||this.generation!==null&&generation<this.generation)return false;if(this.generation===null||generation>this.generation){this.units.clear();this.pages.clear();this.dirtyPages.clear();this.sizes.clear();this.staged=null;this.generation=generation;}return true;}
 evidence(units:{parId:number;sourceRevision:number}[],generation=0){if(!this.advance(generation))return;for(const unit of units){if(!this.units.has(unit.parId))this.units.set(unit.parId,{born:unit.sourceRevision,material:null,removed:null});}if(this.units.size>20000)throw Error('Insertion capture membership budget exceeded');}
 removed(ids:number[],revision:number){for(const id of ids){const unit=this.units.get(id);if(unit&&unit.removed===null)unit.removed=revision;}}
 paragraph(event:any){if(!this.advance(event.versions?.engine_generation))return;const unit=this.units.get(event.par_id);if(!unit||event.status!=='ok'||!Number.isSafeInteger(event.versions?.source_revision))return;const dl=event.dl;const material=dl?.lines?.some((line:any)=>line.w>0&&line.h+line.d>0)||dl?.other?.some((item:any)=>['g','r','i'].includes(item?.[0]));if(material&&event.versions.source_revision>=unit.born)unit.material=Math.min(unit.material??Infinity,event.versions.source_revision);}
 admit(event:any){
  if(event.compile?.state==='Failed')return{accepted:true,event,missingParIds:[]};
  const v:Versions=event.versions;
  if(!this.advance(v.engine_generation))return{accepted:false,event:null,missingParIds:[],reason:'superseded-generation'};
  if(this.staged&&['source_revision','layout_version','context_revision'].some(key=>v[key as keyof Versions]<this.staged![key as keyof Versions]))return{accepted:false,event:null,missingParIds:[],reason:'superseded-staged-capture'};
  if(this.accepted&&(v.engine_generation<this.accepted.engine_generation||v.engine_generation===this.accepted.engine_generation&&(v.layout_version<this.accepted.layout_version||v.source_revision<this.accepted.source_revision)))return{accepted:false,event:null,missingParIds:[],reason:'superseded-capture'};
  this.staged={...v};
  for(const page of event.pages_changed??[]){this.pages.set(page.page,page);this.dirtyPages.add(page.page);this.sizes.set(page.page,new TextEncoder().encode(JSON.stringify(page)).length);}
  for(const page of this.pages.keys())if(page>event.pages_total){this.pages.delete(page);this.dirtyPages.delete(page);this.sizes.delete(page);}
  const present=new Set<number>((event.placements??[]).map((p:any)=>p.par_id)),missingParIds=[...this.units].filter(([id,u])=>u.born<=v.source_revision&&u.material!==null&&u.material<=v.source_revision&&(u.removed===null||u.removed>v.source_revision)&&!present.has(id)).map(([id])=>id);
  if(missingParIds.length)return{accepted:false,event:null,missingParIds,reason:'capture-missing-live-insertions'};
  this.accepted={...v};for(const [id,u]of this.units)if(u.removed!==null&&u.removed<=v.source_revision)this.units.delete(id);
  const changed=[...this.dirtyPages].sort((a,b)=>a-b).map(page=>this.pages.get(page));this.dirtyPages.clear();
  return{accepted:true,event:{...event,pages_changed:changed},missingParIds:[]};
 }
 stagedBytes(committed:Map<number,any>){let bytes=0;for(const [page,value]of this.pages)if(committed.get(page)!==value)bytes+=this.sizes.get(page)??0;return bytes;}
}
