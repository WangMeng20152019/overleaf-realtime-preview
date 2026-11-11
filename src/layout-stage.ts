/** Accumulate incremental layouts while their matching PDF is loading; only the newest ticket commits. */
export class LayoutStage {
 private sequence=0;private latest:any=null;private pages:Map<number,any>|null=null;
 stage(event:any,current:Map<number,any>){const v=event.versions;if(!v||![v.source_revision,v.engine_generation,v.layout_version].every(Number.isSafeInteger))return null;const old=this.latest;if(old&&(v.engine_generation<old.engine_generation||v.source_revision<old.source_revision||(v.engine_generation===old.engine_generation&&v.layout_version<old.layout_version)))return null;this.latest={...v};if(!this.pages)this.pages=new Map(current);for(const page of event.pages_changed??[])this.pages.set(page.page,page);for(const page of this.pages.keys())if(page>event.pages_total)this.pages.delete(page);return {sequence:++this.sequence,event,pages:[...this.pages.values()]};}
 current(ticket:any){return ticket.sequence===this.sequence;}
 committed(ticket:any){if(this.current(ticket))this.pages=null;}
 reset(){this.sequence++;this.latest=null;this.pages=null;}
}
