import {glyphInkBounds} from './glyph-bounds.ts';
import {planCapturedRemoval,capturedRemovalOverlaysSafe} from './captured-removal.ts';
import type {DisplayList,FontDesc,Item,Placement,Line} from '../vendor/src/protocol';
type Row={line:Line;dx:number;dy:number};type Rect=[number,number,number,number];
type Overlay={dl?:DisplayList;overlay?:{dl:DisplayList};rows:readonly Row[]};
/** Strict fallback: clear OLD actual ink only, never the new row's advance box.
 * Caller retains immutable layout/resource/version fences and paints original DL.
 */
export function planInkOverlayMasks(input:{dl:DisplayList;owned:ReadonlySet<number>;rows:readonly Row[];liveDL:DisplayList;otherOverlays?:readonly Overlay[];fonts:{get(desc:FontDesc):unknown};scale:number}) : {rects:Rect[];reason?:undefined}|{rects:[];reason:string}{
 const {dl,owned,rows,liveDL,fonts,scale}=input,fail=(reason:string)=>({rects:[] as [],reason});
 if(Object.keys(liveDL.images_info??{}).length)return fail('Live image metadata unsupported');
 if(!owned.size||!rows.length||rows.length>20000)return fail('Missing exact overlay rows');
 const indices=[...owned].sort((a,b)=>a-b);if(indices.some(i=>!dl.lines[i]))return fail('Invalid owned rows');
 // Planner is geometry-only; synthetic source IDs describe exact capture groups,
 // never equate capture unit IDs with source unit IDs.
 const fragment=(ids:number[])=>({page:1,first_line:1,last_line:ids.length,x:dl.lines[ids[0]].x,xs:ids.map(i=>dl.lines[i].x),baselines:ids.map(i=>dl.lines[i].y),approximate:false});
 const placements:Placement[]=[{par_id:1,kind:'par',lines:indices.length,fragments:[fragment(indices)]}];
 dl.lines.forEach((_,i)=>{if(!owned.has(i))placements.push({par_id:i+2,kind:'par',lines:1,fragments:[fragment([i])]});});
 const old=planCapturedRemoval({dl,page:1,parId:1,placements,ownedLineIndices:owned,fonts,scale});if(!old.ok)return fail(old.reason);
 const pad=1.5/scale,width=dl.page_width??dl.width,height=dl.page_height??dl.height,newInk:Rect[]=[];
 const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<1e12;
 const add=(item:Item,dx:number,dy:number):boolean=>{if(!finite(dx)||!finite(dy))return false;if(item[0]==='c')return true;if(item[0]==='m')return item.length===3&&['on','off'].includes(String(item[1]))&&finite(item[2]);let r:Rect;
 if(item[0]==='g'){let b;try{const d=liveDL.fonts[String(item[1])];b=glyphInkBounds(d,item,fonts.get(d));}catch{return false;}if(!b)return false;r=[b.x0+dx,b.y0+dy,b.x1+dx,b.y1+dy];}
 else if(item[0]==='r'){const [,x,y,w,h]=item;if(![x,y,w,h].every(finite)||Number(w)<0||Number(h)<0)return false;r=[Number(x)+dx,Number(y)+dy,Number(x)+dx+Math.max(Number(w),1/scale),Number(y)+dy+Math.max(Number(h),1/scale)];}else return false;
 if(r[0]-pad<0||r[1]-pad<0||r[2]+pad>width||r[3]+pad>height)return false;if(r[2]>r[0]||r[3]>r[1])newInk.push([r[0]-pad,r[1]-pad,r[2]+pad,r[3]+pad]);return true;};
 for(const row of rows)for(const item of row.line.items)if(!add(item,row.dx,row.dy))return fail('Unbounded live ink');for(const item of liveDL.other??[])if(!add(item,0,0))return fail('Unbounded global live ink');
 // This also validates live flags/resources even when live ink is all whitespace.
 if(!capturedRemovalOverlaysSafe(old.rects,input.otherOverlays??[],fonts,scale))return fail('Old ink mask intersects another live overlay');
 const remaining:Overlay={dl,rows:dl.lines.filter((_,i)=>!owned.has(i)).map(line=>({line,dx:0,dy:0}))};
 if(newInk.length&&!capturedRemovalOverlaysSafe(newInk,[remaining,...input.otherOverlays??[]],fonts,scale))return fail('New ink intersects neighbouring paint');
 // Validate flags/global bounds against old masks without treating own new ink
 // as an obstacle to the old ink it is explicitly replacing.
 const liveFlags={...liveDL,other:[],images_info:{}};
 if(!capturedRemovalOverlaysSafe(old.rects,[{dl:liveFlags,rows:[]}],fonts,scale))return fail('Unsupported live display flags');
 return {rects:old.rects};
}
