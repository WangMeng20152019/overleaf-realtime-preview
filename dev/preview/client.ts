import {textSequencePlan} from './text-sequence'
import {mathConstructionPlan} from './math-construction'
import {OwnedInsertions} from './owned-insertions'
import {EditorState,Compartment} from '@codemirror/state'
import {EditorView,ViewPlugin} from '@codemirror/view'
import {rtexBridge} from '../../integration/source-patch/rtex-bridge'
import {installOverleafProject} from '../../integration/project-entry'

const config=await(await fetch('/fixture/config')).json()
const frame=document.querySelector<HTMLIFrameElement>('#preview')!
const log=document.querySelector<HTMLElement>('#log')!
const bridgeStatus=document.querySelector<HTMLElement>('#bridge-status')!
const previewStatus=document.querySelector<HTMLElement>('#preview-status')!
const metrics=document.querySelector<HTMLElement>('#metrics')!
const mode=document.querySelector<HTMLElement>('#native-mode')!
const typingStatus=document.querySelector<HTMLElement>('#typing-status')!
const typingResult=document.querySelector<HTMLElement>('#typing-result')!
const typingControls=new Compartment()
const ownedInsertions=new OwnedInsertions()
const record=(message:string)=>{log.textContent=(new Date().toISOString().slice(11,23)+' '+message+'\n'+log.textContent).slice(0,12000)}
let ready=false,lastCursor:any=null,latestAck:any=null,view:EditorView,stopped=false,typingBusy=false,canonicalDesired:string|null=null,canonicalRunning=false
let typingAbort:AbortController|null=null
const pendingTimings:any[]=[]
let sequenceTrace:any=null
let matrixDeletionObserver:(()=>void)|null=null
function traceEvent(kind:string,value:any){if(!sequenceTrace)return;const serialized=JSON.stringify(value);if(sequenceTrace.last[kind]===serialized)return;sequenceTrace.last[kind]=serialized;sequenceTrace.events.push({kind,observedAt:performance.timeOrigin+performance.now(),value});if(sequenceTrace.events.length>256){sequenceTrace.events.shift();sequenceTrace.truncated=true}const output=document.querySelector<HTMLElement>('#sequence-trace');if(output)output.textContent=JSON.stringify({scenario:sequenceTrace.scenario,startedAt:sequenceTrace.startedAt,truncated:sequenceTrace.truncated,events:sequenceTrace.events,canvasContentClaim:false},null,2)}
function post(value:any){if(ready)frame.contentWindow?.postMessage(value,location.origin)}
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.projectId!==config.projectId)return
 if(event.data.type==='rtex:ready'){ready=true;if(lastCursor)post(lastCursor);for(const timing of pendingTimings.splice(0))post(timing);record('Preview ready; queued cursor/timings forwarded')}
 if(event.data.type==='rtex:nav-unavailable')record('Preview reports this position has no verified mapping')
})
window.addEventListener('rtex:native:data',((event:CustomEvent)=>{const value=event.detail;if(value.docId!==config.docId)return
 if(value.kind==='transactions')record(`native ${value.viewEpoch}: tx ${value.records.map((r:any)=>r.transactionId+':'+r.origin+':'+r.changes.length+' changes').join(', ')}`)
 else if(value.kind==='composition')record(`native composition ${value.phase}`)
}) as EventListener)
// This endpoint represents the fixture's synthetic canonical document service,
// not rtex synchronization. installOverleafProject alone sends compiler edits.
async function saveCanonical(){if(canonicalRunning)return;canonicalRunning=true;try{while(canonicalDesired!==null){const text=canonicalDesired;canonicalDesired=null;const response=await fetch('/fixture/document',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:config.projectId,docId:config.docId,text})});if(!response.ok)throw Error('Synthetic canonical save failed: '+response.status)}}catch(error){record(String(error))}finally{canonicalRunning=false}}
const initial=await(await fetch(`/project/${config.projectId}/doc/${config.docId}/download`)).text()
const session=await installOverleafProject({baseURL:'/rtex/',token:'session',projectId:config.projectId,resourceMap:config.resourceMap??[],pollMs:1000,
 onStatus:value=>{bridgeStatus.textContent=value.state+(value.path?' · '+value.path:'')+(value.message?' · '+value.message:'');record('project-entry '+bridgeStatus.textContent);if(value.state==='stopped'){stopped=true;typingAbort?.abort();post({type:'rtex:pause',projectId:config.projectId,reason:value.message});}},
 onTransport:transport=>{bridgeStatus.dataset.transport=transport},
 onCursor:value=>{lastCursor=value;post(value);record(`cursor paragraph ${value.parId} revision ${value.sourceRevision}`)},
 onEditTiming:value=>{latestAck=value;traceEvent('ack',value);if(ready)post(value);else{pendingTimings.push(value);if(pendingTimings.length>32)pendingTimings.shift()}record(`edit acknowledged: source ${value.sourceRevision}, units ${(value.affectedParIds??[]).join(',')}`)},
})
// Install the real source observer before the real project-entry ViewPlugin binds
// this immutable document. The event is dispatched BEFORE EditorView construction.
const native=rtexBridge({currentDoc:{doc_id:config.docId}})
const extensions:any[]=[]
window.dispatchEvent(new CustomEvent('UNSTABLE_editor:extensions',{detail:{CodeMirror:{EditorView,ViewPlugin},extensions,rtexDocumentId:config.docId}}))
if(!extensions.length)throw Error('Real project-entry extension listener did not register')
view=new EditorView({parent:document.querySelector('#editor')!,state:EditorState.create({doc:initial,extensions:[native,...extensions,typingControls.of([]),EditorView.lineWrapping,EditorView.updateListener.of(update=>{if(update.docChanged){ownedInsertions.map(update.changes);canonicalDesired=update.state.doc.toString();void saveCanonical()}})]})})
const showMode=()=>{mode.textContent=`Source mode: ${view.dom.dataset.rtexSourceMode??'binding'} · epoch ${view.dom.dataset.rtexSourceViewEpoch??'pending'}`;mode.dataset.sourceMode=view.dom.dataset.rtexSourceMode??'binding'}
new MutationObserver(showMode).observe(view.dom,{attributes:true,attributeFilter:['data-rtex-source-mode','data-rtex-source-view-epoch']});showMode()
const insert=(text:string)=>{if(stopped||typingBusy)return;const at=view.state.doc.toString().indexOf('Beta anchor paragraph');if(at<0)throw Error('Synthetic insertion anchor missing');view.focus();view.dispatch({changes:{from:at,insert:text},selection:{anchor:at+text.length},userEvent:'input.paste'});ownedInsertions.add(at,text,view.state.doc)}
let paragraphs=0,formulas=0
document.querySelector('#insert-paragraph')!.addEventListener('click',()=>insert(`Fresh project-native paragraph ${++paragraphs} with $\\mathbb{R}+x^2$.\n\n`))
document.querySelector('#insert-formula')!.addEventListener('click',()=>{formulas++;insert(`\\[\\mathbb{Z} \\otimes \\mathbb{R} + ${formulas}\\]\n\n`)})
document.querySelector('#type-more')!.addEventListener('click',()=>{if(stopped||typingBusy)return;const text=view.state.doc.toString(),at=text.indexOf('Alpha stable');view.focus();view.dispatch({changes:{from:at,insert:'Responsive '},selection:{anchor:at+11},userEvent:'input.type'})})
const go=(needle:string)=>{if(stopped||typingBusy)return;const at=view.state.doc.toString().indexOf(needle);if(at<0)return;view.focus();view.dispatch({selection:{anchor:at},effects:EditorView.scrollIntoView(at,{y:'center'})})}
document.querySelector('#go-distant')!.addEventListener('click',()=>go('Distant target paragraph'))
document.querySelector('#go-first')!.addEventListener('click',()=>go('Alpha stable'))
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
const readFinalMetric=(revision:number)=>{try{const raw=frame.contentDocument?.querySelector<HTMLElement>('#status')?.dataset.rtexLatency;if(!raw)return null;const value=JSON.parse(raw);return value.sourceRevision===revision?value:null}catch{return null}}
async function typeFormulaStepByStep(scenario='character',providedPlan?:ReturnType<typeof textSequencePlan>){
 if(stopped||typingBusy)return
 if(view.dom.dataset.rtexSourceMode!=='native'){typingStatus.textContent='Wait for Source mode: native before starting this synthetic typing check';return}
 const plan=providedPlan??mathConstructionPlan(scenario)
 typingBusy=true;const controlAbort=new AbortController();typingAbort=controlAbort;const overallTimer=setTimeout(()=>controlAbort.abort(),35000);for(const button of document.querySelectorAll<HTMLButtonElement>('button, select'))if(button.id!=='stop')button.disabled=true
 const started=performance.timeOrigin+performance.now(),baseline=view.state.doc.toString(),anchor=baseline.indexOf('Beta anchor paragraph')
 let expected=baseline,dispatches=0,finalDispatchAt=0,totalInputAt=0,mathReadyAt:number|null=null
 const phases:{label:string;dispatchedAt:number;sourceCodeUnits:number}[]=[]
 const {intervalMs,typedCharacters}=plan
 if(providedPlan)sequenceTrace={scenario,startedAt:started,truncated:false,last:{},events:[]}
 try{
  view.dispatch({effects:typingControls.reconfigure([EditorView.editable.of(false),EditorState.readOnly.of(true)])})
  if(anchor<0)throw Error('Synthetic body insertion anchor missing')
  for(const step of plan.steps){
   if(step.delayBeforeMs)await sleep(step.delayBeforeMs)
   if(controlAbort.signal.aborted)throw Error('Synthetic typing exceeded its bounded lifetime');if(stopped)throw Error('Bridge stopped during synthetic typing')
   if(view.state.doc.toString()!==expected)throw Error('Synthetic source changed outside this typing control')
   const at=anchor+step.at;finalDispatchAt=performance.timeOrigin+performance.now();if(!totalInputAt)totalInputAt=finalDispatchAt;if(step.mathReady)mathReadyAt=finalDispatchAt
   expected=expected.slice(0,at)+step.insert+expected.slice(at)
   view.dispatch({changes:{from:at,insert:step.insert},selection:{anchor:at+step.insert.length},effects:EditorView.scrollIntoView(at+step.insert.length,{y:'center'}),scrollIntoView:true,userEvent:dispatches?'input.type':'input.paste'});dispatches++
   phases.push({label:step.label,dispatchedAt:finalDispatchAt,sourceCodeUnits:expected.length});typingStatus.textContent=`${scenario} · ${step.label} · ${dispatches}/${plan.steps.length} transactions · ${intervalMs} ms pauses`
   traceEvent('dispatch',{scenario,label:step.label,dispatchedAt:finalDispatchAt,sourceCodeUnits:expected.length});record('Synthetic phase: '+scenario+' / '+step.label)
  }
  ownedInsertions.add(anchor,plan.finalBlock,view.state.doc)
  typingStatus.textContent='Typing finished; waiting for exact canonical/source-mirror equality and final edit acknowledgment…'
  const deadline=performance.now()+20000;let mirror:any=null,sourceMap:any=null,canonicalEqual=false
  while(performance.now()<deadline){
   if(controlAbort.signal.aborted)throw Error('Synthetic typing verification canceled or timed out');if(stopped)throw Error('Bridge stopped before final source acknowledgment')
   const query=new URLSearchParams({projectId:config.projectId,docId:config.docId,path:'main.tex'})
   const response=await fetch('/rtex/api/document?'+query,{cache:'no-store',credentials:'same-origin',signal:controlAbort.signal});if(!response.ok)throw Error('Read-only mirror verification failed: '+response.status)
   mirror=await response.json();if(mirror.engineAlive!==true)throw Error('Engine stopped before final source verification');const canonicalResponse=await fetch(`/project/${config.projectId}/doc/${config.docId}/download`,{cache:'no-store',credentials:'same-origin',signal:controlAbort.signal});if(!canonicalResponse.ok)throw Error('Read-only canonical verification failed: '+canonicalResponse.status);const canonical=await canonicalResponse.text();canonicalEqual=canonical===expected
   if(mirror.text===expected&&canonicalEqual){const mapResponse=await fetch('/rtex/api/source-map?'+query,{cache:'no-store',credentials:'same-origin',signal:controlAbort.signal});if(!mapResponse.ok)throw Error('Read-only acknowledgment verification failed: '+mapResponse.status);sourceMap=await mapResponse.json();if(sourceMap.projectId===config.projectId&&sourceMap.path==='main.tex'&&sourceMap.revision===mirror.revision&&latestAck?.sourceRevision===sourceMap.sourceRevision&&latestAck?.ackAt>=finalDispatchAt)break}
   await sleep(150)
  }
  if(view.state.doc.toString()!==expected||mirror?.text!==expected||!canonicalEqual||sourceMap?.revision!==mirror?.revision||latestAck?.sourceRevision!==sourceMap?.sourceRevision||!(latestAck?.ackAt>=finalDispatchAt))throw Error('Exact final source/acknowledgment not observed within 20 seconds')
  const ack={...latestAck},digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(expected)))].map(x=>x.toString(16).padStart(2,'0')).join('')
  typingStatus.textContent=`Sources match exactly; final source revision ${ack.sourceRevision} acknowledged. Waiting up to 8 seconds for its actual rendered metric…`
  let rendered=readFinalMetric(ack.sourceRevision);const renderDeadline=performance.now()+8000
  while(!rendered&&performance.now()<renderDeadline&&!stopped&&!controlAbort.signal.aborted){await sleep(100);rendered=readFinalMetric(ack.sourceRevision)}
  if(stopped||controlAbort.signal.aborted)throw Error('Synthetic typing stopped while waiting for the rendered result')
  const result={state:'done',syntheticTyping:true,osIMEClaim:false,scenario,intervalMs,dispatches,typedCharacters,phases,totalInputAt,mathReadyAt,mathReadyMeaning:'Fixture dispatch completing the planned formula source; not engine completion',totalInputToAckMs:ack.ackAt-totalInputAt,mathReadyToAckMs:mathReadyAt===null?null:ack.ackAt-mathReadyAt,totalInputToPaintMs:rendered?rendered.paintAt-totalInputAt:null,fixtureMathReadyToPaintMs:rendered&&mathReadyAt!==null?rendered.paintAt-mathReadyAt:null,editorEqualsExpected:true,canonicalEqualsExpected:true,mirrorEqualsExpected:true,finalSourceCodeUnits:expected.length,finalSourceSHA256:digest,documentRevision:mirror.revision,sourceRevision:ack.sourceRevision,readOnlyVerifiedDocumentRevision:sourceMap.revision,readOnlyVerifiedSourceRevision:sourceMap.sourceRevision,engineAlive:mirror.engineAlive,ackInputAt:ack.inputAt,sentAt:ack.sentAt,ackAt:ack.ackAt,inputToAckMs:ack.ackAt-ack.inputAt,elapsedMs:performance.timeOrigin+performance.now()-started,sequenceTraceSelector:providedPlan?'#sequence-trace':undefined,renderMetric:rendered,renderMetricState:rendered?'observed exact final revision':'not observed within bounded wait; inspect actual preview'}
  typingResult.textContent=JSON.stringify(result,null,2);typingResult.dataset.state='done'
  typingStatus.textContent=rendered?'Done: all final sources match; actual final-revision rendered metric observed':'Done: all final sources match; no final-revision rendered metric observed within 8 seconds'
  record('Synthetic step-by-step typing done: exact final source revision '+ack.sourceRevision+'; rendered metric '+Boolean(rendered))
 }catch(error){typingStatus.textContent='Synthetic typing error: '+String(error);typingResult.dataset.state='error';typingResult.textContent=JSON.stringify({state:'error',message:String(error),editorEqualsExpected:view.state.doc.toString()===expected,scenario,dispatches,phases,totalInputAt,mathReadyAt,syntheticTyping:true,osIMEClaim:false},null,2);record(typingStatus.textContent)}
 finally{clearTimeout(overallTimer);if(typingAbort===controlAbort)typingAbort=null;typingBusy=false;try{if(!stopped)view.dispatch({effects:typingControls.reconfigure([])})}catch(error){record('Editor control restore failed: '+String(error))}for(const button of document.querySelectorAll<HTMLButtonElement>('button, select'))if(button.id!=='stop')button.disabled=stopped}
}
document.querySelector('#type-formula')!.addEventListener('click',()=>{void typeFormulaStepByStep()})
document.querySelector('#run-paced-math')!.addEventListener('click',()=>{void typeFormulaStepByStep(document.querySelector<HTMLSelectElement>('#math-scenario')!.value)})
document.querySelector('#run-text-sequence')!.addEventListener('click',()=>{const plan=textSequencePlan(document.querySelector<HTMLSelectElement>('#text-break-mode')!.value,Number(document.querySelector<HTMLSelectElement>('#text-cadence')!.value));void typeFormulaStepByStep(plan.scenario,plan)})
async function deleteLastFixtureInsertion(){
 if(stopped||typingBusy)return
 const result=document.querySelector<HTMLElement>('#deletion-result')!,deletionStatus=document.querySelector<HTMLElement>('#deletion-status')!
 if(view.dom.dataset.rtexSourceMode!=='native'){deletionStatus.textContent='请等待原生桥接就绪';return}
 let owned:any;try{owned=ownedInsertions.last(view.state.doc)}catch(error){deletionStatus.textContent=String(error);record('Fixture deletion refused: '+String(error));return}
 const before=view.state.doc.toString(),expected=before.slice(0,owned.from)+before.slice(owned.to),controlAbort=new AbortController(),timer=setTimeout(()=>controlAbort.abort(),25000)
 typingBusy=true;typingAbort=controlAbort;for(const button of document.querySelectorAll<HTMLButtonElement>('button, select'))if(button.id!=='stop')button.disabled=true
 result.dataset.state='pending';result.textContent='';deletionStatus.textContent='已提交删除，等待真实原生控制器确认和源文件一致性核验…'
 try{
  view.dispatch({effects:typingControls.reconfigure([EditorView.editable.of(false),EditorState.readOnly.of(true)])})
  const dispatchedAt=performance.timeOrigin+performance.now()
  view.dispatch({changes:{from:owned.from,to:owned.to,insert:''},selection:{anchor:owned.from},userEvent:'delete.selection',scrollIntoView:true});ownedInsertions.forget(owned.id)
  record('Fixture-owned block deleted: '+owned.id+'; '+(owned.to-owned.from)+' UTF-16 units; awaiting native acknowledgment')
  const query=new URLSearchParams({projectId:config.projectId,docId:config.docId,path:'main.tex'}),deadline=performance.now()+20000
  let mirror:any=null,sourceMap:any=null,canonicalEqual=false
  while(performance.now()<deadline){
   if(stopped||controlAbort.signal.aborted)throw Error('Deletion verification stopped or timed out')
   const response=await fetch('/rtex/api/document?'+query,{cache:'no-store',credentials:'same-origin',signal:controlAbort.signal});if(!response.ok)throw Error('Mirror verification failed: '+response.status);mirror=await response.json()
   const canonical=await fetch(`/project/${config.projectId}/doc/${config.docId}/download`,{cache:'no-store',credentials:'same-origin',signal:controlAbort.signal});if(!canonical.ok)throw Error('Canonical verification failed: '+canonical.status);canonicalEqual=await canonical.text()===expected
   if(mirror.text===expected&&canonicalEqual){const response=await fetch('/rtex/api/source-map?'+query,{cache:'no-store',credentials:'same-origin',signal:controlAbort.signal});if(!response.ok)throw Error('Source-map verification failed: '+response.status);sourceMap=await response.json();if(sourceMap.projectId===config.projectId&&sourceMap.path==='main.tex'&&sourceMap.revision===mirror.revision&&latestAck?.sourceRevision===sourceMap.sourceRevision&&latestAck?.ackAt>=dispatchedAt)break}
   await sleep(100)
  }
  if(view.state.doc.toString()!==expected||mirror?.text!==expected||!canonicalEqual||sourceMap?.revision!==mirror?.revision||latestAck?.sourceRevision!==sourceMap?.sourceRevision||!(latestAck?.ackAt>=dispatchedAt)||mirror?.engineAlive!==true)throw Error('Exact deletion source/acknowledgment with live engine was not verified')
  const verified={state:'done',operation:'delete-fixture-owned-insertion',ownedBlockId:owned.id,deletedCodeUnits:owned.to-owned.from,editorEqualsExpected:true,canonicalEqualsExpected:true,mirrorEqualsExpected:true,engineAlive:mirror.engineAlive,documentRevision:mirror.revision,sourceRevision:sourceMap.sourceRevision,dispatchedAt,ackAt:latestAck.ackAt,renderedNonReappearance:'Requires visible preview observation after this acknowledgment'}
  result.dataset.state='done';result.textContent=JSON.stringify(verified,null,2);deletionStatus.textContent='删除已确认：编辑器、规范源文件和镜像完全一致；源版本 '+sourceMap.sourceRevision+'。请继续观察预览是否重现旧内容。';record('Deletion ACK verified: source '+sourceMap.sourceRevision+'; mirror/canonical/editor equal; engine alive')
 }catch(error){result.dataset.state='error';result.textContent=JSON.stringify({state:'error',message:String(error)},null,2);deletionStatus.textContent='删除核验失败：'+String(error);record(deletionStatus.textContent)}
 finally{clearTimeout(timer);if(typingAbort===controlAbort)typingAbort=null;typingBusy=false;try{if(!stopped)view.dispatch({effects:typingControls.reconfigure([])})}catch(error){record(String(error))}for(const button of document.querySelectorAll<HTMLButtonElement>('button, select'))if(button.id!=='stop')button.disabled=stopped}
}
document.querySelector('#delete-insertion')!.addEventListener('click',()=>{void deleteLastFixtureInsertion()})
document.querySelector('#stop')!.addEventListener('click',()=>{stopped=true;typingAbort?.abort();session.stop();post({type:'rtex:pause',projectId:config.projectId,reason:'Fixture bridge explicitly stopped'});bridgeStatus.textContent='Stopped; reload this synthetic fixture to bind again'})
frame.addEventListener('load',()=>{const status=frame.contentDocument?.querySelector<HTMLElement>('#status');if(!status)return;const update=()=>{matrixDeletionObserver?.();previewStatus.textContent=status.textContent;for(const [kind,key]of [['paint','rtexLatency'],['insertion','rtexInsertion'],['layout','rtexLayoutLoading']] as const){const raw=status.dataset[key];if(raw){try{traceEvent(kind,JSON.parse(raw))}catch{}}}traceEvent('canvas-manifests',[...(frame.contentDocument?.querySelectorAll<HTMLCanvasElement>('canvas')??[])].map(canvas=>({page:canvas.dataset.page,layout:canvas.dataset.rtexLayout,overlays:canvas.dataset.rtexOverlays,insertion:canvas.dataset.rtexInsertion,frozen:canvas.dataset.rtexInsertionFrozen}))); metrics.textContent=JSON.stringify({canvases:frame.contentDocument?.querySelectorAll('canvas').length,insertion:status.dataset.rtexInsertion?JSON.parse(status.dataset.rtexInsertion):null,latency:status.dataset.rtexLatency?JSON.parse(status.dataset.rtexLatency):null,layout:status.dataset.rtexLayoutLoading?JSON.parse(status.dataset.rtexLayoutLoading):null,connection:status.dataset.rtexConnection,transport:status.dataset.rtexTransport,delivery:status.dataset.rtexDelivery},null,2)};new MutationObserver(update).observe(status,{attributes:true,childList:true,subtree:true});const pageRoot=frame.contentDocument?.querySelector('#pages');if(pageRoot)new MutationObserver(update).observe(pageRoot,{childList:true,subtree:true});update()})
frame.src='/rtex/?preview=#session'
window.addEventListener('pagehide',()=>{typingAbort?.abort();session.stop();view.destroy()},{once:true})
record('Real installOverleafProject installed; CodeMirror view created from its extensions')

// All compiler writes still flow through real CM/native observer/project-entry.
// Read-only fixture trace observes actual bridge events, not predicted pixels.
async function runLocationDeleteMatrix(retained=false,structural=false,multi=false,retirement=false){
 if(typingBusy||stopped)return;
 const output=document.querySelector<HTMLElement>(retained?'#retained-result':'#matrix-result')!,label=document.querySelector<HTMLElement>(retained?'#retained-status':'#matrix-status')!;
 if(view.dom.dataset.rtexSourceMode!=='native'||!ready){label.textContent='Wait for native source mode and preview ready.';return;}
 const baseline=view.state.doc.toString(),control=new AbortController(),timer=setTimeout(()=>control.abort(),180000),results:any[]=[];let expected=baseline;
 typingBusy=true;typingAbort=control;output.dataset.state='running';sequenceTrace={scenario:retained?'retained-location-matrix':'location-delete-matrix',startedAt:performance.timeOrigin+performance.now(),truncated:false,last:{},events:[]};
 const buttons=[...document.querySelectorAll<HTMLButtonElement>('button,select')];for(const b of buttons)if(b.id!=='stop')b.disabled=true;
 const snapshot=()=>{const status=frame.contentDocument?.querySelector<HTMLElement>('#status'),root=frame.contentDocument?.querySelector<HTMLElement>('#pages'),rect=root?.getBoundingClientRect();return{status:status?.textContent,dataset:{...status?.dataset},canvases:[...(frame.contentDocument?.querySelectorAll<HTMLCanvasElement>('canvas')??[])].map(c=>{const r=c.getBoundingClientRect();return{page:Number(c.dataset.page),layout:c.dataset.rtexLayout,overlays:c.dataset.rtexOverlays,insertion:c.dataset.rtexInsertion,replacement:c.dataset.rtexReplacement,removals:c.dataset.rtexRemovals,visible:Boolean(rect&&r.bottom>rect.top&&r.top<rect.bottom&&r.width>0&&r.height>0)}})}};
 async function parity(target:string,dispatchedAt:number){const deadline=performance.now()+15000,query=new URLSearchParams({projectId:config.projectId,docId:config.docId,path:'main.tex'});while(performance.now()<deadline){if(stopped||control.signal.aborted)throw Error('Matrix stopped/deadline');const [mirrorResponse,canonicalResponse]=await Promise.all([fetch('/rtex/api/document?'+query,{cache:'no-store',signal:control.signal}),fetch(`/project/${config.projectId}/doc/${config.docId}/download`,{cache:'no-store',signal:control.signal})]);if(!mirrorResponse.ok||!canonicalResponse.ok)throw Error('Parity read rejected');const mirror=await mirrorResponse.json(),canonical=await canonicalResponse.text();if(mirror.engineAlive!==true)throw Error('Engine stopped');if(view.state.doc.toString()===target&&mirror.text===target&&canonical===target&&latestAck?.ackAt>=dispatchedAt){return{ack:{...latestAck},documentRevision:mirror.revision,editorEqualsExpected:true,canonicalEqualsExpected:true,mirrorEqualsExpected:true}}await sleep(75)}throw Error('Exact source/ack deadline')}
 function visiblePNG(preferredPage?:number,revision?:number,removal=false){
  const doc=frame.contentDocument,root=doc?.querySelector<HTMLElement>('#pages'),rect=root?.getBoundingClientRect();if(!rect)return null;
  const candidates=[...(doc?.querySelectorAll<HTMLCanvasElement>('canvas')??[])].filter(c=>{const r=c.getBoundingClientRect();if(c.width<=0||c.height<=0||r.bottom<=rect.top||r.top>=rect.bottom||r.width<=0||r.height<=0)return false;if(preferredPage!==undefined&&Number(c.dataset.page)!==preferredPage)return false;if(removal){try{if(!JSON.parse(c.dataset.rtexRemovals??'[]').some((r:any)=>r.sourceRevision===revision))return false;}catch{return false}}else if(revision!==undefined){try{if(JSON.parse(c.dataset.rtexLayout??'null')?.source_revision!==revision)return false;}catch{return false}}return true;});
  const canvas=candidates[0];if(!canvas)return null;try{return{page:Number(canvas.dataset.page),observedAt:performance.timeOrigin+performance.now(),width:canvas.width,height:canvas.height,layout:canvas.dataset.rtexLayout,removals:canvas.dataset.rtexRemovals,overlays:canvas.dataset.rtexOverlays,insertion:canvas.dataset.rtexInsertion,replacement:canvas.dataset.rtexReplacement,png:canvas.toDataURL('image/png')}}catch(error){return{error:String(error)}}
 }
 async function step(name:string,from:number,to:number,insert:string,requireFull=false,extraChanges:{from:number;to:number;insert:string}[]=[]){
  if(view.state.doc.toString()!==expected)throw Error('Unexpected nonfixture source change');label.textContent=name;
  const deletionVisual:any=name.includes('complete deletion')?{before:visiblePNG(),earlyProjected:null,fullAfter:null}:null;
  const visualBefore=retained||structural?visiblePNG():null;const before=snapshot(),dispatchedAt=performance.timeOrigin+performance.now(),dispatchChanges=[{from,to,insert},...extraChanges];for(const change of [...dispatchChanges].sort((a,b)=>b.from-a.from))expected=expected.slice(0,change.from)+change.insert+expected.slice(change.to);
  if(deletionVisual)matrixDeletionObserver=()=>{if(deletionVisual.earlyProjected||!latestAck||latestAck.ackAt<dispatchedAt)return;const metric=readFinalMetric(latestAck.sourceRevision);if(metric?.kind!=='deletion')return;const image=visiblePNG(metric.page,metric.sourceRevision,true);if(image)deletionVisual.earlyProjected={metric:{...metric},image};};
  const primaryAnchor=from+insert.length+extraChanges.filter(c=>c.to<=from).reduce((sum,c)=>sum+c.insert.length-(c.to-c.from),0);view.dispatch({changes:dispatchChanges,selection:{anchor:primaryAnchor},effects:EditorView.scrollIntoView(primaryAnchor,{y:'center'}),userEvent:insert?'input.type':'delete.selection'});
  const verified=await parity(expected,dispatchedAt),revision=verified.ack.sourceRevision;
  if(deletionVisual)matrixDeletionObserver=()=>{if(deletionVisual.earlyProjected)return;const metric=readFinalMetric(revision);if(metric?.kind!=='deletion')return;const image=visiblePNG(metric.page,revision,true);if(image)deletionVisual.earlyProjected={metric:{...metric},image};};
  matrixDeletionObserver?.();let metric=readFinalMetric(revision),after=snapshot(),fullFrame=false,trace:any=null;
  const deadline=performance.now()+8000;
  while(performance.now()<deadline&&!stopped&&!control.signal.aborted){
   metric=readFinalMetric(revision);after=snapshot();
   fullFrame=after.canvases.some(c=>{if(!c.visible||!c.layout)return false;try{const v=JSON.parse(c.layout);return v.source_revision===revision}catch{return false}});
   const windowFrame=structural&&after.canvases.some(c=>c.visible&&(c.insertion&&JSON.parse(c.insertion).sourceRevision===revision||c.removals&&JSON.parse(c.removals).some((r:any)=>r.sourceRevision===revision)));if((requireFull&&fullFrame)||(!requireFull&&(metric||fullFrame||windowFrame)))break;
   await sleep(75);
  }
  matrixDeletionObserver?.();if(deletionVisual&&fullFrame)deletionVisual.fullAfter=visiblePNG(deletionVisual.earlyProjected?.image?.page??deletionVisual.before?.page,revision);matrixDeletionObserver=null;
  const traceResponse=await fetch('/fixture/events',{cache:'no-store',signal:control.signal});if(traceResponse.ok){const all=await traceResponse.json();trace=all.events.filter((e:any)=>e.observedAt>=dispatchedAt&&(e.versions?.source_revision===revision||e.sourceRevision===revision||e.event==='BackgroundScheduled'));}
  const result={name,requiredFullCapture:requireFull,sourceRevision:revision,dispatchedAt,...verified,actualRevisionMetric:metric??null,fullLayoutCanvasObserved:fullFrame,frameObservedAt:performance.timeOrigin+performance.now(),sourceExactVerified:true,trace,before,after,...(deletionVisual?{deletionVisual}:{}),...(retained||structural?{visibleBefore:visualBefore,visibleAfter:visiblePNG(metric?.page)}:{}),paintClaim:metric?'Exact production latency metric observed':fullFrame?'Matching actual visible layout canvas observed; polling time is an upper bound, not renderer paint timestamp':'No matching actual canvas metric observed within bounded wait'};
  results.push(result);output.textContent=JSON.stringify({state:'running',results},null,2);record('Matrix '+name+' ACK '+revision+'; metric '+Boolean(metric)+'; fullframe '+fullFrame);
  if(requireFull&&!fullFrame)throw Error('Required full-layout canvas not observed before deletion');return result;
 }
 try{
  view.dispatch({effects:typingControls.reconfigure([EditorView.editable.of(false),EditorState.readOnly.of(true)])});
  if(retirement){
   const marker='Beta anchor paragraph',start=expected.indexOf(marker),block='Retirement native 你好 ordinary paragraph.\n\n';if(start<0)throw Error('Missing retirement anchor');
   const inserted=await step('Retirement / show genuinely new native Body',start,start,block);
   const nativeCert=inserted.trace?.find((e:any)=>e.event==='InsertionUpdate'&&e.state==='ready');if(!nativeCert?.parId)throw Error('No genuine ready insertion certificate');
   const deletedId=nativeCert.parId;const shown=inserted.after.canvases.some((c:any)=>c.visible&&c.insertion&&JSON.parse(c.insertion).parIds?.includes(deletedId));if(!shown)throw Error('New Body did not actually paint provisionally');
   const sentinel=' RTEX Retirement Sentinel',alphaAt=expected.indexOf('Alpha stable')+'Alpha stable'.length;const deleted=await step('Retirement / delete inserted Body PLUS outside edit and await genuine capture',start,start+block.length,'',true,[{from:alphaAt,to:alphaAt,insert:sentinel}]);
   const raw=await(await fetch('/fixture/events',{cache:'no-store',signal:control.signal})).json(),trace=raw.events.filter((e:any)=>e.observedAt>=deleted.dispatchedAt);
   const hold=trace.find((e:any)=>e.event==='SourceLineageState'&&e.sourceRevision===deleted.sourceRevision&&e.requiresCapture===true),removed=trace.find((e:any)=>e.event==='ParagraphUpdate'&&e.parId===deletedId&&e.status==='removed'&&e.versions?.source_revision===deleted.sourceRevision),capture=trace.find((e:any)=>e.event==='LayoutUpdate'&&e.versions?.source_revision>=deleted.sourceRevision&&!e.placedIds?.includes(deletedId));
   if(!hold||!removed||!capture||!Array.isArray(capture.placedIds)||capture.compile?.state!=='Ok'||hold.observedAt>removed.observedAt||capture.versions.context_revision<=nativeCert.baseVersions.context_revision)throw Error('Genuine ordered hold/removal/new-context capture-omission evidence not observed');
   results.push({name:'Retirement / genuine capture admitted',deletedId,hold,removed,capture,browserBaseline:deleted.after.canvases.filter((c:any)=>c.visible).map((c:any)=>c.layout),sourceExactVerified:true});
   const at=expected.indexOf('Gamma stable')+'Gamma stable'.length,follow=await step('Retirement / first edit against new genuine context',at,at,' 测试');
   const followPG=follow.trace?.find((e:any)=>e.event==='ParagraphUpdate'&&e.status==='ok'&&e.versions?.source_revision===follow.sourceRevision);if(!followPG||followPG.versions.context_revision!==capture.versions.context_revision||followPG.versions.engine_generation!==capture.versions.engine_generation)throw Error('First new-context PG did not match genuine capture');
   if(!follow.actualRevisionMetric&&!follow.after.canvases.some((c:any)=>c.visible&&JSON.parse(c.overlays??'[]').some((u:any)=>u.revision===follow.sourceRevision)))throw Error('Post-capture first edit has no matching actual visible paint');
   await step('Retirement / restore follow-up edit',at,at+3,'');const sentinelAt=expected.indexOf(sentinel);if(sentinelAt<0)throw Error('Missing owned retirement sentinel');await step('Retirement / remove owned outside sentinel',sentinelAt,sentinelAt+sentinel.length,'');
  }else if(multi){
   const marker='Second section paragraph 2',nextMarker='Second section paragraph 8',start=expected.indexOf(marker),end=expected.indexOf(nextMarker);if(start<0||end<0)throw Error('Missing multi-Body anchors');const original=expected.slice(start,end);
   await step('Multi Body / clear six captured paragraphs',start,end,'');
   await step('Multi Body / retype two fresh paragraphs',start,start,'你好第一段。\n\n你好第二段。\n\n');
   let at=expected.indexOf('你好第二段。')+'你好第二段。'.length;await step('Multi Body / continue second paragraph',at,at,'继续');
   await step('Multi Body / replace first committed text',start,start+'你好第一段。'.length,'重新写入第一段。');
   await step('Multi Body / clear both successors',start,expected.indexOf(nextMarker),'');
   await step('Multi Body / retype inline formula',start,start,'公式 $\\mathbb{R}+x^2$ 然后继续输入。\n\n');
   at=expected.indexOf('然后继续输入。')+'然后继续输入。'.length;await step('Multi Body / continue formula paragraph',at,at,'测试');
   await step('Multi Body / clear final successor',start,expected.indexOf(nextMarker),'');
   // Six current bodies exceed the explicit four-current-unit provisional cap.
   // Restore authoritative source and require its genuine full capture.
   await step('Multi Body / restore six source paragraphs',start,start,original,true);
  }else if(structural){
   const marker='Second section paragraph 4',nextMarker='Second section paragraph 5',start=expected.indexOf(marker),end=expected.indexOf(nextMarker);if(start<0||end<0)throw Error('Missing structural anchors');
   const original=expected.slice(start,end),splitAt=start+marker.length;
   await step('Window / split captured Body',splitAt,splitAt,'\n\n你好');
   let at=expected.indexOf('你好')+2;await step('Window / continue fresh successor',at,at,'继续');
   at=expected.indexOf('你好继续')+'你好继续'.length;await step('Window / split successor again',at,at,'\n\n第三段');
   await step('Window / complete deletion before capture',start,expected.indexOf(nextMarker),'');
   await step('Window / retype two fresh paragraphs',start,start,'重新输入第一段。\n\n第二段也要显示。\n\n');
   await step('Window / replace committed local text',start,start+'重新输入第一段。'.length,'输入法提交的中文。');
   await step('Window / remove first retained paragraph',start,expected.indexOf('第二段也要显示。'),'');
   await step('Window / continue survivor',start+'第二段'.length,start+'第二段'.length,'继续');
   await step('Window / complete deletion again',start,expected.indexOf(nextMarker),'');
   await step('Window / restore exact captured source',start,start,original);
  }else if(retained){
   const marks={A:'Alpha stable',B:'Second section paragraph 5',C:'Distant target paragraph',S:'Second section paragraph 4'};
   const append=async(key:keyof typeof marks,text:string)=>{const at=expected.indexOf(marks[key])+marks[key].length;if(at<marks[key].length)throw Error('Missing immutable retained anchor');await step(key+' retain '+text,at,at,text);};
   const remove=async(key:keyof typeof marks,text:string)=>{const at=expected.indexOf(marks[key])+marks[key].length;if(expected.slice(at,at+text.length)!==text)throw Error('Retained insertion ownership changed');await step(key+' remove ONLY '+text,at,at+text.length,'');};
   await append('A',' 测试');await append('B',' 测试');await append('A',' 再次');
   await remove('A',' 再次 测试');await append('C',' 测试');await remove('B',' 测试');await remove('C',' 测试');
   // Same captured physical page: ordinary paragraph4 remains while paragraph5 grows.
   await append('S',' 测试');await append('B',' 测试');await remove('B',' 测试');await remove('S',' 测试');
  }else{
  const anchors=['Alpha stable','Second section paragraph 5','Distant target paragraph'];
  for(const anchor of anchors){for(const phase of ['first','revisit']){const at=expected.indexOf(anchor)+anchor.length;if(at<anchor.length)throw Error('Missing immutable synthetic anchor');await step(anchor+' / '+phase+' append',at,at,' 测试');await step(anchor+' / '+phase+' revert',at,at+3,'');}}
  const at=expected.indexOf('Beta anchor paragraph'),block='New native Body 你好 with ordinary text.\n\n';if(at<0)throw Error('Missing insertion anchor');
  await step('New Body / insert and require full capture',at,at,block,true);
  await step('New Body / complete deletion after capture',at,at+block.length,'',true);
  }
  if(expected!==baseline||view.state.doc.toString()!==baseline)throw Error('Final editor did not restore immutable baseline');
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(baseline)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const result={state:'done',scenario:retirement?'capture-retirement':multi?'multi-captured-body':structural?'body-window':retained?'retained':'location-delete',synthetic:true,osIMEClaim:false,compilerWrites:'actual CM/native observer/project-entry only',baselineSourceSHA256:digest,allStepsExact:results.every(s=>s.sourceExactVerified),finalEditorEqualsBaseline:true,finalCanonicalEqualsBaseline:true,finalMirrorEqualsBaseline:true,steps:results};output.textContent=JSON.stringify(result,null,2);output.dataset.state='done';label.textContent=(retirement?'Done: genuine hold/removal/capture retirement verified; source restored. ':multi?'Done: six captured Bodies clear/retype exact; baseline restored. ':structural?'Done: body window split/clear/retype exact; baseline restored. ':retained?'Done: retained-location and same-page steps exact; baseline restored. ':'Done: all 14 steps acknowledged and exact; baseline restored. ')+results.filter(s=>structural||retained||s.name.includes('first append')||s.name.includes('complete deletion')).map(s=>{const m=s.actualRevisionMetric;return s.name+' | '+(m?m.kind+' '+m.totalMs.toFixed(1)+' ms':'no visible metric');}).join(' ; ');
 }catch(error){
  let restore:any=null;
  if(!stopped&&!control.signal.aborted&&view.state.doc.toString()===expected&&expected!==baseline){try{const at=performance.timeOrigin+performance.now();view.dispatch({changes:{from:0,to:view.state.doc.length,insert:baseline},userEvent:'input.paste'});expected=baseline;restore=await parity(baseline,at);}catch(e){restore={error:String(e)}}}
  output.dataset.state='error';output.textContent=JSON.stringify({state:'error',message:String(error),results,restore,editorEqualsBaseline:view.state.doc.toString()===baseline,synthetic:true,osIMEClaim:false},null,2);label.textContent='Matrix stopped: '+String(error);
 }finally{matrixDeletionObserver=null;clearTimeout(timer);if(typingAbort===control)typingAbort=null;typingBusy=false;try{if(!stopped)view.dispatch({effects:typingControls.reconfigure([])})}catch{}for(const b of buttons)if(b.id!=='stop')b.disabled=stopped;}
}
document.querySelector('#run-multi-body-matrix')!.addEventListener('click',()=>{void runLocationDeleteMatrix(false,true,true)});
document.querySelector('#run-window-matrix')!.addEventListener('click',()=>{void runLocationDeleteMatrix(false,true)});
document.querySelector('#run-matrix')!.addEventListener('click',()=>{void runLocationDeleteMatrix()});

const matrixDownload=document.querySelector<HTMLButtonElement>('#download-matrix')!;
const matrixOutput=document.querySelector<HTMLElement>('#matrix-result')!;
new MutationObserver(()=>{matrixDownload.disabled=!['done','error'].includes(matrixOutput.dataset.state??'')||typingBusy;}).observe(matrixOutput,{attributes:true,attributeFilter:['data-state']});
matrixDownload.addEventListener('click',()=>{
 if(!['done','error'].includes(matrixOutput.dataset.state??'')||typingBusy)return;
 const raw=matrixOutput.textContent??'';try{const parsed=JSON.parse(raw);if(!['done','error'].includes(parsed.state))return;}catch{return;}
 const url=URL.createObjectURL(new Blob([raw],{type:'application/json;charset=utf-8'}));
 const link=document.createElement('a');link.href=url;link.download='location-delete-matrix-result.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});

document.querySelector('#run-retained-matrix')!.addEventListener('click',()=>{void runLocationDeleteMatrix(true)});
const retainedOutput=document.querySelector<HTMLElement>('#retained-result')!,retainedDownload=document.querySelector<HTMLButtonElement>('#download-retained')!;
new MutationObserver(()=>{retainedDownload.disabled=!['done','error'].includes(retainedOutput.dataset.state??'')||typingBusy;}).observe(retainedOutput,{attributes:true,attributeFilter:['data-state']});
retainedDownload.addEventListener('click',()=>{if(typingBusy||!['done','error'].includes(retainedOutput.dataset.state??''))return;const raw=retainedOutput.textContent??'';try{if(!['done','error'].includes(JSON.parse(raw).state))return;}catch{return;}const url=URL.createObjectURL(new Blob([raw],{type:'application/json;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='retained-location-matrix-result.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);});

document.querySelector('#run-retirement-matrix')!.addEventListener('click',()=>{void runLocationDeleteMatrix(false,false,false,true)});
