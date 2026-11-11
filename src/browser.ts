import {planBodyWindowReplacement,planBodyWindowRemoval} from './body-window-replacement';
import {GenerationRecovery} from './generation-recovery';
import {planCapturedRemoval,capturedRemovalOverlaysSafe} from './captured-removal';
import {planInkOverlayMasks} from './ink-overlay';
import {planParagraphReplacement} from './paragraph-replacement';
import {planComposedBodyReplacement} from './composed-body-replacement';
import {planAdjacentBodyReplacement} from './body-replacement-group';
import {planRemovalAdmission} from './removal-admission';
import {replacementParagraphMatches} from './body-replacement-evidence';
import {PreviewResources,type ResourceOwner} from './preview-resources';
import {fontKey} from '../vendor/src/fontKey';
import {composeFlowPage} from './flow-page';
import {assembleInsertionBatch,batchAccountsFor} from './insertion-batch';
import {boundOtherGlyphs,glyphInkBounds} from './glyph-bounds';
import {planInsertionFlow,projectBaselineY} from './insertion-flow';
import {selectInsertionAnchors} from './insertion-anchors';
import {normalizeFlowTransforms} from './flow-transforms';
import {HostFallback} from './host-fallback';
import {PreviewReconnect} from './preview-reconnect';
import {LayoutHealth} from './layout-health';
import {LayoutRecovery} from './layout-recovery';
import {LayoutStage} from './layout-stage';
import {LayoutPaintQueue} from './layout-paint-queue';
import {createSocketRPC} from '../integration/socket-client.js';
import {hybridMasks} from './hybrid-overlay';
import {LatencyTracker} from './latency';
import {closestParagraph} from './paragraph-hit';
import {PageViewport} from './page-viewport';
import {PDFBaseCache} from './pdf-base-cache';
import {inferParagraphRhythm,textFontSignature} from './paragraph-rhythm';
import {FontStore,ImageStore,Painter,inexactReason,imageInfo} from '../vendor/webview/render';
import {PreviewModel} from '../vendor/webview/model';
import * as pdfjs from 'pdfjs-dist';
pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdf.worker.mjs',location.href).href;
const token=location.hash.slice(1)||'session';const readOnly=new URLSearchParams(location.search).has('preview');history.replaceState(null,'',location.pathname+location.search);
const headers={...(token==='session'?{}:{Authorization:`Bearer ${token}`}),'Content-Type':'application/json'};
let nativeInsertions=false,insertionMeta:any=null,provisional:any=null,heldInsertion:any=null;const nativeParagraphs=new Map<number,any>();const insertionCanvasPlans=new WeakMap<HTMLCanvasElement,any>();
const capturedRemovals=new Map<number,any>();const bodyCertificates=new Map<number,any>();let replacementMeta:any=null,windowCertificate:any=null,snapshotHold:any=null;
const paragraphRemovals=new Map<number,any>();let removalFloor:any=null,contentEpoch=0,insertionUnderlay:any=null,pendingUnderlay:any=null,heldRemoval:any=null;
let layoutHandover:any=null;let cursorSuppressed=0,cursorAppliedLayout='';
let paused=false;const lifecycle=new AbortController();addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
const socket=token==='session'?createSocketRPC(new URL('.',location.href),lifecycle.signal,globalThis.WebSocket,state=>{queueMicrotask(()=>{if(!paused)status.dataset.rtexTransport=state;});}):null;
const api=async(p:string,init:any={})=>{if(p.startsWith('poll?cursor=')&&!init.httpOnly){const reply=await socket?.request('/api/'+p);if(reply&&!(reply.status===413&&reply.body?.transport==='http')){status.dataset.rtexTransport='websocket';return {ok:reply.status>=200&&reply.status<300,status:reply.status,json:async()=>reply.body};}status.dataset.rtexTransport='http';}return fetch(new URL('api/'+p,location.href),{...init,signal:init.signal?AbortSignal.any([lifecycle.signal,init.signal]):lifecycle.signal,headers});};let currentPath='',projectId='',docId='';
const source=document.querySelector('textarea')!;source.readOnly=readOnly;if(readOnly)source.style.display='none';const status=document.querySelector('#status')!;const pages=document.querySelector('#pages')!;
const model=new PreviewModel(),layouts=new LayoutStage();let committedPlacements:any[]=[];let paragraphRhythms=new WeakMap<object,Map<string,ReturnType<typeof inferParagraphRhythm>>>();
const layoutPaintQueue=new LayoutPaintQueue();let layoutPaintVersions:any=null,layoutPaintTimer:any=null;const layoutPaintPDFPages=new Set<number>();
function paragraphRhythm(dl:any,page:number,signature:string|null){if(!signature)return null;let entries=paragraphRhythms.get(dl);if(!entries){entries=new Map();paragraphRhythms.set(dl,entries);}if(!entries.has(signature))entries.set(signature,inferParagraphRhythm({...dl,page},committedPlacements,signature));return entries.get(signature)??null;}let fonts=new FontStore();let fallbackRequest=0;let layoutLoad:any=null;const engineTimings=new Map<string,number>();const eventStages=new Map<string,any>();const pendingParagraphs=new Map<number,{event:any;stage:any}>();let committedVersions:any=null;let committedCompileMs:number|undefined;let cursorTarget:any=null,cursorApplied=0,layoutRevision=-1;let fallback:any=null,committedFallbackEvent:any=null,revision=0,ackText='',submittedText='',sending=false,engineRevision=0;let observedGeneration=0;
const recovery=new LayoutRecovery();const layoutHealth=new LayoutHealth();
function recoverLayout(versions:any=committedVersions){if(!versions||lifecycle.signal.aborted)return;const revision=Math.max(engineRevision,versions.source_revision),generation=Math.max(observedGeneration,versions.engine_generation);void recovery.request(revision,generation,async()=>{const response=await api('request-layout',{method:'POST',body:JSON.stringify({projectId,sourceRevision:revision,engineGeneration:generation})});if(!response.ok&&response.status!==409)throw Error('完整排版请求失败，请重新打开实时预览');}).catch(error=>{if(!lifecycle.signal.aborted)status.textContent=String(error);});}
const hostFallback=new HostFallback({signal:lifecycle.signal,latest:version=>({source_revision:Math.max(version.source_revision,engineRevision),engine_generation:Math.max(observedGeneration,version.engine_generation,committedVersions?.engine_generation??0)}),request:async version=>{const response=await api('request-layout',{method:'POST',body:JSON.stringify({projectId,sourceRevision:version.source_revision,engineGeneration:version.engine_generation})});if(response.status===409)return false;if(!response.ok)throw Error('完整排版请求失败，当前保留上一版预览');return true;},onError:error=>{if(!paused&&!lifecycle.signal.aborted)status.textContent=String(error);}});
let images=createImages();
function createImages(){const store=new ImageStore(async(data,page)=>{const pdf=await pdfjs.getDocument({data:data.slice()}).promise;const p=await pdf.getPage(page);const v=p.getViewport({scale:1.3});const c=document.createElement('canvas');c.width=v.width;c.height=v.height;await p.render({canvas:c,canvasContext:c.getContext('2d')!,viewport:v}).promise;return c;});
store.onLoaded=()=>{if(images===store&&!lifecycle.signal.aborted)scheduleResourceWake();};return store;}
let drawVersion=0;addEventListener('pagehide',()=>viewport.dispose(),{once:true});
const pdfBases=new PDFBaseCache<HTMLCanvasElement>(8);
const lazyPDFRecovery=new Map<string,{attempts:number;terminal:boolean}>();
const permanentPDFError=(error:any)=>[400,401,403,404,416].includes(error?.status);
function lazyRecoveryState(id:string){let state=lazyPDFRecovery.get(id);if(!state){state={attempts:0,terminal:false};lazyPDFRecovery.set(id,state);while(lazyPDFRecovery.size>12)lazyPDFRecovery.delete(lazyPDFRecovery.keys().next().value!);}return state;}
function recoverLazyPDF(error:any,request:number,document:any){
 if(lifecycle.signal.aborted||request!==fallbackRequest||document!==fallback)return true;
 const event=committedFallbackEvent;if(!event?.pdf_range)return false;
 if(layoutLoad&&layoutLoad.metrics.phase!=='committed')return true; // A newer paired layout already owns recovery; never replay the old event.
 const state=lazyRecoveryState(event.pdf_id);
 if(permanentPDFError(error)||state.attempts>=2){state.terminal=true;status.dataset.rtexPDFRecovery=JSON.stringify({pdfId:event.pdf_id,attempts:state.attempts,state:'stopped'});status.textContent='页面暂不可用，保留当前预览；请重新打开实时预览';return true;}
 state.attempts++;status.dataset.rtexPDFRecovery=JSON.stringify({pdfId:event.pdf_id,attempts:state.attempts,state:'retrying'});status.textContent='页面连接中断，保留当前预览，正在重新载入…';stageLayout(event);return true;
}
const previewTrace:any[]=[];
function tracePreview(kind:string,details:any={}){previewTrace.push({at:performance.timeOrigin+performance.now(),kind,...details});while(previewTrace.length>32)previewTrace.shift();status.dataset.rtexTrace=JSON.stringify(previewTrace);}
const generationRecovery=new GenerationRecovery({
 onTrace:entry=>{const {kind,...details}=entry;tracePreview(kind,details);},
 request:async(version,signal)=>{
  if(paused||lifecycle.signal.aborted)throw new DOMException('Aborted','AbortError');
  tracePreview('generation-recovery-request',{versions:version});status.dataset.rtexGenerationRecovery=JSON.stringify({state:'requesting',versions:version});
  const response=await api('request-layout',{method:'POST',signal,body:JSON.stringify({projectId,sourceRevision:version.source_revision,engineGeneration:version.engine_generation,reason:'source-lineage'})});
  const reply=await response.json();
  if(paused||lifecycle.signal.aborted||signal.aborted)throw new DOMException('Aborted','AbortError');
  if(response.ok||response.status===409)observeRecoveryPair({source_revision:reply.sourceRevision,engine_generation:reply.engineGeneration});
  tracePreview('generation-recovery-response',{versions:version,status:response.status,scheduled:reply.scheduled===true,latest:{source_revision:reply.sourceRevision,engine_generation:reply.engineGeneration}});
  if(response.status===409){status.dataset.rtexGenerationRecovery=JSON.stringify({state:'superseded',versions:version});return{status:'superseded',latest:{source_revision:reply.sourceRevision,engine_generation:reply.engineGeneration}};}
  if(!response.ok)throw Error('排版交接请求失败，保留当前预览');
  status.dataset.rtexGenerationRecovery=JSON.stringify({state:'waiting-capture',versions:version});return{status:'accepted',retryAfterMs:reply.retryAfterMs};
 },
 onError:()=>{tracePreview('generation-recovery-stopped',{sourceRevision:engineRevision,engineGeneration:observedGeneration});status.dataset.rtexGenerationRecovery=JSON.stringify({state:'stopped',sourceRevision:engineRevision,engineGeneration:observedGeneration});if(!paused&&!lifecycle.signal.aborted)status.textContent='排版交接暂未完成，保留当前预览；请重新打开实时预览';}
});
lifecycle.signal.addEventListener('abort',()=>generationRecovery.dispose(),{once:true});
addEventListener('pagehide',()=>generationRecovery.dispose(),{once:true});
function observeRecoveryPair(v:any){if(!Number.isSafeInteger(v?.source_revision)||v.source_revision<0||!Number.isSafeInteger(v?.engine_generation)||v.engine_generation<observedGeneration)return;engineRevision=Math.max(engineRevision,v.source_revision);observedGeneration=Math.max(observedGeneration,v.engine_generation);generationRecovery.observe({source_revision:engineRevision,engine_generation:observedGeneration});}
function observeEngineEvent(e:any){
 const sourceRevision=e.versions?.source_revision??(e.event==='DocumentChanged'?e.source_revision:undefined);
 if(Number.isSafeInteger(sourceRevision)&&sourceRevision>=0)engineRevision=Math.max(engineRevision,sourceRevision);
 const generation=e.versions?.engine_generation??(e.event==='EngineState'?e.engine_generation:undefined);
 if(Number.isSafeInteger(generation)&&generation>=0){if(generation>observedGeneration)tracePreview('generation-advanced',{from:observedGeneration,to:generation,event:e.event,state:e.state,bibliography:e.event==='EngineState'&&/bibliography/.test(String(e.reason??''))});observedGeneration=Math.max(observedGeneration,generation);}
 generationRecovery.observe({source_revision:engineRevision,engine_generation:observedGeneration});
 if(e.event==='EngineState')tracePreview('engine-state',{engineGeneration:generation,state:e.state,bibliography:/bibliography/.test(String(e.reason??''))});
 if(e.event==='LayoutDeferred')tracePreview('layout-deferred',{versions:e.versions,reason:['superseded-generation','superseded-staged-capture','superseded-capture','capture-missing-live-insertions'].includes(e.reason)?e.reason:'other',missingCount:e.missingParIds?.length??0});
 if(e.event==='LayoutUpdate')tracePreview('layout-received',{versions:e.versions,pages:e.pages_total,compileState:e.compile?.state,passes:e.passes,wallMs:e.wall_ms,convergence:e.convergence?.state,pdfBytes:e.pdf_bytes});
 if((e.event==='ParagraphUpdate'||e.event==='EngineState'&&e.state==='Ready')&&Number.isSafeInteger(generation)&&(!committedVersions||generation>committedVersions.engine_generation))generationRecovery.demand();
}
function exportPreviewDiagnostics(){
 const fields=['rtexEditShape','rtexLastClassifiedShape','rtexSourceLineage','rtexGenerationRecovery','rtexConnection','rtexTransport','rtexDelivery','rtexCompileState','rtexLayoutLoading','rtexLatency','rtexInsertion','rtexHandover','rtexPaintQueue'];
 const report={format:1,build:'capture-demand-20261101',observedAt:Date.now(),projectId,engineRevision,baseline:committedVersions,latestObserved:{source_revision:engineRevision,engine_generation:observedGeneration},states:Object.fromEntries(fields.map(k=>[k,status.dataset[k]??null])),trace:previewTrace.slice(),dirtyCertificate:replacementMeta?{kind:replacementMeta.kind,sourceRevision:replacementMeta.sourceRevision,parId:replacementMeta.parId,dirtyUnits:replacementMeta.dirtyUnits??[],units:replacementMeta.units??[],replacedParIds:replacementMeta.replacedParIds??[],removedParIds:replacementMeta.removedParIds??[],outsideAliases:replacementMeta.outsideAliases??[],reverted:replacementMeta.reverted===true}:null,canvases:[...pages.querySelectorAll('canvas')].map((c:any)=>({page:c.dataset.page,layout:c.dataset.rtexLayout??null,overlays:c.dataset.rtexOverlays??null,insertion:c.dataset.rtexInsertion??null,removals:c.dataset.rtexRemovals??null})),sourceIncluded:false};
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='rtex-preview-diagnostics.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const diagnosticHeader=status.parentElement;if(diagnosticHeader?.tagName==='HEADER'){const button=document.createElement('button');button.textContent='诊断';button.title='下载最近的预览状态和耗时记录，不包含正文';button.style.cssText='float:right;font-size:12px;margin-left:8px;cursor:pointer';button.addEventListener('click',exportPreviewDiagnostics);diagnosticHeader.append(button);}
function removalPlans(page:number,dl:any){return [...capturedRemovals.values()].filter(r=>r.page===page&&r.dl===dl&&committedVersions&&versionFields.every(k=>r.baseline[k]===committedVersions[k])&&(r.sourceCertificate?.kind==='body-window-replacement'&&r.sourceCertificate.units.length===0||paragraphRemovals.has(r.parId)&&compareSource(paragraphRemovals.get(r.parId),r.versions)===0));}
function removalManifestsMatch(projections:any[],overlays:any[]){
 return projections.every(r=>Array.isArray(r.safeOverlayManifest)&&r.safeOverlayManifest.length===overlays.length&&r.safeOverlayManifest.every((entry:any)=>{const current=overlays.find(o=>o.overlay.parId===entry.parId),saved=nativeParagraphs.get(entry.parId)?.event,cert=bodyCertificates.get(entry.parId);return current&&current.overlay.dl===entry.dl&&current.overlay.revision===entry.sourceRevision&&saved===entry.event&&saved.edit_id===entry.editId&&cert?.proof.editId===entry.editId&&cert.proof.sourceRevision===entry.sourceRevision&&versionFields.every(k=>cert.baseline[k]===r.baseline[k])&&dlResourcesReady(current.overlay.dl);}));
}
function projectCapturedRemoval(e:any){
 const v=e.versions,id=e.par_id,b=committedVersions;if(!b||v.source_revision<=b.source_revision||['engine_generation','context_revision','layout_version'].some(k=>v[k]!==b[k]))return null;
 const placed=committedPlacements.find(p=>p.par_id===id);if(!placed||placed.fragments.length!==1)return null;
 const page=placed.fragments[0].page,base=model.pages.get(page);if(!base||[provisional,heldInsertion].some(flow=>flow?.plan.page===page)||heldRemoval?.page===page||layoutHandover?.page===page)return null;
 const overlays=model.overlaysOn(page),proven=overlays.map(item=>{const event=nativeParagraphs.get(item.overlay.parId)?.event,certificate=bodyCertificates.get(item.overlay.parId);return {...item,event,resourcesReady:dlResourcesReady(item.overlay.dl),nativeProof:certificate&&versionFields.every(k=>certificate.baseline[k]===b[k])?certificate.proof:null};});
 const admitted=planRemovalAdmission({dl:base.dl,page,parId:id,placements:committedPlacements,owned:model.ownLines(page,id),fonts,scale:.000020,removalVersions:v,baseline:b,baseResourcesReady:dlResourcesReady(base.dl),otherPageOverlays:proven});
 if(!admitted.ok){tracePreview('removal-deferred',{parId:id,page,reason:admitted.reason});return null;}
 const projection={...admitted.projection,safeOverlayManifest:admitted.safeOverlayManifest,parId:id,page,dl:base.dl,baseline:{...b},versions:{...v}};capturedRemovals.set(id,projection);tracePreview('removal-projected',{parId:id,page,sourceRevision:v.source_revision});return projection;
}
function clearPdfBases(){pdfBases.clear();cursorPDFWarm.clear();}
const cursorPDFWarm=new Set<string>();let cursorWarmLoads=0;
function warmCursorPDF(target:any){
 if(!fallback||!committedFallbackEvent||paused)return;const fragments=model.placements.get(target.parId),f=target.edge==='end'?fragments?.at(-1):fragments?.[0];if(!f)return;
 const key=`${fallbackRequest}:${f.page}`;if(cursorPDFWarm.has(key)||cursorWarmLoads>=1)return;cursorPDFWarm.add(key);while(cursorPDFWarm.size>24)cursorPDFWarm.delete(cursorPDFWarm.values().next().value!);
 const dl=model.pages.get(f.page)?.dl;if(!dl)return;const lease=pdfBase(f.page,Math.ceil((dl.page_width??dl.width)*.000020));const began=performance.now();cursorWarmLoads++;void lease.promise.then(()=>tracePreview('cursor-pdf-warm',{page:f.page,ms:performance.now()-began}),()=>{}).finally(()=>{lease.release();cursorWarmLoads--;if(cursorTarget)warmCursorPDF(cursorTarget);});
}
function pdfBase(n:number,width:number){const pdfDocument=fallback,request=fallbackRequest,key=`${request}:${n}:${width}`;return pdfBases.acquire(key,async()=>{const page=await pdfDocument.getPage(n),view=page.getViewport({scale:width/page.getViewport({scale:1}).width}),base=documentCanvas();base.width=Math.ceil(view.width);base.height=Math.ceil(view.height);try{await page.render({canvas:base,canvasContext:base.getContext('2d')!,viewport:view}).promise;return base;}catch(error){base.width=base.height=0;throw error;}});}
function documentCanvas(){return document.createElement('canvas');}
addEventListener('pagehide',()=>{clearPdfBases();void fallback?.destroy();},{once:true});
async function renderPage(n:number){const epoch=contentEpoch;if(layoutHandover?.page===n)return cloneInsertionCanvas(layoutHandover.canvas);if(heldRemoval?.page===n&&compareSource(committedVersions,heldRemoval.versions)<0)return cloneInsertionCanvas(heldRemoval.canvas);if(heldInsertion?.plan.page===n)return cloneInsertionCanvas(heldInsertion.canvas);if(provisional?.plan.page===n&&!sameOverlayManifest(provisional.overlayVersions,model.overlaysOn(n).map(o=>({parId:o.overlay.parId,revision:o.overlay.revision})))){freezeInsertion();if(heldInsertion)return cloneInsertionCanvas(heldInsertion.canvas);}const renderedVersions=committedVersions?{...committedVersions}:null,fullCompileMs=committedCompileMs;if(model.deferredPages.has(n)){recoverLayout();status.textContent='段落位置正在重新排版，保留上一版预览';if(viewport.pageElement(n)?.querySelector('canvas'))throw Error('KEEP_LAST_FRAME');}const p=model.pages.get(n);if(!p)throw Error('Page unavailable');const dl=p.dl;if(p.exact&&!dlResourcesReady(dl)){rememberBlockedPage(n);throw Error('KEEP_LAST_FRAME');}const scale=0.000020;const c=document.createElement('canvas');c.width=Math.ceil((dl.page_width??dl.width)*scale);c.height=Math.ceil((dl.page_height??dl.height)*scale);c.dataset.page=String(n);const ctx=c.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,c.width,c.height);
 const reason=!p.exact?'等待完整页面':inexactReason(dl,fonts,images);const replacement=provisional?.kind==='replacement'&&provisional.plan.page===n?provisional:null;const overlays=model.overlaysOn(n).filter(o=>!replacement||![...flowIds(replacement),...(replacement.oldParIds??[])].includes(o.overlay.parId));const painted:any[]=[];const plans=new Map<number,any>();let refused=false;
 if(overlays.length&&!globalGlyphResourcesReady(dl)){rememberBlockedPage(n);throw Error('KEEP_LAST_FRAME');}
 for(const item of overlays){const others=overlays.filter(other=>other!==item),otherRows=others.flatMap(other=>other.rows),owned=model.ownLines(n,item.overlay.parId);let plan=hybridMasks(dl,owned,item.rows,otherRows,boundOtherGlyphs(dl,fonts)??[]);if(plan.reason)plan=planInkOverlayMasks({dl,owned,rows:item.rows,liveDL:item.overlay.dl,otherOverlays:others,fonts,scale});if(!dlResourcesReady(item.overlay.dl)){rememberBlockedPage(n);refused=true;break;}if(plan.reason||inexactReason(item.overlay.dl,fonts,images)){tracePreview('overlay-deferred',{page:n,parId:item.overlay.parId,reason:plan.reason??inexactReason(item.overlay.dl,fonts,images)});refused=true;break;}plans.set(item.overlay.parId,plan);}
 if(refused){recoverLayout();status.textContent='正在等待完整排版，保留上一版预览以避免文字重叠';if(viewport.pageElement(n)?.querySelector('canvas'))throw Error('KEEP_LAST_FRAME');}
 const drawable=refused?[]:overlays;
 const removed=removalPlans(n,dl),hiddenRemoved=new Set(removed.flatMap(r=>r.hiddenLineIndices));
 if(removed.length&&(!removalManifestsMatch(removed,drawable)||!capturedRemovalOverlaysSafe(removed.flatMap(r=>r.rects),drawable,fonts,scale))){tracePreview('removal-overlay-deferred',{page:n});throw Error('KEEP_LAST_FRAME');}
 if(reason){if(!fallback)throw Error('KEEP_LAST_FRAME');const request=fallbackRequest,document=fallback;if(committedFallbackEvent&&lazyPDFRecovery.get(committedFallbackEvent.pdf_id)?.terminal)throw Error('KEEP_LAST_FRAME');const lease=pdfBase(n,c.width);try{let base;try{base=await lease.promise;}catch(error){if(request!==fallbackRequest)throw Error('STALE_PDF_BASE');if(recoverLazyPDF(error,request,document))throw Error('KEEP_LAST_FRAME');throw error;}if(request!==fallbackRequest)throw Error('STALE_PDF_BASE');if(epoch!==contentEpoch||base.width<=0||base.height<=0)throw Error('KEEP_LAST_FRAME');if(drawable.length&&!globalGlyphResourcesReady(dl)||drawable.some(item=>!dlResourcesReady(item.overlay.dl)))throw Error('KEEP_LAST_FRAME');if(removed.length&&(!removalManifestsMatch(removed,drawable)||!capturedRemovalOverlaysSafe(removed.flatMap(r=>r.rects),drawable,fonts,scale)))throw Error('KEEP_LAST_FRAME');ctx.drawImage(base,0,0,c.width,c.height);const painter=new Painter(ctx,[scale,0,0,scale,0,0],fonts,images);for(const r of removed)painter.clearRects(r.rects,'white');for(const item of drawable){painter.clearRects(plans.get(item.overlay.parId).rects,'white');painter.draw(item.overlay.dl,item.overlay.dl.other??[]);for(const row of item.rows)painter.draw(item.overlay.dl,row.line.items,row.dx,row.dy);painted.push({parId:item.overlay.parId,revision:item.overlay.revision});}}finally{lease.release();}}
 else{const painter=new Painter(ctx,[scale,0,0,scale,0,0],fonts,images);const hidden=refused?new Set<number>():model.hiddenLines(n);dl.lines.forEach((line,i)=>{if(hiddenRemoved.has(i))painter.draw(dl,line.items.filter(it=>it[0]==='c'));else if(replacement?.owned.has(i))painter.draw(dl,line.items.filter(it=>it[0]==='c'));else if(!hidden.has(i))painter.draw(dl,line.items)});painter.draw(dl,dl.other??[]);for(const ov of drawable){painter.draw(ov.overlay.dl,ov.overlay.dl.other??[]);for(const row of ov.rows)painter.draw(ov.overlay.dl,row.line.items,row.dx,row.dy);painted.push({parId:ov.overlay.parId,revision:ov.overlay.revision});}}
 c.dataset.rtexRemovals=JSON.stringify(removed.map(r=>({parId:r.parId,...(r.metricParId?{metricParId:r.metricParId,metricEligible:r.metricEligible}:{}),sourceRevision:r.versions.source_revision,page:n})));c.dataset.rtexOverlays=JSON.stringify(painted);if(renderedVersions)c.dataset.rtexLayout=JSON.stringify({...renderedVersions,fullCompileMs});
return insertionCanvas(c,n,renderedVersions);}
let lastMetricRevision=-1;const latency=new LatencyTracker(metric=>{if(paused)return;if(metric.sourceRevision<lastMetricRevision)return;lastMetricRevision=metric.sourceRevision;status.dataset.rtexLatency=JSON.stringify(metric);status.textContent=`${metric.kind==='deletion'?'删除已显示（分页待校正）':metric.kind==='insertion'?'新段落已显示（分页待校正）':metric.kind==='layout'?'完整排版已更新':'段落已更新'} · ${Number.isFinite(metric.mathReadyToPaintMs)?'公式完成到绘制 '+metric.mathReadyToPaintMs.toFixed(0)+' ms':'输入到绘制 '+metric.totalMs.toFixed(0)+' ms'}${metric.kind==='layout'?(Number.isFinite(metric.fullCompileMs)?' · 完整编译 '+metric.fullCompileMs.toFixed(0)+' ms':''):metric.kind==='deletion'?'':' · 段落引擎 '+metric.engineMs.toFixed(2)+' ms'}${status.dataset.rtexCompileState==='CompiledWithErrors'?' · 文档仍有编译错误':''}`;});
const viewport=new PageViewport(pages,async page=>{if(paused)throw Error('KEEP_LAST_FRAME');const epoch=contentEpoch,canvas=await renderPage(page);if(epoch!==contentEpoch)throw Error('KEEP_LAST_FRAME');if(paused){canvas.width=canvas.height=0;throw Error('KEEP_LAST_FRAME');}return canvas;},{onPaint:page=>{recordLayoutPaint(page);releaseLayoutPaintQueue(page);followCursor();requestAnimationFrame(()=>{if(paused)return;const canvas=viewport.pageElement(page)?.querySelector('canvas');const rb=canvas?.getBoundingClientRect(),rr=pages.getBoundingClientRect();if(documentVisible()&&rb&&rb.bottom>rr.top&&rb.top<rr.bottom&&rb.right>rr.left&&rb.left<rr.right)for(const r of JSON.parse(canvas?.dataset.rtexRemovals??'[]')){const projection=capturedRemovals.get(r.parId);if(r.metricEligible===false)continue;const sx=.000020*rb.width/canvas!.width,sy=.000020*rb.height/canvas!.height;if(!projection?.rects.some((q:number[])=>rb.left+q[2]*sx>rr.left&&rb.left+q[0]*sx<rr.right&&rb.top+q[3]*sy>rr.top&&rb.top+q[1]*sy<rr.bottom))continue;latency.deletionPaint(r.sourceRevision,performance.timeOrigin+performance.now(),{visible:true,parId:r.metricParId??r.parId,page:r.page});}for(const item of JSON.parse(canvas?.dataset.rtexOverlays??'[]')){const engineMs=engineTimings.get(`${item.revision}:${item.parId}`);if(engineMs!==undefined)latency.paint(item.revision,engineMs,performance.timeOrigin+performance.now(),{...eventStages.get(`${item.revision}:${item.parId}`),parId:item.parId});}});},onError:error=>{if(paused)return;if(!['Error: STALE_PDF_BASE','Error: KEEP_LAST_FRAME'].includes(String(error)))status.textContent=String(error);}});
function documentVisible(){const frame=window.frameElement;return !document.hidden&&document.visibilityState!=='hidden'&&frame?.checkVisibility?.({checkVisibilityCSS:true,checkOpacity:true})!==false;}
function recordLayoutPaint(page:number){finishLayoutHandover(page);promoteUnderlay(page);releaseConvergedUnderlay(page);recordInsertionPaint(page);if(paused)return;if(!documentVisible()){latency.invalidateBefore(performance.timeOrigin+performance.now());return;}if(!committedVersions)return;const element=viewport.pageElement(page),canvas=element?.querySelector('canvas');if(canvas?.dataset.rtexInsertion)return;if(!canvas?.dataset.rtexLayout||JSON.parse(canvas.dataset.rtexOverlays??'[]').length)return;const version=JSON.parse(canvas.dataset.rtexLayout);if(['source_revision','engine_generation','layout_version','context_revision'].some(key=>version[key]!==committedVersions[key]))return;const bounds=pages.getBoundingClientRect(),box=element!.getBoundingClientRect();if(box.height<=0||box.width<=0||bounds.width<=0||bounds.bottom<=bounds.top||box.bottom<=bounds.top||box.top>=bounds.bottom)return;const modelPage=model.pages.get(page);if(!modelPage)return;const height=modelPage.dl.page_height??modelPage.dl.height;if(!Number.isFinite(height)||height<=0)return;const parIds:number[]=[];for(const [id,fragments]of model.placements){if(!model.ownLines(page,id).size)continue;if(fragments.some(fragment=>fragment.page===page&&fragment.approximate===false&&fragment.baselines?.some(baseline=>{const y=box.top+baseline*box.height/height;return y>=bounds.top&&y<=bounds.bottom;})))parIds.push(id);}latency.layoutPaint(version.source_revision,performance.timeOrigin+performance.now(),{page,parIds,engineGeneration:version.engine_generation,contextRevision:version.context_revision,layoutVersion:version.layout_version,fullCompileMs:version.fullCompileMs,visible:true});}
document.addEventListener?.('visibilitychange',()=>{latency.invalidateBefore(performance.timeOrigin+performance.now());if(!documentVisible())void orderedPreview(()=>flushLayoutPaintQueue('hidden'));});
function pausePreview(reason:string){if(paused)return;paused=true;takeLayoutPaintQueue('paused');clearLayoutHandover();provisional=null;clearHeldInsertion();insertionMeta=null;nativeParagraphs.clear();lifecycle.abort();socket?.close();cancelLayoutLoad();layouts.reset();++fallbackRequest;pendingParagraphs.clear();viewport.freeze();cursorTarget=null;source.disabled=true;clearPdfBases();void fallback?.destroy();status.dataset.rtexConnection='paused';status.textContent='预览已暂停，保留最后画面：'+reason;}
addEventListener('message',message=>{const value=message.data;if(message.origin!==location.origin||message.source!==parent||!projectId||value?.type!=='rtex:pause'||value.projectId!==projectId)return;pausePreview(typeof value.reason==='string'?value.reason.slice(0,500):'连接或文档状态已变化，请重新打开实时预览');});
async function draw(dirty?:Iterable<number>,sync=true){if(paused||lifecycle.signal.aborted)return;if(sync)viewport.sync([...model.pages].map(([page,p])=>({page,width:(p.dl.page_width??p.dl.width)*.000020,height:(p.dl.page_height??p.dl.height)*.000020})));viewport.invalidate(dirty);followCursor();}
function unavailableNavigation(){if(paused)return;parent.postMessage({type:'rtex:nav-unavailable',projectId},location.origin);}
let cursorMaterialized='';
function materializeCursorPage(page:number){
 if(paused||!cursorTarget||!committedVersions||!model.pages.has(page))return;
 const element=viewport.pageElement(page);if(!element)return;
 const box=element.getBoundingClientRect(),root=pages.getBoundingClientRect();
 if(!Number.isFinite(box.top)||!Number.isFinite(box.bottom)||root.height<=0||box.height<=0)return;
 const key=JSON.stringify([cursorTarget.sequence,page,...versionFields.map(field=>committedVersions[field])]);
 if(cursorMaterialized===key)return;cursorMaterialized=key;
 if(layoutHandover?.targetPage===page&&viewport.preparePage){viewport.preparePage(page);return;}
 // ensurePage only schedules visible pages. Bring the committed placeholder
 // into view first; a missing/stale bitmap cannot authorize baseline projection.
 if(box.bottom<=root.top||box.top>=root.bottom)pages.scrollTo({top:pages.scrollTop+box.top-root.top,behavior:'auto'});
 viewport.ensurePage(page);
}
function cursorPresentationStamp(){const frames=[...model.pages.keys()].flatMap(page=>{const proof=displayedWindowCertificate(page),shown=displayedInsertion(page);return proof||shown?[{page,revision:proof?.sourceRevision??shown.meta.sourceRevision,aliases:proof?.outsideAliases??[]}]:[];});return JSON.stringify([committedVersions,frames]);}
function followCursor(){
 const stamp=cursorPresentationStamp();if(paused||!cursorTarget||cursorTarget.sequence<=cursorSuppressed||cursorTarget.sequence===cursorApplied&&cursorAppliedLayout===stamp)return;
 const pendingAlias=windowCertificate?.outsideAliases?.some((a:any)=>a.currentParId===cursorTarget.parId);if(pendingAlias&&windowCertificate.sourceRevision>=cursorTarget.sourceRevision&&![...model.pages.keys()].some(page=>displayedWindowCertificate(page)?.sourceRevision>=windowCertificate.sourceRevision))return;
 const candidate=provisional??heldInsertion;
 if(candidate&&flowIds(candidate).includes(cursorTarget.parId)){const flow=displayedInsertion(candidate.plan.page);if(!flow||!displayedLayoutMatches(candidate.plan.page)){materializeCursorPage(candidate.plan.page);return;}if(cursorTarget.sourceRevision>flow.meta.sourceRevision)return;const element=viewport.pageElement(flow.plan.page)!,canvas=element.querySelector('canvas')!,marker=JSON.parse(canvas.dataset.rtexInsertion),box=element.getBoundingClientRect();cursorApplied=cursorTarget.sequence;cursorAppliedLayout=stamp;pages.scrollTo({top:pages.scrollTop+box.top-pages.getBoundingClientRect().top+(cursorTarget.edge==='end'?((flow.blocks?.find((b:any)=>b.parId===cursorTarget.parId)?.event.dl.lines.at(-1)?.y??flow.event.dl.lines.at(-1)?.y??0)+(flow.blocks?.find((b:any)=>b.parId===cursorTarget.parId)?.dy??0)+flow.plan.translation.dy)*.000020:(flow.blocks?.find((b:any)=>b.parId===cursorTarget.parId)?(flow.blocks.find((b:any)=>b.parId===cursorTarget.parId).firstBaseline+flow.plan.translation.dy)*.000020:marker.firstBaselinePx))*box.height/Number(canvas.height)-pages.clientHeight*.3,behavior:'auto'});return;}
 const captureId=capturedCursorId(cursorTarget.parId),overlay=model.overlays.get(captureId),fragments=overlay?.fragments??model.placements.get(captureId);let fragment=cursorTarget.edge==='end'?fragments?.at(-1):fragments?.[0];
 if(!fragment||!fragment.baselines?.length){if(cursorTarget.explicit){unavailableNavigation();cursorApplied=cursorTarget.sequence;cursorAppliedLayout=stamp;}return;}
 const shown=displayedInsertion(fragment.page);if(shown)fragment=model.placements.get(captureId)?.find(f=>f.page===fragment!.page)??fragment;
 if(!displayedLayoutMatches(fragment.page)){materializeCursorPage(fragment.page);return;}
 if(shown&&cursorTarget.sourceRevision>shown.meta.sourceRevision)return;
 const windowProof=displayedWindowCertificate(fragment.page),protectedAlias=windowProof?.sourceRevision>=cursorTarget.sourceRevision&&windowProof.outsideAliases?.some((a:any)=>a.capturedParId===captureId&&a.currentParId===cursorTarget.parId);if(!protectedAlias&&layoutRevision<cursorTarget.sourceRevision&&(!overlay||overlay.revision<cursorTarget.sourceRevision)&&(!shown||shown.meta.sourceRevision<cursorTarget.sourceRevision))return;
 const element=viewport.pageElement(fragment.page),page=model.pages.get(fragment.page);if(!element||!page)return;const box=element.getBoundingClientRect(),height=page.dl.page_height??page.dl.height,y=shown?projectBaselineY(shown.plan,(cursorTarget.edge==='end'?fragment.baselines.at(-1):fragment.baselines[0]))*box.height/shown.plan.projection.expandedHeight:(cursorTarget.edge==='end'?fragment.baselines.at(-1)!:fragment.baselines[0])*box.height/height;
 cursorApplied=cursorTarget.sequence;cursorAppliedLayout=stamp;pages.scrollTo({top:pages.scrollTop+box.top-pages.getBoundingClientRect().top+y-pages.clientHeight*.3,behavior:'auto'});viewport.ensurePage(fragment.page);
}
addEventListener('message',message=>{const value=message.data;if(paused||message.origin!==location.origin||message.source!==parent||!value||value.type!=='rtex:cursor'||value.projectId!==projectId||!Number.isSafeInteger(value.parId)||!Number.isSafeInteger(value.sourceRevision)||!Number.isSafeInteger(value.sequence)||value.sequence<=0||value.edge!==undefined&&value.edge!=='end')return;if(!projectDocuments.some((d:any)=>d.docId===value.docId&&d.path===value.path))return;if(cursorTarget&&value.sequence<cursorTarget.sequence)return;cursorTarget=value;warmCursorPDF(value);followCursor();});
const versionFields=['source_revision','engine_generation','context_revision','layout_version'];
function acceptInsertion(meta:any){
 if(paragraphRemoved(meta.parId,{...meta.baseVersions,source_revision:meta.sourceRevision}))return;
 if(!nativeInsertions||paused||meta.projectId!==projectId||!projectDocuments.some(d=>d.docId===meta.docId&&d.path===meta.path)||!Number.isSafeInteger(meta.sourceRevision)||meta.sourceRevision<engineRevision)return;
 if(meta.state!=='ready'||meta.verified!==true){if(provisional){freezeInsertion();status.textContent='新增内容正在重新排版，当前保留上一版临时排版';}insertionMeta=null;return;}
 insertionMeta=meta;tryInsertion();
}
function tryInsertion(){
 const meta=insertionMeta;let record=meta&&nativeParagraphs.get(meta.parId);if(!meta||!record||!committedVersions||paused||meta.sourceRevision<engineRevision||meta.sourceRevision<=layoutRevision||versionFields.some(k=>meta.baseVersions?.[k]!==committedVersions[k]))return;
 const boundaryPage=model.placements.get(meta.beforeParId)?.at(-1)?.page,donor=boundaryPage&&model.pages.get(boundaryPage);
 const rhythm=donor?paragraphRhythm(donor.dl,boundaryPage,textFontSignature(record.event.dl)):null;
 let batch:any=null;if(Array.isArray(meta.insertions)){
  batch=assembleInsertionBatch(meta,nativeParagraphs,rhythm);if(!batch.ok)return;
  if(batch.blocks.some((b:any)=>paragraphRemoved(b.parId,b.event.versions)||!dlResourcesReady(b.event.dl)||inexactReason(b.event.dl,fonts,images)))return;
  record={event:{par_id:meta.parId,status:'ok',versions:batch.versions,dl:batch.dl,timing:{total_us:batch.totalUs}},stage:record.stage};
 }
 const retractsRemoval=batch&&heldRemoval&&meta.baseVersions.engine_generation===heldRemoval.versions.engine_generation&&meta.sourceRevision>=heldRemoval.versions.source_revision&&(heldRemoval.removedParIds??[]).every((id:number)=>meta.removedParIds?.includes(id));
 if(heldRemoval&&compareSource(committedVersions,heldRemoval.versions)<0&&!retractsRemoval)return;
 // A single insertion plan is relative to the captured baseline, not to the
 // already-expanded bitmap. Replacing it with another ID would erase the
 // preceding new paragraph. Keep the proven pixels until a current capture
 // incorporates it; multi-insertion composition needs its own geometry proof.
 const preceding=provisional??heldInsertion;
 if(preceding&&!batchAccountsFor(flowIds(preceding),batch?batch.blocks.map((b:any)=>b.parId):[meta.parId],meta.removedParIds??[])){
  if(provisional)freezeInsertion();
  recoverLayout(record.event.versions);
  status.textContent='多个新增段落正在完整排版，保留已显示内容';
  return;
 }
 const e=record.event;if(paragraphRemoved(e.par_id,e.versions)||!dlResourcesReady(e.dl)||e.status!=='ok'||e.versions.source_revision!==meta.sourceRevision||inexactReason(e.dl,fonts,images))return;
 const anchors=selectInsertionAnchors(model.placements.get(meta.beforeParId),model.placements.get(meta.afterParId),true);
 if(!anchors.ok){status.dataset.rtexInsertion=JSON.stringify({state:'waiting-layout',reason:anchors.reason,sourceRevision:meta.sourceRevision});return;}
 const page=anchors.page,base=model.pages.get(page),afterPage=anchors.pageEnd?model.pages.get(anchors.after.page):null;if(!base||!dlResourcesReady(base.dl)||anchors.pageEnd&&!afterPage)return;
 const sameBatch=batch&&provisional?.blocks?.length===batch.blocks.length&&batch.blocks.every((b:any,i:number)=>provisional.blocks[i].event===b.event);
 if(provisional?.meta===meta&&(provisional.event===e||sameBatch)&&sameOverlayManifest(provisional.overlayVersions,model.overlaysOn(page).map(o=>({parId:o.overlay.parId,revision:o.overlay.revision})))&&model.overlaysOn(page).every(o=>dlResourcesReady(o.overlay.dl)))return;
 const geometry=normalizeFlowTransforms(base.dl,fonts);if(!geometry.ok){status.dataset.rtexInsertion=JSON.stringify({state:'waiting-layout',reason:geometry.reason,sourceRevision:meta.sourceRevision});return;}
 const otherGlyphBounds=boundOtherGlyphs(base.dl,fonts);if(otherGlyphBounds===null){status.dataset.rtexInsertion=JSON.stringify({state:'waiting-layout',reason:'Unbounded font outline',sourceRevision:meta.sourceRevision});return;}
 for(const unit of meta.requiredUnits??[]){if(!model.placements.has(unit.parId))return;let overlay=model.overlays.get(unit.parId);if(!overlay||overlay.revision<unit.sourceRevision){const saved=nativeParagraphs.get(unit.parId),event=saved?.event;if(!event||!dlResourcesReady(event.dl)||event.status!=='ok'||event.versions.source_revision<unit.sourceRevision||event.versions.source_revision>meta.sourceRevision||versionFields.slice(1).some(k=>event.versions[k]!==committedVersions[k])||inexactReason(event.dl,fonts,images))return;model.applyParagraph(unit.parId,event.dl,event.fragments,event.versions.source_revision);overlay=model.overlays.get(unit.parId);}if(!overlay||overlay.revision>meta.sourceRevision)return;const provenance=nativeParagraphs.get(unit.parId)?.event;if(!provenance||provenance.dl!==overlay.dl||provenance.versions.source_revision!==overlay.revision||versionFields.slice(1).some(k=>provenance.versions[k]!==committedVersions[k]))return;}
 const overlays=model.overlaysOn(page);for(const item of overlays){const provenance=nativeParagraphs.get(item.overlay.parId)?.event;if(!provenance||!dlResourcesReady(item.overlay.dl)||provenance.dl!==item.overlay.dl||provenance.versions.source_revision!==item.overlay.revision||versionFields.slice(1).some(k=>provenance.versions[k]!==committedVersions[k]))return;}const sourceAnchors=anchors.pageEnd?[...model.placements.keys()].filter(id=>model.ownLines(page,id).size):[meta.beforeParId,meta.afterParId];const owned=new Map([...sourceAnchors,...overlays.map(o=>o.overlay.parId)].map(id=>[id,model.ownLines(page,id)]));
 // The bitmap painter clears original row masks. A scaled glyph can protrude
 // beyond its row, so prove those masks have not erased any normalized ink.
 for(const overlay of overlays){const masks=hybridMasks(base.dl,owned.get(overlay.overlay.parId)!,overlay.rows,overlays.filter(other=>other!==overlay).flatMap(other=>other.rows),otherGlyphBounds);if(masks.reason||geometry.transforms.some(t=>masks.rects.some(([x0,y0,x1,y1])=>x0<t.bound.x1&&x1>t.bound.x0&&y0<t.bound.y1&&y1>t.bound.y0)))return;}
 const composed=composeFlowPage({base:geometry.dl,overlays,owned,anchors:sourceAnchors,boundedOtherGlyphs:otherGlyphBounds});if(!composed.ok){status.dataset.rtexInsertion=JSON.stringify({state:'waiting-layout',reason:composed.reason,sourceRevision:meta.sourceRevision});return;}
 const beforeRows=composed.anchorLineIndices.get(meta.beforeParId)!.map(i=>composed.dl.lines[i]),advance=rhythm?.paragraphAdvance??rhythm?.lineAdvance;
 const minimumFirstBaseline=advance&&meta.plainBodyParIds?.includes(batch?batch.blocks[0].parId:meta.parId)&&textFontSignature(batch?batch.blocks[0].event.dl:e.dl)===rhythm?.fontSignature&&committedPlacements.find(p=>p.par_id===meta.beforeParId)?.kind==='par'&&textFontSignature({...composed.dl,other:[]},beforeRows)===rhythm?.fontSignature?Math.max(...beforeRows.map(r=>r.y))+advance:undefined;
 const otherSourceLineIndices=anchors.pageEnd?[...new Set([...composed.anchorLineIndices].filter(([id])=>id!==meta.beforeParId).flatMap(([,indices])=>indices))]:[];
 const dirty=new Set<number>();
 const plan=planInsertionFlow({page:composed.dl,pageNumber:page,baseVersions:committedVersions,lineage:{...meta,kind:'pure-insertion',insertionCount:1,split:false,insertedParId:meta.parId,before:{parId:meta.beforeParId,page,lineIndices:composed.anchorLineIndices.get(meta.beforeParId)!},after:{parId:meta.afterParId,page:anchors.after.page,lineIndices:anchors.pageEnd?[...model.ownLines(anchors.after.page,meta.afterParId)]:composed.anchorLineIndices.get(meta.afterParId)!}},insert:e.dl,insertVersions:e.versions,insertDrawable:true,existingOverlayParIds:[],renderScale:.000020,boundedOtherGlyphs:otherGlyphBounds,minimumFirstBaseline,...(anchors.pageEnd?{pageEnd:{afterPage:afterPage!.dl,otherSourceLineIndices}}:{})});
 if(!plan.ok){status.dataset.rtexInsertion=JSON.stringify({state:'waiting-layout',reason:plan.reason,sourceRevision:meta.sourceRevision});if(dirty.size)void draw(dirty,false);return;}
 clearHeldInsertion();if(retractsRemoval)clearHeldRemoval();contentEpoch++;provisional={meta,event:e,stage:record.stage,plan,blocks:batch?.blocks,overlayVersions:composed.overlayVersions};status.dataset.rtexInsertion=JSON.stringify({state:'provisional',parId:meta.parId,parIds:flowIds(provisional),sourceRevision:meta.sourceRevision,page,pageEnd:Boolean(anchors.pageEnd),rhythmAdvance:advance??null});status.textContent='新段落正在显示，分页将在后台校正';dirty.add(page);void draw(dirty,false);
}
function releaseOrdinaryReplacement(e:any){if((provisional??heldInsertion)?.meta?.sourceCertificate?.kind==='body-window-replacement')return;
 const active=provisional??heldInsertion;if(active?.kind!=='replacement'||!flowIds(active).includes(e.par_id)||compareSource(e.versions,active.event.versions)<=0||!committedVersions||versionFields.slice(1).some(k=>e.versions[k]!==committedVersions[k]))return;
 const page=active.plan.page,base=model.pages.get(page),overlays=model.overlaysOn(page);if(!base||model.deferredPages.has(page)||!overlays.some(o=>o.overlay.parId===e.par_id&&o.overlay.revision===e.versions.source_revision)||!dlResourcesReady(base.dl)||!globalGlyphResourcesReady(base.dl))return;
 for(const item of overlays){if(!dlResourcesReady(item.overlay.dl)||inexactReason(item.overlay.dl,fonts,images))return;const others=overlays.filter(o=>o!==item),owned=model.ownLines(page,item.overlay.parId);let mask=hybridMasks(base.dl,owned,item.rows,others.flatMap(o=>o.rows),boundOtherGlyphs(base.dl,fonts)??[]);if(mask.reason)mask=planInkOverlayMasks({dl:base.dl,owned,rows:item.rows,liveDL:item.overlay.dl,otherOverlays:others,fonts,scale:.000020});if(mask.reason)return;}
 provisional=null;clearHeldInsertion();clearUnderlay();contentEpoch++;tracePreview('replacement-normalized',{parId:e.par_id,page,sourceRevision:e.versions.source_revision});
}
// Replacement evidence comes only from the authenticated bridge's native span
// proof; geometry cannot turn a client timing hint into source authority.
function acceptReplacement(meta:any){
 if(!nativeInsertions||paused||meta.projectId!==projectId||!projectDocuments.some(d=>d.docId===meta.docId&&d.path===meta.path))return;
 if(meta.editShape){status.dataset.rtexEditShape=JSON.stringify(meta.editShape);if(meta.editShape.sourceMapAvailable&&meta.editShape.capturedUnitCount>0)status.dataset.rtexLastClassifiedShape=JSON.stringify(meta.editShape);}
 if(meta.state!=='ready'||meta.verified!==true){tracePreview('replacement-unavailable',{sourceRevision:meta.sourceRevision,reason:meta.reason??'Source lineage needs a new capture'});if(replacementMeta?.path===meta.path&&meta.sourceRevision>=replacementMeta.sourceRevision)replacementMeta=null;return;}
 if(meta.kind==='body-window-replacement'){
  if(!Number.isSafeInteger(meta.sourceRevision)||meta.sourceRevision<engineRevision||!committedVersions||versionFields.some(k=>meta.baseVersions?.[k]!==committedVersions[k])||!Array.isArray(meta.units)||meta.units.length>4||!Array.isArray(meta.replacedParIds)||meta.replacedParIds.length<1||meta.replacedParIds.length>8||new Set(meta.replacedParIds).size!==meta.replacedParIds.length||!Array.isArray(meta.removedParIds))return;
  replacementMeta=meta;windowCertificate=meta;snapshotHold=null;for(const alias of meta.outsideAliases??[]){capturedRemovals.delete(alias.capturedParId);model.dropOverlays([alias.capturedParId,alias.currentParId]);}tracePreview('body-window-certificate',{sourceRevision:meta.sourceRevision,parId:meta.parId,replacedParIds:meta.replacedParIds,units:meta.units.map((u:any)=>u.parId),removedParIds:meta.removedParIds});tryBodyWindow();return;
 }
 if(!Number.isSafeInteger(meta.parId)||!Number.isSafeInteger(meta.sourceRevision)||meta.sourceRevision<engineRevision||!committedVersions||versionFields.some(k=>meta.baseVersions?.[k]!==committedVersions[k]))return;
 replacementMeta=meta;
 const units=meta.kind==='body-set-replacement'?meta.dirtyUnits:[{parId:meta.parId,sourceRevision:meta.sourceRevision,editId:meta.editId}];
 if(Array.isArray(units)&&units.length<=8)for(const unit of units)if(Number.isSafeInteger(unit.parId)&&Number.isSafeInteger(unit.editId)&&Number.isSafeInteger(unit.sourceRevision))bodyCertificates.set(unit.parId,{baseline:{...meta.baseVersions},proof:{verified:true,parId:unit.parId,editId:unit.editId,sourceRevision:unit.sourceRevision}});
 if(meta.reverted===true)bodyCertificates.set(meta.parId,{baseline:{...meta.baseVersions},proof:{verified:true,parId:meta.parId,editId:meta.editId,sourceRevision:meta.sourceRevision}});
 while(bodyCertificates.size>32)bodyCertificates.delete(bodyCertificates.keys().next().value!);
 tracePreview('replacement-certificate',{parId:meta.parId,sourceRevision:meta.sourceRevision,dirtyUnits:units?.map((u:any)=>u.parId),reverted:meta.reverted===true});tryReplacement();
}
function tryReplacement(){
 if(replacementMeta?.kind==='body-window-replacement'){tryBodyWindow();return;}
 const meta=replacementMeta;let record=meta&&nativeParagraphs.get(meta.parId),e=record?.event;
 if(!meta||!e||paused||!committedVersions||meta.sourceRevision<engineRevision||meta.sourceRevision<=layoutRevision||versionFields.some(k=>meta.baseVersions[k]!==committedVersions[k])||!replacementParagraphMatches(meta,e)||paragraphRemoved(e.par_id,e.versions)||!dlResourcesReady(e.dl)||inexactReason(e.dl,fonts,images))return;
 const placed=committedPlacements.find(p=>p.par_id===meta.parId);if(placed?.fragments?.length!==1)return;const page=placed.fragments[0].page,base=model.pages.get(page);if(!base||!dlResourcesReady(base.dl)||heldRemoval?.page===page||layoutHandover?.page===page||removalPlans(page,base.dl).length)return;
 const active=provisional??heldInsertion;if(active&&(active.kind!=='replacement'||active.plan.page!==page)){tracePreview('replacement-deferred',{parId:meta.parId,reason:'Another provisional page is still awaiting capture'});return;}
 const dirty=meta.kind==='body-set-replacement'?meta.dirtyUnits:[{parId:meta.parId,sourceRevision:meta.sourceRevision,editId:meta.editId}];
 if(!Array.isArray(dirty)||dirty.length>8)return;
 for(const unit of dirty){const saved=nativeParagraphs.get(unit.parId)?.event;if(!saved||saved.status!=='ok'||saved.par_id!==unit.parId||saved.edit_id!==unit.editId||saved.versions.source_revision!==unit.sourceRevision||unit.sourceRevision>meta.sourceRevision||versionFields.slice(1).some(k=>saved.versions[k]!==committedVersions[k])||paragraphRemoved(unit.parId,saved.versions))return;
  const fragments=model.placements.get(unit.parId);if(!fragments)return;
  if(fragments.some(f=>f.page===page)&&(!dlResourcesReady(saved.dl)||inexactReason(saved.dl,fonts,images)))return;
  if(model.overlays.get(unit.parId)?.dl!==saved.dl)model.applyParagraph(unit.parId,saved.dl,saved.fragments,saved.versions.source_revision);
 }
 const overlays=model.overlaysOn(page);let target=overlays.find(o=>o.overlay.parId===meta.parId);if(!target||target.overlay.revision!==meta.sourceRevision)return;
 let selectedId=meta.parId,sceneMeta=meta;
 // A retained expanded paragraph still owns the page. A later ordinary edit
 // recomposes that same expansion with fresh neighbouring overlays rather than
 // freezing its old bitmap or overwriting the previous paragraph.
 if(active?.kind==='replacement'&&(active.meta.parId!==meta.parId||meta.reverted===true)){
  const retained=flowIds(active).filter(id=>dirty.some((u:any)=>u.parId===id));if(retained.length)selectedId=retained.includes(meta.parId)?meta.parId:retained[0];target=overlays.find(o=>o.overlay.parId===selectedId);record=nativeParagraphs.get(selectedId);e=record?.event;if(!target||!e)return;
  const captured=committedPlacements.find(p=>p.par_id===selectedId),order=committedPlacements.indexOf(captured);if(order<1||order>=committedPlacements.length-1)return;
  sceneMeta={...meta,kind:'body-set-presentation',parId:selectedId,beforeParId:committedPlacements[order-1].par_id,afterParId:committedPlacements[order+1].par_id,sourceCertificate:meta,currentEditParId:meta.parId};
 }
 const others=overlays.filter(o=>o!==target);
 for(const item of others){const cert=bodyCertificates.get(item.overlay.parId),saved=nativeParagraphs.get(item.overlay.parId)?.event;if(!cert||versionFields.some(k=>cert.baseline[k]!==committedVersions[k])||!saved||saved.dl!==item.overlay.dl||saved.edit_id!==cert.proof.editId||saved.versions.source_revision!==cert.proof.sourceRevision||item.overlay.revision!==saved.versions.source_revision||saved.status!=='ok'||!dlResourcesReady(saved.dl)||inexactReason(saved.dl,fonts,images))return;}
 if(active&&!flowIds(active).every(id=>overlays.some(o=>o.overlay.parId===id))){tracePreview('replacement-deferred',{parId:meta.parId,reason:'Previous visible units are not covered by this composition'});return;}

 // Prefer the ordinary overlay whenever its actual masks are safe. A temporary
 // expanded page is only needed when row growth cannot fit the captured frame.
 const ordinary=target,owned=model.ownLines(page,selectedId);let masks=hybridMasks(base.dl,owned,ordinary.rows,others.flatMap(o=>o.rows),boundOtherGlyphs(base.dl,fonts)??[]);if(masks.reason)masks=planInkOverlayMasks({dl:base.dl,owned,rows:ordinary.rows,liveDL:e.dl,otherOverlays:others,fonts,scale:.000020});if(!masks.reason)return;
 const groupIds=new Set<number>([selectedId]);if(meta.kind==='body-set-replacement'){let changed=true;while(changed){changed=false;for(const unit of dirty){if(groupIds.has(unit.parId))continue;const linked=dirty.some((member:any)=>groupIds.has(member.parId)&&(member.beforeParId===unit.parId&&unit.afterParId===member.parId||member.afterParId===unit.parId&&unit.beforeParId===member.parId));if(linked){groupIds.add(unit.parId);changed=true;}}}}
 const grouped=groupIds.size>1;
 let plan=others.length?planComposedBodyReplacement({verifiedCompleteDirtySet:meta.kind==='body-set-replacement',dl:base.dl,placements:committedPlacements,page,parId:selectedId,owned:new Map([...new Set([selectedId,sceneMeta.beforeParId,sceneMeta.afterParId,...others.map(o=>o.overlay.parId)])].map(id=>[id,model.ownLines(page,id)])),beforeParId:sceneMeta.beforeParId,afterParId:sceneMeta.afterParId,pg:e,baseVersions:committedVersions,others,fonts,scale:.000020}):planParagraphReplacement({verifiedSingleBodyReplacement:true,dl:base.dl,placements:committedPlacements,page,parId:selectedId,owned:model.ownLines(page,selectedId),beforeParId:sceneMeta.beforeParId,afterParId:sceneMeta.afterParId,pg:e,baseVersions:committedVersions,fonts,scale:.000020,existingOverlayParIds:[]});
 if(!plan.ok&&grouped)plan=planAdjacentBodyReplacement({verifiedCompleteDirtySet:true,dl:base.dl,placements:committedPlacements,page,targetParId:selectedId,dirtyUnits:dirty,records:nativeParagraphs,owned:new Map(committedPlacements.map(p=>[p.par_id,model.ownLines(page,p.par_id)]).filter(([,indices])=>(indices as Set<number>).size)as any),baseVersions:committedVersions,sourceRevision:meta.sourceRevision,others:overlays.filter(o=>!groupIds.has(o.overlay.parId)),fonts,scale:.000020});
 if(!plan.ok){tracePreview('replacement-deferred',{parId:meta.parId,reason:plan.reason});return;}
 if(provisional?.kind==='replacement'&&provisional.sourceEvent===e&&provisional.meta.sourceRevision===meta.sourceRevision&&sameOverlayManifest(provisional.overlayVersions,overlays.map(o=>({parId:o.overlay.parId,revision:o.overlay.revision}))))return;
 clearHeldInsertion();clearUnderlay();contentEpoch++;
 const groupPlan=plan.kind==='adjacent-body-replacement'?plan:null;
 if(groupPlan)sceneMeta={...sceneMeta,kind:'body-set-presentation',parId:selectedId,beforeParId:groupPlan.beforeParId,afterParId:groupPlan.afterParId,sourceCertificate:meta,currentEditParId:meta.parId};
 const currentRecord=nativeParagraphs.get(meta.parId)??record;
 provisional={kind:'replacement',meta:sceneMeta,sourceEvent:e,event:groupPlan?{...e,dl:groupPlan.compositeDL,versions:{...e.versions,source_revision:meta.sourceRevision},timing:currentRecord.event.timing}:selectedId===meta.parId?e:{...e,versions:{...e.versions,source_revision:meta.sourceRevision}},stage:currentRecord.stage,plan:plan.flow,blocks:groupPlan?.blocks,clearRects:plan.clearRects,owned:groupPlan?.ownedUnion??model.ownLines(page,selectedId),overlayVersions:overlays.map(o=>({parId:o.overlay.parId,revision:o.overlay.revision})),baseOverlayVersions:groupPlan?.externalOverlayManifest??('baseOverlayVersions'in plan?plan.baseOverlayVersions:[])};
 tracePreview('replacement-projected',{parId:meta.parId,page,sourceRevision:meta.sourceRevision});void draw([page],false);
}
function bodyWindowParagraphMatches(meta:any,e:any){
 const unit=meta?.units?.find((u:any)=>u.parId===e?.par_id);return meta?.kind==='body-window-replacement'&&meta.verified===true&&unit&&e?.event==='ParagraphUpdate'&&e.status==='ok'&&e.edit_id===unit.editId&&e.versions?.source_revision===unit.sourceRevision&&unit.sourceRevision>meta.baseVersions.source_revision&&unit.sourceRevision<=meta.sourceRevision&&versionFields.slice(1).every(k=>e.versions[k]===meta.baseVersions[k]);
}
function tryBodyWindow(){
 const meta=replacementMeta;if(meta?.kind!=='body-window-replacement'||paused||!committedVersions||meta.sourceRevision<engineRevision||meta.sourceRevision<=layoutRevision||versionFields.some(k=>meta.baseVersions[k]!==committedVersions[k]))return;
 const old=meta.replacedParIds[0],placed=committedPlacements.find(p=>p.par_id===old);if(placed?.fragments?.length!==1)return;const page=placed.fragments[0].page,base=model.pages.get(page);if(!base||!dlResourcesReady(base.dl)||layoutHandover?.page===page)return;
 const active=provisional??heldInsertion;
 if(active&&(active.plan.page!==page||active.kind!=='replacement'||active.oldParIds?.some((id:number)=>!meta.replacedParIds.includes(id))||flowIds(active).some(id=>!meta.units.some((u:any)=>u.parId===id)&&!meta.removedParIds.includes(id)))){tracePreview('body-window-deferred',{sourceRevision:meta.sourceRevision,reason:'Previous presentation not fully accounted'});return;}
 if(!meta.units.length){projectEmptyBodyWindow(meta,page,base,active);return;}

 for(const unit of meta.units){const saved=nativeParagraphs.get(unit.parId)?.event;if(!bodyWindowParagraphMatches(meta,saved)||paragraphRemoved(unit.parId,saved.versions)||!dlResourcesReady(saved.dl)||inexactReason(saved.dl,fonts,images)){tracePreview('body-window-deferred',{sourceRevision:meta.sourceRevision,reason:'Waiting for exact window paragraphs',parId:unit.parId});return;}}
 const target=meta.currentEditParId??meta.units.at(-1).parId,current=nativeParagraphs.get(target);if(!current||!bodyWindowParagraphMatches(meta,current.event))return;
 const all=model.overlaysOn(page),others=all.filter(o=>!meta.replacedParIds.includes(o.overlay.parId)&&!meta.units.some((u:any)=>u.parId===o.overlay.parId));
 // Every retained ordinary neighbour still needs the existing authenticated proof.
 for(const item of others){const cert=bodyCertificates.get(item.overlay.parId),pg=nativeParagraphs.get(item.overlay.parId)?.event;if(!cert||versionFields.some(k=>cert.baseline[k]!==committedVersions[k])||!pg||pg.dl!==item.overlay.dl||pg.edit_id!==cert.proof.editId||pg.versions.source_revision!==cert.proof.sourceRevision||item.overlay.revision!==pg.versions.source_revision||pg.status!=='ok'||!dlResourcesReady(pg.dl)||inexactReason(pg.dl,fonts,images))return;}
 if(heldRemoval&&!(heldRemoval.page===page&&heldRemoval.removedParIds?.every((id:number)=>meta.removedParIds.includes(id))))return;
 const plan=planBodyWindowReplacement({verifiedBodyWindow:true,resourcesReady:true,dl:base.dl,placements:committedPlacements,page,baseVersions:committedVersions,sourceRevision:meta.sourceRevision,replacedParIds:meta.replacedParIds,beforeParId:meta.beforeParId,afterParId:meta.afterParId,units:meta.units,plainBodyParIds:meta.plainBodyParIds??[],records:nativeParagraphs,owned:new Map(committedPlacements.map(p=>[p.par_id,model.ownLines(page,p.par_id)]).filter(([,rows])=>(rows as Set<number>).size)as any),others,fonts,scale:.000020});
 if(!plan.ok){tracePreview('body-window-deferred',{sourceRevision:meta.sourceRevision,reason:plan.reason});return;}
 if(provisional?.meta?.sourceCertificate===meta&&provisional.sourceEvent===current.event&&sameOverlayManifest(provisional.overlayVersions,all.map(o=>({parId:o.overlay.parId,revision:o.overlay.revision}))))return;
 clearHeldInsertion();clearHeldRemoval();clearUnderlay();for(const id of meta.replacedParIds)capturedRemovals.delete(id);contentEpoch++;
 const sceneMeta={...meta,parId:target,currentEditParId:target,sourceCertificate:meta};
 provisional={kind:'replacement',meta:sceneMeta,sourceEvent:current.event,event:{...current.event,dl:plan.compositeDL,versions:{...current.event.versions,source_revision:meta.sourceRevision}},stage:current.stage,plan:plan.flow,blocks:plan.blocks,oldParIds:plan.oldParIds,clearRects:plan.clearRects,owned:plan.oldOwned,overlayVersions:all.map(o=>({parId:o.overlay.parId,revision:o.overlay.revision})),baseOverlayVersions:plan.externalOverlayManifest};
 tracePreview('body-window-projected',{sourceRevision:meta.sourceRevision,parId:target,page,oldParIds:plan.oldParIds,parIds:plan.blocks.map((b:any)=>b.parId)});void draw([page],false);
}
function projectEmptyBodyWindow(meta:any,page:number,base:any,active:any){
 const old=meta.replacedParIds[0];if(!meta.replacedParIds.every((id:number)=>meta.removedParIds.includes(id))||heldRemoval&&heldRemoval.page!==page)return;
 const actualRemoved=meta.removedParIds.filter((id:number)=>!(meta.outsideAliases??[]).some((a:any)=>a.capturedParId===id)&&(()=>{const v=paragraphRemovals.get(id);return v&&v.source_revision===meta.sourceRevision&&versionFields.slice(1).every(k=>v[k]===meta.baseVersions[k]);})()).at(-1);
 const all=model.overlaysOn(page),others=all.filter(o=>!meta.replacedParIds.includes(o.overlay.parId));
 const proven=others.map(item=>{const event=nativeParagraphs.get(item.overlay.parId)?.event,certificate=bodyCertificates.get(item.overlay.parId);return{...item,event,resourcesReady:dlResourcesReady(item.overlay.dl),nativeProof:certificate&&versionFields.every(k=>certificate.baseline[k]===meta.baseVersions[k])?certificate.proof:null};});
 // The source certificate proves the original captured Body is absent NOW.
 // This is a source-derived removal floor, not a relabelled ParagraphUpdate.
 const versions={...meta.baseVersions,source_revision:meta.sourceRevision};
 const admitted=planBodyWindowRemoval({verifiedBodyWindow:true,resourcesReady:true,dl:base.dl,page,placements:committedPlacements,owned:new Map(committedPlacements.map(p=>[p.par_id,model.ownLines(page,p.par_id)]).filter(([,rows])=>(rows as Set<number>).size)as any),fonts,scale:.000020,removalVersions:versions,baseVersions:meta.baseVersions,sourceRevision:meta.sourceRevision,replacedParIds:meta.replacedParIds,beforeParId:meta.beforeParId,afterParId:meta.afterParId,otherPageOverlays:proven});
 if(!admitted.ok){tracePreview('body-window-deferred',{sourceRevision:meta.sourceRevision,reason:admitted.reason});return;}
 const element=viewport.pageElement(page),canvas=element?.querySelector('canvas'),box=element?.getBoundingClientRect(),bounds=pages.getBoundingClientRect();
 const previous=active??displayedInsertion(page);const metricEligible=Boolean(actualRemoved&&(meta.replacedParIds.includes(actualRemoved)||previous&&canvas&&box&&projectedInkVisible(previous,canvas,box,bounds,actualRemoved)));
 provisional=null;clearHeldInsertion();clearHeldRemoval();clearUnderlay();model.dropOverlays(meta.replacedParIds);for(const id of meta.replacedParIds)capturedRemovals.delete(id);contentEpoch++;
 capturedRemovals.set(old,{...admitted.projection,safeOverlayManifest:admitted.safeOverlayManifest,parId:old,metricParId:actualRemoved??old,metricEligible,page,dl:base.dl,baseline:{...meta.baseVersions},versions,sourceCertificate:meta});
 status.textContent='已删除文字，分页将在后台校正';tracePreview('body-window-empty-projected',{sourceRevision:meta.sourceRevision,page,parId:actualRemoved,replacedParIds:meta.replacedParIds});void draw([page],false);
}
function sameOverlayManifest(expected:any[],actual:any[]){const normalize=(values:any[])=>values.map(v=>({parId:v.parId,revision:v.revision})).sort((a,b)=>a.parId-b.parId);return JSON.stringify(normalize(expected??[]))===JSON.stringify(normalize(actual??[]));}
function cloneInsertionCanvas(source:HTMLCanvasElement){const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;canvas.getContext('2d')!.drawImage(source,0,0);Object.assign(canvas.dataset,source.dataset);const geometry=insertionCanvasPlans.get(source);if(geometry)insertionCanvasPlans.set(canvas,geometry);return canvas;}
function clearPendingUnderlay(){if(pendingUnderlay){pendingUnderlay.record.canvas.width=pendingUnderlay.record.canvas.height=0;pendingUnderlay=null;}}
function promoteUnderlay(page:number){if(!pendingUnderlay||pendingUnderlay.target!==viewport.pageElement(page)?.querySelector('canvas'))return;clearUnderlay();insertionUnderlay=pendingUnderlay.record;pendingUnderlay=null;}
function clearUnderlay(){if(insertionUnderlay){insertionUnderlay.canvas.width=insertionUnderlay.canvas.height=0;insertionUnderlay=null;}}
function clearHeldRemoval(){if(heldRemoval){heldRemoval.canvas.width=heldRemoval.canvas.height=0;heldRemoval=null;}}
function releaseConvergedUnderlay(page:number){const canvas=viewport.pageElement(page)?.querySelector('canvas');if(!canvas||canvas.dataset.rtexInsertion||!canvas.dataset.rtexLayout)return;const v=JSON.parse(canvas.dataset.rtexLayout);if(insertionUnderlay?.page===page&&compareSource(v,insertionUnderlay.versions)>=0)clearUnderlay();if(heldRemoval?.page===page&&compareSource(v,heldRemoval.versions)>=0)clearHeldRemoval();}
addEventListener('pagehide',()=>{clearPendingUnderlay();clearUnderlay();clearHeldRemoval();},{once:true});
function clearHeldInsertion(){if(heldInsertion){heldInsertion.canvas.width=heldInsertion.canvas.height=0;heldInsertion=null;}}
function freezeInsertion(){const flow=provisional;if(!flow)return;const canvas=viewport.pageElement(flow.plan.page)?.querySelector('canvas');if(canvas?.dataset.rtexInsertion){const marker=JSON.parse(canvas.dataset.rtexInsertion);if(marker.parId===flow.meta.parId&&marker.sourceRevision===flow.meta.sourceRevision){clearHeldInsertion();heldInsertion={...flow,canvas:cloneInsertionCanvas(canvas)};heldInsertion.canvas.dataset.rtexInsertionFrozen='true';}}provisional=null;insertionMeta=null;}
function flowIds(flow:any):number[]{return flow?.blocks?.map((b:any)=>b.parId)??(flow?[flow.meta.parId]:[]);}
function flowResourcesReady(flow:any){return flow?.blocks?flow.blocks.every((b:any)=>dlResourcesReady(b.event.dl)):dlResourcesReady(flow.event.dl);}
function displayedInsertion(page:number){const canvas=viewport.pageElement(page)?.querySelector('canvas');return canvas?.dataset.rtexInsertion?insertionCanvasPlans.get(canvas)??null:null;}
function displayedLayoutMatches(page:number){const canvas=viewport.pageElement(page)?.querySelector('canvas');if(!canvas?.dataset.rtexLayout||!committedVersions)return false;const value=JSON.parse(canvas.dataset.rtexLayout);return versionFields.every(k=>value[k]===committedVersions[k]);}
function insertionCanvas(base:HTMLCanvasElement,page:number,versions:any){
 const flow=provisional;if(!flow||flow.plan.page!==page||versionFields.some(k=>flow.meta.baseVersions[k]!==versions?.[k]))return base;
 if(!flowResourcesReady(flow)){if(flow.kind==='replacement')tracePreview('flow-frame-deferred',{reason:'resources',sourceRevision:flow.meta.sourceRevision});freezeInsertion();if(heldInsertion)return cloneInsertionCanvas(heldInsertion.canvas);if(flow.kind==='replacement')throw Error('KEEP_LAST_FRAME');return base;}
 if(!sameOverlayManifest(flow.baseOverlayVersions??flow.overlayVersions,JSON.parse(base.dataset.rtexOverlays??'[]'))){if(flow.kind==='replacement')tracePreview('flow-frame-deferred',{reason:'base-overlay-manifest',sourceRevision:flow.meta.sourceRevision});freezeInsertion();if(heldInsertion)return cloneInsertionCanvas(heldInsertion.canvas);if(flow.kind==='replacement')throw Error('KEEP_LAST_FRAME');return base;}
 const plan=flow.plan;if(base.width!==plan.pixels.width||base.height!==plan.pixels.baseHeight){if(flow.kind==='replacement'){tracePreview('flow-frame-deferred',{reason:'dimensions',sourceRevision:flow.meta.sourceRevision,actual:[base.width,base.height],expected:[plan.pixels.width,plan.pixels.baseHeight]});throw Error('KEEP_LAST_FRAME');}return base;}
 if(flow.kind==='replacement'){const eraser=new Painter(base.getContext('2d')!,[.000020,0,0,.000020,0,0],fonts,images);eraser.clearRects(flow.clearRects,'white');}
 const canvas=document.createElement('canvas');canvas.width=base.width;canvas.height=plan.pixels.height;const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
 const cut=plan.pixels.cutY,height=plan.pixels.insertHeight;
 ctx.drawImage(base,0,0,base.width,cut,0,0,base.width,cut);ctx.drawImage(base,0,cut,base.width,base.height-cut,0,cut+height,base.width,base.height-cut);
 if(flow.blocks){for(const b of flow.blocks){const painter=new Painter(ctx,[.000020,0,0,.000020,0,0],fonts,images),dx=plan.translation.dx+b.dx,dy=plan.translation.dy+b.dy;painter.draw(b.event.dl,b.event.dl.other??[],dx,dy);for(const line of b.event.dl.lines)painter.draw(b.event.dl,line.items,dx,dy);}}else{const painter=new Painter(ctx,[.000020,0,0,.000020,0,0],fonts,images);painter.draw(flow.event.dl,flow.event.dl.other??[],plan.translation.dx,plan.translation.dy);for(const line of flow.event.dl.lines)painter.draw(flow.event.dl,line.items,plan.translation.dx,plan.translation.dy);}
 Object.assign(canvas.dataset,base.dataset);canvas.dataset.rtexInsertion=JSON.stringify({sourceRevision:flow.meta.sourceRevision,sourceUnitRevision:(flow.sourceEvent??flow.event).versions.source_revision,currentEditParId:flow.meta.currentEditParId??flow.meta.parId,kind:flow.kind??'insertion',parId:flow.meta.parId,parIds:flowIds(flow),page,topPx:cut,bottomPx:cut+height,firstBaselinePx:(flow.event.dl.lines[0].y+plan.translation.dy)*.000020});insertionCanvasPlans.set(canvas,{kind:flow.kind,meta:flow.meta,event:flow.event,sourceEvent:flow.sourceEvent,plan:flow.plan,blocks:flow.blocks,oldParIds:flow.oldParIds});tracePreview('flow-frame-assembled',{page,parId:flow.meta.parId,sourceRevision:flow.meta.sourceRevision,flowKind:flow.kind??'insertion'});clearPendingUnderlay();if(flow.kind!=='replacement')pendingUnderlay={target:canvas,record:{parId:flow.meta.parId,parIds:flowIds(flow),page,versions:{...flow.event.versions},canvas:cloneInsertionCanvas(base)}};base.width=base.height=0;return canvas;
}
function projectedInkVisible(flow:any,canvas:HTMLCanvasElement,box:DOMRect,bounds:DOMRect,metricParId=flow.meta.parId){
 const sx=.000020*box.width/canvas.width,sy=.000020*box.height/canvas.height;
 const blocks=flow.blocks?flow.blocks.filter((block:any)=>block.parId===metricParId):[{event:flow.event,dx:0,dy:0}];
 for(const block of blocks){const dl=block.event.dl,dx=flow.plan.translation.dx+(block.dx??0),dy=flow.plan.translation.dy+(block.dy??0);
 for(const item of [...dl.lines.flatMap((line:any)=>line.items),...dl.other??[]]){let ink:any=null;
  if(item[0]==='g'){try{const desc=dl.fonts[String(item[1])];ink=glyphInkBounds(desc,item,fonts.get(desc));}catch{continue;}}
  else if(item[0]==='r')ink={x0:item[1],y0:item[2],x1:item[1]+Math.max(item[3],1/.000020),y1:item[2]+Math.max(item[4],1/.000020)};
  if(ink&&box.left+(ink.x1+dx)*sx>bounds.left&&box.left+(ink.x0+dx)*sx<bounds.right&&box.top+(ink.y1+dy)*sy>bounds.top&&box.top+(ink.y0+dy)*sy<bounds.bottom)return true;
 }}return false;
}
pages.addEventListener('scroll',()=>{if(provisional)recordInsertionPaint(provisional.plan.page);},{passive:true});
function recordInsertionPaint(page:number){
 const element=viewport.pageElement(page),canvas=element?.querySelector('canvas');if(paused||!provisional||!canvas?.dataset.rtexInsertion)return;const marker=JSON.parse(canvas.dataset.rtexInsertion),flow=provisional,drawn=insertionCanvasPlans.get(canvas);
 let metricParId=flow.meta.parId,metricEvent=flow.sourceEvent??flow.event,metricStage=flow.stage;
 if(flow.kind==='replacement'&&flow.blocks){if(flow.meta.sourceCertificate?.kind==='body-window-replacement'&&(!Number.isSafeInteger(flow.meta.sourceCertificate.currentEditParId)||flow.sourceEvent?.versions.source_revision!==flow.meta.sourceRevision))return;const id=flow.meta.currentEditParId??flow.meta.parId,block=flow.blocks.find((b:any)=>b.parId===id);if(!block||!(flow.meta.sourceCertificate?.kind==='body-window-replacement'?bodyWindowParagraphMatches(flow.meta.sourceCertificate,block.event):replacementParagraphMatches(flow.meta.sourceCertificate,block.event)))return;metricParId=id;metricEvent=block.event;metricStage=block.stage;}else if(flow.kind==='replacement'&&metricEvent.versions.source_revision!==marker.sourceRevision)return;
 if(drawn?.meta!==flow.meta||drawn.event!==flow.event||drawn.plan!==flow.plan||marker.sourceRevision!==flow.meta.sourceRevision||marker.parId!==flow.meta.parId||JSON.stringify(marker.parIds??[marker.parId])!==JSON.stringify(flowIds(flow))||!displayedLayoutMatches(page))return;
 requestAnimationFrame(()=>{if(paused||!documentVisible()||element?.querySelector('canvas')!==canvas||provisional!==flow||!flowResourcesReady(flow)||!displayedLayoutMatches(page))return;const bounds=pages.getBoundingClientRect(),box=element!.getBoundingClientRect(),top=box.top+marker.topPx*box.height/canvas.height,bottom=box.top+marker.bottomPx*box.height/canvas.height;if(box.width<=0||box.height<=0||top>=bounds.bottom||bottom<=bounds.top||!projectedInkVisible(flow,canvas,box,bounds,metricParId))return;if(flow.kind==='replacement')latency.paint(marker.sourceRevision,metricEvent.timing.total_us/1000,performance.timeOrigin+performance.now(),{...metricStage,parId:metricParId,page,provisional:true,visible:true});else latency.insertionPaint(marker.sourceRevision,flow.event.timing.total_us/1000,performance.timeOrigin+performance.now(),{...flow.stage,parId:marker.parId,page,provisional:true,visible:true});});
}
let clickedParagraph:number|null=null;
function displayedWindowCertificate(page:number){const shown=displayedInsertion(page),proof=shown?.meta?.sourceCertificate;if(proof?.kind==='body-window-replacement')return proof;const canvas=viewport.pageElement(page)?.querySelector('canvas'),markers=JSON.parse(canvas?.dataset.rtexRemovals??'[]');return [...capturedRemovals.values()].find(r=>r.page===page&&r.sourceCertificate?.kind==='body-window-replacement'&&markers.some((m:any)=>m.parId===r.parId&&m.sourceRevision===r.versions.source_revision))?.sourceCertificate??null;}
function capturedCursorId(parId:number){for(const p of model.pages.keys()){const proof=displayedWindowCertificate(p),alias=proof?.outsideAliases?.find((a:any)=>a.currentParId===parId);if(alias)return alias.capturedParId;}return parId;}
function navigationPlacements(){const result=model.currentPlacements();for(const [id,fragments]of model.placements)if(fragments.some(f=>displayedInsertion(f.page)))result.set(id,fragments);return result;}
function visibleParagraphs(){const bounds=pages.getBoundingClientRect(),points:{parId:number;page:number;baseline:number;sourceRevision:number;y:number}[]=[];for(const [parId,fragments]of navigationPlacements())for(const fragment of fragments){const element=viewport.pageElement(fragment.page),page=model.pages.get(fragment.page);if(!element||!page||!displayedLayoutMatches(fragment.page))continue;const box=element.getBoundingClientRect(),height=page.dl.page_height??page.dl.height;for(const baseline of fragment.baselines??[]){const shown=displayedInsertion(fragment.page),flow=shown?.plan;if(shown?.kind==='replacement'&&(shown.meta.sourceCertificate?.kind==='body-window-replacement'?shown.oldParIds??[]:[...flowIds(shown),...(shown.oldParIds??[])]).includes(parId))continue;const y=box.top+(flow?projectBaselineY(flow,baseline):baseline)*box.height/(flow?flow.projection.expandedHeight:height);if(y>=bounds.top&&y<=bounds.bottom){const proof=displayedWindowCertificate(fragment.page),alias=proof?.outsideAliases?.find((a:any)=>a.capturedParId===parId);if(proof?.replacedParIds.includes(parId))continue;points.push({parId:alias?.currentParId??parId,page:fragment.page,baseline,sourceRevision:alias?proof.sourceRevision:shown?shown.meta.baseVersions.source_revision:model.overlays.get(parId)?.revision??layoutRevision,y});}}}if(provisional||heldInsertion){const candidate=provisional??heldInsertion,flow=displayedInsertion(candidate.plan.page);if(flow&&displayedLayoutMatches(flow.plan.page)){const element=viewport.pageElement(flow.plan.page),box=element!.getBoundingClientRect();for(const line of flow.event.dl.lines){const baseline=line.y+flow.plan.translation.dy,y=box.top+baseline*box.height/flow.plan.projection.expandedHeight;if(y>=bounds.top&&y<=bounds.bottom)points.push({parId:flow.blocks?(line.unit??flow.meta.parId):flow.meta.parId,page:flow.plan.page,baseline,sourceRevision:flow.meta.sourceRevision,y});}}}return points;}
function reportPosition(){if(paused)return;const points=visibleParagraphs(),bounds=pages.getBoundingClientRect();const parId=clickedParagraph!==null&&points.some(p=>p.parId===clickedParagraph)?clickedParagraph:(points.sort((a,b)=>Math.abs(a.y-(bounds.top+bounds.bottom)/2)-Math.abs(b.y-(bounds.top+bounds.bottom)/2))[0]?.parId??null);if(parId!==null)parent.postMessage({type:'rtex:position',projectId,parId},location.origin);else unavailableNavigation();}
pages.addEventListener('click',event=>{if(paused)return;const target=(event.target as Element).closest?.('.rtex-page') as HTMLElement|null;const page=Number(target?.dataset.page),modelPage=model.pages.get(page);if(!target||!modelPage){clickedParagraph=null;return;}const box=target.getBoundingClientRect(),height=modelPage.dl.page_height??modelPage.dl.height;clickedParagraph=closestParagraph(visibleParagraphs().filter(point=>point.page===page),event.clientY);});pages.addEventListener('dblclick',()=>reportPosition());
addEventListener('message',message=>{if(!paused&&message.origin===location.origin&&message.source===parent&&message.data?.type==='rtex:locate'&&message.data.projectId===projectId)reportPosition();});
let projectDocuments:any[]=[];
addEventListener('message',message=>{const value=message.data;if(paused||message.origin!==location.origin||message.source!==parent||value?.type!=='rtex:edit-timing'||value.projectId!==projectId||!projectDocuments.some(d=>d.docId===value.docId&&d.path===value.path)||!Number.isSafeInteger(value.sourceRevision)||!['inputAt','sentAt','ackAt'].every(k=>Number.isFinite(value[k])))return;if(value.affectedParIds!==undefined&&(!Array.isArray(value.affectedParIds)||value.affectedParIds.length>128||!value.affectedParIds.every((id:any)=>Number.isSafeInteger(id)&&id>0)))return;if(!documentVisible()){latency.invalidateBefore(performance.timeOrigin+performance.now());return;}latency.timing(value);});
for(const name of ['wheel','touchstart'])pages.addEventListener(name,()=>{viewport.clearPriority?.();if(cursorTarget)cursorSuppressed=Math.max(cursorSuppressed,cursorTarget.sequence);},{passive:true});
function decode(r:any){if(r.data instanceof Uint8Array)return r;if(r.data)r.data=Uint8Array.from(atob(r.data),c=>c.charCodeAt(0));return r;}
type ResourceLease={kind:'fonts'|'images';key:string;owner?:ResourceOwner;desc?:any;preinstalled?:any};
let resourceEpoch=0,dlResourceLeases=new WeakMap<object,{versions:any;leases:ResourceLease[]}>();
const resourceParagraphs=new Map<number,{event:any;stage:any;bytes:number}>(),imageDecodes=new Map<string,{owner:ResourceOwner;timer:any}>();
const blockedResourcePages=new Map<number,{base:any;overlays:any[]}>();
function rememberBlockedPage(page:number){blockedResourcePages.set(page,{base:model.pages.get(page)?.dl,overlays:model.overlaysOn(page).map(o=>o.overlay.dl)});}
const resourceWaiters=new Set<()=>void>();let previewLane=Promise.resolve(),resourceWakeQueued=false;
function resourceFailure(error:any){if(lifecycle.signal.aborted)return;pausePreview('预览资源载入失败，请重新打开预览');status.dataset.rtexConnection='stopped';status.textContent=String(error);}
const resources=new PreviewResources({signal:lifecycle.signal,changed:scheduleResourceWake,failed:resourceFailure,load:async(ref,bytes,signal)=>{
 const data=new Uint8Array(bytes);for(let offset=0;offset<bytes;offset+=524288){const response=await api('resource/'+ref+'?offset='+offset,{signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),cache:'force-cache',credentials:'same-origin'});if(!response.ok)throw Object.assign(Error('预览资源暂不可用：'+response.status),{permanent:response.status<500,status:response.status});const chunk=new Uint8Array(await response.arrayBuffer());if(chunk.length!==Math.min(524288,bytes-offset))throw Object.assign(Error('预览资源数据不完整'),{permanent:true});data.set(chunk,offset);}return data;
}});
function orderedPreview(work:()=>Promise<void>|void){const next=previewLane.then(()=>{if(!paused&&!lifecycle.signal.aborted)return work();});previewLane=next.catch(error=>resourceFailure(error));return next;}
function captureDLResources(dl:any,versions:any){
 if(!dl||dlResourceLeases.has(dl))return;const leases=new Map<string,ResourceLease>();
 for(const item of [...(dl.other??[]),...(dl.lines??[]).flatMap((line:any)=>line.items??[])]){
  let kind:'fonts'|'images',key:string,desc:any;
  if(item[0]==='g'){desc=dl.fonts?.[String(item[1])];if(!desc)continue;kind='fonts';key=fontKey(desc);}
  else if(item[0]==='i'){const info=imageInfo(dl,item[1]);if(!info?.file)continue;kind='images';key=info.file;}
  else continue;
  const owner=resources.owner(kind,key);leases.set(kind+':'+key,{kind,key,owner,desc,preinstalled:owner?undefined:kind==='fonts'?fonts.get(desc):images.get(key)});
 }
 dlResourceLeases.set(dl,{versions:{...versions},leases:[...leases.values()]});
}
function resourceLeasesReady(captured:{versions:any;leases:ResourceLease[]},leases=captured.leases){
 let ready=true;
 for(const lease of leases){
  if(!lease.owner){const owner=resources.owner(lease.kind,lease.key);if(owner){if(!resources.compatible(owner,captured.versions)){ready=false;continue;}lease.owner=owner;}}
  const owner=lease.owner;
  if(!owner){if(lease.preinstalled&&lease.preinstalled.kind!=='pending'&&(lease.kind==='fonts'?fonts.get(lease.desc):images.get(lease.key))===lease.preinstalled)continue;ready=false;continue;}
  if(!resources.current(owner)||!resources.compatible(owner,captured.versions)||owner.state!=='installed'){resources.prioritize(owner);ready=false;continue;}
  if(lease.kind==='images'&&images.get(lease.key)?.kind==='pending')ready=false;
 }
 return ready;
}
function dlResourcesReady(dl:any){const captured=dlResourceLeases.get(dl);return !captured||resourceLeasesReady(captured);}
function globalGlyphResourcesReady(dl:any){
 const captured=dlResourceLeases.get(dl);if(!captured)return true;
 const keys=new Set((dl.other??[]).filter((item:any)=>item[0]==='g'&&dl.fonts?.[String(item[1])]).map((item:any)=>fontKey(dl.fonts[String(item[1])])));
 return resourceLeasesReady(captured,captured.leases.filter(lease=>lease.kind==='fonts'&&keys.has(lease.key)));
}
function installReadyResources(){
 for(const [key,job]of imageDecodes)if(images.get(key)?.kind!=='pending'){clearTimeout(job.timer);imageDecodes.delete(key);}
 for(const owner of resources.ready()){
  if(owner.kind==='images'&&(imageDecodes.size>=4||images.get(owner.key)?.kind==='pending'))continue;
  const value=decode(resources.materialize(owner));
  if(owner.kind==='fonts')fonts.add(owner.key,value);
  else{images.add(owner.key,value);if(images.get(owner.key)?.kind==='pending'){const epoch=resourceEpoch;imageDecodes.set(owner.key,{owner,timer:setTimeout(()=>{if(epoch===resourceEpoch&&!lifecycle.signal.aborted)resourceFailure(Error('预览图片解码超时，请重新打开预览'));},15000)});}}
  resources.installed(owner);
 }
}
function retainResourceParagraph(e:any,stage:any){
 const old=resourceParagraphs.get(e.par_id);if(old&&old.event.versions.source_revision>e.versions.source_revision)return;
 const bytes=JSON.stringify(e.dl??{}).length*2;
 if((!old&&resourceParagraphs.size>=128)||bytes+[...resourceParagraphs.values()].reduce((sum,p)=>sum+p.bytes,0)-(old?.bytes??0)>8000000)throw Error('等待预览资源的段落超过预算，请重新打开预览');
 resourceParagraphs.set(e.par_id,{event:{...e,fonts:{},images:{}},stage,bytes});
}
function scheduleResourceWake(){
 if(resourceWakeQueued||paused||lifecycle.signal.aborted)return;resourceWakeQueued=true;const epoch=resourceEpoch;
 void orderedPreview(async()=>{
  resourceWakeQueued=false;if(epoch!==resourceEpoch)return;installReadyResources();
  for(const [id,pending]of resourceParagraphs){const e=pending.event;
   if(e.versions.source_revision<engineRevision||e.versions.source_revision<=layoutRevision||committedVersions&&e.versions.engine_generation<committedVersions.engine_generation){resourceParagraphs.delete(id);continue;}
   if(!dlResourcesReady(e.dl))continue;resourceParagraphs.delete(id);await processParagraph(e,{...pending.stage,hydratedAt:performance.timeOrigin+performance.now()});
  }
  for(const wake of [...resourceWaiters])wake();tryInsertion();
  const ready:number[]=[];for(const [page,blocked]of blockedResourcePages){const overlays=model.overlaysOn(page).map(o=>o.overlay.dl);if(model.pages.get(page)?.dl!==blocked.base||overlays.length!==blocked.overlays.length||overlays.some((dl,i)=>dl!==blocked.overlays[i])){blockedResourcePages.delete(page);continue;}if((!model.pages.get(page)?.exact||dlResourcesReady(blocked.base))&&(!overlays.length||globalGlyphResourcesReady(blocked.base))&&overlays.every(dlResourcesReady)){blockedResourcePages.delete(page);ready.push(page);}}if(ready.length)await draw(ready,false);
 }).catch(()=>{});
}
function waitLayoutResources(ticket:any,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
 const clear=()=>{resourceWaiters.delete(check);signal.removeEventListener('abort',abort);};
 const abort=()=>{clear();reject(new DOMException('Aborted','AbortError'));};
 const check=()=>{if(signal.aborted||!layouts.current(ticket)){abort();return;}if(ticket.pages.every((page:any)=>dlResourcesReady(page.dl))){clear();resolve();}};
 resourceWaiters.add(check);signal.addEventListener('abort',abort,{once:true});check();
});}
// Retain weak DL leases across reset: still-visible old geometry must fail its old
// epoch/store identities until fresh layout metadata replaces it. Weak keys collect normally.
function resetPreviewResources(){
 resourceEpoch++;resources.reset();resourceParagraphs.clear();blockedResourcePages.clear();for(const job of imageDecodes.values())clearTimeout(job.timer);imageDecodes.clear();fonts=new FontStore();images=createImages();resourceWakeQueued=false;
}
lifecycle.signal.addEventListener('abort',()=>{for(const job of imageDecodes.values())clearTimeout(job.timer);imageDecodes.clear();resourceParagraphs.clear();},{once:true});
function registerPreviewEvent(e:any){
 resources.register(e);installReadyResources();if(e.dl)captureDLResources(e.dl,e.versions);for(const page of e.pages_changed??[])captureDLResources(page.dl,e.versions);
}
function takeLayoutPaintQueue(reason:string){
 if(layoutPaintTimer!==null){clearTimeout(layoutPaintTimer);layoutPaintTimer=null;}
 const queued=layoutPaintQueue.drain();layoutPaintVersions=null;layoutPaintPDFPages.clear();
 if(queued.length){status.dataset.rtexPaintQueue=JSON.stringify({state:'released',reason,count:queued.length});tracePreview('layout-paint-queue-released',{reason,count:queued.length});}
 return queued;
}
async function applyQueuedLayouts(events:any[]){
 // Register every descriptor against its genuine capture before accumulating
 // its incremental pages. The final event alone starts a paired PDF load.
 events.sort((a,b)=>compareSource(a.versions,b.versions)||a.versions.layout_version-b.versions.layout_version||a.versions.context_revision-b.versions.context_revision);
 const usable=events.filter(e=>e.compile?.state!=='Failed');for(let i=0;i<usable.length;i++){const e=usable[i];registerPreviewEvent(e);if(i===usable.length-1)await event(e);else layouts.stage(e,model.pages);}for(const e of events.filter(e=>e.compile?.state==='Failed'))await event(e);
}
async function flushLayoutPaintQueue(reason:string){const queued=takeLayoutPaintQueue(reason);if(queued.length)await applyQueuedLayouts(queued);}
function beginLayoutPaintQueue(versions:any,pdfPages:any[]){takeLayoutPaintQueue('replaced');layoutPaintQueue.begin(versions);layoutPaintVersions=layoutPaintQueue.waiting?{...versions}:null;for(const page of pdfPages)layoutPaintPDFPages.add(page.page);}
function visibleQueuedPDFPage(){const bounds=pages.getBoundingClientRect();return [...layoutPaintPDFPages].some(page=>{const box=viewport.pageElement(page)?.getBoundingClientRect();return box&&box.width>0&&box.height>0&&box.bottom>bounds.top&&box.top<bounds.bottom;});}
function releaseLayoutPaintQueue(page:number){
 const v=layoutPaintVersions,element=viewport.pageElement(page),canvas=element?.querySelector('canvas');if(!v||!layoutPaintPDFPages.has(page)||!fallback||!committedFallbackEvent||['source_revision','engine_generation','layout_version','context_revision'].some(k=>committedFallbackEvent.versions?.[k]!==v[k])||!documentVisible()||!canvas?.dataset.rtexLayout||canvas.dataset.rtexInsertion||JSON.parse(canvas.dataset.rtexOverlays??'[]').length)return;
 const painted=JSON.parse(canvas.dataset.rtexLayout),box=element!.getBoundingClientRect(),bounds=pages.getBoundingClientRect();
 if(['source_revision','engine_generation','layout_version','context_revision'].some(k=>painted[k]!==v[k])||box.width<=0||box.height<=0||box.bottom<=bounds.top||box.top>=bounds.bottom||bounds.width<=0||bounds.bottom<=bounds.top)return;
 // Keep the genuine first frame through a browser paint before moving to the
 // later convergence context; merely parsing its PDF is not a paint receipt.
 requestAnimationFrame(()=>requestAnimationFrame(()=>{void orderedPreview(async()=>{if(layoutPaintVersions!==v)return;const queued=layoutPaintQueue.painted(painted);if(queued===null)return;if(layoutPaintTimer!==null){clearTimeout(layoutPaintTimer);layoutPaintTimer=null;}layoutPaintVersions=null;layoutPaintPDFPages.clear();if(queued.length){status.dataset.rtexPaintQueue=JSON.stringify({state:'released',reason:'painted',count:queued.length});tracePreview('layout-paint-queue-released',{reason:'painted',count:queued.length});await applyQueuedLayouts(queued);}});}));
}
function incomingResourcesReplaceOwner(e:any){return (['fonts','images'] as const).some(kind=>Object.entries(e[kind]??{}).some(([key,value])=>{const owner=resources.owner(kind,key);return owner&&owner.identity!==JSON.stringify(value);}));}
addEventListener('pagehide',()=>{takeLayoutPaintQueue('closed');},{once:true});
function ingestPreviewEvent(e:any,stage:any={}){return orderedPreview(async()=>{
 if(e.event==='LayoutUpdate'){
  if(e.compile?.state!=='Failed'&&documentVisible()&&pages.clientWidth>0&&pages.clientHeight>0&&visibleQueuedPDFPage()&&layoutPaintQueue.defer(e)){
   status.dataset.rtexPaintQueue=JSON.stringify({state:'waiting-first-paint',count:layoutPaintQueue.size,versions:layoutPaintVersions});tracePreview('layout-paint-queued',{versions:e.versions,count:layoutPaintQueue.size});
   if(layoutPaintTimer===null)layoutPaintTimer=setTimeout(()=>{layoutPaintTimer=null;void orderedPreview(()=>flushLayoutPaintQueue('timeout'));},15000);
   return;
  }
  const queued=takeLayoutPaintQueue('superseded');if(queued.length){await applyQueuedLayouts([...queued,e]);return;}
 }else if(layoutPaintQueue.waiting&&incomingResourcesReplaceOwner(e))await flushLayoutPaintQueue('resource-owner-changed');
 registerPreviewEvent(e);
 if(e.event==='ParagraphUpdate'){const pending=resourceParagraphs.get(e.par_id);if(pending&&pending.event.versions.source_revision<=e.versions.source_revision)resourceParagraphs.delete(e.par_id);}
 await event(e,stage);
});}
function layoutLoading(ticket:any,operation:any,values:any){if(!layouts.current(ticket))return;const elapsed=performance.now()-operation.started;Object.assign(operation.metrics,values);if(values.phase==='committed'&&operation.metrics.committedMs===undefined)operation.metrics.committedMs=elapsed;operation.metrics.elapsedMs=operation.metrics.committedMs??elapsed;if(operation.metrics.committedMs!==undefined&&values.phase===undefined)operation.metrics.progressObservedMs=elapsed;status.dataset.rtexLayoutLoading=JSON.stringify(operation.metrics);}
function cancelLayoutLoad(){layoutLoad?.controller.abort();}
addEventListener('pagehide',cancelLayoutLoad,{once:true});
async function loadRangedLayoutPDF(ticket:any,operation:any){
 const retry=new PreviewReconnect(),signal=operation.signal;
 while(layouts.current(ticket)&&!signal.aborted){
  let task:any=null,destroy:(()=>void)|null=null;
  try{
   const started=performance.now();layoutLoading(ticket,operation,{phase:'loading-ranges',transport:'range',attempts:++operation.attempts,totalBytes:ticket.event.pdf_bytes});
   task=pdfjs.getDocument({url:new URL('api/pdf/'+ticket.event.pdf_id,location.href).href,httpHeaders:token==='session'?{}:{Authorization:`Bearer ${token}`},withCredentials:true,disableStream:true,disableAutoFetch:true,rangeChunkSize:65536});operation.task=task;
   task.onProgress=(progress:any)=>layoutLoading(ticket,operation,{bytes:progress.loaded,totalBytes:progress.total??ticket.event.pdf_bytes});
   destroy=()=>{void task.destroy();};signal.addEventListener('abort',destroy,{once:true});
   const pdf=await task.promise;
   if(signal.aborted||!layouts.current(ticket)){void pdf.destroy();throw new DOMException('Aborted','AbortError');}
   layoutLoading(ticket,operation,{phase:'ready',documentMs:performance.now()-started});return pdf;
  }catch(error:any){
   if(task)await Promise.resolve(task.destroy()).catch(()=>{});
   if(signal.aborted||[400,401,403,404,416].includes(error?.status))throw error;
   layoutLoading(ticket,operation,{phase:'retrying'});status.textContent='页面连接中断，保留当前预览，正在重试…';await retry.wait(signal);
  }finally{if(destroy)signal.removeEventListener('abort',destroy);operation.task=null;}
 }
 throw Error('STALE_PDF_BASE');
}
async function loadLayoutPDF(ticket:any,operation:any){const retry=new PreviewReconnect(),signal=operation.signal;while(layouts.current(ticket)&&!signal.aborted){try{const began=performance.now();layoutLoading(ticket,operation,{phase:'fetching',attempts:++operation.attempts});const response=await api('pdf/'+ticket.event.pdf_id,{signal});if(!response.ok)throw Object.assign(Error('完整页面载入失败，保留上一版预览'),{permanent:response.status<500});const data=new Uint8Array(await response.arrayBuffer());if(signal.aborted||!layouts.current(ticket))throw new DOMException('Aborted','AbortError');layoutLoading(ticket,operation,{phase:'parsing',bytes:data.byteLength,fetchMs:performance.now()-began});const parsing=performance.now(),task=pdfjs.getDocument({data});operation.task=task;const destroy=()=>void task.destroy();signal.addEventListener('abort',destroy,{once:true});try{const pdf=await task.promise;if(signal.aborted||!layouts.current(ticket)){void pdf.destroy();throw new DOMException('Aborted','AbortError');}layoutLoading(ticket,operation,{phase:'ready',parseMs:performance.now()-parsing});return pdf;}finally{signal.removeEventListener('abort',destroy);operation.task=null;}}catch(error:any){if(error.permanent||signal.aborted)throw error;layoutLoading(ticket,operation,{phase:'retrying'});status.textContent='完整页面连接中断，保留当前预览，正在重试…';await retry.wait(signal);}}throw Error('STALE_PDF_BASE');}
function compareSource(a:any,b:any){return (a?.engine_generation??0)-(b?.engine_generation??0)||(a?.source_revision??-1)-(b?.source_revision??-1);}
function paragraphAtOrBeforeLayout(v:any){return Boolean(committedVersions&&v?.engine_generation===committedVersions.engine_generation&&v.source_revision<=layoutRevision);}
function paragraphRemoved(id:number,versions:any){const removed=paragraphRemovals.get(id);return Boolean(removed&&compareSource(versions,removed)<=0);}
function admitRemoval(e:any){
 const v=e.versions,id=e.par_id,old=paragraphRemovals.get(id),cached=nativeParagraphs.get(id)?.event,active=provisional??heldInsertion;
 if(!v||!Number.isSafeInteger(v.source_revision)||!Number.isSafeInteger(v.engine_generation)||committedVersions&&compareSource(v,committedVersions)<0||old&&compareSource(v,old)<=0||cached&&compareSource(v,cached.versions)<0||active?.meta.parId===id&&compareSource(v,active.event.versions)<0||(model.overlays.get(id)?.revision??-1)>v.source_revision)return;
 if(!old&&paragraphRemovals.size>=1024)throw Error('Preview deletion history exceeds its bound; reopen preview');
 if(snapshotHold){engineRevision=Math.max(engineRevision,v.source_revision);paragraphRemovals.set(id,{...v});if(!removalFloor||compareSource(v,removalFloor)>0)removalFloor={...v};nativeParagraphs.delete(id);pendingParagraphs.delete(id);resourceParagraphs.delete(id);generationRecovery.demand();return;}
 engineRevision=Math.max(engineRevision,v.source_revision);paragraphRemovals.set(id,{...v});if(!removalFloor||compareSource(v,removalFloor)>0)removalFloor={...v};contentEpoch++;
 if(layoutHandover?.parId===id&&compareSource(v,layoutHandover.versions)>=0)clearLayoutHandover();nativeParagraphs.delete(id);pendingParagraphs.delete(id);resourceParagraphs.delete(id);if((pendingUnderlay?.record.parIds??[pendingUnderlay?.record.parId]).includes(id)&&compareSource(v,pendingUnderlay.record.versions)>=0)clearPendingUnderlay();
 const dirty=model.dropOverlays([id]),flow=provisional??heldInsertion;
 if(flow?.kind==='replacement'&&flow.meta.parId===id&&compareSource(v,flow.event.versions)>=0){provisional=null;clearHeldInsertion();replacementMeta=null;clearUnderlay();}
 const protectedOutside=windowCertificate&&versionFields.every(k=>windowCertificate.baseVersions[k]===committedVersions?.[k])&&((windowCertificate.outsideAliases??[]).some((a:any)=>a.capturedParId===id)||!windowCertificate.replacedParIds.includes(id)&&!windowCertificate.units.some((u:any)=>u.parId===id)&&!windowCertificate.removedParIds.includes(id));const classifiedEmpty=[...capturedRemovals.values()].some(r=>r.sourceCertificate===windowCertificate&&windowCertificate?.units.length===0&&r.versions.source_revision===v.source_revision&&windowCertificate.sourceRevision===v.source_revision&&windowCertificate.replacedParIds.includes(id)&&versionFields.every(k=>r.baseline[k]===committedVersions?.[k]));const projected=protectedOutside||snapshotHold||classifiedEmpty?null:projectCapturedRemoval(e);if(projected){dirty.add(projected.page);status.textContent='已删除文字，分页将在后台校正';}else if(flow?.kind==='replacement'&&flow.meta.parId===id){const previous=viewport.pageElement(flow.plan.page)?.querySelector('canvas');if(previous){clearHeldRemoval();heldRemoval={page:flow.plan.page,versions:{...v},removedParIds:[id],canvas:cloneInsertionCanvas(previous)};dirty.add(flow.plan.page);}}
 // Retraction is allowed only from the proven pre-insertion bitmap of the exact
 // still-displayed insertion. Never mask or freeze the deleted inserted ink.
 const underlay=insertionUnderlay,shown=underlay&&viewport.pageElement(underlay.page)?.querySelector('canvas'),marker=shown?.dataset.rtexInsertion?JSON.parse(shown.dataset.rtexInsertion):null;
 if((underlay?.parIds??[underlay?.parId]).includes(id)&&(marker?.parIds??[marker?.parId]).includes(id)&&marker.sourceRevision===underlay.versions.source_revision&&shown.dataset.rtexLayout===underlay.canvas.dataset.rtexLayout&&shown.dataset.rtexOverlays===underlay.canvas.dataset.rtexOverlays&&compareSource(v,underlay.versions)>=0){clearHeldRemoval();heldRemoval={page:underlay.page,versions:{...v},removedParIds:[id],canvas:underlay.canvas};insertionUnderlay=null;dirty.add(underlay.page);}
 if(compareSource(committedVersions,v)<0)cancelLayoutLoad();
 if(flowIds(flow).includes(id)&&compareSource(v,flow.event.versions)>=0){dirty.add(flow.plan.page);provisional=null;clearHeldInsertion();insertionMeta=null;}
 else if(insertionMeta?.parId===id)insertionMeta=null;
 if(dirty.size)void draw(dirty,false);
}
function clearLayoutHandover(){if(layoutHandover){layoutHandover.canvas.width=layoutHandover.canvas.height=0;layoutHandover=null;}}
function prepareLayoutHandover(event:any){
 const target=cursorTarget;if(!target||target.edge!=='end'){clearLayoutHandover();return;}
 const placement=event.placements?.find((p:any)=>p.par_id===target.parId),tail=placement?.fragments?.at(-1);
 if(!tail||tail.approximate!==false||!tail.baselines?.length||!Number.isFinite(tail.baselines.at(-1))){clearLayoutHandover();return;}
 const previous=layoutHandover;
 if(previous){if(previous.parId===target.parId&&event.versions.engine_generation===previous.versions.engine_generation&&compareSource(event.versions,previous.versions)>=0&&tail.page!==previous.page){previous.targetPage=tail.page;previous.targetVersions={...event.versions};return;}clearLayoutHandover();}
 const flow=provisional??heldInsertion,overlay=model.overlays.get(target.parId),page=flowIds(flow).includes(target.parId)?flow.plan.page:overlay?.fragments?.at(-1)?.page;
 if(!page||tail.page===page)return;const canvas=viewport.pageElement(page)?.querySelector('canvas');if(!canvas)return;
 const marker=canvas.dataset.rtexInsertion?JSON.parse(canvas.dataset.rtexInsertion):null,drawn=JSON.parse(canvas.dataset.rtexOverlays??'[]').find((p:any)=>p.parId===target.parId);
 const sourceRevision=marker&&(marker.parIds??[marker.parId]).includes(target.parId)?marker.sourceRevision:drawn?.revision;
 if(!Number.isSafeInteger(sourceRevision)||sourceRevision>event.versions.source_revision||committedVersions?.engine_generation!==event.versions.engine_generation||canvas.width*canvas.height>64000000)return;
 layoutHandover={page,parId:target.parId,versions:{engine_generation:event.versions.engine_generation,source_revision:sourceRevision},targetPage:tail.page,targetVersions:{...event.versions},canvas:cloneInsertionCanvas(canvas)};
 status.dataset.rtexHandover=JSON.stringify({state:'waiting-tail',parId:target.parId,page,targetPage:tail.page,sourceRevision});
}
function finishLayoutHandover(page:number){
 const held=layoutHandover;if(!held||page!==held.targetPage)return;const canvas=viewport.pageElement(page)?.querySelector('canvas');
 if(!canvas?.dataset.rtexLayout||canvas.dataset.rtexInsertion||!model.ownLines(page,held.parId).size)return;
 const versions=JSON.parse(canvas.dataset.rtexLayout);if(versionFields.some(k=>versions[k]!==held.targetVersions[k]))return;
 const oldPage=held.page;clearLayoutHandover();status.dataset.rtexHandover=JSON.stringify({state:'complete',parId:held.parId,page,targetSourceRevision:versions.source_revision});void draw([oldPage],false);requestAnimationFrame(()=>{if(!paused)recordLayoutPaint(page);});
}
addEventListener('pagehide',clearLayoutHandover,{once:true});
function stageLayout(event:any){
 if(paused||lifecycle.signal.aborted)return;if(layoutPaintQueue.size){const queued=takeLayoutPaintQueue('retry');void orderedPreview(()=>applyQueuedLayouts([...queued,event]));return;}if(event.versions.engine_generation<observedGeneration){tracePreview('layout-rejected-old-generation',{versions:event.versions,observedGeneration});return;}const ticket=layouts.stage(event,model.pages);if(!ticket)return;
 const visible=provisional??heldInsertion,contradictsRemoval=[...paragraphRemovals].some(([id,v])=>compareSource(event.versions,v)<=0&&event.placements?.some((p:any)=>p.par_id===id));
 // Stage every incremental delta, but do not replace a newer visible insertion
 // or a deletion with old captured ink. Uncommitted ticket pages merge into the
 // next accepted full capture, including changes on unrelated pages.
 // A held unknown-source frame may still contain an authoritatively removed
 // insertion. Preserve its pixels until capture, but do not require that retired
 // ID to reappear forever. Only a same-generation removal covering the displayed
 // version and covered by this capture can retire that membership obligation.
 const missingVisible=visible&&event.versions.engine_generation===visible.event.versions.engine_generation&&flowIds(visible).some(id=>{if(event.placements?.some((p:any)=>p.par_id===id))return false;const removed=paragraphRemovals.get(id);return !(removed&&removed.engine_generation===event.versions.engine_generation&&removed.source_revision>=visible.event.versions.source_revision&&event.versions.source_revision>=removed.source_revision);});
 if(layoutHandover&&compareSource(event.versions,layoutHandover.versions)<0||visible&&(compareSource(event.versions,visible.event.versions)<0||missingVisible)||removalFloor&&compareSource(event.versions,removalFloor)<0||contradictsRemoval){cancelLayoutLoad();if(visible){const shown=displayedInsertion(visible.plan.page);if(shown?.meta.parId===visible.meta.parId&&shown.meta.sourceRevision===visible.meta.sourceRevision)freezeInsertion();void draw([visible.plan.page],false);}return;}
 prepareLayoutHandover(event);provisional=null;clearHeldInsertion();insertionMeta=null;
 const retainedNative=[...nativeParagraphs.values()].filter(record=>compareSource(record.event.versions,event.versions)>0&&!paragraphRemoved(record.event.par_id,record.event.versions));
 for(const [id,record]of nativeParagraphs)if(compareSource(record.event.versions,event.versions)<=0||paragraphRemoved(id,record.event.versions))nativeParagraphs.delete(id);
 for(const [id,removed]of paragraphRemovals)if(compareSource(event.versions,removed)>0)paragraphRemovals.delete(id);
 cancelLayoutLoad();
 const controller=new AbortController(),operation={controller,signal:AbortSignal.any([lifecycle.signal,controller.signal]),task:null,started:performance.now(),attempts:0,metrics:{sourceRevision:event.versions.source_revision,engineGeneration:event.versions.engine_generation,layoutVersion:event.versions.layout_version,phase:'staging'}};layoutLoad=operation;layoutLoading(ticket,operation,{});
 void(async()=>{
  let pdfPages=ticket.pages.filter(page=>!page.exact||dlResourcesReady(page.dl)&&Boolean(inexactReason(page.dl,fonts,images))),needsPDF=pdfPages.length>0;if(needsPDF&&documentVisible()&&pages.clientWidth>0&&pages.clientHeight>0)beginLayoutPaintQueue(event.versions,pdfPages);
  // Commit new geometry with no PDF rather than pairing it with old PDF bytes.
  // Exact pages can paint immediately; PDF-dependent pages retain their last canvas.
  const previous=fallback;fallback=null;committedFallbackEvent=null;++fallbackRequest;clearPdfBases();
  layoutRevision=event.versions.source_revision;status.dataset.rtexCompileState=event.compile.state;committedVersions={...event.versions};generationRecovery.layoutAccepted(event.versions);if(event.versions.engine_generation>=observedGeneration&&event.versions.source_revision>=engineRevision)status.dataset.rtexGenerationRecovery=JSON.stringify({state:'captured',versions:event.versions});tracePreview('layout-committed',{versions:event.versions,pages:event.pages_total});committedCompileMs=Number.isFinite(event.wall_ms)?event.wall_ms:undefined;
  committedPlacements=event.placements??[];windowCertificate=null;if(snapshotHold&&event.versions.engine_generation>=snapshotHold.engine_generation&&event.versions.source_revision>=Math.max(snapshotHold.source_revision,engineRevision)){snapshotHold=null;status.dataset.rtexSourceLineage=JSON.stringify({requiresCapture:false,sourceRevision:event.versions.source_revision,engineGeneration:event.versions.engine_generation});tracePreview('layout-source-covered',{versions:event.versions});}bodyCertificates.clear();if(replacementMeta&&replacementMeta.sourceRevision<=event.versions.source_revision)replacementMeta=null;capturedRemovals.clear();paragraphRhythms=new WeakMap();const dirty=model.applyLayout({pages:ticket.pages,pagesTotal:event.pages_total,placements:event.placements,keepFromRevision:event.versions.source_revision+1});layouts.committed(ticket);for(const page of ticket.pages){if(page.exact&&!dlResourcesReady(page.dl))rememberBlockedPage(page.page);else blockedResourcePages.delete(page.page);}
  const settled=()=>event.compile.state==='CompiledWithErrors'?'文档仍有编译错误，当前显示可用排版；请查看常规编译日志':layoutRevision<engineRevision?'正在编译最新内容，当前显示上一版排版':`${event.pages_total} 页 · ${event.convergence.state==='Converged'?'排版已稳定':'分页更新中'}`;
  layoutLoading(ticket,operation,{phase:needsPDF?'waiting-pdf':'committed'});status.textContent=needsPDF?'可直接绘制的页面已更新；其余页面正在载入，保留原画面':settled();await draw(dirty);if(!layouts.current(ticket)||operation.signal.aborted)return;
  for(const [id,pending]of pendingParagraphs){if(pending.event.versions.source_revision<=layoutRevision){pendingParagraphs.delete(id);continue;}if(pending.event.versions.engine_generation===committedVersions.engine_generation&&pending.event.versions.layout_version<=committedVersions.layout_version){pendingParagraphs.delete(id);await processParagraph(pending.event,pending.stage);}}
  for(const pending of retainedNative)if(model.placements.has(pending.event.par_id))await processParagraph(pending.event,pending.stage);
  void previous?.destroy();
  if(!needsPDF&&ticket.pages.some(page=>!dlResourcesReady(page.dl))){await waitLayoutResources(ticket,operation.signal);if(!layouts.current(ticket)||operation.signal.aborted)return;pdfPages=ticket.pages.filter(page=>!page.exact||Boolean(inexactReason(page.dl,fonts,images)));needsPDF=pdfPages.length>0;}
  if(needsPDF){
   if(!event.pdf_id){void orderedPreview(()=>flushLayoutPaintQueue('unavailable'));status.textContent='部分字体或图形暂不支持直接预览，完整页面暂不可用；保留原画面';layoutLoading(ticket,operation,{phase:'unavailable'});return;}
   const pdf=await(event.pdf_range===true?loadRangedLayoutPDF(ticket,operation):loadLayoutPDF(ticket,operation));
   if(!layouts.current(ticket)||operation.signal.aborted){void pdf.destroy();return;}
   fallback=pdf;committedFallbackEvent={...event,pages_changed:ticket.pages};++fallbackRequest;clearPdfBases();layoutLoading(ticket,operation,{phase:'committed'});status.textContent=settled();await draw(pdfPages.map(page=>page.page),false);
  }
 })().catch(error=>{if(layouts.current(ticket)&&!operation.signal.aborted){if(permanentPDFError(error)&&committedFallbackEvent?.pdf_id===event.pdf_id)lazyRecoveryState(event.pdf_id).terminal=true;layoutLoading(ticket,operation,{phase:'failed'});status.textContent=String(error);void orderedPreview(()=>flushLayoutPaintQueue('failed'));}}).finally(()=>{if(layoutLoad===operation){layoutLoad=null;if(operation.signal.aborted)void orderedPreview(()=>flushLayoutPaintQueue('aborted'));}});
}
async function event(e:any,stage:any={}){if(paused||lifecycle.signal.aborted)return;observeEngineEvent(e);if(e.event==='SourceLineageState'){observeRecoveryPair({source_revision:e.sourceRevision,engine_generation:e.engineGeneration});snapshotHold=e.requiresCapture===true?{source_revision:e.sourceRevision,engine_generation:e.engineGeneration}:null;status.dataset.rtexSourceLineage=JSON.stringify({requiresCapture:Boolean(snapshotHold),sourceRevision:e.sourceRevision,engineGeneration:e.engineGeneration});tracePreview('snapshot-source-lineage',{requiresCapture:Boolean(snapshotHold),sourceRevision:e.sourceRevision,engineGeneration:e.engineGeneration});if(snapshotHold)generationRecovery.demand();return;}if(e.event==='ParagraphUpdate'){tracePreview('paragraph-received',{parId:e.par_id,sourceRevision:e.versions?.source_revision,status:e.status,versions:e.versions,engineUs:e.timing?.total_us});if(e.status==='removed'){admitRemoval(e);if(nativeInsertions)tryReplacement();return;} if(paragraphRemoved(e.par_id,e.versions)||['ok','ok_degraded'].includes(e.status)&&paragraphAtOrBeforeLayout(e.versions))return;}const eventAt=performance.timeOrigin+performance.now();if(!Number.isFinite(stage.eventReceivedAt))stage={eventReceivedAt:eventAt,hydratedAt:eventAt};if(e.event==='DocumentChanged')engineRevision=Math.max(engineRevision,e.source_revision??0);if(e.event==='DocumentChanged'&&e.path===currentPath&&!readOnly&&!sending&&e.revision!==revision){source.disabled=true;status.textContent='文档已由其他编辑器修改，请重新打开只读预览';}if(e.event==='DocumentChanged'&&e.path===currentPath&&readOnly){if(typeof e.text==='string')source.value=ackText=e.text;revision=e.revision;engineRevision=Math.max(engineRevision,e.source_revision??0);}if(e.event==='BridgeError'){status.textContent=e.message;source.disabled=true;return;}
 if(e.event==='EngineState'&&['Failed','Restarting'].includes(e.state))status.textContent=`预览引擎${e.state==='Failed'?'失败':'正在重启'}：${e.reason??''}`;if(e.event==='BackgroundScheduled')status.textContent=(e.reasons??[]).includes('paragraph boundaries changed')?'新增段落正在完整排版，当前保留上一版预览':'正在重新排版，当前保留上一版预览';if(e.event==='Diagnostics'){const errors=(e.items??[]).filter((d:any)=>d.severity==='error'||d.severity==='Error');if(errors.length)status.textContent=`编译错误：${errors[0].message}`;}if(e.event==='LayoutUpdate'){hostFallback.layout(e.versions);layoutHealth.observe(e);if(e.compile.state!=='Failed')stageLayout(e);else status.textContent=model.pages.size?'完整编译失败，保留上一版预览；修正后将自动恢复':'完整编译失败，暂时没有有效预览；修正后将自动恢复';}
 if(e.event==='ReplacementUpdate')acceptReplacement(e);if(e.event==='InsertionUpdate'){tracePreview('insertion-certificate',{sourceRevision:e.sourceRevision,state:e.state,parId:e.parId,count:e.insertions?.length??(e.parId?1:0)});acceptInsertion(e);}if(e.event==='ParagraphUpdate'){if(nativeInsertions&&e.status==='ok'&&(nativeParagraphs.get(e.par_id)?.event.versions.source_revision??-1)<=e.versions.source_revision){nativeParagraphs.set(e.par_id,{event:e,stage});while(nativeParagraphs.size>32)nativeParagraphs.delete(nativeParagraphs.keys().next().value!);}await processParagraph(e,stage);if(nativeInsertions){tryInsertion();tryReplacement();}}}
async function processParagraph(e:any,stage:any){if(paused||lifecycle.signal.aborted||paragraphRemoved(e.par_id,e.versions))return;if(snapshotHold&&e.versions.source_revision>layoutRevision){if(e.status==='ok'){nativeParagraphs.set(e.par_id,{event:e,stage});while(nativeParagraphs.size>32)nativeParagraphs.delete(nativeParagraphs.keys().next().value!);}generationRecovery.demand();return;}if(nativeInsertions&&windowCertificate&&versionFields.every(k=>windowCertificate.baseVersions[k]===committedVersions?.[k])&&(windowCertificate.units.some((u:any)=>u.parId===e.par_id)||(windowCertificate.outsideAliases??[]).length)){if(e.status==='ok'){nativeParagraphs.set(e.par_id,{event:e,stage});while(nativeParagraphs.size>32)nativeParagraphs.delete(nativeParagraphs.keys().next().value!);}if(replacementMeta?.kind==='body-window-replacement'&&replacementMeta.sourceRevision>=e.versions.source_revision)tryBodyWindow();else hostFallback.mark(e.versions);return;}layoutHealth.observe(e);if(e.status==='error'&&e.versions.source_revision>=engineRevision&&(!committedVersions||e.versions.engine_generation>=committedVersions.engine_generation)){const diagnostic=(e.diagnostics??[]).find((d:any)=>d.severity==='error'||d.severity==='Error');status.textContent=diagnostic?.message?'公式或命令尚未完整：'+diagnostic.message+'；完成后将自动恢复':'公式或命令尚未完整，保留上一版预览；完成后将自动恢复';}if(paragraphAtOrBeforeLayout(e.versions))return;if(layoutHealth.needsRecovery(e.versions))recoverLayout(e.versions);if((model.overlays.get(e.par_id)?.revision??-1)>e.versions.source_revision||(pendingParagraphs.get(e.par_id)?.event.versions.source_revision??-1)>e.versions.source_revision)return;if(committedVersions&&e.versions.engine_generation<committedVersions.engine_generation)return;if(!committedVersions||e.versions.engine_generation!==committedVersions.engine_generation||e.versions.layout_version>committedVersions.layout_version){pendingParagraphs.set(e.par_id,{event:e,stage});while(pendingParagraphs.size>128)pendingParagraphs.delete(pendingParagraphs.keys().next().value!);return;} if(e.versions.source_revision>=engineRevision&&(readOnly||source.value===(sending?submittedText:ackText))){let dirty:Set<number>|undefined;if(e.status==='removed'){if((provisional??heldInsertion)?.meta.parId===e.par_id){const oldPage=(provisional??heldInsertion).plan.page;provisional=null;clearHeldInsertion();insertionMeta=null;nativeParagraphs.delete(e.par_id);void draw([oldPage],false);}dirty=model.dropOverlays([e.par_id]);}else if(['ok','ok_degraded'].includes(e.status)){if(!dlResourcesReady(e.dl)){retainResourceParagraph(e,stage);return;}const hostReason=inexactReason(e.dl,fonts,images);if(e.status==='ok_degraded'||hostReason){tracePreview('paragraph-full-layout',{parId:e.par_id,status:e.status,reason:hostReason});if(e.versions.source_revision<=layoutRevision)return;hostFallback.mark(e.versions,e.status==='ok_degraded'||e.pagination_stale===true);status.textContent='当前字体或图形需要完整排版，正在更新；当前保留上一版预览';return;}if(nativeInsertions&&!model.placements.has(e.par_id)){nativeParagraphs.set(e.par_id,{event:e,stage});while(nativeParagraphs.size>32)nativeParagraphs.delete(nativeParagraphs.keys().next().value!);tryInsertion();return;}if(nativeInsertions){nativeParagraphs.set(e.par_id,{event:e,stage});while(nativeParagraphs.size>32)nativeParagraphs.delete(nativeParagraphs.keys().next().value!);}dirty=model.applyParagraph(e.par_id,e.dl,e.fragments,e.versions.source_revision);releaseOrdinaryReplacement(e);const revival=capturedRemovals.get(e.par_id);if(revival&&compareSource(e.versions,revival.versions)>0){capturedRemovals.delete(e.par_id);contentEpoch++;}if(!model.placements.has(e.par_id))recoverLayout(e.versions);eventStages.set(`${e.versions.source_revision}:${e.par_id}`,{...stage,appliedAt:performance.timeOrigin+performance.now()});while(eventStages.size>96)eventStages.delete(eventStages.keys().next().value!);engineTimings.set(`${e.versions.source_revision}:${e.par_id}`,e.timing.total_us/1000);while(engineTimings.size>96)engineTimings.delete(engineTimings.keys().next().value!);status.textContent=`段落已计算，等待绘制 · 引擎 ${(e.timing.total_us/1000).toFixed(2)} ms${e.pagination_stale?' · 完整分页待更新':''}${status.dataset.rtexCompileState==='CompiledWithErrors'?' · 文档仍有编译错误':''}`;}if(nativeInsertions&&insertionMeta?.sourceRevision===e.versions.source_revision)tryInsertion();if(nativeInsertions)tryReplacement();if(dirty?.size)await draw(dirty,false);}}
async function send(){if(paused||lifecycle.signal.aborted)return;if(sending)return;sending=true;try{while(!paused&&!lifecycle.signal.aborted&&source.value!==ackText){const text=source.value;submittedText=text;let start=0;while(start<text.length&&start<ackText.length&&text[start]===ackText[start])start++;if(start>0&&/[\uD800-\uDBFF]/.test(ackText[start-1]))start--;let end=ackText.length,nextEnd=text.length;while(end>start&&nextEnd>start&&ackText[end-1]===text[nextEnd-1]){end--;nextEnd--;}if(end<ackText.length&&end>start&&/[\uD800-\uDBFF]/.test(ackText[end-1])){end++;nextEnd++;}const r=await api('edit',{method:'POST',body:JSON.stringify({revision,start,end,text:text.slice(start,nextEnd),path:currentPath,projectId,docId})});const b=await r.json();if(paused||lifecycle.signal.aborted)return;if(!r.ok)throw Error(b.error);revision=b.revision;engineRevision=b.engine.result.source_revision;ackText=text;}}catch(e){if(!paused&&!lifecycle.signal.aborted){status.textContent=String(e);source.disabled=true;}}finally{sending=false;}}
source.addEventListener('input',()=>{if(paused)return;status.textContent='正在编辑，等待预览更新';if(!readOnly)void send()});
(async()=>{status.textContent='正在载入项目…';const project=await(await api('project')).json();projectId=project.projectId;nativeInsertions=project.nativeBridgeProtocol===1;projectDocuments=project.documents;if(parent!==window)parent.postMessage({type:'rtex:ready',projectId},location.origin);currentPath=new URLSearchParams(location.search).get('path')??project.main;docId=project.documents.find((d:any)=>d.path===currentPath)?.docId??'';status.textContent='正在载入文档…';const r=await api('document?'+new URLSearchParams({path:currentPath,projectId,docId}));if(!r.ok)throw Error('身份验证失败，请重新登录');const d=await r.json();if(paused||lifecycle.signal.aborted)return;source.value=ackText=d.text;revision=d.revision;status.textContent='正在载入预览…';if(token==='session'){let cursor:number|undefined,subscription:any=null;const reconnect=new PreviewReconnect();while(!lifecycle.signal.aborted){try{if(cursor!==undefined&&!subscription)subscription=socket?.subscribe?.(cursor)??null;let batch:any;if(subscription){try{batch=await subscription.next();status.dataset.rtexDelivery='push';}catch(error:any){subscription.close();subscription=null;if(lifecycle.signal.aborted)throw error;status.dataset.rtexTransport='http';}}if(!batch){const response=await api('poll'+(cursor===undefined?'':'?cursor='+cursor),{httpOnly:true});if(!response.ok)throw Object.assign(Error('预览连接被拒绝：'+response.status),{permanent:response.status<500});batch=await response.json();status.dataset.rtexDelivery='http';}const eventReceivedAt=performance.timeOrigin+performance.now();if(batch.reset){await orderedPreview(()=>{cancelLayoutLoad();takeLayoutPaintQueue('reset');layouts.reset();pendingParagraphs.clear();nativeParagraphs.clear();resetPreviewResources();});}for(const item of batch.events){await ingestPreviewEvent(item,{eventReceivedAt,hydratedAt:performance.timeOrigin+performance.now()});}if(lifecycle.signal.aborted)throw new DOMException('Aborted','AbortError');cursor=batch.cursor;reconnect.success();status.dataset.rtexConnection='connected';}catch(error:any){subscription?.close();subscription=null;if(lifecycle.signal.aborted||error.permanent)throw error;status.dataset.rtexConnection='reconnecting';status.textContent='网络连接中断，保留当前预览，正在重新连接…';await reconnect.wait(lifecycle.signal);}}return;}const stream=await api('events');if(!stream.ok)throw Error('预览连接被拒绝');const reader=stream.body!.getReader(),decoder=new TextDecoder();let buffer='';while(true){const {value,done}=await reader.read();if(done)throw Error('预览连接已断开');buffer+=decoder.decode(value,{stream:true});let i;while((i=buffer.indexOf('\n\n'))>=0){const chunk=buffer.slice(0,i);buffer=buffer.slice(i+2);if(chunk.startsWith('data: '))await ingestPreviewEvent(JSON.parse(chunk.slice(6)));}}})().catch(e=>{if(lifecycle.signal.aborted)return;status.dataset.rtexConnection='stopped';status.textContent=String(e);source.disabled=true;});
