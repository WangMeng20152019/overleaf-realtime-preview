import {planRemovalAdmission} from './removal-admission.ts';
import {planCapturedRemoval,capturedRemovalOverlaysSafe} from './captured-removal.ts';
import {boundedGeometry} from './paragraph-replacement.ts';
import {composeFlowPage} from './flow-page.ts';
import {boundOtherGlyphs} from './glyph-bounds.ts';
import {assembleInsertionBatch} from './insertion-batch.ts';
import {planInsertionFlow} from './insertion-flow.ts';
import {inferParagraphRhythm,textFontSignature} from './paragraph-rhythm.ts';
import type {DisplayList,Placement,Versions,FontDesc} from '../vendor/src/protocol';
import type {PageOverlay} from '../vendor/webview/model';
type Unit={parId:number;sourceRevision:number;editId:number};
type WindowBase={verifiedBodyWindow:true;resourcesReady:true;dl:DisplayList;placements:readonly Placement[];page:number;baseVersions:Versions;sourceRevision:number;replacedParIds:readonly number[];beforeParId:number;afterParId:number;owned:ReadonlyMap<number,ReadonlySet<number>>;fonts:{get(desc:FontDesc):unknown};scale:number};
type Input=WindowBase&{units:readonly Unit[];records:ReadonlyMap<number,any>;others:readonly PageOverlay[];plainBodyParIds?:readonly number[]};
const versionKeys=['source_revision','engine_generation','context_revision','layout_version'] as const;
function capturedWindow(input:WindowBase){
 const fail=(reason:string)=>({ok:false as const,reason}),{dl,placements,page,baseVersions,fonts,scale}=input,ids=input.replacedParIds;
 if(input.verifiedBodyWindow!==true||input.resourcesReady!==true||!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length||!versionKeys.every(k=>Number.isSafeInteger(baseVersions?.[k])&&baseVersions[k]>=0)||!Number.isSafeInteger(input.sourceRevision)||input.sourceRevision<=baseVersions.source_revision||[...ids,input.beforeParId,input.afterParId].some(id=>!Number.isSafeInteger(id)||id<=0)||new Set([...ids,input.beforeParId,input.afterParId]).size!==ids.length+2)return fail('Bounded captured Body window proof required');
 const exact=(id:number,body=false)=>{const found=placements.filter(p=>p.par_id===id);return found.length===1&&(!body||['Body','par'].includes(found[0].kind))&&found[0].fragments.length===1&&found[0].fragments[0].page===page&&found[0].fragments[0].approximate===false?found[0]:null;};
 const olds=ids.map(id=>exact(id,true)),before=exact(input.beforeParId),after=exact(input.afterParId);if(olds.some(p=>!p)||!before||!after)return fail('Exact same-page Body window and outer anchors required');
 const start=placements.findIndex(p=>p.par_id===ids[0]);if(start<1||placements[start-1].par_id!==input.beforeParId||placements[start+ids.length]?.par_id!==input.afterParId||ids.some((id,i)=>placements[start+i]?.par_id!==id))return fail('Captured Bodies are not consecutive source placements');
 const ordered=[before,...olds as Placement[],after];for(let i=0;i<ordered.length;i++){const b=ordered[i].fragments[0].baselines;if(!b.length||b.some((y,n)=>!Number.isFinite(y)||n>0&&y<=b[n-1])||i>0&&ordered[i-1].fragments[0].baselines.at(-1)!>=b[0])return fail('Captured window reverses or splits vertical source order');}
 const oldOwned=new Set<number>(),rects:[number,number,number,number][]=[],preservedStateItems:any[]=[];let left=-Infinity,right=Infinity;
 for(const id of ids){const owned=input.owned.get(id);if(!owned?.size||[...owned].some(i=>oldOwned.has(i)))return fail('Missing or shared original ownership');let bodyLeft=Infinity,bodyRight=-Infinity;for(const i of owned){oldOwned.add(i);const row=dl.lines[i];if(!row||![row.x,row.w].every(Number.isFinite)||row.w<0)return fail('Invalid original row');if(row.w>0&&row.items.some(item=>['g','r','i'].includes(item[0]))){bodyLeft=Math.min(bodyLeft,row.x);bodyRight=Math.max(bodyRight,row.x+row.w);}}if(!Number.isFinite(bodyLeft)||!Number.isFinite(bodyRight)||bodyLeft>=bodyRight)return fail('Missing original Body material bounds');left=Math.max(left,bodyLeft);right=Math.min(right,bodyRight);const removal=planCapturedRemoval({dl,page,parId:id,placements,ownedLineIndices:owned,fonts,scale});if(!removal.ok)return removal;rects.push(...removal.rects);preservedStateItems.push(...removal.preservedStateItems);}
 if(left>=right)return fail('Captured window is not a single column');
 preservedStateItems.sort((a,b)=>a.lineIndex-b.lineIndex||a.itemIndex-b.itemIndex);
 return{ok:true as const,olds:olds as Placement[],before,after,oldOwned,rects,preservedStateItems};
}
/** Empty window geometry: old ink disappears, neighbours never move. Caller
 * validates source/current-ID roles and tombstones; this creates no removed PG. */
export function planBodyWindowRemoval(input:WindowBase&{removalVersions:Versions;otherPageOverlays:Parameters<typeof planRemovalAdmission>[0]['otherPageOverlays']}){
 const c=capturedWindow(input);if(!c.ok)return c;
 if(!Array.isArray(input.otherPageOverlays)||input.otherPageOverlays.length>8||input.removalVersions?.source_revision!==input.sourceRevision||versionKeys.slice(1).some(k=>input.removalVersions[k]!==input.baseVersions[k])||input.otherPageOverlays.some(o=>input.replacedParIds.includes(o.overlay.parId)))return{ok:false as const,reason:'Removal versions or retained membership differ'};
 let manifest:any[]=[];
 for(const id of input.replacedParIds){const admitted=planRemovalAdmission({dl:input.dl,placements:input.placements,page:input.page,parId:id,owned:input.owned.get(id)!,removalVersions:input.removalVersions,baseline:input.baseVersions,baseResourcesReady:true,otherPageOverlays:input.otherPageOverlays,fonts:input.fonts,scale:input.scale});if(!admitted.ok)return admitted;manifest=admitted.safeOverlayManifest;}
 return{ok:true as const,projection:{ok:true as const,rects:c.rects,hiddenLineIndices:[...c.oldOwned].sort((a,b)=>a-b),preservedStateItems:c.preservedStateItems},safeOverlayManifest:manifest,oldOwned:c.oldOwned,oldParIds:[...input.replacedParIds]};
}

/** Geometry only. Authenticated caller proves a complete bounded source window,
 * unchanged outer source, current unit order and resource leases. New IDs are
 * never relabelled as the removed source ID: original events remain immutable. */
export function planBodyWindowReplacement(input:Input){
 const fail=(reason:string)=>({ok:false as const,reason});const {dl,placements,page,baseVersions,fonts,scale}=input;
 const captured=capturedWindow(input);if(!captured.ok)return captured;const oldIDs=input.replacedParIds,old=captured.olds[0],oldOwned=captured.oldOwned,ids=input.units?.map(u=>u.parId)??[],keys=versionKeys;
 if(!Array.isArray(input.units)||!input.units.length||input.units.length>4||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0||id===input.beforeParId||id===input.afterParId)||!Array.isArray(input.others)||input.others.length>8)return fail('One to four ready successors required');
 const removal={rects:captured.rects};
 if(input.others.some(o=>ids.includes(o.overlay.parId)||oldIDs.includes(o.overlay.parId))||!capturedRemovalOverlaysSafe(removal.rects,input.others,fonts,scale))return fail('Other overlay conflicts with original window');
 for(const unit of input.units){const e=input.records.get(unit.parId)?.event;if(!Number.isSafeInteger(unit.editId)||unit.editId<=0||!Number.isSafeInteger(unit.sourceRevision)||unit.sourceRevision<=baseVersions.source_revision||unit.sourceRevision>input.sourceRevision||e?.event!=='ParagraphUpdate'||e.status!=='ok'||e.par_id!==unit.parId||e.edit_id!==unit.editId||e.versions?.source_revision!==unit.sourceRevision||keys.slice(1).some(k=>e.versions[k]!==baseVersions[k]))return fail('Waiting for exact current successor paragraphs');}
 const globals=boundOtherGlyphs(dl,fonts);if(!globals)return fail('Unavailable original glyph outlines');
 const composed=composeFlowPage({base:dl,overlays:input.others,owned:input.owned,anchors:[...oldIDs,input.beforeParId,input.afterParId],boundedOtherGlyphs:globals});if(!composed.ok)return fail(composed.reason);
 const remove=new Set(oldIDs.flatMap(id=>composed.anchorLineIndices.get(id)!)),indexMap=new Map<number,number>();const remaining=composed.dl.lines.filter((_,i)=>{if(remove.has(i))return false;indexMap.set(i,indexMap.size);return true;});
 const first=input.records.get(ids[0])!.event.dl,signature=textFontSignature(first),rhythm=signature?inferParagraphRhythm({...dl,page},placements,signature):null;
 const meta={insertions:input.units.map(u=>({...u,beforeParId:input.beforeParId,afterParId:input.afterParId})),insertionCount:ids.length,beforeParId:input.beforeParId,afterParId:input.afterParId,sourceRevision:input.sourceRevision,baseVersions,plainBodyParIds:[...input.plainBodyParIds??[]]};
 const assembled=assembleInsertionBatch(meta,new Map(input.records),rhythm);if(!assembled.ok)return fail(assembled.reason);
 // Position original PGs at the original Body origin, preserving each block's
 // internal layout. Calibrated spacing is provisional, never final TeX glue.
 const origin=old.fragments[0].xs[0],firstOrigin=first.lines.find((l:any)=>l.w>0&&l.h+l.d>0)?.x;if(!Number.isFinite(origin)||!Number.isFinite(firstOrigin))return fail('Missing window typesetting origin');
 const dx=origin-(Number(firstOrigin)+assembled.blocks[0].dx),combined=structuredClone(assembled.dl);
 for(const line of combined.lines){line.x+=dx;for(const item of line.items){if(item[0]==='g')item[4]+=dx;else if(item[0]==='r')item[1]+=dx;}}
 for(const item of combined.other??[]){if(item[0]==='g')item[4]+=dx;else if(item[0]==='r')item[1]+=dx;}
 let previousBottom=-Infinity;
 for(const block of assembled.blocks){block.dx+=dx;const measured=boundedGeometry(block.event.dl,fonts,scale);if(!measured)return fail('Unavailable successor ink bounds');const top=Math.min(...measured.lines.map(l=>l.y-l.h)),bottom=Math.max(...measured.lines.map(l=>l.y+l.d));const extra=Number.isFinite(previousBottom)?Math.max(0,previousBottom+131072-(top+block.dy)):0;
  if(extra)for(const line of combined.lines)if(line.unit===block.parId){line.y+=extra;for(const item of line.items){if(item[0]==='g')item[5]+=extra;else if(item[0]==='r')item[2]+=extra;}}
  block.dy+=extra;block.firstBaseline+=extra;block.top=top+block.dy;block.bottom=bottom+block.dy;previousBottom=block.bottom;
 }
 const geometry=boundedGeometry({...composed.dl,lines:remaining},fonts,scale),insert=boundedGeometry(combined,fonts,scale);if(!geometry||!insert)return fail('Unavailable bounded window geometry');
 const globalBounds=boundOtherGlyphs(geometry,fonts);if(!globalBounds)return fail('Unavailable composed glyph outlines');const pad=1.5/scale;for(const g of globalBounds)g.rect={x0:g.rect.x0-pad,y0:g.rect.y0-pad,x1:g.rect.x1+pad,y1:g.rect.y1+pad};
 const remap=(id:number)=>composed.anchorLineIndices.get(id)!.map(i=>indexMap.get(i)!);
 const flow=planInsertionFlow({page:geometry,pageNumber:page,baseVersions,lineage:{verified:true,state:'ready',kind:'pure-insertion',baseVersions,sourceRevision:input.sourceRevision,insertedParId:ids[0],insertionCount:1,split:false,before:{parId:input.beforeParId,page,lineIndices:remap(input.beforeParId)},after:{parId:input.afterParId,page,lineIndices:remap(input.afterParId)}},insert,insertVersions:{...baseVersions,source_revision:input.sourceRevision},insertDrawable:true,existingOverlayParIds:[],renderScale:scale,boundedOtherGlyphs:globalBounds});if(!flow.ok)return fail(flow.reason);flow.translation.dx=0;
 const width=dl.page_width??dl.width;if(insert.lines.some(l=>!Number.isFinite(l.x)||!Number.isFinite(l.w)||l.x<0||l.x+l.w>width))return fail('Window exceeds horizontal page bounds');
 return{ok:true as const,kind:'body-window-replacement' as const,flow,oldOwned:new Set(oldOwned),oldParIds:[...oldIDs],blocks:assembled.blocks,clearRects:removal.rects,compositeDL:combined,externalOverlayManifest:composed.overlayVersions,parIds:ids,beforeParId:input.beforeParId,afterParId:input.afterParId,paragraphRhythm:rhythm};
}
