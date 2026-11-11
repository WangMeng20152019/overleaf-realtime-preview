/** One panel per launcher, including clicks and close events during asynchronous setup. */
export function createPanelLifecycle(mount,config,{onState=()=>{},onError=()=>{}}={}){
 let state='idle',panel=null,pending=null,closedDuringOpen=false,generation=0;
 const change=next=>{state=next;onState(next);};
 const closed=id=>{
  if(state==='disposed'||id!==generation)return;
  panel=null;
  if(state==='opening')closedDuringOpen=true;
  else change('idle');
 };
 function open(){
  if(state==='disposed')return Promise.resolve(null);
  if(state==='open'){panel?.focus?.();return Promise.resolve(panel);}
  if(state==='opening')return pending;
  closedDuringOpen=false;const id=++generation;change('opening');
  pending=Promise.resolve().then(()=>state==='disposed'?null:mount({...config,onClose:()=>closed(id)})).then(result=>{
   if(state==='disposed'||closedDuringOpen){result?.close();if(state!=='disposed')change('idle');return null;}
   panel=result;change('open');return panel;
  }).catch(error=>{if(state!=='disposed'){panel=null;change('idle');onError(error);}return null;}).finally(()=>{pending=null;});
  return pending;
 }
 function close(){
  if(state==='opening'){closedDuringOpen=true;return;}
  if(state==='open'){const current=panel;panel=null;current?.close();if(state!=='disposed'&&state!=='idle')change('idle');}
 }
 function dispose(){if(state==='disposed')return;const current=panel;panel=null;change('disposed');current?.close();}
 return {open,close,dispose,get state(){return state;}};
}
