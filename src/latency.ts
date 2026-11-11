/** Pair acknowledged edit revisions with actual visible canvas commits, never engine completion alone. */
export class LatencyTracker {
 private timings=new Map<number,any>();private paints=new Map<number,any[]>();private delivered=new Set<number>();private inputFloor=-Infinity;
 private report:(metric:any)=>void;constructor(report:(metric:any)=>void){this.report=report;}
 timing(value:any){if(value.inputAt<this.inputFloor)return;const input={...value};if(!Number.isFinite(input.mathReadyAt)||input.mathReadyAt<input.inputAt||input.mathReadyAt>input.sentAt)delete input.mathReadyAt;this.timings.set(input.sourceRevision,input);this.finish(input.sourceRevision);this.trim();}
 paint(sourceRevision:number,engineMs:number,paintAt:number,stage:any={}){this.record(sourceRevision,{paintAt,engineMs,...stage,kind:'paragraph'});}
 insertionPaint(sourceRevision:number,engineMs:number,paintAt:number,details:any){if(details.visible!==true)return;this.record(sourceRevision,{...details,engineMs,paintAt,kind:'insertion'});}
 layoutPaint(sourceRevision:number,paintAt:number,details:any){if(details.visible!==true)return;this.record(sourceRevision,{...details,paintAt,kind:'layout'});}
 deletionPaint(sourceRevision:number,paintAt:number,details:any){if(details.visible!==true)return;this.record(sourceRevision,{...details,paintAt,kind:'deletion'});}
 invalidateBefore(inputAt:number){this.inputFloor=Math.max(this.inputFloor,inputAt);for(const [revision,value]of this.timings)if(value.inputAt<this.inputFloor)this.timings.delete(revision);this.paints.clear();}
 private record(revision:number,paint:any){const candidates=this.paints.get(revision)??[];if(!candidates.some(old=>old.kind===paint.kind&&old.parId===paint.parId&&old.page===paint.page))candidates.push(paint);while(candidates.length>16)candidates.shift();this.paints.set(revision,candidates);this.finish(revision);this.trim();}
 private finish(revision:number){const input=this.timings.get(revision);if(!input||this.delivered.has(revision))return;const ids=input.affectedParIds;const paint=this.paints.get(revision)?.find(value=>{
  if(value.paintAt<input.inputAt)return false;
  if(value.kind==='layout')return Array.isArray(ids)&&ids.length===1&&value.parIds?.includes(ids[0]);
  return !Array.isArray(ids)||!ids.length||ids.includes(value.parId);
 });if(!paint)return;this.delivered.add(revision);this.report({...input,...paint,...(Number.isFinite(input.mathReadyAt)&&paint.paintAt>=input.mathReadyAt?{mathConstructionMs:input.mathReadyAt-input.inputAt,mathReadyToPaintMs:paint.paintAt-input.mathReadyAt}:{}),totalMs:paint.paintAt-input.inputAt,queueMs:input.sentAt-input.inputAt,ackMs:input.ackAt-input.sentAt,...(Number.isFinite(paint.eventReceivedAt)?{deliveryAfterAckMs:paint.eventReceivedAt-input.ackAt,eventToPaintMs:paint.paintAt-paint.eventReceivedAt,hydrateMs:paint.hydratedAt-paint.eventReceivedAt,applyToPaintMs:paint.paintAt-paint.appliedAt}:{})});}
 private trim(){for(const map of [this.timings,this.paints])while(map.size>96)map.delete(map.keys().next().value!);while(this.delivered.size>96)this.delivered.delete(this.delivered.values().next().value!);}
}
