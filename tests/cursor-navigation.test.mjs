import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {transform} from 'esbuild';
import {cursorParagraph,cursorParagraphEnd,cursorNavigationEnd} from '../integration/cursor-position.js';
import {installOverleafProject} from '../integration/project-entry.js';

const text='\\begin{equation}a=1\\end{equation}\n\\input{included}\n\\newpage\n\\section{Distant}\nDistant anchor 中文.\n\nFinal anchor.\n';
const head=text.indexOf('\n\nFinal'),end=head+1;
const env={id:5,kind:'Env',range:{start:0,end:Buffer.byteLength(text.slice(0,end))}};
const interior=text.indexOf('Distant anchor')+4;

test('navigation proves coarse Env end without changing Body-only geometry eligibility',()=>{
 assert.equal(cursorParagraph(text,head,[env]),env);
 assert.equal(cursorNavigationEnd(text,head,env),true,'One trailing newline remains inside this multi-page Env');
 assert.equal(cursorParagraphEnd(text,head,env),false,'Env must not acquire Body insertion/geometry eligibility');
 assert.equal(cursorNavigationEnd(text,interior,env),false,'Interior source must not be projected by a made-up proportion');
 assert.equal(cursorNavigationEnd(text,head,{...env,kind:'Heading'}),false);
 assert.equal(cursorNavigationEnd(text,head,{...env,range:{start:0,end:env.range.end+2}}),false,'Suffix includes actual next-unit text');
 const unicode='中文😀\n',span={kind:'Env',range:{start:0,end:Buffer.byteLength(unicode)}};
 assert.equal(cursorNavigationEnd(unicode,4,span),true);assert.equal(cursorNavigationEnd(unicode,3,span),false,'Split UTF16 surrogate is never a navigation endpoint');
});

test('actual project adapter publishes Env end edge and retains coarse interior behavior',async()=>{
 const saved={window:globalThis.window,location:globalThis.location,fetch:globalThis.fetch,WebSocket:globalThis.WebSocket};
 const projectId='0123456789abcdef01234567',docId='aaaaaaaaaaaaaaaaaaaaaaaa',cursors=[];let session,plugin;
 globalThis.window=new EventTarget();globalThis.WebSocket=undefined;
 globalThis.location={href:`https://overleaf.example/project/${projectId}`,origin:'https://overleaf.example',pathname:`/project/${projectId}`};
 const response=data=>({ok:true,status:200,redirected:false,json:async()=>data,arrayBuffer:async()=>new TextEncoder().encode(data).buffer});
 globalThis.fetch=async raw=>{const url=new URL(raw,location.href);if(url.pathname.endsWith('/api/project'))return response({projectId,main:'main.tex',engineAlive:true,documents:[{docId,path:'main.tex'}]});if(url.pathname.endsWith('/api/document'))return response({text,revision:0});if(url.pathname.endsWith('/api/source-map'))return response({projectId,path:'main.tex',revision:0,sourceRevision:5,spans:[env]});if(url.pathname.endsWith('/api/settings'))return response({projectId,rootDocId:docId,compiler:'lualatex'});if(url.pathname.endsWith('/api/resources'))return response({projectId,verified:true,resources:[]});if(url.pathname.endsWith('/entities'))return response({project_id:projectId,entities:[{path:'main.tex',type:'doc'}]});if(url.pathname.endsWith('/download'))return response(text);throw Error('Unexpected synthetic endpoint');};
 try{
  session=await installOverleafProject({baseURL:'/rtex-test/',token:'fixture-token',projectId,onCursor:cursor=>cursors.push(cursor),pollMs:60000});
  const extensions=[];window.dispatchEvent(new CustomEvent('UNSTABLE_editor:extensions',{detail:{rtexDocumentId:docId,extensions,CodeMirror:{ViewPlugin:{define:create=>create}}}}));
  const doc={toString:()=>text},state=position=>({doc,selection:{main:{head:position,anchor:position}}});const view={state:state(head),dom:new EventTarget(),composing:false};plugin=extensions[0](view);
  await new Promise(resolve=>setTimeout(resolve,170));assert.equal(cursors.at(-1)?.parId,5);assert.equal(cursors.at(-1)?.edge,'end');assert.equal(cursors.at(-1)?.sourceRevision,5);
  view.state=state(interior);plugin.update({docChanged:false,selectionSet:true,state:view.state});await new Promise(resolve=>setTimeout(resolve,170));assert.equal(cursors.at(-1)?.parId,5);assert.equal(cursors.at(-1)?.edge,undefined);assert.equal(cursors.length,2);
 }finally{plugin?.destroy();session?.stop();Object.assign(globalThis,saved);}
});

// Execute the actual preview navigation functions with deterministic page geometry.
// The application bootstrap/network/render lanes are excluded from this unit fixture.
const browser=await readFile(new URL('../src/browser.ts',import.meta.url),'utf8');
const between=(start,end)=>browser.slice(browser.indexOf(start),browser.indexOf(end,browser.indexOf(start)));
const single=name=>browser.split('\n').find(line=>line.startsWith('function '+name+'('));
const source=[between('function materializeCursorPage(','function cursorPresentationStamp('),between('function cursorPresentationStamp(',"\naddEventListener('message',"),single('displayedLayoutMatches'),single('capturedCursorId')].join('\n');
const compiled=(await transform(source,{loader:'ts',target:'es2022'})).code;
function previewFixture(edge){
 const baseline={source_revision:5,engine_generation:0,context_revision:1,layout_version:2},painted=new Map([[1,true],[3,false]]),ensured=[],scrolls=[];
 const pages={scrollTop:0,clientHeight:500,getBoundingClientRect:()=>({top:0,bottom:500,height:500}),scrollTo(value){this.scrollTop=Math.max(0,value.top);scrolls.push(this.scrollTop);}};
 const elements=new Map([1,3].map(page=>[page,{getBoundingClientRect:()=>({top:(page-1)*1000-pages.scrollTop,bottom:page*1000-pages.scrollTop,height:1000}),querySelector:()=>painted.get(page)?{dataset:{rtexLayout:JSON.stringify(baseline)}}:null}]));
 const context={paused:false,cursorTarget:{parId:5,sourceRevision:5,sequence:1,...(edge?{edge}:{} )},cursorSuppressed:0,cursorApplied:0,cursorAppliedLayout:'',cursorMaterialized:'',committedVersions:baseline,layoutRevision:5,windowCertificate:null,provisional:null,heldInsertion:null,layoutHandover:null,versionFields:['source_revision','engine_generation','context_revision','layout_version'],model:{pages:new Map([1,3].map(page=>[page,{dl:{page_height:1000}}])),overlays:new Map(),placements:new Map([[5,[{page:1,baselines:[100]},{page:3,baselines:[300]}]]])},viewport:{pageElement:page=>elements.get(page),ensurePage:page=>ensured.push(page)},pages,displayedInsertion:()=>null,displayedWindowCertificate:()=>null,unavailableNavigation:()=>{throw Error('Unexpected unsupported navigation');}};
 vm.createContext(context);vm.runInContext(compiled,context);
 return{context,ensured,scrolls,painted,run:()=>vm.runInContext('followCursor()',context)};
}
test('proven Env end materializes the actual last fragment and waits for its matching canvas',()=>{
 const f=previewFixture('end');f.run();assert.equal(f.ensured.at(-1),3);assert.equal(f.context.pages.scrollTop,2000);assert.equal(f.context.cursorApplied,0,'Missing canvas must not be treated as a completed navigation');f.painted.set(3,true);f.run();assert.equal(f.ensured.at(-1),3);assert.equal(f.context.pages.scrollTop,2150);assert.equal(f.context.cursorApplied,1);
});
test('interior coarse Env retains first-fragment navigation without invented source-position interpolation',()=>{
 const f=previewFixture();f.run();assert.equal(f.ensured.at(-1),1);assert.equal(f.context.pages.scrollTop,0);assert.equal(f.context.cursorApplied,1);
});
