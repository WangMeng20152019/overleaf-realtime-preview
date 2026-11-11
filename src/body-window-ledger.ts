import {verifyNativeProof,type NativeProof} from './native-edits.ts';
import type {Versions} from '../vendor/src/protocol';
type Span={id:number;kind:string;range:{start:number;end:number}};
type Unit={parId:number;sourceRevision:number;editId:number};
const keys=['source_revision','engine_generation','context_revision','layout_version'] as const;
const positive=(n:any)=>Number.isSafeInteger(n)&&n>0;
const byte=(s:string)=>new TextEncoder().encode(s).length;
function mapped(text:string,spans:Span[]){if(!Array.isArray(spans)||spans.length>20000)throw Error('Invalid span inventory');const needed=new Set(spans.flatMap(s=>[s.range?.start,s.range?.end])),positions=new Map<number,number>();let b=0;for(let i=0;i<=text.length;){if(needed.has(b))positions.set(b,i);if(i===text.length)break;const c=text.codePointAt(i)!;b+=c<128?1:c<2048?2:c<65536?3:4;i+=c>65535?2:1;}let end=0;const ids=new Set<number>();return spans.map(s=>{const from=positions.get(s.range?.start),to=positions.get(s.range?.end);if(!positive(s.id)||ids.has(s.id)||from===undefined||to===undefined||from<end||to<from)throw Error('Invalid exact span map');ids.add(s.id);end=to;return{...s,range:{...s.range},from,to,text:text.slice(from,to)};});}
/** One immutable captured Body plus its exact surrounding whitespace gap.
 * Source proof only: no coordinates, no source mutation, no PG fabrication.
 * removedParIds/windowRetiredParIds are scoped membership history, NOT engine
 * tombstones; a nonremoved ID can return to this window after outside retarget. */
export class CapturedBodyWindowLedger{
 readonly path:string;readonly docId:string;readonly versions:Versions;readonly replacedParIds:readonly number[];readonly beforeParId:number;readonly afterParId:number;
 private baseline:string;private current:string;private initial:ReturnType<typeof mapped>;private spans:ReturnType<typeof mapped>;private from:number;private end:number;private prefix:string;private suffix:string;private revision:number;private epoch:string|null=null;private transaction:number|null=null;private records=0;private proofBytes=0;private live=true;private units=new Map<number,Unit>();private removed=new Set<number>();private engineRemoved=new Set<number>();
 constructor(path:string,docId:string,text:string,spans:Span[],versions:Versions,parId:number|readonly number[]){
  if(keys.some(k=>!Number.isSafeInteger(versions?.[k])||versions[k]<0))throw Error('Genuine captured versions required');this.initial=mapped(text,spans);const ids:number[]=typeof parId==='number'?[parId]:Array.isArray(parId)?[...parId]:[];if(!ids.length||ids.length>8||ids.some(id=>!positive(id))||new Set(ids).size!==ids.length)throw Error('Bounded ordered captured Body IDs required');const i=this.initial.findIndex(s=>s.id===ids[0]),members=this.initial.slice(i,i+ids.length),before=this.initial[i-1],after=this.initial[i+ids.length];if(i<0||members.length!==ids.length||members.some((s,n)=>s.id!==ids[n]||s.kind!=='Body'||!s.text.trim())||!before||!after||!['Body','Heading','Env'].includes(before.kind)||!['Body','Heading','Env'].includes(after.kind))throw Error('Consecutive captured Body members required');let gap=before.to;for(const member of members){if(!/^[ \t\r\n]*$/.test(text.slice(gap,member.from)))throw Error('Unowned captured boundary material');gap=member.to;}if(!/^[ \t\r\n]*$/.test(text.slice(gap,after.from)))throw Error('Unowned captured boundary material');
  this.path=path;this.docId=docId;this.versions={...versions};this.replacedParIds=Object.freeze(ids);this.beforeParId=before.id;this.afterParId=after.id;this.baseline=text;this.current=text;this.spans=this.initial;this.from=before.to;this.end=after.from;this.prefix=text.slice(0,this.from);this.suffix=text.slice(this.end);this.revision=versions.source_revision;if(byte(text.slice(this.from,this.end))>65536)throw Error('Captured window budget');
  for(const id of ids)this.units.set(id,{parId:id,sourceRevision:versions.source_revision,editId:0});
 }
 matchesLayout(v:any){return this.live&&keys.every(k=>v?.[k]===this.versions[k]);}
 append(input:{path:string;docId:string;before:string;after:string;afterSpans:Span[];proof:NativeProof;result:any}){
  const retire=()=>{this.live=false;this.units.clear();return null;};if(!this.live)return null;
  try{const {before,after,proof,result}=input;if(input.path!==this.path||input.docId!==this.docId||before!==this.current||!positive(result?.source_revision)||result.source_revision<=this.revision||!positive(result.edit_id)||this.epoch!==null&&(proof.viewEpoch!==this.epoch||proof.baseTransactionId!==this.transaction))return retire();const verified=verifyNativeProof(before,after,proof);if(verified.origins.length!==1||verified.origins[0]!=='local'||proof.records.some(r=>!r.changes.length||!['none','committed'].includes(r.composition?.phase)))return retire();
   const bytes=JSON.stringify(proof.records).length;if(this.records+proof.records.length>256||this.proofBytes+bytes>1500000)return retire();let end=this.end;for(const r of proof.records){if(r.changes.some(c=>c.fromA<this.from||c.toA>end))return retire();end+=r.changes.reduce((n,c)=>n+c.inserted.length-(c.toA-c.fromA),0);}
   if(after.slice(0,this.from)!==this.prefix||after.slice(end)!==this.suffix||byte(after.slice(this.from,end))>65536)return retire();
   const next=mapped(after,input.afterSpans);
   const outside=(rows:typeof next,windowEnd:number)=>rows.filter(s=>s.to<=this.from||s.from>=windowEnd);
   const descriptor=(s:typeof next[number],windowEnd:number)=>[s.kind,s.text,s.to<=this.from?s.from:s.from-windowEnd,s.to<=this.from?s.to:s.to-windowEnd];
   const capturedOutside=outside(this.initial,this.baseline.length-this.suffix.length),currentOutside=outside(next,end);if(capturedOutside.length!==currentOutside.length||capturedOutside.some((s,i)=>JSON.stringify(descriptor(s,this.baseline.length-this.suffix.length))!==JSON.stringify(descriptor(currentOutside[i],end))))return retire();
   const outsideAliases=capturedOutside.flatMap((s,i)=>s.id===currentOutside[i].id?[]:[{capturedParId:s.id,currentParId:currentOutside[i].id}]);if(outsideAliases.length>8)return retire();
   const capturedBefore=this.initial.find(s=>s.id===this.beforeParId)!,capturedAfter=this.initial.find(s=>s.id===this.afterParId)!;
   const beforeAnchor=currentOutside.find(s=>s.to===this.from&&s.kind===capturedBefore.kind&&s.text===capturedBefore.text),afterAnchor=currentOutside.find(s=>s.from===end&&s.kind===capturedAfter.kind&&s.text===capturedAfter.text);if(!beforeAnchor||!afterAnchor)return retire();
   const window=next.filter(s=>s.from>=this.from&&s.to<=end&&s.id!==beforeAnchor.id&&s.id!==afterAnchor.id);let cursor=this.from;for(const s of window){if(!/^[ \t\r\n]*$/.test(after.slice(cursor,s.from)))return retire();cursor=s.to;}if(!/^[ \t\r\n]*$/.test(after.slice(cursor,end)))return retire();if(window.length>4||window.some(s=>s.kind!=='Body'||!s.text.trim())||next.some(s=>s.from<this.from&&s.to>this.from||s.from<end&&s.to>end))return retire();
   const outcome=result.outcome;if(!outcome||outcome.preamble_changed!==false||!['fast','background'].includes(result.routed)||!['added','removed','touched'].every(k=>Array.isArray(outcome[k])&&new Set(outcome[k]).size===outcome[k].length&&outcome[k].every(positive)))return retire();
   const previousById=new Map(this.spans.map(s=>[s.id,s]));const old=this.spans.filter(s=>s.from>=this.from&&s.to<=this.end),oldIds=new Set(this.spans.map(s=>s.id)),newIds=new Set(next.map(s=>s.id)),windowIds=new Set(window.map(s=>s.id)),sameSet=(a:number[],b:number[])=>a.length===b.length&&a.every(id=>b.includes(id));
   if(!sameSet(outcome.added,next.filter(s=>!oldIds.has(s.id)).map(s=>s.id))||!sameSet(outcome.removed,this.spans.filter(s=>!newIds.has(s.id)).map(s=>s.id))||outcome.touched.some((id:number)=>!oldIds.has(id)||!newIds.has(id))||outcome.added.some((id:number)=>this.engineRemoved.has(id)))return retire();
   for(const s of next){const previous=previousById.get(s.id);if((!previous||previous.text!==s.text||previous.kind!==s.kind)&&!outcome.added.includes(s.id)&&!outcome.touched.includes(s.id))return retire();}
   for(const id of outcome.removed)this.engineRemoved.add(id);
   for(const s of old)if(!windowIds.has(s.id)){this.removed.add(s.id);this.units.delete(s.id);}
   for(const s of window){const previous=old.find(p=>p.id===s.id),changed=!previous||previous.text!==s.text;if(changed||outcome.touched.includes(s.id))this.units.set(s.id,{parId:s.id,sourceRevision:result.source_revision,editId:result.edit_id});}
   this.current=after;this.spans=next;this.end=end;this.revision=result.source_revision;this.epoch=proof.viewEpoch;this.transaction=proof.transactionId;this.records+=proof.records.length;this.proofBytes+=bytes;
   const changedIds=new Set<number>([...outcome.added,...outcome.touched]),last=proof.records.at(-1)!.changes.at(-1)!;const caret=last.toB;
   let selected=window.find(s=>changedIds.has(s.id)&&s.from<=caret&&caret<=s.to);
   if(!selected)selected=[...window].reverse().find(s=>changedIds.has(s.id)&&s.to<=caret&&s.to>=last.fromB&&/^[ \t\r\n]*$/.test(after.slice(s.to,caret)));
   const target=selected?.id??null;
   return{verified:true as const,state:'ready' as const,kind:'body-window-replacement' as const,baseVersions:{...this.versions},replacedParIds:[...this.replacedParIds],beforeParId:this.beforeParId,afterParId:this.afterParId,units:window.map(s=>({...this.units.get(s.id)!})),plainBodyParIds:window.filter(s=>!/[\\$%_^{}&#~]/.test(s.text)).map(s=>s.id),removedParIds:[...this.removed],windowRetiredParIds:[...this.removed],outsideAliases,sourceRevision:result.source_revision,editId:result.edit_id,currentEditParId:target,parId:target,viewEpoch:proof.viewEpoch,transactionId:proof.transactionId};
  }catch{return retire();}
 }
}
