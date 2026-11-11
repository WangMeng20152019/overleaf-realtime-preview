type Version={source_revision:number;engine_generation:number};
const compare=(a:Version,b:Version)=>a.engine_generation-b.engine_generation||a.source_revision-b.source_revision;
/** Recover actual failed units, without treating unrelated nonfatal document errors as a new failure per edit. */
export class LayoutHealth {
 private usable:Version|null=null;
 private usableState:string|null=null;private usableErrors=0;
 private failed:{version:Version;paragraph:boolean;repaired:Version|null}|null=null;
 observe(event:any){
  const version:Version=event.versions;
  if(!version)return;
  if(this.usable&&compare(version,this.usable)<0)return;
  const paragraphError=event.event==='ParagraphUpdate'&&event.status==='error';
  const layoutFailed=event.event==='LayoutUpdate'&&event.compile?.state==='Failed';
  if(paragraphError||layoutFailed){
   if(!this.failed||compare(version,this.failed.version)>=0)this.failed={version,paragraph:paragraphError,repaired:null};
   return;
  }
  if(event.event==='ParagraphUpdate'&&event.status==='ok'){
   if(this.failed&&compare(version,this.failed.version)>0)this.failed.repaired=version;
   return;
  }
  if(event.event!=='LayoutUpdate'||!['Ok','CompiledWithErrors'].includes(event.compile?.state))return;
  const errors=event.compile?.count??0;
  const newlyBroken=event.compile.state==='CompiledWithErrors'&&this.usable&&compare(version,this.usable)>0&&(this.usableState==='Ok'||errors>this.usableErrors);
  this.usable=version;this.usableState=event.compile.state;this.usableErrors=errors;
  if(newlyBroken&&!this.failed){this.failed={version,paragraph:true,repaired:null};return;}
  if(!this.failed||compare(version,this.failed.version)<0)return;
  // A successful full pass is authoritative. A nonfatal pass also completes a
  // repaired unit once that unit actually compiled successfully; unrelated
  // diagnostics elsewhere must not keep requesting full passes on every key.
  if(event.compile.state==='Ok'||!this.failed.paragraph||this.failed.repaired&&compare(version,this.failed.repaired)>=0)this.failed=null;
 }
 needsRecovery(version:Version){return Boolean(this.failed&&compare(version,this.failed.version)>0);}
}
