/** Call only with evidence already validated against exact before/after source.
 * One native transaction/change is expressed in the acknowledged before frame.
 * Multi-step changes use different frames and must retain the wire envelope. */
export function capturedEditCoordinates(wireStart:number,wireEnd:number,verifiedNativeProof?:{records?:{changes?:{fromA:number;toA:number}[]}[]}){
 const records=verifiedNativeProof?.records,change=records?.length===1&&records[0].changes?.length===1?records[0].changes[0]:null;
 return change?{start:change.fromA,end:change.toA,coordinateSource:'native-single-change' as const}:{start:wireStart,end:wireEnd,coordinateSource:'wire-envelope' as const};
}
type Span={id:number;kind:string;range:{start:number;end:number}};
export function describeSourceUnits(spans:Span[]|null|undefined,selectedIds:readonly number[]){if(!Array.isArray(spans))return null;const selected=new Set(selectedIds);return spans.map((s,sourceOrder)=>({s,sourceOrder})).filter(({s})=>selected.has(s.id)).slice(0,16).map(({s,sourceOrder})=>({id:s.id,kind:['Body','Heading','Env','Preamble','Trailer'].includes(s.kind)?s.kind:'other',sourceOrder,bytes:s.range.end-s.range.start}));}
/** Privacy-bounded source classification. Input coordinates are verified native
 * UTF-16 coordinates, never OT offsets; no source text is returned or stored. */
export function classifyCapturedEdit(input:{before:string;start:number;end:number;spans:Span[]|null;placements:any[];outcome:any;routed:unknown}){
 const {before,start,end,spans,placements,outcome}=input;
 const ids=(value:any)=>Array.isArray(value)?value.filter((n:any)=>Number.isSafeInteger(n)&&n>0):[];
 const added=ids(outcome?.added),removed=ids(outcome?.removed),touched=ids(outcome?.touched);
 const summary:any={routed:['fast','background'].includes(String(input.routed))?input.routed:'other',addedCount:added.length,removedCount:removed.length,touchedCount:touched.length,addedIds:added.slice(0,16),removedIds:removed.slice(0,16),touchedIds:touched.slice(0,16),preambleChanged:outcome?.preamble_changed===true,sourceMapAvailable:Array.isArray(spans),engineAffectedOldUnits:describeSourceUnits(spans,[...removed,...touched]),capturedUnits:[],sourceContiguous:null,allBody:null,capturedPages:[],geometryScope:'unknown',reasonCode:'source-map-unavailable'};
 const result=(bodyWindowIds:number[]=[])=>({bodyWindowIds,summary});
 if(!Array.isArray(spans))return result();
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>before.length||[start,end].some(n=>n>0&&n<before.length&&/[\uD800-\uDBFF]/.test(before[n-1])&&/[\uDC00-\uDFFF]/.test(before[n]))){summary.reasonCode='invalid-edit-coordinate';return result();}
 const from=Buffer.byteLength(before.slice(0,start)),to=Buffer.byteLength(before.slice(0,end));
 let affected=spans.map((span,order)=>({span,order})).filter(({span:s})=>from===to?s.range.start<=from&&from<s.range.end:s.range.start<to&&s.range.end>from);
 // Parser spans may own leading/trailing paragraph separators. A range that
 // overlaps only that ASCII whitespace does not replace the adjacent Body's
 // material. The source ledger still proves all boundary edits and outside bytes.
 if(from!==to&&affected.length){const bytes=Buffer.from(before),material=affected.filter(({span:s})=>{const overlap=bytes.subarray(Math.max(from,s.range.start),Math.min(to,s.range.end));return overlap.some(byte=>![9,10,11,12,13,32].includes(byte));});if(material.length)affected=material;}
 // A separator-only edit can retire neighbouring IDs without intersecting ink.
 // The final native window proof still checks every intermediate source change.
 if(!affected.length){const changed=new Set([...removed,...touched]);affected=spans.map((span,order)=>({span,order})).filter(({span})=>changed.has(span.id));}
 summary.capturedUnitCount=affected.length;summary.capturedUnits=affected.slice(0,16).map(({span:s,order})=>({id:s.id,kind:['Body','Heading','Env','Preamble','Trailer'].includes(s.kind)?s.kind:'other',sourceOrder:order,bytes:s.range.end-s.range.start,pages:[...new Set((placements.find(p=>p.par_id===s.id)?.fragments??[]).map((f:any)=>f.page).filter((p:any)=>Number.isSafeInteger(p)&&p>0))].sort((a:any,b:any)=>a-b).slice(0,8)}));
 summary.truncated=affected.length>16||Math.max(added.length,removed.length,touched.length)>16;
 summary.sourceContiguous=affected.length>0&&affected.every((a,i)=>!i||a.order===affected[i-1].order+1);summary.allBody=affected.length>0&&affected.every(({span})=>span.kind==='Body');summary.capturedPages=[...new Set(summary.capturedUnits.flatMap((u:any)=>u.pages))].sort((a:any,b:any)=>a-b).slice(0,8);summary.geometryScope=summary.capturedPages.length===1?'single-page':summary.capturedPages.length>1?'multi-page':'unplaced';
 if(!affected.length){summary.reasonCode='no-captured-material';return result();}
 if(!summary.allBody){summary.reasonCode='captured-non-body';return result();}
 if(!summary.sourceContiguous){summary.reasonCode='captured-non-contiguous';return result();}
 if(affected.length>8){summary.reasonCode='captured-window-too-large';return result();}
 summary.reasonCode='body-window-candidate';return result(affected.map(({span})=>span.id));
}
