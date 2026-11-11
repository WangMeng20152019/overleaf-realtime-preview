/** Native CM evidence describes editor text; it never supplies raw ShareJS/OT offsets. */
type Origin='local'|'remote'|'undo'|'redo'|'reject';
type Change={fromA:number;toA:number;fromB:number;toB:number;inserted:string;removed:string};
type Step={transactionId:number;beforeLength:number;afterLength:number;origin:Origin;changes:Change[];composition:{id:number|null;phase:string}};
export type NativeProof={version:1;coordinateSpace:'codemirror-utf16';viewEpoch:string;baseTransactionId:number;transactionId:number;records:Step[]};
type Piece={start:number;end:number}|{text:string};
const origins=new Set(['local','remote','undo','redo','reject']);
const integer=(n:any)=>Number.isSafeInteger(n)&&n>=0;
function validText(s:any):s is string{if(typeof s!=='string')return false;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const d=s.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;}
function boundary(s:string,n:number){return !(n>0&&n<s.length&&s.charCodeAt(n-1)>=0xd800&&s.charCodeAt(n-1)<=0xdbff&&s.charCodeAt(n)>=0xdc00&&s.charCodeAt(n)<=0xdfff);}
const length=(p:Piece)=>'text'in p?p.text.length:p.end-p.start;
function cut(pieces:Piece[],at:number):number{let offset=0;for(let i=0;i<pieces.length;i++){const p=pieces[i],size=length(p);if(at===offset)return i;if(at<offset+size){const n=at-offset,left='text'in p?{text:p.text.slice(0,n)}:{start:p.start,end:p.start+n},right='text'in p?{text:p.text.slice(n)}:{start:p.start+n,end:p.end};pieces.splice(i,1,left,right);return i+1;}offset+=size;}if(at===offset)return pieces.length;throw Error('Native change outside source');}
function replace(pieces:Piece[],from:number,to:number,text:string){const first=cut(pieces,from),last=cut(pieces,to);pieces.splice(first,last-first,...(text?[{text}]:[]));}
function insertedOnly(pieces:Piece[],baselineLength:number){const result:{at:number;text:string}[]=[];let next=0;for(const piece of pieces){if('text'in piece){const last=result.at(-1);if(last?.at===next)last.text+=piece.text;else if(piece.text)result.push({at:next,text:piece.text});}else{if(piece.start!==next)return null;next=piece.end;}}return next===baselineLength?result:null;}
function validate(base:string,proof:NativeProof){
 if(!validText(base)||proof?.version!==1||proof.coordinateSpace!=='codemirror-utf16'||typeof proof.viewEpoch!=='string'||!/^rtex-view-\d+$/.test(proof.viewEpoch)||!integer(proof.baseTransactionId)||!integer(proof.transactionId)||!Array.isArray(proof.records)||proof.records.length>256)throw Error('Invalid native evidence');
 let text=base,last=proof.baseTransactionId,units=0;const pieces:Piece[]=base?[{start:0,end:base.length}]:[];
 for(const record of proof.records){
  if(record.transactionId!==++last||record.beforeLength!==text.length||!integer(record.afterLength)||!origins.has(record.origin)||!Array.isArray(record.changes)||record.changes.length>4096||!record.composition||!['none','intermediate','committed'].includes(record.composition.phase)||!(record.composition.id===null||Number.isSafeInteger(record.composition.id)&&record.composition.id>0))throw Error('Native transaction chain differs');
  let previous=0,delta=0;
  for(const c of record.changes){
   if(![c.fromA,c.toA,c.fromB,c.toB].every(integer)||c.fromA<previous||c.toA<c.fromA||c.toA>text.length||!boundary(text,c.fromA)||!boundary(text,c.toA)||!validText(c.inserted)||typeof c.removed!=='string'||text.slice(c.fromA,c.toA)!==c.removed||c.fromB!==c.fromA+delta||c.toB!==c.fromB+c.inserted.length)throw Error('Native change coordinates differ');
   units+=c.inserted.length+c.removed.length;if(units>2*1024*1024)throw Error('Native evidence exceeds text budget');previous=c.toA;delta+=c.inserted.length-(c.toA-c.fromA);
  }
  for(const c of [...record.changes].reverse()){replace(pieces,c.fromA,c.toA,c.inserted);text=text.slice(0,c.fromA)+c.inserted+text.slice(c.toA);}
  if(text.length!==record.afterLength)throw Error('Native source length differs');
 }
 if(last!==proof.transactionId)throw Error('Native transaction endpoint differs');
 return {text,pureInsertions:insertedOnly(pieces,base.length),origins:[...new Set(proof.records.map(r=>r.origin))]};
}
/** Verify against the exact acknowledged source and expected resulting source before using placement hints. */
export function verifyNativeProof(before:string,after:string,proof:NativeProof){const result=validate(before,proof);if(result.text!==after)throw Error('Native evidence does not match source');return {pureInsertions:result.pureInsertions,origins:result.origins};}
/** Strip repeated full snapshots from native events; preserve each exact transaction and mixed origin. */
export function nativeProof(before:string,viewEpoch:string,baseTransactionId:number,records:any[]):NativeProof{
 let text=before;const steps:Step[]=[];
 for(const r of records){if(r.before!==text||typeof r.after!=='string')throw Error('Native snapshot chain differs');steps.push({transactionId:r.transactionId,beforeLength:r.before.length,afterLength:r.after.length,origin:r.origin,changes:r.changes.map((c:Change)=>({...c})),composition:{...r.composition}});text=r.after;}
 const proof:NativeProof={version:1,coordinateSpace:'codemirror-utf16',viewEpoch,baseTransactionId,transactionId:steps.at(-1)?.transactionId??baseTransactionId,records:steps};verifyNativeProof(before,text,proof);return proof;
}
/** Incremental lineage across acknowledgments; never replays an ever-growing edit history. */
export class NativeSourceLineage {
 private pieces:Piece[];private current:string;private epoch:string|null=null;private transactionId:number|null=null;private seen=new Set<Origin>();private baselineLength:number;
 constructor(baseline:string){if(!validText(baseline))throw Error('Invalid native baseline');this.current=baseline;this.baselineLength=baseline.length;this.pieces=baseline?[{start:0,end:baseline.length}]:[];}
 append(before:string,after:string,proof:NativeProof){
  if(before!==this.current||this.epoch!==null&&(proof.viewEpoch!==this.epoch||proof.baseTransactionId!==this.transactionId))throw Error('Native lineage endpoint differs');verifyNativeProof(before,after,proof);
  const candidate=this.pieces.map(piece=>({...piece}));for(const step of proof.records){for(const c of [...step.changes].reverse())replace(candidate,c.fromA,c.toA,c.inserted);}
  const merged:Piece[]=[];for(const piece of candidate){if(!length(piece))continue;const last=merged.at(-1);if(last&&'text'in last&&'text'in piece)last.text+=piece.text;else if(last&&'start'in last&&'start'in piece&&last.end===piece.start)last.end=piece.end;else merged.push(piece);}
  if(merged.length>4096)throw Error('Native lineage exceeds piece budget');this.pieces=merged;this.current=after;this.epoch=proof.viewEpoch;this.transactionId=proof.transactionId;for(const step of proof.records)this.seen.add(step.origin);
  return {pureInsertions:insertedOnly(this.pieces,this.baselineLength),origins:[...this.seen]};
 }
}
