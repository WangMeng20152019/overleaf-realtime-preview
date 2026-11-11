/** Read-only transport retry budget. Source writes deliberately never use this. */
export class PreviewReconnect {
 private failures=0;
 success(){this.failures=0;}
 async wait(signal:AbortSignal){if(signal.aborted)throw new DOMException('Aborted','AbortError');if(++this.failures>8)throw Error('预览连接暂不可用，请重新打开实时预览');const delay=Math.min(250*2**(this.failures-1),4000);await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new DOMException('Aborted','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},delay);signal.addEventListener('abort',abort,{once:true});});}
}
