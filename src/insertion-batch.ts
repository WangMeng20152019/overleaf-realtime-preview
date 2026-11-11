import {textFontSignature,type ParagraphRhythm} from './paragraph-rhythm.ts';
import type {DisplayList,Item,Versions} from '../vendor/src/protocol';

const finite=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e12;
const id=(v:any)=>Number.isSafeInteger(v)&&v>0;
const keys=['engine_generation','context_revision','layout_version'];
const fail=(reason:string)=>({ok:false as const,reason});
const flagged=(v:any)=>v!=null&&(typeof v==='object'?Object.keys(v).length>0:Boolean(v));
/** Geometry assembly only. The caller supplies authenticated source membership,
 * checks each original DL's resource lease, and paints each block separately.
 * Only PGs within each verified text revision floor and current batch revision
 * are admitted; this never paints a partial batch. */
export function assembleInsertionBatch(meta:any,records:Map<number,any>,rhythm?:ParagraphRhythm|null){
 const entries=meta?.insertions;
 if(!Array.isArray(entries)||entries.length<1||entries.length>8||meta.insertionCount!==entries.length||!id(meta.sourceRevision)||!meta.baseVersions||['source_revision',...keys].some(k=>!Number.isSafeInteger(meta.baseVersions[k])||meta.baseVersions[k]<0))return fail('Invalid insertion batch');
 const ids=new Set<number>(),blocks:any[]=[],fonts:any={},lines:any[]=[];let cursor=0,fontId=1,itemCount=0,totalUs=0;
 const plain=new Set(Array.isArray(meta?.plainBodyParIds)?meta.plainBodyParIds:[]);
 for(const entry of entries){
  if(!id(entry?.parId)||ids.has(entry.parId)||entry.beforeParId!==meta.beforeParId||entry.afterParId!==meta.afterParId||!id(entry.sourceRevision)||entry.sourceRevision>meta.sourceRevision||entry.sourceRevision<=meta.baseVersions.source_revision)return fail('Invalid insertion membership');
  ids.add(entry.parId);const record=records.get(entry.parId),e=record?.event;
  if(!e||e.par_id!==entry.parId||e.status!=='ok'||!Number.isSafeInteger(e.versions?.source_revision)||e.versions.source_revision<entry.sourceRevision||e.versions.source_revision>meta.sourceRevision||keys.some(k=>e.versions[k]!==meta.baseVersions[k]))return fail('Waiting for exact insertion paragraphs');
  const dl:DisplayList=e.dl;
  if(!dl||!Array.isArray(dl.lines)||!dl.lines.length||lines.length+dl.lines.length>128||!Array.isArray(dl.other??[])||flagged(dl.flags)||Number(dl.inserts??0)>0||dl.other.some(it=>!Array.isArray(it)||!['c','m'].includes(it[0])))return fail('Unsupported insertion batch material');
  itemCount+=dl.other.length;if(itemCount>65536)return fail('Unsupported insertion batch item');
  let top=Infinity,bottom=-Infinity,left=Infinity;
  for(const line of dl.lines){
   if(!line||![line.x,line.y,line.w,line.h,line.d].every(finite)||line.w<0||line.h<0||line.d<0||!Array.isArray(line.items))return fail('Invalid insertion row');
   left=Math.min(left,line.x);
   if(line.h+line.d>0){top=Math.min(top,line.y-line.h);bottom=Math.max(bottom,line.y+line.d);}
   for(const it of line.items){
    if(++itemCount>65536||!Array.isArray(it)||!['g','r','c','m'].includes(it[0]))return fail('Unsupported insertion batch item');
    if(it[0]==='g'){
     if(![it[4],it[5],it[6]].every(finite)||Number(it[6])<0||!dl.fonts?.[String(it[1])])return fail('Invalid insertion glyph');
     top=Math.min(top,Number(it[5])-line.h);bottom=Math.max(bottom,Number(it[5])+line.d);
    }else if(it[0]==='r'){
     if(!it.slice(1,5).every(finite)||Number(it[3])<0||Number(it[4])<0)return fail('Invalid insertion rule');
     top=Math.min(top,Number(it[2]));bottom=Math.max(bottom,Number(it[2])+Number(it[4]));
    }
   }
  }
  if(![left,top,bottom].every(finite)||bottom<=top)return fail('Empty insertion block');
  const first=dl.lines.find(line=>line.h+line.d>0)??dl.lines[0];
  let dy=cursor-top;
  const previous=blocks.at(-1),advance=rhythm?.paragraphAdvance??rhythm?.lineAdvance;
  if(previous&&rhythm&&finite(advance)&&Number(advance)>0&&plain.has(previous.parId)&&plain.has(entry.parId)&&textFontSignature(previous.event.dl)===rhythm.fontSignature&&textFontSignature(dl)===rhythm.fontSignature)dy=Math.max(dy,previous.event.dl.lines.at(-1)!.y+previous.dy+Number(advance)-first.y);
  const dx=-left,fontMap=new Map<string,number>();
  for(const [key,desc]of Object.entries(dl.fonts??{})){if(fontId>4096)return fail('Insertion font budget exceeded');fontMap.set(key,fontId);fonts[String(fontId++)]=desc;}
  for(const line of dl.lines){
   const items:Item[]=line.items.map(original=>{const it=[...original] as Item;if(it[0]==='g'){it[1]=fontMap.get(String(it[1]));it[4]=Number(it[4])+dx;it[5]=Number(it[5])+dy;}else if(it[0]==='r'){it[1]=Number(it[1])+dx;it[2]=Number(it[2])+dy;}return it;});
   lines.push({...line,x:line.x+dx,y:line.y+dy,unit:entry.parId,items});
  }
  blocks.push({parId:entry.parId,sourceRevision:entry.sourceRevision,event:e,stage:record.stage,dx,dy,firstBaseline:first.y+dy,top:top+dy,bottom:bottom+dy});
  cursor=bottom+dy+131072;totalUs+=Number.isFinite(e.timing?.total_us)?e.timing.total_us:0;
 }
 const dl:DisplayList={lines,other:[],fonts,flags:{}};
 return{ok:true as const,dl,blocks,versions:{...meta.baseVersions,source_revision:meta.sourceRevision} as Versions,totalUs};
}

/** A new plan may replace a visible batch only if it accounts for every live
 * member. A verified source deletion is explicit, never inferred from omission. */
export function batchAccountsFor(previous:number[],next:number[],removed:number[]=[]){
 return previous.every(id=>next.includes(id)||removed.includes(id));
}
