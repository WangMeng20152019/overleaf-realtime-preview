import {planCapturedRemoval,capturedRemovalOverlaysSafe} from './captured-removal';
import {boundedGeometry} from './paragraph-replacement';
import {composeFlowPage} from './flow-page';
import {boundOtherGlyphs} from './glyph-bounds';
import {planInsertionFlow} from './insertion-flow';
import type {DisplayList,Placement,Versions,FontDesc} from '../vendor/src/protocol';
import type {PageOverlay} from '../vendor/webview/model';
type Input={verifiedCompleteDirtySet:true;dl:DisplayList;placements:readonly Placement[];page:number;parId:number;owned:ReadonlyMap<number,ReadonlySet<number>>;beforeParId:number;afterParId:number;pg:any;baseVersions:Versions;others:readonly PageOverlay[];fonts:{get(desc:FontDesc):unknown};scale:number};
/** Geometry only. Authenticated caller proves the COMPLETE retained dirty-unit
 * inventory and each live result. This helper composes only ordinary safe
 * overlays; multiple unproven expanded flows remain a full-layout fallback. */
export function planComposedBodyReplacement(input:Input){
 const fail=(reason:string)=>({ok:false as const,reason});const {dl,placements,page,parId,owned,pg,baseVersions,others,fonts,scale}=input;
 if(input.verifiedCompleteDirtySet!==true||!Array.isArray(others)||others.length>8)return fail('Complete bounded dirty-set proof required');
 const target=placements.filter(p=>p.par_id===parId),before=placements.filter(p=>p.par_id===input.beforeParId),after=placements.filter(p=>p.par_id===input.afterParId);
 if(target.length!==1||before.length!==1||after.length!==1||new Set([parId,input.beforeParId,input.afterParId]).size!==3||[...target,...before,...after].some(p=>p.fragments.length!==1||p.fragments[0].page!==page||p.fragments[0].approximate!==false))return fail('Exact same-page source anchors required');
 const keys=['engine_generation','context_revision','layout_version'];
 if(pg?.par_id!==parId||pg.status!=='ok'||pg.versions.source_revision<=baseVersions.source_revision||keys.some(k=>pg.versions[k]!==baseVersions[k as keyof Versions]))return fail('Replacement result differs from captured context');
 const originalOwned=owned.get(parId);if(!originalOwned)return fail('Missing target ownership');
 const removal=planCapturedRemoval({dl,page,parId,placements,ownedLineIndices:originalOwned,fonts,scale});if(!removal.ok)return fail(removal.reason);
 if(others.some(o=>o.overlay.parId===parId)||!capturedRemovalOverlaysSafe(removal.rects,others,fonts,scale))return fail('Retained overlay conflicts with removed target ink');
 const global=boundOtherGlyphs(dl,fonts);if(!global)return fail('Unbounded original global ink');
 const anchors=[parId,input.beforeParId,input.afterParId];
 const composed=composeFlowPage({base:dl,overlays:others,owned,anchors,boundedOtherGlyphs:global});if(!composed.ok)return fail(composed.reason);
 const removed=new Set(composed.anchorLineIndices.get(parId));const indexMap=new Map<number,number>();
 const remaining=composed.dl.lines.filter((_,i)=>{if(removed.has(i))return false;indexMap.set(i,indexMap.size);return true;});
 const geometry=boundedGeometry({...composed.dl,lines:remaining},fonts,scale),insert=boundedGeometry(pg.dl,fonts,scale);if(!geometry||!insert)return fail('Unbounded composed glyph geometry');
 const globals=boundOtherGlyphs(geometry,fonts);if(!globals)return fail('Unbounded composed global ink');const pad=1.5/scale;for(const g of globals)g.rect={x0:g.rect.x0-pad,y0:g.rect.y0-pad,x1:g.rect.x1+pad,y1:g.rect.y1+pad};
 const remap=(id:number)=>composed.anchorLineIndices.get(id)!.map(i=>indexMap.get(i)!);
 const flow=planInsertionFlow({page:geometry,pageNumber:page,baseVersions,lineage:{verified:true,state:'ready',kind:'pure-insertion',baseVersions,sourceRevision:pg.versions.source_revision,insertedParId:parId,insertionCount:1,split:false,before:{parId:input.beforeParId,page,lineIndices:remap(input.beforeParId)},after:{parId:input.afterParId,page,lineIndices:remap(input.afterParId)}},insert,insertVersions:pg.versions,insertDrawable:true,existingOverlayParIds:[],renderScale:scale,boundedOtherGlyphs:globals});
 if(!flow.ok)return fail(flow.reason);
 const origin=pg.dl.lines.find((l:any)=>l.w>0&&l.h+l.d>0)?.x;flow.translation.dx=target[0].fragments[0].xs[0]-Number(origin);
 if(!Number.isFinite(flow.translation.dx)||insert.lines.some(l=>l.x+flow.translation.dx<0||l.x+l.w+flow.translation.dx>(dl.page_width??dl.width)))return fail('Composed replacement exceeds page');
 return{ok:true as const,kind:'replacement' as const,flow,clearRects:removal.rects,baseOverlayVersions:composed.overlayVersions};
}
