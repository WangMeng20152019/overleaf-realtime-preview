import type {DisplayList,FontDesc,Item} from '../vendor/src/protocol';
export type GlyphRect={x0:number;y0:number;x1:number;y1:number};
export type BoundedOtherGlyph={itemIndex:number;item:readonly unknown[];rect:GlyphRect};
type Point={x:number;y:number};
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1e12;
// All Bezier curves lie inside their control polygon. Never use advance width as
// a painted-ink bound, and never substitute a generic font for missing outlines.
function commandPoints(commands:any[]):Point[]|null{
 const out:Point[]=[];if(!Array.isArray(commands)||commands.length>65536)return null;
 for(const c of commands){const keys=c?.type==='Z'?[]:c?.type==='M'||c?.type==='L'?['x','y']:c?.type==='C'?['x1','y1','x2','y2','x','y']:c?.type==='Q'?['x1','y1','x','y']:null;if(!keys||!keys.every(k=>finite(c[k])))return null;for(let i=0;i<keys.length;i+=2)out.push({x:c[keys[i]],y:c[keys[i+1]]});}return out;
}
function svgPoints(svg:unknown):Point[]|null{
 if(typeof svg!=='string'||svg.length>1000000)return null;
 const tokens=svg.match(/[MLCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)??[];
 if(svg.replace(/[MLCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g,'')!=='')return null;
 const out:Point[]=[];let i=0,cmd='';while(i<tokens.length){if(/^[MLCQZ]$/.test(tokens[i])){cmd=tokens[i++];if(cmd==='Z'){cmd='';continue;}}if(!cmd)return null;const n=cmd==='C'?6:cmd==='Q'?4:2;if(i+n>tokens.length)return null;const values=tokens.slice(i,i+n).map(Number);if(!values.every(finite))return null;for(let j=0;j<n;j+=2)out.push({x:values[j],y:values[j+1]});i+=n;if(out.length>65536)return null;if(cmd==='M')cmd='L';}return out;
}
/** Same local glyph transform as Painter. Caller must reject surrounding M/l/u items. */
export function glyphInkBounds(desc:FontDesc,item:Item,font:any):GlyphRect|null{
 if(!desc||!font||font.kind==='missing'||item?.[0]!=='g'||!finite(font.upem)||font.upem<=0)return null;
 const [, ,char,index,x,y,,ef]=item;if(![x,y].every(finite)||ef!=null&&!finite(ef))return null;
 let points:Point[]|null=null;
 try{if(font.kind==='sfnt'){if(!Number.isSafeInteger(index)||Number(index)<0||Number(index)>=font.font.numGlyphs)return null;points=commandPoints(font.font.glyphs.get(index).path.commands);}else if(font.kind==='type1'){if(!Number.isSafeInteger(char)||Number(char)<0)return null;points=svgPoints(font.src[char as number]);}else return null;}catch{return null;}
 if(!points)return null;
 const size=desc.size??655360,extend=desc.extend??0;let slant=(desc.slant??0)/1000,hx=(1+Number(ef??0)/1000000)*(extend?extend/1000:1);
 if(font.kind==='type1'){if(font.extend)hx*=font.extend;if(font.slant&&!slant)slant=font.slant;}
 if(![size,extend,slant,hx].every(finite)||size<=0)return null;
 const s=size/font.upem,b={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};
 if(!points.length)return {x0:Number(x),y0:Number(y),x1:Number(x),y1:Number(y)};
 for(const p of points){const px=Number(x)+s*(hx*p.x+slant*p.y),py=Number(y)-s*p.y;if(![px,py].every(finite))return null;b.x0=Math.min(b.x0,px);b.x1=Math.max(b.x1,px);b.y0=Math.min(b.y0,py);b.y1=Math.max(b.y1,py);}return b;
}
/** Complete item-index/fingerprint evidence for every global glyph; null if any outline is unavailable. */
export function boundOtherGlyphs(dl:DisplayList,fonts:{get(desc:FontDesc):unknown}):BoundedOtherGlyph[]|null{
 const out:BoundedOtherGlyph[]=[];if(!Array.isArray(dl.other))return null;
 for(let i=0;i<dl.other.length;i++){const item=dl.other[i];if(item[0]!=='g')continue;const desc=dl.fonts[String(item[1])];let rect:GlyphRect|null;try{rect=glyphInkBounds(desc,item,fonts.get(desc));}catch{return null;}if(!rect)return null;out.push({itemIndex:i,item:[...item],rect});}return out;
}
