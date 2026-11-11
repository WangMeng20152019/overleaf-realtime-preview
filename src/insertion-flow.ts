import type {BoundedOtherGlyph} from './glyph-bounds';
import type {DisplayList,Line,Versions} from '../vendor/src/protocol';

// This is an internal geometric checker, not a validator for browser-supplied
// evidence. The caller must construct lineage from authenticated server-side
// native-proof/span verification, and resolve owned rows from this exact layout.
export type FlowAnchor={parId:number;page:number;lineIndices:readonly number[]};
export type FlowLineage={verified:true;state:'ready';kind:'pure-insertion';baseVersions:Versions;sourceRevision:number;insertedParId:number;insertionCount:1;split:false;before:FlowAnchor;after:FlowAnchor};
export type InsertionFlowInput={page:DisplayList;pageNumber:number;baseVersions:Versions;lineage:FlowLineage;insert:DisplayList;insertVersions:Versions;insertDrawable:true;existingOverlayParIds:readonly number[];renderScale:number;boundedOtherGlyphs?:readonly BoundedOtherGlyph[];pageEnd?:{afterPage:DisplayList;otherSourceLineIndices:readonly number[]};minimumFirstBaseline?:number};
type Rect={x0:number;y0:number;x1:number;y1:number;owner:number|null};
type RowHorizontal={x0:number;x1:number;owner:number};
export type InsertionFlowPlan={ok:true;provisional:true;page:number;parId:number;baseVersions:Versions;sourceRevision:number;cutY:number;insertHeight:number;translation:{dx:number;dy:number};pixels:{width:number;baseHeight:number;height:number;cutY:number;insertHeight:number};projection:{cutY:number;insertHeight:number;baseHeight:number;expandedHeight:number}};
export type InsertionFlowResult=InsertionFlowPlan|{ok:false;reason:string};
const PAD=32768; // half a TeX point; captured line boxes bound glyph material.
const versionKeys=['source_revision','engine_generation','context_revision','layout_version'] as const;
const safe=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1e12;
const id=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
const validVersion=(v:any):v is Versions=>v&&versionKeys.every(k=>Number.isSafeInteger(v[k])&&v[k]>=0);
const sameVersion=(a:Versions,b:Versions)=>versionKeys.every(k=>a[k]===b[k]);
const flagged=(value:unknown)=>value!=null&&(typeof value!=='object'?Boolean(value):Object.keys(value).length>0);
const refuse=(reason:string):InsertionFlowResult=>({ok:false,reason});
function bounds(rects:Rect[]){const b={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};for(const r of rects){b.x0=Math.min(b.x0,r.x0);b.y0=Math.min(b.y0,r.y0);b.x1=Math.max(b.x1,r.x1);b.y1=Math.max(b.y1,r.y1);}return b;}
function material(dl:DisplayList,scale:number,insert=false,certified:readonly BoundedOtherGlyph[]=[]):{rects:Rect[];text:Rect[];horizontal:RowHorizontal[]}|string{
 if(!dl||!Array.isArray(dl.lines)||dl.lines.length>(insert?128:512)||!Array.isArray(dl.other??[]))return 'Material complexity exceeds trial scope';
 if(flagged(dl.flags)||Number(dl.inserts??0)>0)return 'Unbounded flags or page-builder inserts are unsupported';
 const evidence=new Map<number,BoundedOtherGlyph>();for(const e of certified){if(!e||!Number.isSafeInteger(e.itemIndex)||e.itemIndex<0||e.itemIndex>=dl.other.length||evidence.has(e.itemIndex)||dl.other[e.itemIndex]?.[0]!=='g'||!Array.isArray(e.item)||JSON.stringify(e.item)!==JSON.stringify(dl.other[e.itemIndex])||!e.rect||![e.rect.x0,e.rect.y0,e.rect.x1,e.rect.y1].every(safe)||e.rect.x1<e.rect.x0||e.rect.y1<e.rect.y0)return 'Invalid certified glyph bounds';evidence.set(e.itemIndex,e);}
 const rects:Rect[]=[],text:Rect[]=[],horizontal:RowHorizontal[]=[];let count=0;
 function rectangle(x:number,y:number,w:number,h:number,owner:number|null){if(![x,y,w,h].every(safe)||w<0||h<0)return false;const pixel=1/scale;rects.push({x0:x-PAD,y0:y-PAD,x1:x+Math.max(w,pixel)+PAD,y1:y+Math.max(h,pixel)+PAD,owner});return true;}
 function items(values:any[],owner:number|null,line?:Line):string|null{
  for(const [itemIndex,item] of values.entries()){if(++count>65536||!Array.isArray(item))return 'Material complexity exceeds trial scope';
   const kind=item[0];
   if(kind==='l'||kind==='u'||kind==='M')return 'Unbounded literal, unsupported item or transform';
   if(kind==='c'||kind==='m')continue;
   if(kind==='g'){if(!line){const e=evidence.get(itemIndex);if(!e)return 'Unbounded glyph material';const r=e.rect;if(!rectangle(r.x0,r.y0,r.x1-r.x0,r.y1-r.y0,owner))return 'Invalid certified glyph bounds';continue;}if(!line||![item[4],item[5],item[6]].every(safe)||Number(item[6])<0)return 'Unbounded glyph material';if(!rectangle(item[4],item[5]-line.h,item[6],line.h+line.d,owner))return 'Invalid glyph geometry';continue;}
   if(kind==='r'){if(!rectangle(item[1],item[2],item[3],item[4],owner))return 'Invalid rule geometry';continue;}
   if(kind==='i'){if(insert)return 'Inserted images are outside the trial scope';if(!rectangle(item[2],item[3],item[4],item[5],owner))return 'Invalid image geometry';continue;}
   return 'Unknown drawing material';
  }return null;
 }
 for(let i=0;i<dl.lines.length;i++){
  const line=dl.lines[i];if(!line||![line.x,line.y,line.w,line.h,line.d].every(safe)||line.w<0||line.h<0||line.d<0||!Array.isArray(line.items))return 'Invalid captured row geometry';
  if(line.w===0||line.h+line.d===0){
   // TeX display math can begin with a full-hsize, zero-height row. It
   // contributes no ink, but its horizontal origin keeps the formula centered.
   // The original DL remains unchanged, so color/marker state is still replayed.
   if(!line.items.every(item=>Array.isArray(item)&&(item[0]==='c'||item[0]==='m')))return 'Invalid captured row geometry';
   const reason=items(line.items,i,line);if(reason)return reason;
   if(line.w>0)horizontal.push({x0:line.x-PAD,x1:line.x+line.w+PAD,owner:i});
   continue;
  }
  horizontal.push({x0:line.x-PAD,x1:line.x+line.w+PAD,owner:i});
  const rect={x0:line.x-PAD,y0:line.y-line.h-PAD,x1:line.x+line.w+PAD,y1:line.y+line.d+PAD,owner:i};rects.push(rect);text.push(rect);const reason=items(line.items,i,line);if(reason)return reason;
 }
 const reason=items(dl.other??[],null);if(reason)return reason;
 // images_info is a document-wide resource registry, copied onto image-free
 // pages too. Only an actual i item paints pixels; its explicit rectangle was
 // bounded above. Cached pictures and other unbounded drawing remain refused.
 return {rects,text,horizontal};
}
function owned(anchor:FlowAnchor,dl:DisplayList,page:number):Set<number>|null{
 if(!anchor||!id(anchor.parId)||anchor.page!==page||!Array.isArray(anchor.lineIndices)||!anchor.lineIndices.length)return null;
 const indices=new Set<number>();for(const n of anchor.lineIndices){if(!Number.isSafeInteger(n)||n<0||n>=dl.lines.length||indices.has(n))return null;indices.add(n);}
 const units=new Set([...indices].map(i=>dl.lines[i].unit).filter(id));
 if(units.size&&dl.lines.some((line,i)=>units.has(line.unit!)&&!indices.has(i)))return null;
 return indices;
}

/** Single verified new block, one physical page, no old pixel erasure or repagination claim. */
export function planInsertionFlow(input:InsertionFlowInput):InsertionFlowResult{
 if(!input||typeof input!=='object')return refuse('Invalid insertion input');
 const {page,pageNumber,baseVersions,lineage,insert,insertVersions,renderScale:scale}=input;
 if(!validVersion(baseVersions)||!validVersion(lineage?.baseVersions)||!sameVersion(baseVersions,lineage.baseVersions)||!validVersion(insertVersions))return refuse('Base versions differ');
 if(lineage.verified!==true||lineage.state!=='ready'||lineage.kind!=='pure-insertion'||lineage.insertionCount!==1||lineage.split!==false||!id(lineage.insertedParId)||!Number.isSafeInteger(lineage.sourceRevision)||lineage.sourceRevision<=baseVersions.source_revision)return refuse('Verified single pure insertion required');
 if(insertVersions.source_revision!==lineage.sourceRevision||['engine_generation','context_revision','layout_version'].some(k=>insertVersions[k as keyof Versions]!==baseVersions[k as keyof Versions]))return refuse('Inserted box does not match the verified source and layout');
 if(input.insertDrawable!==true||!Array.isArray(input.existingOverlayParIds)||input.existingOverlayParIds.length)return refuse('Existing overlay conflict or unverified drawable box');
 if(!id(pageNumber)||!safe(scale)||scale<=0||scale>1)return refuse('Invalid rendering scale or page');
 if(!page||!insert||!Array.isArray(page.lines)||page.lines.some(line=>!line)||input.pageEnd&&(!input.pageEnd.afterPage||!Array.isArray(input.pageEnd.afterPage.lines)||input.pageEnd.afterPage.lines.some(line=>!line)))return refuse('Invalid captured page');
 const width=page.page_width??page.width,height=page.page_height??page.height;if(!safe(width)||!safe(height)||width<=0||height<=0)return refuse('Invalid page dimensions');
 const pixelWidth=Math.ceil(width*scale),baseHeight=Math.ceil(height*scale);if(pixelWidth>8192||baseHeight>16384||pixelWidth*baseHeight>64000000)return refuse('Canvas exceeds trial bounds');
 const before=owned(lineage.before,page,pageNumber),after=owned(lineage.after,input.pageEnd?.afterPage??page,input.pageEnd?lineage.after.page:pageNumber);
 if(input.pageEnd&&(lineage.after.page!==pageNumber+1||!Array.isArray(input.pageEnd.otherSourceLineIndices)||input.pageEnd.otherSourceLineIndices.some(i=>!Number.isSafeInteger(i)||i<0||i>=page.lines.length)))return refuse('Invalid adjacent page boundary');
 if(!before||!after||lineage.before.parId===lineage.after.parId||lineage.insertedParId===lineage.before.parId||lineage.insertedParId===lineage.after.parId||!input.pageEnd&&[...before].some(i=>after.has(i)))return refuse('Missing, split, multi-page or ambiguous owned anchors');
 const aUnits=new Set([...before].map(i=>page.lines[i].unit).filter(id));if(!input.pageEnd&&[...after].some(i=>aUnits.has(page.lines[i].unit!)))return refuse('Anchors share a captured unit');
 const old=material(page,scale,false,input.boundedOtherGlyphs??[]),fresh=material(insert,scale,true);if(typeof old==='string')return refuse(old);if(typeof fresh==='string')return refuse(fresh);if(!fresh.rects.length)return refuse('No new rows');
 const a=bounds(old.rects.filter(r=>r.owner!==null&&before.has(r.owner))),b=input.pageEnd?{x0:0,y0:height,x1:width,y1:height}:bounds(old.rects.filter(r=>r.owner!==null&&after.has(r.owner)));
 if(input.pageEnd&&input.pageEnd.otherSourceLineIndices.some(i=>!before.has(i)&&page.lines[i].y+page.lines[i].d+PAD>a.y1))return refuse('Source material remains after the page-end anchor');
 if(![a.x0,a.y0,a.x1,a.y1,b.x0,b.y0,b.x1,b.y1].every(safe)||a.y1>=b.y0||a.x1<=b.x0||b.x1<=a.x0)return refuse('Anchors are not consecutive vertical single-column material');
 // Independent lines beside one another at the same height make reading order
 // ambiguous. This intentionally also refuses complicated side-by-side headers.
 for(let i=0;i<old.text.length;i++)for(let j=i+1;j<old.text.length;j++){const x=old.text[i],y=old.text[j];if(x.y0<y.y1&&x.y1>y.y0&&(x.x1+PAD<y.x0||y.x1+PAD<x.x0))return refuse('Multi-column or side-by-side material is ambiguous');}
 for(const r of old.rects){if(r.owner!==null&&(before.has(r.owner)||!input.pageEnd&&after.has(r.owner)))continue;if(!input.pageEnd&&r.y0>=a.y1&&r.y0<b.y0)return refuse('Intervening material makes source ordering ambiguous');}
 let upper=b.y0;for(const r of old.rects){if(r.owner!==null&&before.has(r.owner))continue;if(r.y0<a.y1&&r.y1>a.y1)return refuse('No full-width whitespace after the anchor');if(r.y0>=a.y1)upper=Math.min(upper,r.y0);}
 const cutPixel=input.pageEnd?Math.ceil(a.y1*scale+1):Math.round((a.y1+upper)*scale/2),cutY=cutPixel/scale,guard=0.5/scale;
 if(cutPixel<=0||cutPixel>=baseHeight||cutY-a.y1<guard||upper-cutY<guard||old.rects.some(r=>r.y0<cutY+guard&&r.y1>cutY-guard))return refuse('No pixel-safe full-width whitespace cut');
 const added=bounds(fresh.rects),padding=Math.max(65536,1/scale);
 const inkRows=insert.lines.filter(line=>line.h+line.d>0),firstBaseline=inkRows[0]?.y;
 const extra=input.minimumFirstBaseline===undefined?0:safe(input.minimumFirstBaseline)&&safe(firstBaseline)?Math.max(0,input.minimumFirstBaseline-(cutY+padding-added.y0+firstBaseline)):NaN;
 if(!safe(extra))return refuse('Invalid provisional paragraph rhythm');
 const insertPixels=Math.ceil((added.y1-added.y0+2*padding+extra)*scale);
 if(insertPixels<=0||insertPixels>baseHeight||baseHeight+insertPixels>16384||pixelWidth*(baseHeight+insertPixels)>64000000)return refuse('Inserted block exceeds trial canvas bounds');
 const anchorRows=old.horizontal.filter(row=>before.has(row.owner));
 const anchorOrigin=anchorRows.length?Math.min(...anchorRows.map(row=>row.x0)):a.x0;
 const insertOrigin=fresh.horizontal.length?Math.min(...fresh.horizontal.map(row=>row.x0)):added.x0;
 const horizontalLeft=Math.min(added.x0,...fresh.horizontal.map(row=>row.x0)),horizontalRight=Math.max(added.x1,...fresh.horizontal.map(row=>row.x1));
 const insertHeight=insertPixels/scale,dx=anchorOrigin-insertOrigin,dy=cutY+padding+extra-added.y0;
 if(horizontalLeft+dx<0||horizontalRight+dx>width)return refuse('Inserted material exceeds page width');
 return {ok:true,provisional:true,page:pageNumber,parId:lineage.insertedParId,baseVersions:{...baseVersions},sourceRevision:lineage.sourceRevision,cutY,insertHeight,translation:{dx,dy},pixels:{width:pixelWidth,baseHeight,height:baseHeight+insertPixels,cutY:cutPixel,insertHeight:insertPixels},projection:{cutY,insertHeight,baseHeight:height,expandedHeight:height+insertHeight}};
}
/** Map original page coordinates without losing any old pixel bands. */
export function projectBaselineY(plan:InsertionFlowPlan,y:number){return y<plan.cutY?y:y+plan.insertHeight;}
export function unprojectFlowY(plan:InsertionFlowPlan,y:number):{kind:'baseline';y:number}|{kind:'insertion';y:number}{if(y<plan.cutY)return {kind:'baseline',y};if(y>=plan.cutY+plan.insertHeight)return {kind:'baseline',y:y-plan.insertHeight};return {kind:'insertion',y:y-plan.translation.dy};}
