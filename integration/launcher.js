import {mountRealtimePanel} from './project-entry.js';
(async()=>{
 const marker=Symbol.for('overleaf.rtex.trial.launcher');if(window[marker])return;
 const match=location.pathname.match(/^\/project\/([a-f0-9]{24})$/i);if(!match)return;
 window[marker]=true;let shell=null,observer=null,disposed=false,mounting=false;
 const cleanup=()=>{disposed=true;observer?.disconnect();shell?.dispose();delete window[marker];};
 window.addEventListener('pagehide',cleanup,{once:true});
 try{
  const response=await fetch('/rtex-test/api/config',{credentials:'same-origin',cache:'no-store'});if(!response.ok||response.redirected){cleanup();return;}
  const config=await response.json();if(config.projectId!==match[1]||disposed){cleanup();return;}
  const install=async()=>{if(disposed||shell||mounting)return;const panel=document.querySelector('#ide-redesign-pdf-panel');if(!panel?.querySelector('.pdf.full-size'))return;mounting=true;observer?.disconnect();shell=await mountRealtimePanel({...config,token:'session',panel});if(disposed)shell.dispose();};
  observer=new MutationObserver(()=>void install());observer.observe(document.body,{childList:true,subtree:true});await install();
 }catch(error){console.error('Realtime preview launcher failed',error);cleanup();}
})();
