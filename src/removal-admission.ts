import {planCapturedRemoval,capturedRemovalOverlaysSafe} from './captured-removal.ts';
import {hybridMasks} from './hybrid-overlay.ts';
import {boundOtherGlyphs} from './glyph-bounds.ts';
import {planInkOverlayMasks} from './ink-overlay.ts';
import type {DisplayList,Placement,Versions,FontDesc} from '../vendor/src/protocol';
import type {PageOverlay} from '../vendor/webview/model';
type ProvenOverlay=PageOverlay&{event:any;resourcesReady:true;nativeProof:{verified:true;parId:number;editId:number;sourceRevision:number}};
type Input={dl:DisplayList;placements:readonly Placement[];page:number;parId:number;owned:ReadonlySet<number>;removalVersions:Versions;baseline:Versions;baseResourcesReady:true;otherPageOverlays:readonly ProvenOverlay[];fonts:{get(desc:FontDesc):unknown};scale:number};
const fields=['source_revision','engine_generation','context_revision','layout_version'] as const;
const valid=(v:any):v is Versions=>v&&fields.every(k=>Number.isSafeInteger(v[k])&&v[k]>=0);
/** Caller-owned resource leases and native edit receipts are explicit trust inputs.
 * This never infers native provenance from an engine DL or a pixel mask.
 * Rendering must recheck this immutable manifest after asynchronous PDF work. */
export function planRemovalAdmission(input:Input){
 const fail=(reason:string)=>({ok:false as const,reason});const {dl,placements,page,parId,owned,removalVersions:v,baseline:b,fonts,scale}=input;
 if(input.baseResourcesReady!==true||!valid(v)||!valid(b)||v.source_revision<=b.source_revision||fields.slice(1).some(k=>v[k]!==b[k]))return fail('Removal baseline or resources differ');
 if(!Array.isArray(input.otherPageOverlays)||input.otherPageOverlays.length>32)return fail('Overlay admission bound');
 const removal=planCapturedRemoval({dl,page,parId,placements,ownedLineIndices:owned,fonts,scale});if(!removal.ok)return removal;
 const bounded=boundOtherGlyphs(dl,fonts);if(!bounded)return fail('Unbounded captured glyphs');
 const ids=new Set<number>(),manifest:{parId:number;sourceRevision:number;editId:number;dl:DisplayList;event:any}[]=[];
 for(const item of input.otherPageOverlays){const {overlay,event:e,nativeProof:proof}=item;
  if(!overlay||overlay.parId===parId||ids.has(overlay.parId)||!Number.isSafeInteger(overlay.parId)||overlay.parId<=0||item.resourcesReady!==true||proof?.verified!==true||e?.event!=='ParagraphUpdate'||e.status!=='ok'||!valid(e.versions)||!Number.isSafeInteger(e.edit_id)||e.edit_id<=0||proof.parId!==overlay.parId||proof.editId!==e.edit_id||proof.sourceRevision!==e.versions.source_revision||e.par_id!==overlay.parId||overlay.dl!==e.dl||overlay.revision!==e.versions.source_revision||e.versions.source_revision<=b.source_revision||e.versions.source_revision>v.source_revision||fields.slice(1).some(k=>e.versions[k]!==b[k]))return fail('Unproven or stale neighbouring overlay');
  ids.add(overlay.parId);
  if(overlay.deferredPages?.length||overlay.fragments.length!==1||overlay.fragments[0].page!==page||overlay.fragments[0].approximate!==false||item.rows.length!==e.dl.lines.length||!item.rows.length||item.rows.some((r,i)=>r.line!==e.dl.lines[i]||![r.dx,r.dy].every(Number.isFinite)))return fail('Incomplete live page geometry');
  const placement=placements.filter(p=>p.par_id===overlay.parId);if(placement.length!==1||placement[0].fragments.length!==1||placement[0].fragments[0].page!==page||placement[0].fragments[0].approximate!==false)return fail('No exact captured neighbour');
  const f=placement[0].fragments[0],indices=new Set<number>();for(let n=0;n<f.baselines.length;n++){const matches=dl.lines.flatMap((line,i)=>Math.abs(line.y-f.baselines[n])<=64&&Math.abs(line.x-f.xs[n])<=64?[i]:[]);if(matches.length!==1)return fail('Ambiguous neighbouring ownership');indices.add(matches[0]);}
  const units=new Set([...indices].map(i=>dl.lines[i].unit).filter(Boolean));dl.lines.forEach((line,i)=>{if(units.has(line.unit))indices.add(i)});if([...indices].some(i=>owned.has(i)))return fail('Shared captured ownership');
  const others=input.otherPageOverlays.filter(x=>x!==item),otherRows=others.flatMap(x=>x.rows);let mask=hybridMasks(dl,indices,item.rows,otherRows,bounded);
  if(mask.reason)mask=planInkOverlayMasks({dl,owned:indices,rows:item.rows,liveDL:e.dl,otherOverlays:others,fonts,scale});
  if(mask.reason)return fail('Neighbour overlay is not safely drawable: '+mask.reason);
  // A white-mask intersection is harmless. Actual other-unit ink is not.
  if(!capturedRemovalOverlaysSafe(mask.rects,others,fonts,scale))return fail('Neighbour mask intersects other live ink');
  manifest.push({parId:overlay.parId,sourceRevision:overlay.revision,editId:e.edit_id,dl:overlay.dl,event:e});
 }
 if(!capturedRemovalOverlaysSafe(removal.rects,input.otherPageOverlays,fonts,scale))return fail('Removal intersects retained live ink');
 return {ok:true as const,projection:removal,safeOverlayManifest:manifest};
}
