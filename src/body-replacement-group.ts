import {planCapturedRemoval,capturedRemovalOverlaysSafe} from './captured-removal';
import {boundedGeometry} from './paragraph-replacement';
import {composeFlowPage} from './flow-page';
import {boundOtherGlyphs} from './glyph-bounds';
import {planInsertionFlow} from './insertion-flow';
import {assembleInsertionBatch} from './insertion-batch';
import type {DisplayList,Placement,Versions,FontDesc} from '../vendor/src/protocol';
import type {PageOverlay} from '../vendor/webview/model';
type Slot={parId:number;sourceRevision:number;editId:number;beforeParId:number;afterParId:number};
type Input={verifiedCompleteDirtySet:true;dl:DisplayList;placements:readonly Placement[];page:number;targetParId:number;dirtyUnits:readonly Slot[];records:ReadonlyMap<number,any>;owned:ReadonlyMap<number,ReadonlySet<number>>;baseVersions:Versions;sourceRevision:number;others:readonly PageOverlay[];fonts:{get(desc:FontDesc):unknown};scale:number};
/** One adjacent dirty band, never multiple independently guessed page splices. */
export function planAdjacentBodyReplacement(input:Input){
 const fail=(reason:string)=>({ok:false as const,reason});const {dl,placements,page,owned,baseVersions,fonts,scale}=input;
 if(input.verifiedCompleteDirtySet!==true||!Array.isArray(input.dirtyUnits)||input.dirtyUnits.length<2||input.dirtyUnits.length>8||new Set(input.dirtyUnits.map(u=>u.parId)).size!==input.dirtyUnits.length)return fail('Complete bounded dirty set required');
 const slots=new Map(input.dirtyUnits.map(u=>[u.parId,u])),target=slots.get(input.targetParId);if(!target)return fail('Missing dirty target');
 const group:Slot[]=[target],seen=new Set([target.parId]);
 for(;;){const first=group[0],previous=slots.get(first.beforeParId);if(!previous)break;if(seen.has(previous.parId)||previous.afterParId!==first.parId)return fail('Inconsistent source neighbour links');group.unshift(previous);seen.add(previous.parId);}
 for(;;){const last=group.at(-1)!,next=slots.get(last.afterParId);if(!next)break;if(seen.has(next.parId)||next.beforeParId!==last.parId)return fail('Inconsistent source neighbour links');group.push(next);seen.add(next.parId);}
 if(group.length<2)return fail('No adjacent dirty group');
 const ids=group.map(u=>u.parId),beforeParId=group[0].beforeParId,afterParId=group.at(-1)!.afterParId;
 const exact=(id:number,member=true)=>{const p=placements.filter(p=>p.par_id===id);return p.length===1&&(member?['Body','par'].includes(p[0].kind):['Body','par','Env','Heading','env','heading'].includes(p[0].kind)||/^(?:heading|env):[A-Za-z][A-Za-z0-9*_-]{0,127}$/.test(p[0].kind))&&p[0].fragments.length===1&&p[0].fragments[0].page===page&&p[0].fragments[0].approximate===false?p[0]:null;};
 const originals=group.map(u=>exact(u.parId));if(originals.some(p=>!p)||!exact(beforeParId,false)||!exact(afterParId,false))return fail('Exact same-page Body group and outer anchors required');
 const keys=['engine_generation','context_revision','layout_version'];
 for(const slot of group){const pg=input.records.get(slot.parId)?.event;if(!pg||pg.status!=='ok'||pg.par_id!==slot.parId||pg.edit_id!==slot.editId||pg.versions?.source_revision!==slot.sourceRevision||slot.sourceRevision<=baseVersions.source_revision||slot.sourceRevision>input.sourceRevision||keys.some(k=>pg.versions[k]!==baseVersions[k as keyof Versions]))return fail('Waiting for exact dirty group paragraphs');}
 if(input.others.some(o=>ids.includes(o.overlay.parId)))return fail('Group duplicated in external overlays');
 const clearRects:number[][]=[],ownedUnion=new Set<number>();
 for(const id of ids){const rows=owned.get(id);if(!rows)return fail('Missing group ownership');for(const row of rows)if(ownedUnion.has(row))return fail('Shared group ownership');else ownedUnion.add(row);const removal=planCapturedRemoval({dl,page,parId:id,placements,ownedLineIndices:rows,fonts,scale});if(!removal.ok)return fail(removal.reason);clearRects.push(...removal.rects);}
 if(!capturedRemovalOverlaysSafe(clearRects as any,input.others,fonts,scale))return fail('External live ink intersects group clearing');
 const globals=boundOtherGlyphs(dl,fonts);if(!globals)return fail('Unbounded original global ink');
 const composed=composeFlowPage({base:dl,overlays:input.others,owned,anchors:[...ids,beforeParId,afterParId],boundedOtherGlyphs:globals});if(!composed.ok)return fail(composed.reason);
 const remove=new Set(ids.flatMap(id=>composed.anchorLineIndices.get(id)!)),indexMap=new Map<number,number>();const remaining=composed.dl.lines.filter((_,i)=>{if(remove.has(i))return false;indexMap.set(i,indexMap.size);return true;});
 const meta={insertions:group.map(u=>({...u,beforeParId,afterParId})),insertionCount:group.length,beforeParId,afterParId,sourceRevision:input.sourceRevision,baseVersions};
 const assembled=assembleInsertionBatch(meta,new Map(input.records));if(!assembled.ok)return fail(assembled.reason);
 // Preserve captured paragraph baseline advances while allowing new rows to grow.
 let cursor=0;const blocks=assembled.blocks;const combined=structuredClone(assembled.dl);combined.lines=[];
 for(let i=0;i<blocks.length;i++){const block=blocks[i],old=originals[i]!,pg=block.event.dl;const first=pg.lines.find((l:any)=>l.h+l.d>0);if(!first)return fail('Empty group paragraph');const measured=boundedGeometry(pg,fonts,scale);if(!measured)return fail('Unavailable group glyph bounds');const materialTop=Math.min(...measured.lines.map(l=>l.y-l.h)),materialBottom=Math.max(...measured.lines.map(l=>l.y+l.d));const dx=old.fragments[0].xs[0]-first.x;let dy=-first.y;
  if(i){const prev=blocks[i-1],previousOld=originals[i-1]!,gap=old.fragments[0].baselines[0]-previousOld.fragments[0].baselines.at(-1)!;if(!Number.isFinite(gap)||gap<=0)return fail('Invalid captured paragraph rhythm');dy=Math.max(cursor+gap-first.y,prev.bottom+131072-materialTop);}
  const deltaX=dx-block.dx,deltaY=dy-block.dy;const chunk=assembled.dl.lines.slice(blocks.slice(0,i).reduce((n,b)=>n+b.event.dl.lines.length,0),blocks.slice(0,i+1).reduce((n,b)=>n+b.event.dl.lines.length,0));
  for(const line of chunk){const row=structuredClone(line);row.x+=deltaX;row.y+=deltaY;for(const item of row.items){if(item[0]==='g'){item[4]+=deltaX;item[5]+=deltaY;}else if(item[0]==='r'){item[1]+=deltaX;item[2]+=deltaY;}}combined.lines.push(row);}
  block.dx=dx;block.dy=dy;block.top=materialTop+dy;block.bottom=materialBottom+dy;block.firstBaseline=first.y+dy;cursor=pg.lines.at(-1)!.y+dy;
 }
 const geometry=boundedGeometry({...composed.dl,lines:remaining},fonts,scale),insert=boundedGeometry(combined,fonts,scale);if(!geometry||!insert)return fail('Unbounded group geometry');const bounded=boundOtherGlyphs(geometry,fonts);if(!bounded)return fail('Unbounded composed global ink');const rasterPad=1.5/scale;for(const g of bounded)g.rect={x0:g.rect.x0-rasterPad,y0:g.rect.y0-rasterPad,x1:g.rect.x1+rasterPad,y1:g.rect.y1+rasterPad};
 const remap=(id:number)=>composed.anchorLineIndices.get(id)!.map(i=>indexMap.get(i)!);
 const flow=planInsertionFlow({page:geometry,pageNumber:page,baseVersions,lineage:{verified:true,state:'ready',kind:'pure-insertion',baseVersions,sourceRevision:input.sourceRevision,insertedParId:ids[0],insertionCount:1,split:false,before:{parId:beforeParId,page,lineIndices:remap(beforeParId)},after:{parId:afterParId,page,lineIndices:remap(afterParId)}},insert,insertVersions:{...baseVersions,source_revision:input.sourceRevision},insertDrawable:true,existingOverlayParIds:[],renderScale:scale,boundedOtherGlyphs:bounded});if(!flow.ok)return fail(flow.reason);flow.translation.dx=0;const width=dl.page_width??dl.width;if(!Number.isFinite(width)||insert.lines.some(l=>!Number.isFinite(l.x)||!Number.isFinite(l.w)||l.x<0||l.x+l.w>width))return fail('Group horizontal material exceeds page');
 return{ok:true as const,kind:'adjacent-body-replacement' as const,flow,clearRects,ownedUnion,blocks,compositeDL:combined,externalOverlayManifest:composed.overlayVersions,parIds:ids,firstParId:ids[0],beforeParId,afterParId};
}
