import type {DisplayList,Item} from '../vendor/src/protocol';
import {glyphInkBounds,type GlyphRect} from './glyph-bounds.ts';
export type FlowTransform={lineIndex:number;startItem:number;endItem:number;glyphItem:number;pivot:{x:number;y:number};scale:number;ink:GlyphRect;bound:GlyphRect};
export type FlowTransformResult={ok:true;dl:DisplayList;transforms:FlowTransform[]}|{ok:false;reason:string};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e12;
const reject=(reason:string):FlowTransformResult=>({ok:false,reason});
/** Geometry-only normalization, never a display list to paint. The actual bitmap
 * must be rendered from the original DL, with the same fonts and renderScale.
 * Supports only isolated save/uniform-set/one-glyph/restore groups in one row.
 */
export function normalizeFlowTransforms(dl:DisplayList,fonts:{get(desc:any):unknown},renderScale=.000020):FlowTransformResult{
 if(!dl||!Array.isArray(dl.lines)||!Array.isArray(dl.other)||!finite(renderScale)||renderScale<=0||renderScale>1)return reject('Invalid transform normalization input');
 if(dl.lines.some(line=>!line||!Array.isArray(line.items)||line.items.some(it=>!Array.isArray(it)))||dl.other.some(it=>!Array.isArray(it)))return reject('Invalid transform drawing items');
 if(dl.other.some(it=>it?.[0]==='M'))return reject('Global transform is unsupported');
 if(!dl.lines.some(line=>line?.items?.some(it=>it?.[0]==='M')))return {ok:true,dl,transforms:[]};
 if(dl.lines.length>512)return reject('Transform page complexity exceeds scope');
 const transforms:FlowTransform[]=[],lines=dl.lines.map(line=>({...line,items:line.items?.map(it=>[...it]) as Item[]}));
 const pad=Math.max(65536,1/renderScale);
 for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
  const line=lines[lineIndex];if(!Array.isArray(line.items))return reject('Invalid transform row');const result:Item[]=[];
  for(let i=0;i<line.items.length;i++){
   const item=line.items[i];if(item[0]!=='M'){result.push(item);continue;}
   if(item[1]!=='save'||![item[2],item[3]].every(finite)||item.length>5||item[4]!=null&&item[4]!=='')return reject('Transform group must start with a plain save');
   const start=i,px=Number(item[2]),py=Number(item[3]);let scale:number|null=null,glyphItem=-1,bound:GlyphRect|null=null,ink:GlyphRect|null=null,closed=false;const control:Item[]=[];
   for(i++;i<line.items.length;i++){
    const current=line.items[i];
    if(current[0]==='M'){
     if(current[2]!==px||current[3]!==py||current.length>5)return reject('Transform pivot differs');
     if(current[1]==='set'){
      if(scale!==null||glyphItem!==-1||typeof current[4]!=='string')return reject('Multiple or misplaced transform matrices');
      const values=current[4].trim().split(/\s+/).map(Number);if(values.length!==4||!values.every(finite)||values[0]<=0||values[0]>16||values[1]!==0||values[2]!==0||values[3]!==values[0])return reject('Only positive uniform scaling is supported');scale=values[0];
     }else if(current[1]==='restore'){
      if(current[4]!=null&&current[4]!==''||scale===null||glyphItem===-1||!bound||!ink)return reject('Incomplete transform group');closed=true;break;
     }else return reject('Nested or unknown transform is unsupported');
    }else if(current[0]==='c'||current[0]==='m')control.push(current);
    else if(current[0]==='g'){
     if(scale===null||glyphItem!==-1)return reject('Exactly one glyph after the matrix is required');glyphItem=i;const desc=dl.fonts[String(current[1])];
     try{ink=glyphInkBounds(desc,current,fonts.get(desc));}catch{return reject('Transformed glyph outline is unavailable');}if(!ink)return reject('Transformed glyph outline is unavailable');
     // Painter conjugates by the y flip, which leaves uniform scaling unchanged.
     bound={x0:px+scale*(ink.x0-px)-pad,y0:py+scale*(ink.y0-py)-pad,x1:px+scale*(ink.x1-px)+pad,y1:py+scale*(ink.y1-py)+pad};
     if(!Object.values(bound).every(finite))return reject('Transformed glyph bounds exceed scope');
    }else return reject('Transform group contains additional or unknown ink');
   }
   if(!closed||!bound||!ink||scale===null)return reject('Cross-row or unclosed transform is unsupported');
   transforms.push({lineIndex,startItem:start,endItem:i,glyphItem,pivot:{x:px,y:py},scale,ink,bound});if(transforms.length>64)return reject('Too many transform groups');
   // Color/marker commands stay in original order. Their geometry-free placement
   // relative to the bounding rule is irrelevant: this copy must never be painted.
   result.push(...control,['r',bound.x0,bound.y0,bound.x1-bound.x0,bound.y1-bound.y0]);
  }
  line.items=result;
 }
 return {ok:true,dl:{...dl,lines},transforms};
}
