type Version={source_revision:number;engine_generation:number};
type Options={signal:AbortSignal;latest:(version:Version)=>Version;request:(version:Version)=>Promise<boolean>;onError:(error:unknown)=>void;idleMs?:number};
const compare=(a:Version,b:Version)=>a.engine_generation-b.engine_generation||a.source_revision-b.source_revision;
/** Host-only drawing limitations need a full pass even when the engine reports an exact fast result. */
export class HostFallback {
 private seen:Version|null=null;private covered:Version|null=null;private dirty:Version|null=null;private outstanding:Version|null=null;private timer:ReturnType<typeof setTimeout>|null=null;private pending=false;private stopped=false;private attempts=new Map<string,number>();
 private options:Options;
 constructor(options:Options){this.options=options;if(options.signal.aborted)this.stopped=true;else options.signal.addEventListener('abort',()=>this.stop(),{once:true});}
 mark(version:Version,alreadyScheduled=false){if(this.stopped||this.seen&&compare(version,this.seen)<0||this.covered&&compare(version,this.covered)<=0)return;this.seen={...version};this.dirty={...version};if(alreadyScheduled){this.clearTimer();if(!this.outstanding||compare(version,this.outstanding)>0)this.outstanding={...version};}else this.schedule();}
 layout(version:Version){if(this.stopped)return;if(!this.seen||compare(version,this.seen)>0)this.seen={...version};if(!this.covered||compare(version,this.covered)>0)this.covered={...version};if(this.dirty&&compare(version,this.dirty)>=0)this.dirty=null;if(this.outstanding&&compare(version,this.outstanding)>=0)this.outstanding=null;if(!this.dirty)this.clearTimer();else this.schedule();}
 private clearTimer(){if(this.timer!==null){clearTimeout(this.timer);this.timer=null;}}
 private schedule(){this.clearTimer();if(this.stopped||!this.dirty||this.outstanding||this.pending)return;this.timer=setTimeout(()=>{this.timer=null;void this.send();},this.options.idleMs??500);}
 private async send(){if(this.stopped||!this.dirty||this.outstanding||this.pending)return;const version=this.options.latest(this.dirty),key=version.engine_generation+':'+version.source_revision;const attempts=this.attempts.get(key)??0;if(attempts>=2){this.options.onError(Error('完整排版请求暂不可用，保留上一版预览；请重新打开实时预览'));return;}this.attempts.set(key,attempts+1);while(this.attempts.size>8)this.attempts.delete(this.attempts.keys().next().value!);this.outstanding=version;this.pending=true;try{const accepted=await this.options.request(version);if(!accepted&&this.outstanding===version)this.outstanding=null;}catch(error){if(this.outstanding===version)this.outstanding=null;if(!this.stopped)this.options.onError(error);}finally{this.pending=false;if(!this.stopped&&this.dirty&&!this.outstanding)this.schedule();}}
 stop(){this.stopped=true;this.clearTimer();this.dirty=null;this.outstanding=null;}
}
