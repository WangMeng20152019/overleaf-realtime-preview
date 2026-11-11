import type {DisplayList,Line,Placement} from '../vendor/src/protocol';
export type ParagraphRhythm={fontSignature:string;lineAdvance:number|null;paragraphAdvance:number|null};
const finite=(n:any)=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<1e12;
const flagged=(v:any)=>v!=null&&(typeof v==='object'?Object.keys(v).length>0:Boolean(v));
function canonical(v:any):string{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
/** One actual used text font only; unused global font-table entries are ignored. */
export function textFontSignature(dl:DisplayList,rows:readonly Line[]=dl?.lines):string|null{
 if(!dl||!Array.isArray(rows)||!rows.length||flagged(dl.flags)||Number(dl.inserts??0)>0||!Array.isArray(dl.other??[])||(dl.other??[]).some(i=>!Array.isArray(i)||!['c','m'].includes(i[0])))return null;
 const signatures=new Set<string>();
 for(const r of rows){if(!r||![r.x,r.y,r.w,r.h,r.d].every(finite)||r.w<=0||r.h+r.d<=0||r.h<0||r.d<0||!Array.isArray(r.items))return null;let glyph=false;
  for(const it of r.items){if(!Array.isArray(it)||!['g','c','m'].includes(it[0]))return null;if(it[0]==='g'){const font=dl.fonts?.[String(it[1])];if(!font||![it[4],it[5],it[6]].every(finite)||Number(it[6])<0)return null;const resource=font.filename?`file:${font.filename}#${font.subfont??0}`:(font as any).fontKey??(font.name?`tfm:${font.name}`:null);if(!resource)return null;
     signatures.add(canonical({resource,...Object.fromEntries(['size','designsize','slant','extend','squeeze','subfont','format','type'].map(k=>[k,(font as any)[k]??null]))}));glyph=true;}}
  if(!glyph)return null;
 }return signatures.size===1?[...signatures][0]:null;
}
function consistent(values:number[],minimum:number){if(values.length<minimum||values.some(v=>!finite(v)||v<=0))return null;const mean=values.reduce((a,b)=>a+b,0)/values.length;return values.every(v=>Math.abs(v-mean)<=64)?mean:null;}
/** Same-page captured geometry only; no inferred theorem glue or page-break stride. */
export function inferParagraphRhythm(page:DisplayList,placements:readonly Placement[],expectedSignature?:string):ParagraphRhythm|null{
 if(!page||!Array.isArray(page.lines)||page.lines.length>512||!Array.isArray(placements)||placements.length>10000)return null;
 if(flagged(page.flags)||Number(page.inserts??0)>0||!Array.isArray(page.other??[]))return null;
 const obstacles:{top:number;bottom:number}[]=[];
 for(const item of page.other??[]){if(!Array.isArray(item))return null;if(['c','m'].includes(item[0]))continue;if(item[0]!=='r'||!item.slice(1,5).every(finite)||item.length<5||Number(item[3])<0||Number(item[4])<0)return null;obstacles.push({top:Number(item[2]),bottom:Number(item[2])+Number(item[4])});}
 const obstructs=(top:number,bottom:number)=>obstacles.some(r=>r.top<=bottom&&r.bottom>=top);
 const number=page.page;if(!Number.isSafeInteger(number)||Number(number)<1)return null;
 const owned=new Set<number>(),units:{indices:number[];rows:Line[];signature:string}[]=[];
 for(const p of placements){if(p.kind!=='par'||!Array.isArray(p.fragments)||p.fragments.length!==1)continue;const f=p.fragments[0];if(f.page!==number||f.approximate||!Array.isArray(f.baselines)||!f.baselines.length||p.lines!==f.baselines.length)continue;
  const indices:number[]=[];let valid=true;
  for(let k=0;k<f.baselines.length;k++){const x=f.xs?.[k]??f.x;const matches=page.lines.map((r,i)=>({r,i})).filter(({r})=>r.y===f.baselines[k]&&r.x===x);if(matches.length!==1||owned.has(matches[0].i)){valid=false;break;}indices.push(matches[0].i);}
  if(!valid||new Set(indices).size!==indices.length||indices.some((n,i)=>i>0&&n!==indices[i-1]+1))continue;
  const rows=indices.map(i=>page.lines[i]);if(obstructs(Math.min(...rows.map(r=>r.y-r.h)),Math.max(...rows.map(r=>r.y+r.d))))continue;const signature=textFontSignature({...page,other:[]},rows);if(!signature||(expectedSignature!==undefined&&signature!==expectedSignature))continue;
  // A captured unit may not secretly own additional rows outside its placement.
  const identifiers=new Set(rows.map(r=>r.unit).filter(n=>Number.isSafeInteger(n)&&Number(n)>0));if(identifiers.size&&page.lines.some((r,i)=>identifiers.has(r.unit)&&!indices.includes(i)))continue;
  indices.forEach(i=>owned.add(i));units.push({indices,rows,signature});
 }
 const candidates:ParagraphRhythm[]=[];
 for(const signature of new Set(units.map(u=>u.signature))){
 const group=units.filter(u=>u.signature===signature);
 const advances:number[]=[];for(const u of group)if(u.rows.length>=3)for(let i=1;i<u.rows.length;i++)advances.push(u.rows[i].y-u.rows[i-1].y);
 const lineAdvance=consistent(advances,2);if(advances.length>=2&&lineAdvance===null)continue;
 group.sort((a,b)=>a.indices[0]-b.indices[0]);const boundaries:number[]=[];
 for(let i=1;i<group.length;i++){const a=group[i-1],b=group[i],last=a.rows.at(-1)!,first=b.rows[0];if(b.indices[0]!==a.indices.at(-1)!+1||Math.abs(first.x-last.x)>64||obstructs(last.y+last.d,first.y-first.h))continue;boundaries.push(first.y-last.y);}
 const paragraphAdvance=consistent(boundaries,2);if(boundaries.length>=2&&paragraphAdvance===null)continue;
 if(paragraphAdvance!==null&&lineAdvance!==null&&paragraphAdvance<lineAdvance-64)continue;
 if(lineAdvance!==null||paragraphAdvance!==null)candidates.push({fontSignature:signature,lineAdvance,paragraphAdvance});
 }
 return candidates.length===1?candidates[0]:null;
}
