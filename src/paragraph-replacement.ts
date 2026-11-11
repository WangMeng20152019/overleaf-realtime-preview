import {planCapturedRemoval} from './captured-removal.ts';
import {glyphInkBounds,boundOtherGlyphs} from './glyph-bounds.ts';
import {planInsertionFlow} from './insertion-flow.ts';
import type {InsertionFlowPlan} from './insertion-flow.ts';
import type {DisplayList,FontDesc,Placement,Versions,Line} from '../vendor/src/protocol';
type Input={verifiedSingleBodyReplacement:true;dl:DisplayList;placements:readonly Placement[];page:number;parId:number;owned:ReadonlySet<number>;beforeParId:number;afterParId:number;pg:{par_id:number;status:string;versions:Versions;dl:DisplayList};baseVersions:Versions;fonts:{get(desc:FontDesc):unknown};scale:number;existingOverlayParIds:readonly number[]};
const keys=['source_revision','engine_generation','context_revision','layout_version'] as const;
/** Expand GEOMETRY ONLY to contain the real glyph outlines and raster fringe.
 * Original rows/items remain the paint source; this copy certifies the splice. */
export function boundedGeometry(dl:DisplayList,fonts:Input['fonts'],scale:number):DisplayList|null{
 const pad=1.5/scale,lines:Line[]=[];
 for(const row of dl.lines){if(![row.x,row.y,row.w,row.h,row.d].every(Number.isFinite)||row.w<0||row.h<0||row.d<0)return null;let x0=row.x,x1=row.x+row.w,y0=row.y-row.h,y1=row.y+row.d;
 for(const item of row.items){if(item[0]==='c')continue;if(item[0]==='m'){if(item.length!==3||!['on','off'].includes(String(item[1]))||!Number.isFinite(item[2]))return null;continue;}
 let rect;if(item[0]==='g'){try{const desc=dl.fonts[String(item[1])];rect=glyphInkBounds(desc,item,fonts.get(desc));}catch{return null;}if(!rect)return null;}
 else if(item[0]==='r'){const [,x,y,w,h]=item;if(![x,y,w,h].every(Number.isFinite)||Number(w)<0||Number(h)<0)return null;rect={x0:Number(x),y0:Number(y),x1:Number(x)+Math.max(Number(w),1/scale),y1:Number(y)+Math.max(Number(h),1/scale)};}else return null;
 x0=Math.min(x0,rect.x0-pad);x1=Math.max(x1,rect.x1+pad);y0=Math.min(y0,rect.y0-pad);y1=Math.max(y1,rect.y1+pad);}
 // Keep the original horizontal origin for typesetting alignment. Increasing
 // width to the right cannot bound left overhang; such rows fail closed.
 if(x0<row.x-pad)return null;
 lines.push({...row,x:x0,w:x1-x0,h:Math.max(0,row.y-y0),d:Math.max(0,y1-row.y),items:row.items.map(i=>[...i])});}
 if(!Array.isArray(dl.other)||dl.other.some(item=>item[0]==='m'&&(item.length!==3||!['on','off'].includes(String(item[1]))||!Number.isFinite(item[2]))))return null;
 const other=dl.other.map(item=>item[0]==='r'?['r',Number(item[1])-pad,Number(item[2])-pad,Number(item[3])+2*pad,Number(item[4])+2*pad]:[...item]);
 return {...dl,lines,other};
}
/** Caller proves an exact single-unit native replacement, no other source edits.
 * This helper never creates transferable source proof. The insertion lineage
 * below is private input to an existing geometric checker on a cleared copy. */
export function planParagraphReplacement(input:Input):{ok:true;kind:'replacement';clearRects:[number,number,number,number][];flow:InsertionFlowPlan;oldToNew:Map<number,number>;geometry:DisplayList}|{ok:false;reason:string}{
 const fail=(reason:string)=>({ok:false as const,reason});const {dl,placements,page,parId,owned,pg,baseVersions,fonts,scale}=input;
 if(input.verifiedSingleBodyReplacement!==true||!Number.isFinite(scale)||scale<=0||scale>1||input.existingOverlayParIds?.length!==0)return fail('Single isolated Body replacement proof required');
 if(pg.par_id!==parId||pg.status!=='ok'||!keys.every(k=>Number.isSafeInteger(baseVersions?.[k])&&baseVersions[k]>=0&&Number.isSafeInteger(pg.versions?.[k]))||pg.versions.source_revision<=baseVersions.source_revision||keys.slice(1).some(k=>pg.versions[k]!==baseVersions[k]))return fail('Replacement versions differ');
 if(new Set([parId,input.beforeParId,input.afterParId]).size!==3)return fail('Distinct source anchors required');
 const target=placements.find(p=>p.par_id===parId),before=placements.filter(p=>p.par_id===input.beforeParId),after=placements.filter(p=>p.par_id===input.afterParId);
 if(!target||before.length!==1||after.length!==1||[...before,...after].some(p=>p.fragments.length!==1||p.fragments[0].page!==page||p.fragments[0].approximate))return fail('Exact same-page anchors required');
 const removal=planCapturedRemoval({dl,page,parId,placements,ownedLineIndices:owned,fonts,scale});if(!removal.ok)return fail(removal.reason);
 const resolve=(p:Placement)=>{const ids:number[]=[];for(let n=0;n<p.fragments[0].baselines.length;n++){const f=p.fragments[0],matches=dl.lines.flatMap((line,i)=>Math.abs(line.y-f.baselines[n])<=64&&Math.abs(line.x-f.xs[n])<=64?[i]:[]);if(matches.length!==1)return null;ids.push(matches[0]);}const units=new Set(ids.map(i=>dl.lines[i].unit).filter(Boolean));dl.lines.forEach((line,i)=>{if(units.has(line.unit)&&!ids.includes(i))ids.push(i)});return ids;};
 const beforeIndices=resolve(before[0]),afterIndices=resolve(after[0]);if(!beforeIndices?.length||!afterIndices?.length||[...beforeIndices,...afterIndices].some(i=>owned.has(i))||beforeIndices.some(i=>afterIndices.includes(i)))return fail('Ambiguous anchor ownership');
 const targetYs=[...owned].map(i=>dl.lines[i].y);if(Math.max(...beforeIndices.map(i=>dl.lines[i].y))>=Math.min(...targetYs)||Math.min(...afterIndices.map(i=>dl.lines[i].y))<=Math.max(...targetYs))return fail('Replacement is outside anchor order');
 const oldToNew=new Map<number,number>(),remaining=dl.lines.filter((_,i)=>{if(owned.has(i))return false;oldToNew.set(i,oldToNew.size);return true;});
 const geometry=boundedGeometry({...dl,lines:remaining},fonts,scale),insert=boundedGeometry(pg.dl,fonts,scale);if(!geometry||!insert)return fail('Unbounded glyph geometry');
 const globals=boundOtherGlyphs(geometry,fonts);if(globals)for(const g of globals){const pad=1.5/scale;g.rect={x0:g.rect.x0-pad,y0:g.rect.y0-pad,x1:g.rect.x1+pad,y1:g.rect.y1+pad};}if(!globals)return fail('Unbounded global glyphs');
 const flow=planInsertionFlow({page:geometry,pageNumber:page,baseVersions,lineage:{verified:true,state:'ready',kind:'pure-insertion',baseVersions,sourceRevision:pg.versions.source_revision,insertedParId:parId,insertionCount:1,split:false,before:{parId:input.beforeParId,page,lineIndices:beforeIndices.map(i=>oldToNew.get(i)!)},after:{parId:input.afterParId,page,lineIndices:afterIndices.map(i=>oldToNew.get(i)!)}},insert,insertVersions:pg.versions,insertDrawable:true,existingOverlayParIds:[],renderScale:scale,boundedOtherGlyphs:globals});
 if(!flow.ok)return fail(flow.reason);
 // Geometry rows can widen to outline bounds; align the ORIGINAL typesetting
 // origins of the TARGET first row, never the preceding heading's indent or
 // the minimum x of later unindented lines.
 const originalOrigin=target.fragments[0].xs[0],newOrigin=pg.dl.lines.find(l=>l.w>0&&l.h+l.d>0)?.x;
 const desiredDx=originalOrigin-Number(newOrigin);
 if(!Number.isFinite(desiredDx)||insert.lines.some(l=>l.x+desiredDx<0||l.x+l.w+desiredDx>(dl.page_width??dl.width)))return fail('Replacement exceeds page width');
 flow.translation.dx=desiredDx;
 return {ok:true,kind:'replacement',clearRects:removal.rects,flow,oldToNew,geometry};
}
