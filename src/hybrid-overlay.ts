import type {BoundedOtherGlyph} from './glyph-bounds';
import type {DisplayList,Line} from '../vendor/src/protocol';
type Rect=[number,number,number,number];type Row={line:Line;dx:number;dy:number};
const PAD=32768;
const overlap=(a:Rect,b:Rect)=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1];
function box(line:Line,dx=0,dy=0,pad=0):Rect|null{const values=[line.x,line.y,line.w,line.h,line.d,dx,dy];if(!values.every(Number.isFinite)||line.w<=0||line.h+line.d<=0)return null;return [line.x+dx-pad,line.y+dy-line.h-pad,line.x+dx+line.w+pad,line.y+dy+line.d+pad];}
/** Masks are limited to the edited unit and refused when neighbouring captured material overlaps. */
export function hybridMasks(dl:DisplayList,owned:Set<number>,rows:Row[],otherOverlayRows:readonly Row[]=[],boundedOtherGlyphs:readonly BoundedOtherGlyph[]=[]):{rects:Rect[];reason?:undefined}|{rects:[];reason:string}{
 if(!owned.size||!rows.length)return {rects:[],reason:'No captured paragraph geometry'};
 const masks:Rect[]=[];
 for(const i of owned){const rect=Number.isSafeInteger(i)&&i>=0&&dl.lines[i]&&box(dl.lines[i],0,0,PAD);if(!rect)return {rects:[],reason:'Invalid old paragraph geometry'};masks.push(rect);}
 for(const row of rows){const rect=box(row.line,row.dx,row.dy,PAD);if(!rect)return {rects:[],reason:'Invalid live paragraph geometry'};masks.push(rect);}
 const obstacles:Rect[]=[];
 // Live units can move beyond their old captured boxes. Test their current rows as
 // well as background rows, before either unit can erase or cover the other.
 for(const row of otherOverlayRows){const rect=box(row.line,row.dx,row.dy);if(!rect)return {rects:[],reason:'Invalid neighbouring live geometry'};obstacles.push(rect);}
 const width=dl.page_width??dl.width,height=dl.page_height??dl.height;
 if(width!==undefined||height!==undefined){
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return {rects:[],reason:'Invalid page geometry'};
  if(masks.some(([x0,y0,x1,y1])=>x0<0||y0<0||x1>width||y1>height))return {rects:[],reason:'Live paragraph exceeds page bounds'};
 }
 for(let i=0;i<dl.lines.length;i++)if(!owned.has(i)){const rect=box(dl.lines[i]);if(rect)obstacles.push(rect);}
 const glyphs=new Map<number,Rect>();for(const entry of boundedOtherGlyphs){const item=dl.other?.[entry.itemIndex],r=entry.rect;if(!Number.isSafeInteger(entry.itemIndex)||glyphs.has(entry.itemIndex)||item?.[0]!=='g'||JSON.stringify(item)!==JSON.stringify(entry.item)||!r||![r.x0,r.y0,r.x1,r.y1].every(Number.isFinite)||r.x1<r.x0||r.y1<r.y0)return {rects:[],reason:'Invalid certified global glyph bounds'};glyphs.set(entry.itemIndex,[r.x0,r.y0,r.x1,r.y1]);}
 for(const [index,item]of (dl.other??[]).entries()){if(item[0]==='g'){const rect=glyphs.get(index);if(!rect)return {rects:[],reason:'Unbounded page material requires full PDF update'};obstacles.push(rect);continue;}if(['l','u','M'].includes(item[0]))return {rects:[],reason:'Unbounded page material requires full PDF update'};let rect:Rect|undefined;if(item[0]==='r'){const [,x,y,w,h]=item as [string,number,number,number,number];rect=[x,y,x+w,y+h];}else if(item[0]==='i'){const [,,x,y,w,h]=item as [string,number,number,number,number,number];rect=[x,y,x+w,y+h];}if(rect&&rect.every(Number.isFinite))obstacles.push(rect);}
 for(const info of Object.values(dl.images_info??{})){if(info.bbox?.length===4&&info.bbox.every(Number.isFinite))obstacles.push(info.bbox);}
 if(masks.some(mask=>obstacles.some(obstacle=>overlap(mask,obstacle))))return {rects:[],reason:'Live paragraph would cover neighbouring content'};
 return {rects:masks};
}
