import test from 'node:test';
import assert from 'node:assert/strict';
import {mountRealtimePanel} from '../integration/project-entry.js';

class Element {
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.style={};this.attributes={};if(tag==='iframe')this.contentWindow={messages:[],postMessage(value,origin){this.messages.push({value,origin});}};}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
 setAttribute(key,value){this.attributes[key]=value;}
 querySelector(selector){return selector==='.pdf.full-size'?this.children.find(node=>node.native):null;}
}
function fixture(){
 const saved={document:globalThis.document,location:globalThis.location,addEventListener:globalThis.addEventListener,removeEventListener:globalThis.removeEventListener};
 const panel=new Element('section'),native=new Element('div');native.native=true;panel.append(native);const handlers=new Map();
 globalThis.document={createElement:tag=>new Element(tag)};
 globalThis.location={href:'https://overleaf.example/project/0123456789abcdef01234567',origin:'https://overleaf.example'};
 globalThis.addEventListener=(name,handler)=>handlers.set(name,handler);
 globalThis.removeEventListener=(name,handler)=>{if(handlers.get(name)===handler)handlers.delete(name);};
 return {panel,handlers,frame:()=>panel.children.find(node=>node.tag==='iframe'),click(label){const event={target:{closest:selector=>selector==='button[aria-label]'?{getAttribute:()=>label}:null},blocked:0,stopped:0,immediate:0,preventDefault(){this.blocked++;},stopPropagation(){this.stopped++;},stopImmediatePropagation(){this.immediate++;}};handlers.get('click')?.(event);return event;},restore(){Object.assign(globalThis,saved);}};
}
const labels=[
 ['Chinese forward','转到PDF中的位置','forward'],
 ['English forward','Go to code location in PDF','forward'],
 ['Chinese reverse','转到代码中对应 PDF 的位置（提示：双击 PDF 以获得最佳结果）','reverse'],
 ['English reverse','Go to PDF location in code (Tip: double click on the PDF for best results)','reverse'],
];
for(const [name,label,direction]of labels)test(`${name} SyncTeX control routes only the active realtime panel`,async()=>{
 const f=fixture();let shell,followed=0,callbacks;
 try{
  shell=await mountRealtimePanel({panel:f.panel,baseURL:'/rtex-test/',token:'session',projectId:'0123456789abcdef01234567'},async config=>{callbacks=config;return{stop(){},followCursor(){followed++;}};});
  assert.equal(f.click(label).blocked,0,'Traditional mode must retain native behavior');
  await shell.showRealtime();const frame=f.frame(),event=f.click(label);
  assert.deepEqual([event.blocked,event.stopped,event.immediate],[1,1,1]);
  if(direction==='forward'){assert.equal(followed,1);assert.equal(frame.contentWindow.messages.length,0);}
  else {assert.equal(followed,0);assert.deepEqual(frame.contentWindow.messages,[{value:{type:'rtex:locate',projectId:'0123456789abcdef01234567'},origin:location.origin}]);}
  const messages=frame.contentWindow.messages.length;
  callbacks.onStatus({state:'stopped',message:'Synthetic stopped connection'});
  const pausedMessages=frame.contentWindow.messages.length;
  assert.equal(f.click(label).blocked,1,'Paused realtime UI still suppresses hidden native navigation');
  assert.equal(followed,direction==='forward'?1:0);assert.equal(frame.contentWindow.messages.length,pausedMessages);
  assert.ok(pausedMessages>=messages);
  shell.showTraditional();assert.equal(f.click(label).blocked,0);assert.equal(followed,direction==='forward'?1:0);
 }finally{shell?.dispose();f.restore();}
});
test('unrecognized labels never acquire realtime navigation ownership',async()=>{
 const f=fixture();let shell,followed=0;
 try{shell=await mountRealtimePanel({panel:f.panel,baseURL:'/rtex-test/',token:'session'},async()=>({stop(){},followCursor(){followed++;}}));await shell.showRealtime();for(const label of ['Go to code location in PDF extra','Go to PDF location in code','Other action'])assert.equal(f.click(label).blocked,0);assert.equal(followed,0);assert.equal(f.frame().contentWindow.messages.length,0);}finally{shell?.dispose();f.restore();}
});
