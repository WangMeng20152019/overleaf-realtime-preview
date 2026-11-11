import type {DisplayList,Item,Line} from '../vendor/src/protocol';
import type {PageOverlay} from '../vendor/webview/model';
import type {BoundedOtherGlyph} from './glyph-bounds';
import {hybridMasks} from './hybrid-overlay.ts';
export type FlowPageInput={base:DisplayList;overlays:readonly PageOverlay[];owned:ReadonlyMap<number,ReadonlySet<number>>;anchors:readonly number[];boundedOtherGlyphs?:readonly BoundedOtherGlyph[]};
export type FlowPageResult={ok:true;dl:DisplayList;anchorLineIndices:Map<number,number[]>;overlayVersions:{parId:number;revision:number}[]}|{ok:false;reason:string};
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e12;
const fail=(reason:string):FlowPageResult=>({ok:false,reason});
/** Geometry-only composition of already-validated, already-painted overlays.
 * Caller proves revision/canvas parity and source provenance; this never certifies a bitmap.
 */
export function composeFlowPage(input:FlowPageInput):FlowPageResult{
 const {base,overlays,owned,anchors}=input;
 if(!base||!Array.isArray(base.lines)||!Array.isArray(base.other)||!Array.isArray(overlays)||overlays.length>64||!Array.isArray(anchors)||!anchors.length||anchors.some(p=>!positive(p))||new Set(anchors).size!==anchors.length)return fail('Invalid composition input');
 if(base.lines.some(line=>!line||!Array.isArray(line.items)||line.items.some(it=>!Array.isArray(it)||!['g','r','c','m'].includes(it[0]))))return fail('Unsupported captured row material');
 const ids=new Set<number>(),ownerByIndex=new Map<number,number>();
 // Ownership for every requested unit is complete, including same-unit sibling rows.
 for(const [parId,indices]of owned){if(!positive(parId)||!indices.size)return fail('Missing owned geometry');const units=new Set<number>();for(const i of indices){if(!Number.isSafeInteger(i)||i<0||i>=base.lines.length||!base.lines[i]||ownerByIndex.has(i))return fail('Shared or invalid row ownership');ownerByIndex.set(i,parId);if(positive(base.lines[i].unit))units.add(base.lines[i].unit!);}if(base.lines.some((line,i)=>units.has(line.unit!)&&!indices.has(i)))return fail('Incomplete unit ownership');}
 for(const id of anchors)if(!owned.has(id))return fail('Missing anchor ownership');
 const replaced=new Set<number>();
 for(const ov of overlays){const id=ov?.overlay?.parId;if(!positive(id)||ids.has(id)||!Number.isSafeInteger(ov.overlay.revision)||ov.overlay.revision<0||!Array.isArray(ov.rows)||!ov.rows.length||ov.rows.length>512||!owned.has(id))return fail('Invalid or unowned overlay');ids.add(id);for(const index of owned.get(id)!){const line=base.lines[index];for(const it of line.items)if(it[0]==='r'&&(![it[1],it[2],it[3],it[4]].every(finite)||Number(it[3])<0||Number(it[4])<0||Number(it[1])<line.x||Number(it[1])+Number(it[3])>line.x+line.w||Number(it[2])<line.y-line.h||Number(it[2])+Number(it[4])>line.y+line.d))return fail('Captured rule exceeds owned row');replaced.add(index);}
  if(Object.keys(ov.overlay.dl?.flags??{}).length||Number(ov.overlay.dl?.inserts??0)>0)return fail('Unbounded live flags');
  if(!ov.overlay.dl||!Array.isArray(ov.overlay.dl.other)||ov.overlay.dl.other.some(it=>!Array.isArray(it)||!['c','m'].includes(it[0]))||Object.keys(ov.overlay.dl.images_info??{}).length)return fail('Overlay has extra non-row material');
  for(const row of ov.rows){const line=row?.line;if(!line||![line.x,line.y,line.w,line.h,line.d,row.dx,row.dy].every(finite)||line.w<=0||line.h<0||line.d<0||line.h+line.d<=0||!Array.isArray(line.items)||line.items.some(it=>!Array.isArray(it)||!['g','r','c','m'].includes(it[0])))return fail('Unsupported live row geometry');}
  const checked=hybridMasks(base,new Set(owned.get(id)),ov.rows,overlays.filter(other=>other!==ov).flatMap(other=>other.rows),input.boundedOtherGlyphs??[]);if(checked.reason)return fail(checked.reason);
 }
 const lines:Line[]=[],anchorLineIndices=new Map<number,number[]>(anchors.map(id=>[id,[]]));
 function append(line:Line,owner:number|undefined){const index=lines.length;lines.push(line);if(owner!==undefined)anchorLineIndices.get(owner)?.push(index);}
 base.lines.forEach((line,index)=>{if(!replaced.has(index))append({...line,items:line.items.map(it=>[...it])},ownerByIndex.get(index));});
 const fonts={...base.fonts};let fontId=1;const used=new Set(Object.keys(fonts));
 for(const ov of overlays){const map=new Map<string,number>();for(const [key,desc]of Object.entries(ov.overlay.dl.fonts??{})){while(used.has(String(fontId)))fontId++;map.set(key,fontId);used.add(String(fontId));fonts[String(fontId++)]=desc;}
  for(const row of ov.rows){const items:Item[]=[];for(const original of row.line.items){const it=[...original] as Item;if(it[0]==='g'){const mapped=map.get(String(it[1]));if(mapped===undefined||![it[4],it[5],it[6]].every(finite)||Number(it[6])<0)return fail('Missing font or invalid live glyph');it[1]=mapped;it[4]=Number(it[4])+row.dx;it[5]=Number(it[5])+row.dy;}else if(it[0]==='r'){if(![it[1],it[2],it[3],it[4]].every(finite)||Number(it[3])<0||Number(it[4])<0)return fail('Invalid live rule');if(Number(it[1])<row.line.x||Number(it[1])+Number(it[3])>row.line.x+row.line.w||Number(it[2])<row.line.y-row.line.h||Number(it[2])+Number(it[4])>row.line.y+row.line.d)return fail('Live rule exceeds captured row');it[1]=Number(it[1])+row.dx;it[2]=Number(it[2])+row.dy;}items.push(it);}
   append({...row.line,x:row.line.x+row.dx,y:row.line.y+row.dy,unit:undefined,items},ov.overlay.parId);
  }
 }
 if(anchors.some(id=>!anchorLineIndices.get(id)?.length))return fail('Anchor disappeared during composition');
 return {ok:true,dl:{...base,fonts,lines,other:base.other.map(it=>[...it])},anchorLineIndices,overlayVersions:overlays.map(o=>({parId:o.overlay.parId,revision:o.overlay.revision})).sort((a,b)=>a.parId-b.parId)};
}
