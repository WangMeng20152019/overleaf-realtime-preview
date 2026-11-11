/** Stable page geometry with only visible/nearby page bitmaps resident. */
const canvasRatio=(canvas:any)=>Number.isFinite(canvas?.width)&&canvas.width>0&&Number.isFinite(canvas?.height)&&canvas.height>0?`${canvas.width} / ${canvas.height}`:null;
export interface PageSize {page:number;width:number;height:number}
interface PageEntry {element:HTMLDivElement;version:number;painted:number;canvas?:HTMLCanvasElement;failedVersion?:number;failedEpoch?:number}
export function visiblePageNumbers(boxes:{page:number;top:number;bottom:number}[],top:number,bottom:number,overscan=600){
 return boxes.filter(b=>b.bottom>=top-overscan&&b.top<=bottom+overscan).map(b=>b.page);
}
export function prioritizedPageNumbers(boxes:{page:number;top:number;bottom:number}[],top:number,bottom:number,overscan=600){
 const center=(top+bottom)/2;
 return boxes.filter(b=>b.bottom>=top-overscan&&b.top<=bottom+overscan).sort((a,b)=>{
  const aVisible=a.bottom>top&&a.top<bottom,bVisible=b.bottom>top&&b.top<bottom;
  return Number(bVisible)-Number(aVisible)||Math.abs((a.top+a.bottom)/2-center)-Math.abs((b.top+b.bottom)/2-center)||a.page-b.page;
 }).map(b=>b.page);
}
export interface PaintTiming {startedAt:number;committedAt:number}
interface ViewportOptions {overscan?:number;onError?:(error:unknown)=>void;onPaint?:(page:number,timing:PaintTiming)=>void}
export class PageViewport {
 private container:HTMLElement;private renderPage:(page:number)=>Promise<HTMLCanvasElement>;private options:ViewportOptions;
 private entries=new Map<number,PageEntry>();private scheduled:number|null=null;private inFlight=new Map<PageEntry,object>();private retryEpoch=0;private priority:number|null=null;private warmTarget:number|null=null;private disposed=false;private frozen=false;private resize?:ResizeObserver;
 private scroll=()=>this.schedule();
 constructor(container:HTMLElement,renderPage:(page:number)=>Promise<HTMLCanvasElement>,options:ViewportOptions={}){
  this.container=container;this.renderPage=renderPage;this.options=options;
  container.addEventListener('scroll',this.scroll,{passive:true});
  if(typeof ResizeObserver!=='undefined'){this.resize=new ResizeObserver(()=>{this.schedule();});this.resize.observe(container);}
 }
 sync(pages:PageSize[]){
  if(this.disposed||this.frozen)return;
  const wanted=new Set(pages.map(p=>p.page));
  for(const [n,entry]of this.entries)if(!wanted.has(n)){entry.element.remove();if(entry.canvas)entry.canvas.width=entry.canvas.height=0;this.entries.delete(n);}
  let previous:HTMLElement|null=null;
  for(const p of [...pages].sort((a,b)=>a.page-b.page)){
   if(!Number.isFinite(p.width)||!Number.isFinite(p.height)||p.width<=0||p.height<=0)continue;
   let entry=this.entries.get(p.page);
   if(!entry){const element=document.createElement('div');element.dataset.page=String(p.page);element.className='rtex-page';entry={element,version:1,painted:0};this.entries.set(p.page,entry);}
   const style=entry.element.style;
   style.width=`min(100%, ${p.width}px)`;style.aspectRatio=canvasRatio(entry.canvas)??`${p.width} / ${p.height}`;style.position='relative';style.margin='0 auto 20px';style.background='white';style.boxShadow='0 1px 8px #999';style.overflow='hidden';
   if(entry.element.previousElementSibling!==previous||entry.element.parentElement!==this.container)this.container.insertBefore(entry.element,previous?previous.nextElementSibling:this.container.firstChild);
   previous=entry.element;
  }
  this.schedule();
 }
 invalidate(pages?:Iterable<number>){if(this.disposed||this.frozen)return;for(const n of pages??this.entries.keys()){const entry=this.entries.get(n);if(entry)entry.version++;}this.schedule();}
 pageElement(page:number){return this.entries.get(page)?.element??null;}
 ensurePage(page:number){if(!this.disposed&&!this.frozen&&this.entries.has(page))this.priority=page;this.schedule();return this.pageElement(page);}
 preparePage(page:number){if(!this.disposed&&!this.frozen&&this.entries.has(page)){this.warmTarget=page;this.priority=page;this.schedule();}return this.pageElement(page);}
 clearPriority(){this.priority=null;this.warmTarget=null;this.schedule();}
 private visible(){
  if(this.container.clientWidth<=0||this.container.clientHeight<=0)return new Set<number>();
  const root=this.container.getBoundingClientRect();
  const boxes=[...this.entries].map(([page,e])=>{const b=e.element.getBoundingClientRect();return{page,top:b.top,bottom:b.bottom};});
  const order=prioritizedPageNumbers(boxes,root.top,root.bottom,this.options.overscan??600),target=boxes.find(box=>box.page===this.priority&&box.bottom>root.top&&box.top<root.bottom);
  if(target){const index=order.indexOf(target.page);if(index>=0){order.splice(index,1);order.unshift(target.page);}}
  if(this.warmTarget!==null&&this.entries.has(this.warmTarget)){const index=order.indexOf(this.warmTarget);if(index>=0)order.splice(index,1);order.unshift(this.warmTarget);}
  return new Set(order);
 }
 private schedule(retryErrors=true){
  if(this.disposed||this.frozen)return;if(retryErrors)this.retryEpoch++;
  if(this.scheduled!==null)return;
  this.scheduled=requestAnimationFrame(()=>{this.scheduled=null;this.paint();});
 }
 private paint(){
  if(this.disposed||this.frozen)return;
  const visible=this.visible();
  for(const [n,entry]of this.entries)if(!visible.has(n)&&entry.canvas){entry.canvas.remove();entry.canvas.width=entry.canvas.height=0;entry.canvas=undefined;entry.painted=0;}
  // A slow PDF page occupies one lane, never the whole viewport. Recompute
  // visibility and explicit priority before assigning each bounded lane.
  while(this.inFlight.size<2){
   const next=[...this.visible()].map(n=>({n,entry:this.entries.get(n)})).find(({entry})=>entry&&entry.painted!==entry.version&&!this.inFlight.has(entry)&&!(entry.failedVersion===entry.version&&entry.failedEpoch===this.retryEpoch));
   if(!next?.entry)break;const {n,entry}=next,version=entry.version,epoch=this.retryEpoch,job={};
   this.inFlight.set(entry,job);const startedAt=performance.now();
   void(async()=>{
    let canvas:HTMLCanvasElement;
    try{canvas=await this.renderPage(n);}catch(error){
     if(!this.disposed&&!this.frozen&&this.entries.get(n)===entry&&entry.version===version&&this.visible().has(n)){entry.failedVersion=version;entry.failedEpoch=epoch;if(this.warmTarget===n&&!['KEEP_LAST_FRAME','STALE_PDF_BASE'].includes(error instanceof Error?error.message:''))this.warmTarget=null;this.options.onError?.(error);}return;
    }
    if(this.disposed||this.frozen||this.entries.get(n)!==entry||entry.version!==version||!this.visible().has(n)){canvas.width=canvas.height=0;return;}
    canvas.dataset.page=String(n);canvas.style.cssText='display:block;position:absolute;inset:0;width:100%;height:100%;max-width:none;margin:0;box-shadow:none';
    const ratio=canvasRatio(canvas);if(ratio)entry.element.style.aspectRatio=ratio;const old=entry.canvas;entry.element.replaceChildren(canvas);entry.canvas=canvas;entry.painted=version;entry.failedVersion=entry.failedEpoch=undefined;if(old){old.width=old.height=0;}
    if(this.warmTarget===n)this.warmTarget=null;
    this.options.onPaint?.(n,{startedAt,committedAt:performance.now()});
   })().finally(()=>{if(this.inFlight.get(entry)===job)this.inFlight.delete(entry);this.schedule(false);}).catch(error=>{if(!this.disposed&&!this.frozen)this.options.onError?.(error);});
  }
 }
 freeze(){if(this.disposed||this.frozen)return;this.frozen=true;this.priority=null;this.warmTarget=null;if(this.scheduled!==null){cancelAnimationFrame(this.scheduled);this.scheduled=null;}this.container.removeEventListener('scroll',this.scroll);this.resize?.disconnect();}
 reset(){if(this.frozen&&!this.disposed)return;for(const entry of this.entries.values()){entry.element.remove();if(entry.canvas)entry.canvas.width=entry.canvas.height=0;}this.entries.clear();if(this.scheduled!==null){cancelAnimationFrame(this.scheduled);this.scheduled=null;}this.priority=null;this.warmTarget=null;}
 dispose(){if(this.disposed)return;this.disposed=true;this.container.removeEventListener('scroll',this.scroll);this.resize?.disconnect();this.reset();}
}
