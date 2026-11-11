import type {Fragment} from '../vendor/src/protocol';

export type InsertionAnchors =
 | {ok:true;page:number;before:Fragment;after:Fragment;pageEnd?:true}
 | {ok:false;reason:string};
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const coordinate=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;

function validate(fragments:readonly Fragment[]|undefined):string|null{
 if(!Array.isArray(fragments)||!fragments.length||fragments.length>10000)return 'Missing or excessive anchor fragments';
 let previousPage=0,nextLine=1,rows=0;
 for(const fragment of fragments){
  if(!fragment||fragment.approximate!==false)return 'Anchor fragments must all be exact';
  if(!integer(fragment.page)||fragment.page<=previousPage)return 'Anchor pages repeat or are reordered';
  if(!integer(fragment.first_line)||!integer(fragment.last_line)||fragment.first_line!==nextLine||fragment.last_line<fragment.first_line)return 'Anchor line ranges are incomplete, overlapping or reordered';
  const count=fragment.last_line-fragment.first_line+1;rows+=count;
  if(rows>100000||!Array.isArray(fragment.baselines)||!Array.isArray(fragment.xs)||fragment.baselines.length!==count||fragment.xs.length!==count||!coordinate(fragment.x)||fragment.x!==fragment.xs[0])return 'Anchor row coordinates do not match its line range';
  if(fragment.xs.some(x=>!coordinate(x))||fragment.baselines.some((y,i)=>!coordinate(y)||(i>0&&y<=fragment.baselines[i-1])))return 'Anchor baselines are invalid, repeated or reordered';
  previousPage=fragment.page;nextLine=fragment.last_line+1;
 }
 return null;
}

/** Select only the page containing a source boundary, without moving earlier/later
 * fragments. Caller must prove source order and matching layout versions, then
 * resolve complete capture-unit ownership and run the material/whitespace planner.
 * This establishes fragment order, not ink bounds or permission to paint. */
export function selectInsertionAnchors(before:readonly Fragment[]|undefined,after:readonly Fragment[]|undefined,allowAdjacentPageEnd=false):InsertionAnchors{
 for(const [name,fragments] of [['Before',before],['After',after]] as const){const reason=validate(fragments);if(reason)return {ok:false,reason:`${name}: ${reason}`};}
 const last=before![before!.length-1],first=after![0];
 if(last.page!==first.page){if(allowAdjacentPageEnd&&first.page===last.page+1)return {ok:true,page:last.page,before:last,after:first,pageEnd:true};return {ok:false,reason:'Insertion boundary crosses physical pages'};}
 if(last.baselines[last.baselines.length-1]>=first.baselines[0])return {ok:false,reason:'Boundary anchors overlap or reverse vertical order'};
 return {ok:true,page:last.page,before:last,after:first};
}
