/** Hit-test actual engine baselines projected into viewport CSS pixels.
 * The caller supplies anchors from visible real page placements only. */
export function closestParagraph(anchors:{parId:number;y:number}[],y:number,maxDistance=24):number|null{
 if(!Number.isFinite(y)||!(maxDistance>=0))return null;
 let best:number|null=null,distance=Infinity;
 for(const anchor of anchors){
  if(!Number.isSafeInteger(anchor.parId)||anchor.parId<1||!Number.isFinite(anchor.y))continue;
  const delta=Math.abs(anchor.y-y);
  if(delta>maxDistance)continue;
  if(delta<distance||(delta===distance&&best!==null&&anchor.parId<best)){best=anchor.parId;distance=delta;}
 }
 return best;
}
