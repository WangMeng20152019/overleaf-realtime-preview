import {inspectMathConstruction} from './math-construction.js';
import {verifyNativeProof} from '../src/native-edits.ts';
import {readSourceText} from './source-text.js';
import {createNativeConsumer} from './native-consumer.js';
import {createSocketRPC} from './socket-client.js';
import {cursorParagraph,cursorParagraphEnd,cursorNavigationEnd} from './cursor-position.js';
import {validateStartup} from './startup-validation.js';
import {minimalChange} from './overleaf-browser-hook.js';

/** Verified engine outcome IDs only; old engines remain fast-paint-only metrics. */
export function editAffectedParagraphIds(outcome){
 const valid=values=>Array.isArray(values)?[...new Set(values.filter(id=>Number.isSafeInteger(id)&&id>0))].slice(0,128):[];
 const added=valid(outcome?.added),ids=added.length?added:valid(outcome?.touched);
 return ids.length?ids:undefined;
}

/** One authenticated Overleaf project -> one isolated rtex mirror.
 * Identity comes from the source-patched extension event, never the DOM selection.
 */
export async function installOverleafProject({baseURL, token, projectId, onStatus = ()=>{}, pollMs=3000, resourceMap=[], signal, onCursor=()=>{},onEditTiming=()=>{},onTransport=()=>{},mathHoldMs=10000,drainTimeoutMs=10000}) {
  const base=new URL(baseURL,location.href); if(!base.pathname.endsWith('/'))base.pathname+='/';
  if(base.origin!==location.origin)throw Error('Integrated project requires the authenticated same-origin proxy');
  if(location.pathname.toLowerCase()!==`/project/${projectId}`.toLowerCase())throw Error('Wrong project URL');
  let stopped=false,draining=false,drainPromise=null,failure=null,chain=Promise.resolve(),active=null,timer=null;
  const abort=new AbortController(),docs=new Map(),views=new Map(),mathHolds=new Map();let pendingNavigation=null;
  const requestSignal=signal?AbortSignal.any([abort.signal,signal]):abort.signal;
  const socket=token==='session'?createSocketRPC(base,requestSignal,globalThis.WebSocket,onTransport):null;
  const api=async(p,body)=>{
    if(/^api\/(edit|source-map)(\?|$)/.test(p)){const reply=await socket?.request('/'+p,body);if(reply&&!(reply.status===413&&reply.body?.transport==='http'&&!body)){if(reply.status<200||reply.status>=300)throw Error(`Realtime ${reply.status}: ${JSON.stringify(reply.body)}`);onTransport('websocket');return reply.body;}onTransport('http-fallback');}
    const r=await fetch(new URL(p,base),{method:body?'POST':'GET',headers:{...(token==='session'?{}:{Authorization:`Bearer ${token}`}),...(body?{'Content-Type':'application/json'}:{})},credentials:'same-origin',cache:'no-store',signal:requestSignal,body:body?JSON.stringify(body):undefined});
    if(!r.ok)throw Error(`Realtime ${r.status}: ${await r.text()}`);return r.json();
  };
  let cursorGeneration=0,navigationGeneration=0,cursorTimer=null;const cursorMaps=new Map();
  function cursor(d,state,explicit=false,afterInsertion=false){const record=d&&views.get(d.docId),textDocument=state.doc,selection=state.selection?.main;const live=()=>{const current=record?.view.state;return !stopped&&active===d?.docId&&views.get(d.docId)===record&&current?.doc===textDocument&&current.selection?.main?.head===selection?.head&&current.selection?.main?.anchor===selection?.anchor&&!record.view.composing;};const head=selection?.head;if(!d||!Number.isInteger(head)||!live()){if(explicit&&!stopped)onStatus({state:'nav-unavailable',message:'当前位置暂不支持实时定位，请使用传统 PDF 定位'});return;}const text=state.doc.toString(),generation=++cursorGeneration,cachedMap=cursorMaps.get(d.docId),endpoint=text===d.text&&cachedMap?.revision===d.revision&&cachedMap.path===d.path&&cachedMap.projectId===projectId&&cursorParagraphEnd(text,head,cursorParagraph(text,head,cachedMap.spans));clearTimeout(cursorTimer);cursorTimer=setTimeout(()=>{void(async()=>{if(!live()||generation!==cursorGeneration||text!==d.text||d.flushing||d.desired)return;let map=cursorMaps.get(d.docId);if(!map||map.revision!==d.revision){map=await api('api/source-map?'+new URLSearchParams(identity(d)));if(map.revision===d.revision)cursorMaps.set(d.docId,map);}if(!live()||text!==d.text||d.flushing||d.desired||generation!==cursorGeneration||map.revision!==d.revision||map.path!==d.path||map.projectId!==projectId)return;const span=cursorParagraph(text,head,map.spans);if(span)onCursor({type:'rtex:cursor',projectId,docId:d.docId,path:d.path,parId:span.id,sourceRevision:map.sourceRevision,sequence:generation,explicit,...(cursorNavigationEnd(text,head,span)?{edge:'end'}:{})});else if(explicit)onStatus({state:'nav-unavailable',message:'当前位置暂不支持实时定位，请使用传统 PDF 定位'});})().catch(error=>{if(!stopped&&error?.name!=='AbortError')onStatus({state:'nav-unavailable',message:'定位信息暂不可用，请稍后重试'});});},explicit||afterInsertion||endpoint?0:120);}
  const identity=(d)=>({projectId,docId:d.docId,path:d.path});
  const fail=e=>{if(!stopped){failure=e;onStatus({state:'stopped',message:String(e)});stop();}};
  const enqueue=fn=>{chain=chain.then(()=>stopped?undefined:fn()).catch(fail);return chain;};
  const metadata=await api('api/project');
  const nativeConsumer=metadata.nativeBridgeProtocol===1?createNativeConsumer({onError:issue=>{if(issue.code==='native-recovery-failed')fail(Error('编辑状态无法重新校验，请重新打开实时预览'));}}):null;
  if(metadata.projectId!==projectId||!metadata.engineAlive)throw Error('Project mirror mismatch or dead engine');
  await validateStartup(metadata.documents,async d=>{
    if(!d.docId)throw Error('Verified document-id map required');
    const remote=await api('api/document?'+new URLSearchParams(identity(d)));
    docs.set(d.docId,{...d,text:remote.text,revision:remote.revision,seen:false,pending:0});
  });
  async function synchronize(d,text,initial=false,inputAt=null,native=null){
    if(initial&&text!==d.text){let first=0;while(first<text.length&&first<d.text.length&&text[first]===d.text[first])first++;throw Error(`Initial snapshot mismatch: ${d.path} (mirror ${d.text.length}, editor ${text.length}, first difference ${first}). Reimport before enabling preview.`);}
    d.seen=true;
    if(text===d.text){native?.binding?.ack(native.transactionId,text);return;}
    if(stopped)return;
    const sentAt=performance.timeOrigin+performance.now();const change=minimalChange(d.text,text);const evidence=native?.proof&&JSON.stringify(native.proof).length+change.text.length<1500000?native.proof:null;const result=await api('api/edit',{...identity(d),revision:d.revision,...change,...(evidence?{nativeEvidence:evidence}:{})});
    if(stopped)return;
    if(inputAt!==null&&Number.isSafeInteger(result.engine?.result?.source_revision)){const affectedParIds=editAffectedParagraphIds(result.engine.result.outcome);onEditTiming({type:'rtex:edit-timing',...identity(d),sourceRevision:result.engine.result.source_revision,...(Number.isFinite(native?.mathReadyAt)?{mathReadyAt:native.mathReadyAt}:{}),...(affectedParIds?{affectedParIds}:{}),inputAt,sentAt,ackAt:performance.timeOrigin+performance.now()});}d.text=text;d.revision=result.revision;native?.binding?.ack(native.transactionId,text);onStatus({state:'updated',path:d.path,revision:d.revision});return Array.isArray(result.engine?.result?.outcome?.added)&&result.engine.result.outcome.added.length>0;
  }
  function enqueueSource(d,text,state,native=null,inputAt=native?.inputAt??performance.timeOrigin+performance.now()){d.desired={text,state,native,inputAt};if(d.flushing)return;d.flushing=true;d.pending++;enqueue(async()=>{let addedUnit=false;while(d.desired&&!stopped){const target=d.desired;d.desired=null;const added=await synchronize(d,target.text,false,target.inputAt,target.native);addedUnit=addedUnit||added===true;if(!d.desired){const current=views.get(d.docId);if(active===d.docId&&current?.view.state.doc.toString()===d.text)cursor(d,current.view.state,false,addedUnit);}}}).finally(()=>{d.flushing=false;d.pending--;});}
  // Only committed native changes can enter this lease. No delimiter wait ever
  // occupies the global write chain; inactive polling sees the pending lease.
  function releaseHold(d){const hold=mathHolds.get(d.docId);if(!hold)return null;mathHolds.delete(d.docId);clearTimeout(hold.timer);d.pending--;return hold;}
  function flushHold(d,stripProof=false){const hold=releaseHold(d);if(!hold||stopped)return;let native=hold.target.native;if(stripProof||hold.before!==d.text||hold.revision!==d.revision)native=native?{...native,proof:null}:null;enqueueSource(d,hold.target.text,hold.target.state,native,hold.inputAt);}
  function scheduleSource(d,text,state,native=null){
    if(stopped||draining)return;
    const existing=mathHolds.get(d.docId),inputAt=existing?.inputAt??native?.inputAt??performance.timeOrigin+performance.now();
    const target={text,state,native};
    if(existing){
      existing.target=target;
      const eligible=existing.before===d.text&&existing.revision===d.revision&&!d.flushing&&native?.proof?.viewEpoch===existing.epoch;
      const decision=eligible?inspectMathConstruction(d.text,text,native.proof):{state:'optout',reason:'baseline-or-owner-changed'};
      if(decision.state==='hold')return;
      if(decision.state==='complete')existing.target.native={...native,mathReadyAt:performance.timeOrigin+performance.now()};
      // A malformed/gapped proof must not escape in an otherwise exact full edit.
      let valid=false;try{if(eligible){verifyNativeProof(d.text,text,native.proof);valid=true;}}catch{}
      flushHold(d,!valid);return;
    }
    if(native?.proof&&!d.flushing&&!d.desired){
      const decision=inspectMathConstruction(d.text,text,native.proof);
      if(decision.state==='hold'){
        const hold={before:d.text,revision:d.revision,epoch:native.proof.viewEpoch,target,inputAt,timer:null};
        mathHolds.set(d.docId,hold);d.pending++;onStatus({state:'math-hold',path:d.path,message:'公式输入中，完成后更新'});
        hold.timer=setTimeout(()=>flushHold(d),Math.max(1,Math.min(30000,mathHoldMs)));
        return;
      }
    }
    enqueueSource(d,text,state,native,inputAt);
  }
  function applyNavigation(){const target=pendingNavigation,record=target&&views.get(target.docId),d=target&&docs.get(target.docId);if(!record||!d||active!==target.docId||record.view.state.doc.toString()!==d.text||d.revision!==target.revision)return false;const effects=record.CodeMirror.EditorView?.scrollIntoView?.(target.head,{y:'center'});record.view.dispatch({selection:{anchor:target.head},...(effects?{effects}:{}),scrollIntoView:true});record.view.focus?.();pendingNavigation=null;return true;}
  async function reversePosition(parId){if(!Number.isSafeInteger(parId)||stopped)return;const request=++navigationGeneration;return (async()=>{const ordered=[...docs.values()].sort((a,b)=>(b.docId===active)-(a.docId===active));for(const d of ordered){let map=cursorMaps.get(d.docId);if(!map||map.revision!==d.revision){map=await api('api/source-map?'+new URLSearchParams(identity(d)));if(map.revision===d.revision)cursorMaps.set(d.docId,map);}if(stopped||request!==navigationGeneration)return;if(map.revision!==d.revision||map.projectId!==projectId||map.path!==d.path)continue;const span=map.spans.find(s=>s.id===parId);if(!span)continue;if(d.flushing||d.desired||mathHolds.has(d.docId)){onStatus({state:'nav-unavailable',message:'文档正在同步，请稍后重试定位'});return;}const bytes=new TextEncoder().encode(d.text),head=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.slice(0,span.range.start)).length;pendingNavigation={docId:d.docId,head,revision:d.revision};if(!applyNavigation()){if(!/^[a-f0-9]{24}$/.test(d.docId))throw Error('Invalid document identity');const entity=document.querySelector(`.entity[data-file-id="${d.docId}"][data-file-type="doc"] .entity-name`);if(!entity){onStatus({state:'nav-unavailable',message:'请先在文件树中打开对应源文件，再重试定位'});return;}entity.click();}return;}onStatus({state:'nav-unavailable',message:'当前位置暂不支持实时定位，请使用传统 PDF 定位'});})().catch(error=>{if(!stopped&&error?.name!=='AbortError')onStatus({state:'nav-unavailable',message:'定位信息暂不可用，请稍后重试'});});}
  const listener=e=>{
    if(stopped||draining)return;
    const {CodeMirror,extensions,rtexDocumentId}=e.detail;
    if(!rtexDocumentId){fail(Error('Installed Overleaf lacks immutable document identity hook'));return;}
    const d=docs.get(String(rtexDocumentId));
    extensions.push(CodeMirror.ViewPlugin.define(view=>{
      const docKey=String(rtexDocumentId);
      // CM can create a replacement before destroying the old plugin, even on
      // the same EditorView/native epoch. Retire the old callback owner first.
      for(const [key,previous] of views)if(key===docKey||previous.view===view)previous.retire?.();
      const registration={view,CodeMirror,retire:null};
      if(view.dom?.dataset?.rtexSourceMode==='native'){delete view.dom.dataset.rtexSourceMode;delete view.dom.dataset.rtexSourceViewEpoch;}
      let destroyed=false,composing=false,settling=false,compositionTimer=null,compositionPending=false;const initial=view.state;
      const releaseComposition=()=>{if(compositionPending&&d){d.pending--;compositionPending=false;}};
      const compositionStart=()=>{clearTimeout(cursorTimer);++cursorGeneration;composing=true;settling=false;clearTimeout(compositionTimer);if(d&&!compositionPending){d.pending++;compositionPending=true;}};
      const compositionEnd=()=>{composing=false;settling=true;clearTimeout(compositionTimer);compositionTimer=setTimeout(()=>{settling=false;if(!destroyed&&!stopped&&!draining){if(d)scheduleSource(d,view.state.doc.toString(),view.state);else if(view.state.doc.toString()!==initial.doc.toString())fail(Error('An unsupported source/resource was changed. Reimport project before previewing.'));}releaseComposition();},0);};
      let nativeBinding=null,nativeMode=false,nativeInitial=null,nativeReady=false,nativeInitialQueued=false,nativeDeferred=null,nativeMarkerEpoch=null;
      const clearNativeMarker=()=>{const data=view.dom?.dataset;if(views.get(docKey)===registration&&nativeMarkerEpoch&&data?.rtexSourceMode==='native'&&data.rtexSourceViewEpoch===nativeMarkerEpoch){delete data.rtexSourceMode;delete data.rtexSourceViewEpoch;}nativeMarkerEpoch=null;};
      const prepareNativeInitial=()=>{
        if(destroyed||stopped||draining||!nativeBinding?.active||!nativeInitial||nativeInitialQueued)return;
        if(nativeInitial.composition?.phase==='active'&&!nativeDeferred)return;
        nativeInitialQueued=true;d.pending++;
        enqueue(()=>synchronize(d,nativeInitial.text,true)).then(()=>{
          if(destroyed||stopped||draining||!nativeBinding?.active)return;
          // Baseline acknowledgment may synchronously emit a rebased latest proof.
          // Keep commits gated until that replacement has reached nativeDeferred.
          const acknowledged=nativeBinding.ack(nativeInitial.transactionId,nativeInitial.text);nativeReady=true;
          if(acknowledged===true&&view.dom?.dataset){nativeMarkerEpoch=nativeBinding.epoch;view.dom.dataset.rtexSourceMode='native';view.dom.dataset.rtexSourceViewEpoch=nativeMarkerEpoch;}
          const target=nativeDeferred;nativeDeferred=null;
          if(target)scheduleSource(d,target.text,view.state,{...target,binding:nativeBinding});
          applyNavigation();cursor(d,view.state);
        }).finally(()=>d.pending--);
      };
      if(nativeConsumer&&d){nativeBinding=nativeConsumer.bind(initial,String(rtexDocumentId),{
        onSnapshot(snapshot){if(destroyed||stopped||draining||snapshot.reason==='destroy')return;if(snapshot.initial){nativeInitial=snapshot;queueMicrotask(prepareNativeInitial);}},
        onCommit(value){if(destroyed||stopped||draining||!nativeBinding?.active)return;if(!nativeReady&&nativeInitial&&nativeInitial.text!==d.text&&nativeInitial.composition?.phase==='active'){fail(Error('输入法期间启用的编辑器无法核对初始内容，请完成输入后重新打开实时预览'));return;}if(!nativeReady){nativeDeferred=value;queueMicrotask(prepareNativeInitial);return;}scheduleSource(d,value.text,view.state,{...value,binding:nativeBinding});}
      });nativeMode=Boolean(nativeBinding);}
      if(!nativeMode){view.dom?.addEventListener('compositionstart',compositionStart);view.dom?.addEventListener('compositionend',compositionEnd);}
      const destroy=()=>{if(destroyed)return;if(d)flushHold(d);destroyed=true;clearNativeMarker();nativeDeferred=null;if(d?.desired?.native?.binding===nativeBinding)d.desired.native=null;nativeBinding?.stop();clearTimeout(compositionTimer);releaseComposition();view.dom?.removeEventListener('compositionstart',compositionStart);view.dom?.removeEventListener('compositionend',compositionEnd);if(views.get(docKey)===registration){views.delete(docKey);if(active===docKey)active=null;}};
      registration.retire=destroy;if(active&&active!==docKey){const previous=docs.get(active);if(previous)flushHold(previous);}active=docKey;views.set(docKey,registration);
      if(!nativeMode)queueMicrotask(()=>{if(d&&!destroyed&&!stopped&&!draining){d.pending++;enqueue(()=>synchronize(d,initial.doc.toString(),true)).then(()=>{applyNavigation();cursor(d,view.state);}).finally(()=>d.pending--);}});
      return {update(update){
        if(destroyed||stopped||draining)return;if(nativeMode){if(!update.docChanged&&update.selectionSet)cursor(d,update.state);return;}if(composing||settling||view.composing||update.view?.composing)return;if(!update.docChanged){if(update.selectionSet)cursor(d,update.state);return;}
        if(!d){fail(Error('An unsupported source/resource was changed. Reimport project before previewing.'));return;}
        scheduleSource(d,update.state.doc.toString(),update.state);
      },destroy};
    }));
  };
  const fetchOverleaf=async(path,options={})=>{const r=await fetch(path,{cache:'no-store',...options,credentials:'same-origin',signal:requestSignal});if(!r.ok||r.redirected)throw Error('Overleaf authentication or project access lost');return r;};
  const entities=await (await fetchOverleaf(`/project/${projectId}/entities`)).json();
  if(entities.project_id!==projectId||!Array.isArray(entities.entities))throw Error('Unexpected authenticated project tree response');
  const mainDoc=[...docs.values()].find(d=>d.path===metadata.main);
  const settings=await api('api/settings');
  if(settings?.projectId!==projectId||!mainDoc||settings?.rootDocId!==mainDoc.docId||!['pdflatex','xelatex','lualatex','latex'].includes(settings?.compiler))throw Error('Verified main document and compiler settings required; reimport project');
  const settingsFingerprint=JSON.stringify([settings.rootDocId,settings.compiler]);
  const tree=JSON.stringify(entities.entities);
  const resourceState=await api('api/resources');
  if(resourceState.projectId!==projectId||!resourceState.verified)throw Error('A fresh verified ZIP resource manifest is required');
  const resources=resourceState.resources.map(r=>{
    const id=resourceMap.find(m=>m.path===r.path);
    if(!id||!['doc','file'].includes(id.type)||!/^[a-f0-9]{24}$/.test(id.id)||!/^[a-f0-9]{64}$/.test(r.sha256))throw Error(`Static resource identity missing: ${r.path}`);
    return {...r,...id,etag:null};
  });
  async function checkResources(initial=false){
    const check=async r=>{
      const endpoint=r.type==='doc'?`/project/${projectId}/doc/${r.id}/download`:`/project/${projectId}/file/${r.id}`;
      let initialLength=null;
      if(r.type==='file'){
        // Overleaf fileRefs are immutable by ID: upload/replace/linked refresh/history
        // restore create a new ID, and HEAD of the removed bound ID fails. This relies
        // on that verified server contract, not on size/mtime being a content hash.
        // Editable static docs below still require a fresh full SHA check.
        const head=await fetch(endpoint,{method:'HEAD',credentials:'same-origin',cache:'no-store',signal:requestSignal});
        if(!head.ok||head.redirected)throw Error('Overleaf resource access lost');
        const etag=head.headers.get('etag'),length=head.headers.get('content-length');
        if(r.etag&&etag&&etag!==r.etag)throw Error(`Static resource changed: ${r.path}. Stop and reimport before previewing.`);
        if(length!==null&&(!/^\d+$/.test(length)||(Number.isSafeInteger(r.verifiedBytes??r.bytes)&&Number(length)!==(r.verifiedBytes??r.bytes))))throw Error(`Static resource changed: ${r.path}. Stop and reimport before previewing.`);
        if(etag)r.etag=etag;if(initial&&length!==null)initialLength=Number(length);
        if(!initial)return;
      }
      const response=await fetchOverleaf(endpoint,r.type==='file'?{cache:'force-cache'}:{});
      const bytes=await response.arrayBuffer();
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
      if((initialLength!==null&&bytes.byteLength!==initialLength)||(Number.isSafeInteger(r.bytes)&&r.bytes>=0&&bytes.byteLength!==r.bytes)||hash!==r.sha256)throw Error(`Static resource changed: ${r.path}. Stop and reimport before previewing.`);
      const etag=response.headers.get('etag');if(r.etag&&etag&&r.etag!==etag)throw Error(`Static resource changed: ${r.path}. Stop and reimport before previewing.`);if(etag)r.etag=etag;
      r.verifiedBytes=bytes.byteLength;
    };
    if(initial)await validateStartup(resources,check);else for(const r of resources)await check(r);
  }
  await checkResources(true);
  await validateStartup(docs.values(),async d=>{const response=await fetchOverleaf(`/project/${projectId}/doc/${d.docId}/download`);const text=await readSourceText(response);try{await synchronize(d,text,true);}catch(error){throw Error(`${error.message} Response type: ${response.headers.get('content-type')??'unknown'}; edge codes ${text.charCodeAt(0)},${text.charCodeAt(text.length-1)}.`);}});
  async function poll(){
    if(stopped||draining)return;
    try{
      const current=await (await fetchOverleaf(`/project/${projectId}/entities`)).json();
      if(current.project_id!==projectId||!Array.isArray(current.entities)||JSON.stringify(current.entities)!==tree)throw Error('Project tree changed; stop and reimport before previewing');
      const currentSettings=await api('api/settings');
      if(currentSettings.projectId!==projectId||JSON.stringify([currentSettings.rootDocId,currentSettings.compiler])!==settingsFingerprint)throw Error('Main document or compiler changed; stop and reimport before previewing');
      await checkResources();
      for(const d of docs.values()){
        if(stopped||draining)break;if(d.docId===active||d.pending)continue;
        const r=await fetchOverleaf(`/project/${projectId}/doc/${d.docId}/download`),text=await readSourceText(r);
        if(stopped||draining||d.docId===active||d.pending)continue;
        d.pending++;await enqueue(()=>synchronize(d,text));d.pending--;
      }
    }catch(e){fail(e);}finally{if(!stopped&&!draining)timer=setTimeout(poll,pollMs);}
  }
  function stop(){
    if(stopped)return;stopped=true;for(const d of docs.values())releaseHold(d);clearTimeout(timer);clearTimeout(cursorTimer);++cursorGeneration;++navigationGeneration;socket?.close();abort.abort();token='';
    for(const record of [...views.values()])record.retire?.();nativeConsumer?.stop();window.removeEventListener('UNSTABLE_editor:extensions',listener);
    window.dispatchEvent(new Event('editor:extension-loaded'));
  }
  function drainAndStop(){
    if(drainPromise)return drainPromise;
    if(stopped)return failure?Promise.reject(failure):Promise.resolve();
    draining=true;clearTimeout(timer);clearTimeout(cursorTimer);++cursorGeneration;++navigationGeneration;
    // Quiesce observation first, then flush only the latest committed targets.
    window.removeEventListener('UNSTABLE_editor:extensions',listener);
    for(const record of [...views.values()])record.retire?.();
    nativeConsumer?.stop();for(const d of docs.values())flushHold(d);
    window.dispatchEvent(new Event('editor:extension-loaded'));
    let timeout;
    drainPromise=Promise.race([chain,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Source drain timed out; reopen requires exact parity')),Math.max(1,Math.min(30000,drainTimeoutMs)));})])
      .then(()=>{if(failure)throw failure;}).finally(()=>{clearTimeout(timeout);stop();});
    return drainPromise;
  }
  window.addEventListener('UNSTABLE_editor:extensions',listener);
  window.dispatchEvent(new Event('editor:extension-loaded'));
  await Promise.resolve(); await chain;
  if(stopped)throw Error('Project binding failed before preview activation');
  timer=setTimeout(poll,pollMs);onStatus({state:'connected',projectId,documents:docs.size});
  return {stop,drainAndStop,metadata,reversePosition,followCursor(){const d=docs.get(active),record=views.get(active);if(d&&mathHolds.has(d.docId)){onStatus({state:'nav-unavailable',message:'公式输入中，完成后再定位预览'});return;}if(d&&record)cursor(d,record.view.state,true);else onStatus({state:'nav-unavailable',message:'请先在源文档中放置光标，再定位预览'});}};
}

export async function mountRealtimePanel(config,install=installOverleafProject){
 const panel=config.panel??document.querySelector('#ide-redesign-pdf-panel');
 if(!panel||!panel.querySelector('.pdf.full-size'))throw Error('未找到 Overleaf 原有 PDF 预览区域');
 if(panel.dataset.rtexShell)throw Error('实时预览模式选择器已安装');
 panel.dataset.rtexShell='traditional';
 const style=document.createElement('style');style.textContent=`#ide-redesign-pdf-panel[data-rtex-shell] > .pdf.full-size{position:absolute!important;inset:36px 0 0!important;height:auto!important;width:auto!important}#ide-redesign-pdf-panel[data-rtex-shell="live"] > .pdf.full-size{visibility:hidden!important;pointer-events:none!important}`;
 const bar=document.createElement('div');bar.style.cssText='position:absolute;inset:0 0 auto;height:36px;z-index:20;display:flex;align-items:center;gap:8px;padding:0 8px;background:#203c32;color:white;box-sizing:border-box';
 const traditional=document.createElement('button');traditional.textContent='传统 PDF';
 const realtime=document.createElement('button');realtime.textContent='LuaLaTeX 实时';
 const status=document.createElement('span');status.style.cssText='font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
 bar.append(traditional,realtime,status);panel.append(style,bar);
 let session=null,frame=null,controller=null,messageController=null,generation=0,disposed=false,opening=null,lastCursor=null,paused=false,owner=null,closingPromise=null,closingCancel=null,pauseReason='';
 const select=live=>{panel.dataset.rtexShell=live?'live':'traditional';traditional.setAttribute('aria-pressed',String(!live));realtime.setAttribute('aria-pressed',String(live));};
 function close(cancel=false){
  ++generation;const previous=session,pendingOwner=owner,previousController=controller;session=null;controller=null;owner=null;
  messageController?.abort();messageController=null;frame?.remove();frame=null;lastCursor=null;opening=null;paused=false;pauseReason='';delete panel.dataset.rtexPaused;delete status.dataset.rtexState;select(false);status.textContent='';config.onClose?.();
  if(cancel){closingCancel?.();closingCancel=null;pendingOwner&&(pendingOwner.cancelled=true);previous?.stop();previousController?.abort();return;}
  // Legacy resolved sessions cannot own a native hold or drain lease. Preserve
  // their synchronous close contract; pending installs must still await ownership.
  if(previous&&typeof previous.drainAndStop!=='function'){if(pendingOwner)pendingOwner.cancelled=true;previous.stop();previousController?.abort();return Promise.resolve();}
  if(!previous&&(!pendingOwner||pendingOwner.cancelled)){previousController?.abort();return closingPromise??Promise.resolve();}
  if(pendingOwner)pendingOwner.draining=true;
  // The UI closes synchronously. A new binding waits for the old exact source
  // drain, including an install that was still pending when traditional won.
  let timeout,drainSession=previous;
  const cancelDrain=()=>{if(pendingOwner)pendingOwner.cancelled=true;drainSession?.stop();previousController?.abort();};closingCancel=cancelDrain;
  const work=Promise.resolve(previous??pendingOwner?.promise).then(result=>{drainSession=result;if(pendingOwner?.cancelled)return;return result?.drainAndStop?result.drainAndStop():result?.stop();});
  const wait=Promise.race([work,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Source close timed out')),config.drainTimeoutMs??10000);})]);
  const current=wait.catch(cancelDrain).finally(()=>{clearTimeout(timeout);if(pendingOwner)pendingOwner.cancelled=true;previousController?.abort();if(closingPromise===current)closingPromise=null;if(closingCancel===cancelDrain)closingCancel=null;});
  closingPromise=current;return current;
 }
 function sendPause(current,id){if(id===generation&&paused)current.contentWindow?.postMessage({type:'rtex:pause',projectId:config.projectId,reason:pauseReason},location.origin);}
 function pause(current,id,reason){
  if(id!==generation||disposed)return;
  if(!paused){paused=true;pauseReason=String(reason||'项目连接或校验已中断');lastCursor=null;panel.dataset.rtexPaused='true';status.dataset.rtexState='paused';current.style.pointerEvents='none';current.setAttribute('aria-disabled','true');current.tabIndex=-1;
   const previous=session;session=null;if(owner)owner.cancelled=true;previous?.stop();controller?.abort();
  }
  status.textContent='预览已暂停，内容可能已过期：'+pauseReason+'；确认连接和保存状态后，点击“LuaLaTeX 实时”重新校验';sendPause(current,id);
 }
 function open(){
  if(disposed)return Promise.resolve();if(closingPromise){const requested=generation;return closingPromise.then(()=>requested===generation?open():undefined);}if(panel.dataset.rtexShell==='live')return opening??Promise.resolve();
  const id=++generation;const currentOwner={promise:null,draining:false,cancelled:false};owner=currentOwner;select(true);status.textContent='正在连接…';controller=new AbortController();messageController=new AbortController();
  const current=document.createElement('iframe');current.title='LuaLaTeX 实时预览';current.style.cssText='position:absolute;inset:36px 0 0;width:100%;height:calc(100% - 36px);border:0;background:white;z-index:10';current.src='about:blank';current.onload=()=>{if(paused)sendPause(current,id);else if(lastCursor&&id===generation)current.contentWindow?.postMessage(lastCursor,location.origin);};frame=current;panel.append(current);
  globalThis.addEventListener?.('message',event=>{
   if(event.origin!==location.origin||event.source!==current.contentWindow||event.data?.projectId!==config.projectId||id!==generation)return;
   if(event.data.type==='rtex:ready'){if(paused)sendPause(current,id);else if(lastCursor)current.contentWindow?.postMessage(lastCursor,location.origin);return;}
   if(paused)return;
   if(event.data.type==='rtex:nav-unavailable')status.textContent='当前位置暂不支持实时定位，请使用传统 PDF 定位';
   if(event.data.type==='rtex:position'&&session)void session.reversePosition(event.data.parId);
  },{signal:messageController.signal});
  const url=new URL(config.baseURL,location.href);url.searchParams.set('preview','');url.hash=config.token;
  currentOwner.promise=install({...config,signal:controller.signal,onTransport:transport=>{if(id===generation&&!paused)status.dataset.rtexTransport=transport.startsWith('websocket')?'websocket':'http';},onEditTiming:timing=>{if(id===generation&&!paused)current.contentWindow?.postMessage(timing,location.origin);},onCursor:cursor=>{if(id!==generation||paused)return;lastCursor=cursor;current.contentWindow?.postMessage(cursor,location.origin);},onStatus:s=>{if(id!==generation)return;if(s.state==='stopped'){pause(current,id,s.message);return;}if(paused)return;status.textContent=['nav-unavailable','math-hold'].includes(s.state)?s.message:'实时预览 · '+(s.path??'已连接');}});opening=currentOwner.promise.then(result=>{if(id!==generation||disposed||paused){if(!currentOwner.draining||currentOwner.cancelled)result.stop();return;}session=result;current.src=url.href;}).catch(error=>{pause(current,id,String(error));}).finally(()=>{if(id===generation)opening=null;});return opening;
 }
 const navigate=event=>{if(panel.dataset.rtexShell!=='live')return;const button=event.target.closest?.('button[aria-label]');const label=button?.getAttribute('aria-label')??'';const forward=['转到PDF中的位置','Go to code location in PDF'].includes(label),reverse=['转到代码中对应 PDF 的位置（提示：双击 PDF 以获得最佳结果）','Go to PDF location in code (Tip: double click on the PDF for best results)'].includes(label);if(!forward&&!reverse)return;event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();if(paused)return;if(forward)session?.followCursor();else frame?.contentWindow?.postMessage({type:'rtex:locate',projectId:config.projectId},location.origin);};globalThis.addEventListener?.('click',navigate,true);
 traditional.onclick=()=>void close();realtime.onclick=()=>{if(paused)close();void open();};select(false);
 return {close,focus:()=>void open(),showTraditional:close,showRealtime:open,dispose(){if(disposed)return;disposed=true;globalThis.removeEventListener?.('click',navigate,true);close(true);style.remove();bar.remove();delete panel.dataset.rtexShell;}};
}
