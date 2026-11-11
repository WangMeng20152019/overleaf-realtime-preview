import {glyphInkBounds} from './glyph-bounds.ts';
import type {DisplayList,FontDesc,Item,Placement} from '../vendor/src/protocol';
type Rect=[number,number,number,number];
type Input={dl:DisplayList;page:number;parId:number;placements:readonly Placement[];ownedLineIndices:ReadonlySet<number>;fonts:{get(desc:FontDesc):unknown};scale:number};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<1e12;
const intersects=(a:Rect,b:Rect)=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1];
function flagged(value:unknown):boolean {if(value==null||value===false||value===0)return false;if(Array.isArray(value))return value.some(flagged);if(typeof value==='object')return Object.values(value).some(flagged);return true;}
/** Geometry only. Caller fences immutable layout identity, source revisions and tombstones.
 * Hidden rows MUST replay preservedStateItems in their original row/item order, so
 * deleting ink cannot change subsequent rows' color stack. No neighbour is moved.
 */
export function planCapturedRemoval(input:Input):{ok:true;rects:Rect[];hiddenLineIndices:number[];preservedStateItems:{lineIndex:number;itemIndex:number;item:Item}[]}|{ok:false;reason:string}{
 const fail=(reason:string)=>({ok:false as const,reason});const {dl,page,parId,placements,ownedLineIndices:owned,fonts,scale}=input;
 if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(parId)||parId<1||!finite(scale)||scale<=0||scale>1||!Array.isArray(dl.lines)||!Array.isArray(dl.other)||dl.lines.length>20000)return fail('Invalid page or scale');
 if(flagged(dl.flags)||flagged(dl.inserts))return fail('Unknown page paint or inserts');
 const width=dl.page_width??dl.width,height=dl.page_height??dl.height;if(!finite(width)||!finite(height)||width<=0||height<=0)return fail('Invalid page bounds');
 const matches=placements.filter(p=>p.par_id===parId);if(matches.length!==1)return fail('Ambiguous paragraph');const placement=matches[0];
 if(!['Body','par'].includes(placement.kind)||placement.fragments.length!==1||placement.fragments[0].page!==page||placement.fragments[0].approximate!==false)return fail('Only exact single-page Body removal is supported');
 const fragment=placement.fragments[0];if(!owned.size||placement.lines!==owned.size||fragment.baselines.length!==owned.size||fragment.xs.length!==owned.size||fragment.first_line!==1||fragment.last_line!==owned.size)return fail('Incomplete paragraph ownership');
 const near=(a:number,b:number)=>finite(a)&&finite(b)&&Math.abs(a-b)<=64;
 const anchors=new Map<number,number>();const anchorIndices:number[]=[];
 for(const p of placements)for(const f of p.fragments){if(f.page!==page)continue;if(f.approximate||f.baselines.length!==f.xs.length)return fail('Ambiguous placement inventory');for(let n=0;n<f.baselines.length;n++){const found=dl.lines.flatMap((line,i)=>near(line.y,f.baselines[n])&&near(line.x,f.xs[n])?[i]:[]);if(found.length!==1)return fail('Placement anchor is not one-to-one');const i=found[0];if(anchors.has(i))return fail('Shared row ownership');anchors.set(i,p.par_id);if(p.par_id===parId)anchorIndices.push(i);}}
 const indices=[...owned].sort((a,b)=>a-b);if(indices.some(i=>!Number.isSafeInteger(i)||i<0||!dl.lines[i]))return fail('Invalid owned row');
 const units=new Set(anchorIndices.map(i=>dl.lines[i].unit).filter(u=>u!==undefined&&u!==0));
 const expected=new Set(anchorIndices);for(let i=0;i<dl.lines.length;i++)if(units.has(dl.lines[i].unit))expected.add(i);
 if(expected.size!==owned.size||[...expected].some(i=>!owned.has(i)))return fail('Incomplete capture unit ownership');
 if(indices.some(i=>anchors.has(i)&&anchors.get(i)!==parId))return fail('Shared capture unit ownership');
 const masks:Rect[]=[],obstacles:Rect[]=[],states:{lineIndex:number;itemIndex:number;item:Item}[]=[];const pad=1.5/scale;
 const ink=(item:Item):Rect|null|false=>{if(item[0]==='c')return null;if(item[0]==='m')return item.length===3&&['on','off'].includes(String(item[1]))&&finite(item[2])?null:false;if(item[0]==='g'){const desc=dl.fonts[String(item[1])];let b;try{b=glyphInkBounds(desc,item,fonts.get(desc));}catch{return false;}return b?[b.x0,b.y0,b.x1,b.y1]:false;}
 if(item[0]==='r'){const [,x,y,w,h]=item;if(![x,y,w,h].every(finite)||Number(w)<0||Number(h)<0)return false;return [Number(x),Number(y),Number(x)+Math.max(Number(w),1/scale),Number(y)+Math.max(Number(h),1/scale)];}
 if(item[0]==='i'){const [,key,x,y,w,h]=item;if(![x,y,w,h].every(finite)||Number(w)<=0||Number(h)<=0||!dl.images_info?.[String(key)])return false;return [Number(x),Number(y),Number(x)+Number(w),Number(y)+Number(h)];}return false;};
 for(let i=0;i<dl.lines.length;i++)for(const [j,item]of dl.lines[i].items.entries()){const rect=ink(item);if(rect===false)return fail('Unbounded page item or unavailable glyph');if(!rect){if(owned.has(i)&&item[0]==='c')states.push({lineIndex:i,itemIndex:j,item:[...item]});continue;}if(owned.has(i)){if(item[0]==='i')return fail('Owned image unsupported');if(rect[2]>rect[0]||rect[3]>rect[1])masks.push([rect[0]-pad,rect[1]-pad,rect[2]+pad,rect[3]+pad]);}else obstacles.push(rect);}
 for(const item of dl.other){const rect=ink(item);if(rect===false)return fail('Unbounded global paint');if(rect)obstacles.push(rect);}
 // Cached pictures can be painted by PDF without a corresponding i item.
 for(const info of Object.values(dl.images_info??{})){if(info.cached_picture&&!info.bbox)return fail('Unbounded cached picture');if(info.bbox){if(info.bbox.length!==4||!info.bbox.every(finite)||info.bbox[2]<info.bbox[0]||info.bbox[3]<info.bbox[1])return fail('Invalid image bounds');obstacles.push([...info.bbox]);}}
 if(!masks.length)return fail('No removable ink');if(masks.some(r=>r[0]<0||r[1]<0||r[2]>width||r[3]>height))return fail('Ink exceeds page');
 // Only untouched white paper may be exposed: any other paint underneath or
 // adjacent to padded ink prevents this projection, including background fills.
 if(masks.some(r=>obstacles.some(o=>intersects(r,[o[0]-pad,o[1]-pad,o[2]+pad,o[3]+pad]))))return fail('Removal intersects other page paint');
 return {ok:true,rects:masks,hiddenLineIndices:indices,preservedStateItems:states};
}

/** A projection must never be silently skipped when another overlay arrives:
 * unsafe callers retain the last frame instead of repainting deleted base ink.
 * All coordinates below use the same page-space as the removal rectangles. */
export function capturedRemovalOverlaysSafe(rects:readonly Rect[],overlays:readonly {rows:readonly {line:{items:Item[]};dx:number;dy:number}[];dl?:DisplayList;overlay?:{dl:DisplayList}}[],fonts:{get(desc:FontDesc):unknown},scale:number):boolean {
 if(!finite(scale)||scale<=0||scale>1||!rects.length||rects.some(r=>r.length!==4||!r.every(finite)||r[2]<r[0]||r[3]<r[1]))return false;
 const pad=1.5/scale;
 for(const overlay of overlays){const dl=overlay.dl??overlay.overlay?.dl;if(!dl||flagged(dl.flags)||flagged(dl.inserts)||!Array.isArray(dl.other))return false;
  const test=(item:Item,dx:number,dy:number):boolean=>{if(!finite(dx)||!finite(dy))return false;let r:Rect;if(item[0]==='c')return true;if(item[0]==='m')return item.length===3&&['on','off'].includes(String(item[1]))&&finite(item[2]);
   if(item[0]==='g'){let b;try{const desc=dl.fonts[String(item[1])];b=glyphInkBounds(desc,item,fonts.get(desc));}catch{return false;}if(!b)return false;r=[b.x0+dx,b.y0+dy,b.x1+dx,b.y1+dy];}
   else if(item[0]==='r'){const [,x,y,w,h]=item;if(![x,y,w,h].every(finite)||Number(w)<0||Number(h)<0)return false;r=[Number(x)+dx,Number(y)+dy,Number(x)+dx+Math.max(Number(w),1/scale),Number(y)+dy+Math.max(Number(h),1/scale)];}
   else if(item[0]==='i'){const [,key,x,y,w,h]=item;if(![x,y,w,h].every(finite)||Number(w)<=0||Number(h)<=0||!dl.images_info?.[String(key)])return false;r=[Number(x)+dx,Number(y)+dy,Number(x)+dx+Number(w),Number(y)+dy+Number(h)];}
   else return false;
   return !rects.some(mask=>intersects(mask,[r[0]-pad,r[1]-pad,r[2]+pad,r[3]+pad]));
  };
  if(overlay.rows.length>20000)return false;for(const row of overlay.rows)if(!row.line||!Array.isArray(row.line.items)||!row.line.items.every(item=>test(item,row.dx,row.dy)))return false;
  for(const item of dl.other)if(!test(item,0,0))return false;
  for(const info of Object.values(dl.images_info??{})){if(info.cached_picture&&!info.bbox)return false;if(info.bbox){const b=info.bbox;if(b.length!==4||!b.every(finite)||b[2]<b[0]||b[3]<b[1]||rects.some(r=>intersects(r,[b[0]-pad,b[1]-pad,b[2]+pad,b[3]+pad])))return false;}}
 }
 return true;
}
