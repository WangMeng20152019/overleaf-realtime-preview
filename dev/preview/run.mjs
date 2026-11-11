import http from'node:http'
import {mkdtemp,writeFile,readFile,rm,mkdir,copyFile,chmod,open,realpath,lstat}from'node:fs/promises'
import path from'node:path'
import {fileURLToPath}from'node:url'
import {createRequire}from'node:module'
import {randomBytes,createHash}from'node:crypto'
import {build}from'esbuild'
import assert from'node:assert/strict'
import {once}from'node:events'
import WebSocket from'ws'
const dir=fileURLToPath(new URL('.',import.meta.url)),root=path.resolve(dir,'../..'),runtime=path.join(dir,'.runtime'),modules=path.join(root,'node_modules')
const durationArg=process.argv.find(arg=>arg.startsWith('--duration-ms='));const durationMs=durationArg?Number(durationArg.split('=')[1]):900000;if(!Number.isSafeInteger(durationMs)||durationMs<1000||durationMs>1800000)throw Error('Fixture duration must be 1000..1800000 milliseconds');
const require=createRequire(import.meta.url),P='0123456789abcdef01234567',D='aaaaaaaaaaaaaaaaaaaaaaaa'
const browserSource=path.join(root,'src/browser.ts'),browserOverride=null;
if(process.env.RTEX_BROWSER_SOURCE)throw Error('Browser source overrides are not supported in this release candidate');
const previewOverride={name:'no-source-override',setup(){}};

await mkdir(path.join(runtime,'dist'),{recursive:true});await mkdir(path.join(runtime,'public'),{recursive:true})
const alias={name:'native-annotation-only-fixture',setup(b){b.onResolve({filter:/^\.\/realtime$/},a=>a.importer.endsWith('/rtex-bridge.ts')?{path:'annotation',namespace:'fixture'}:null);b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"import{Annotation}from'@codemirror/state';export const trackChangesAnnotation=Annotation.define();",resolveDir:modules}))}}
await build({entryPoints:[path.join(dir,'client.ts')],outfile:path.join(dir,'client.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',nodePaths:[modules],plugins:[alias]})
await build({entryPoints:[path.join(root,'src/server.ts')],outfile:path.join(runtime,'dist/server.mjs'),platform:'node',format:'esm',bundle:true,external:['bufferutil','utf-8-validate'],banner:{js:"import {createRequire as __nodeRequire} from 'node:module';const require=__nodeRequire(import.meta.url);"}})
await build({entryPoints:[browserSource],outfile:path.join(runtime,'public/app.js'),platform:'browser',format:'iife',bundle:true,plugins:[previewOverride]})
await copyFile(path.join(root,'public/index.html'),path.join(runtime,'public/index.html'))
await copyFile(require.resolve('pdfjs-dist/build/pdf.worker.mjs'),path.join(runtime,'public/pdf.worker.mjs'))
const inputs=['src/server.ts','src/browser.ts','integration/project-entry.js','integration/native-consumer.js','integration/source-patch/rtex-bridge.ts']
const hashes={};for(const input of inputs)hashes[input]=createHash('sha256').update(await readFile(path.join(root,input))).digest('hex')
await writeFile(path.join(dir,'build-info.json'),JSON.stringify({generatedAt:new Date().toISOString(),inputs:hashes,browserSourceOverride:browserOverride,browserSourceEffectiveSHA256:createHash('sha256').update(await readFile(browserOverride??browserSource)).digest('hex'),annotationSubstitution:'Only trackChangesAnnotation is replaced with a local Annotation.define(); actual observer and actual project-entry/native-consumer are bundled unchanged.'},null,2))
if(process.argv.includes('--check')){console.log('CHECK_OK: scoped client, actual server and actual preview built; no server started');process.exit(0)}
const lock=path.join(dir,'.running.lock');try{const handle=await open(lock,'wx',0o600);await handle.writeFile(String(process.pid));await handle.close()}catch{throw Error('Fixture lock exists; check state.json/process before removing stale lock')}
const project=await mkdtemp(path.join(dir,'.project-'));await chmod(project,0o700)
let initial=String.raw`\documentclass{article}
\usepackage{amsmath,amssymb}
\usepackage[fontset=fandol]{ctex}
\setlength{\textheight}{250pt}
\setlength{\parskip}{10pt}
\begin{document}
\section{Native project bridge fixture}
Alpha stable paragraph 中文字体预热。 has math $\mathbb{R}+\mathbb{Z}\otimes x^2$ to warm the exact fonts.

Beta anchor paragraph must remain completely visible when new content is inserted.

Gamma stable paragraph also remains below the insertion.
\newpage
\section{Synthetic second section}
`+Array.from({length:8},(_,i)=>`Second section paragraph ${i+1} has ordinary text and mathematics $x^2+y^2$.\n\n`).join('')+String.raw`\newpage
\section{Distant synthetic section}
Distant target paragraph has a real engine source span for caret navigation.

Final stable paragraph completes this isolated synthetic article.
\end{document}
`
if(process.argv.includes('--multi-body'))initial=initial.replace('\\setlength{\\textheight}{250pt}','\\setlength{\\textheight}{330pt}');
const bibliography=process.argv.includes('--bibliography'),bib='@book{sample,title={Synthetic Reference},author={Example, A},year={2020},publisher={Example}}';
if(bibliography){initial=initial.replace('\\end{document}','\\nocite{sample}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}');await writeFile(path.join(project,'refs.bib'),bib)}
await writeFile(path.join(project,'main.tex'),initial)
await writeFile(path.join(project,'.rtex-import.json'),JSON.stringify({projectId:P,main:'main.tex',entries:[{path:'main.tex',bytes:Buffer.byteLength(initial),sha256:createHash('sha256').update(initial).digest('hex')},...(bibliography?[{path:'refs.bib',bytes:Buffer.byteLength(bib),sha256:createHash('sha256').update(bib).digest('hex')}]:[])]}))
const trace=[],traceAbort=new AbortController();let traceConsumer;
const cookie=randomBytes(24).toString('hex'),connections=new Set();let app,backendPort,origin,expiryTimer,closing=false
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
const authed=req=>(req.headers.cookie??'').split(';').map(s=>s.trim()).includes('rtex_fixture='+cookie)
const safeHost=req=>req.headers.host===new URL(origin).host
const front=http.createServer(async(req,res)=>{try{if(!safeHost(req))return json(res,403,{error:'Fixture host required'});const url=new URL(req.url,origin)
 if(url.pathname===`/project/${P}`&&req.method==='GET'){res.setHeader('Set-Cookie',`rtex_fixture=${cookie}; HttpOnly; SameSite=Strict; Path=/`);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(await readFile(path.join(dir,'index.html')));return}
 if(!authed(req))return json(res,401,{error:'Synthetic fixture session required; open the printed project URL'})
 if(url.pathname==='/fixture/events')return json(res,200,{events:trace});
 if(url.pathname==='/fixture/config')return json(res,200,{projectId:P,docId:D,resourceMap:bibliography?[{path:'refs.bib',type:'doc',id:'b'.repeat(24)}]:[]})
 if(url.pathname==='/fixture/auth')return json(res,200,{projectId:P,engineAlive:Boolean(app&&!closing)})
 if(bibliography&&url.pathname===`/project/${P}/doc/${'b'.repeat(24)}/download`){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(bib);return}
 if(url.pathname===`/project/${P}/entities`)return json(res,200,{project_id:P,entities:[{path:'main.tex',type:'doc'}]})
 if(url.pathname===`/project/${P}/doc/${D}/download`&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(await readFile(path.join(project,'main.tex')));return}
 if(url.pathname==='/fixture/document'&&req.method==='POST'){if(req.headers.origin!==origin)return json(res,403,{error:'Synthetic same-origin write required'});const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>1000000)return json(res,413,{error:'Synthetic document too large'});chunks.push(chunk)}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(body.projectId!==P||body.docId!==D||typeof body.text!=='string')return json(res,403,{error:'Synthetic document binding mismatch'});await writeFile(path.join(project,'main.tex'),body.text);return json(res,200,{saved:true})}
 if(url.pathname==='/client.js'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end(await readFile(path.join(dir,'client.js')));return}
 if(url.pathname==='/rtex/api/settings')return json(res,200,{projectId:P,rootDocId:D,compiler:'lualatex',observedAt:Date.now()})
 if(url.pathname.startsWith('/rtex/')){if(!app)return json(res,503,{error:'Fixture bridge starting'});const headers={...req.headers,host:new URL(origin).host,origin,authorization:'Bearer '+app.token};delete headers['accept-encoding'];const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res)});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()});res.on('close',()=>{if(!res.writableFinished)upstream.destroy()});req.pipe(upstream);return}
 return json(res,404,{error:'Unknown synthetic fixture route'})
 }catch(error){if(!res.headersSent)json(res,500,{error:error.name});else res.end()}})
front.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket))})
front.on('upgrade',(req,socket,head)=>{if(!safeHost(req)||!authed(req)||req.url!=='/rtex/api/socket'||!app){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}const headers={host:new URL(origin).host,origin,authorization:'Bearer '+app.token,cookie:req.headers.cookie,connection:'Upgrade',upgrade:'websocket','sec-websocket-key':req.headers['sec-websocket-key'],'sec-websocket-version':req.headers['sec-websocket-version']};const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:'GET',headers});upstream.on('upgrade',(reply,backend,backendHead)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(reply.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');if(backendHead.length)socket.write(backendHead);if(head.length)backend.write(head);socket.pipe(backend);backend.pipe(socket);socket.on('error',()=>backend.destroy());backend.on('error',()=>socket.destroy());socket.on('close',()=>backend.destroy())});upstream.on('response',reply=>{socket.end(`HTTP/1.1 ${reply.statusCode} Rejected\r\nConnection: close\r\n\r\n`);reply.resume()});upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());upstream.end()})
async function freePort(){const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port}
async function cleanup(){if(closing)return;closing=true;traceAbort.abort();clearTimeout(expiryTimer);if(app)await app.close();for(const socket of connections)socket.destroy();front.closeAllConnections();await new Promise(r=>front.close(r));await rm(project,{recursive:true,force:true});await rm(lock,{force:true});await rm(path.join(dir,'state.json'),{force:true})}
for(const signal of['SIGTERM','SIGINT'])process.on(signal,()=>cleanup().then(()=>process.exit(0)))
try{await new Promise(r=>front.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${front.address().port}`;backendPort=await freePort();process.env.OVERLEAF_ORIGIN=origin;for(const name of['RTEX_TOKEN_FILE','RTEX_SETTINGS_FILE','RTEX_PROJECT_CONFIG'])delete process.env[name];const{startServer}=await import(path.join(runtime,'dist/server.mjs'));app=await startServer({project,token:randomBytes(32).toString('hex'),projectId:P,mapping:{[D]:'main.tex'},requireBinding:true,enableNativeInsertions:true,basePath:'/rtex',port:backendPort,publicOrigin:origin,wsAuthURL:origin+'/fixture/auth'});traceConsumer=(async()=>{let cursor;while(!traceAbort.signal.aborted){try{const batch=await new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port:backendPort,path:'/rtex/api/poll'+(cursor===undefined?'':'?cursor='+cursor),headers:{host:new URL(origin).host,origin,authorization:'Bearer '+app.token},signal:traceAbort.signal},reply=>{const chunks=[];let bytes=0;reply.on('data',b=>{bytes+=b.length;if(bytes>4000000)request.destroy(Error('Trace budget'));else chunks.push(b)});reply.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)))}catch(e){reject(e)}});reply.on('error',reject)});request.on('error',reject);request.end()});cursor=batch.cursor;for(const event of batch.events){if(!['ParagraphUpdate','LayoutUpdate','LayoutDeferred','InsertionUpdate','ReplacementUpdate','SourceLineageState','BackgroundScheduled','EngineState','GenerationRecoveryScheduled','BridgeError'].includes(event.event))continue;trace.push({observedAt:performance.timeOrigin+performance.now(),event:event.event,engineGeneration:event.engine_generation,reason:event.reason,parId:event.par_id??event.parId,editId:event.edit_id??event.editId,beforeParId:event.beforeParId,afterParId:event.afterParId,versions:event.versions,sourceRevision:event.sourceRevision,status:event.status,state:event.state,reasons:event.reasons,timing:event.timing,paginationStale:event.pagination_stale,contextStale:event.context_stale,baseVersions:event.baseVersions,dirtyUnits:event.dirtyUnits,reverted:event.reverted,kind:event.kind,requiresCapture:event.requiresCapture,placedIds:event.placements?.map(p=>p.par_id).slice(0,2048),compile:event.compile,convergence:event.convergence,pages:event.pages_total,wallMs:event.wall_ms,fontDescriptors:Object.keys(event.dl?.fonts??{}).length});if(trace.length>512)trace.shift();}}catch(error){if(!traceAbort.signal.aborted)console.error('TRACE_FAILED '+error.name);break;}}})();const state={pid:process.pid,enginePid:app.engine.pid,url:origin+`/project/${P}`,project,backendPort};await writeFile(path.join(dir,'state.json'),JSON.stringify(state,null,2),{mode:0o600});console.log('FIXTURE_READY '+JSON.stringify({...state,durationMs}));expiryTimer=setTimeout(()=>{console.log('FIXTURE_EXPIRED');void cleanup().then(()=>process.exit(0));},durationMs)
 if(process.argv.includes('--self-test')){const headers={Cookie:'rtex_fixture='+cookie,Origin:origin};assert.equal((await fetch(origin+'/rtex/api/project')).status,401);const get=async suffix=>{const response=await fetch(origin+suffix,{headers});assert.equal(response.status,200,suffix);return response};const metadata=await(await get('/rtex/api/project')).json();assert.equal(metadata.nativeBridgeProtocol,1);assert.match(await(await get('/rtex/')).text(),/id="pages"/);assert.equal(createHash('sha256').update(await(await get('/rtex/app.js')).text()).digest('hex'),createHash('sha256').update(await readFile(path.join(runtime,'public/app.js'))).digest('hex'));assert.match(await(await get('/client.js')).text(),/UNSTABLE_editor:extensions/);const resources=await(await get('/rtex/api/resources')).json();assert.equal(resources.verified,true);assert.deepEqual(resources.resources,[]);assert.equal(await(await get(`/project/${P}/doc/${D}/download`)).text(),initial);assert.equal((await(await get('/rtex/api/settings')).json()).rootDocId,D);assert.equal((await(await get(`/project/${P}/entities`)).json()).project_id,P);let cursor,layout;const deadline=Date.now()+20000;while(!layout&&Date.now()<deadline){const response=await get('/rtex/api/poll'+(cursor===undefined?'':'?cursor='+cursor));const batch=await response.json();cursor=batch.cursor;layout=batch.events.find(event=>event.event==='LayoutUpdate'&&event.pages_total>0)}assert.ok(layout,'Actual engine layout must arrive');const ws=new WebSocket(origin.replace('http:','ws:')+'/rtex/api/socket',{headers});const wsTimer=setTimeout(()=>ws.terminate(),5000);try{await once(ws,'open');const reply=once(ws,'message');ws.send(JSON.stringify({id:1,path:'/api/source-map?'+new URLSearchParams({projectId:P,docId:D,path:'main.tex'})}));const [raw]=await reply;assert.equal(JSON.parse(raw).status,200)}finally{clearTimeout(wsTimer);ws.terminate()}const result={testedAt:new Date().toISOString(),nativeBridgeProtocol:metadata.nativeBridgeProtocol,verifiedResources:resources.verified,resourceCount:resources.resources.length,pages:layout.pages_total,compile:layout.compile.state,anonymousStatus:401,authenticatedWebSocketRPC:200,scopedAssetsVerified:true,browserExecuted:false,nativeEditorAndCanvasAcceptance:'Not exercised by server self-test; manual browser acceptance required'};console.log('SELF_TEST_OK '+JSON.stringify(result));await cleanup();await writeFile(path.join(dir,'self-test.json'),JSON.stringify(result,null,2));process.exit(0)}
}catch(error){await cleanup();throw error}
