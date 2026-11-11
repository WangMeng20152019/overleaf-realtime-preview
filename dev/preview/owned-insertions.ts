// Fixture-only ownership. CodeMirror offsets are UTF-16; touching an owned
// block invalidates it rather than guessing which subsequent text is disposable.
export class OwnedInsertions {
 private entries:{id:number;from:number;to:number;text:string;valid:boolean}[]=[]
 private serial=0
 add(from:number,text:string,doc:{sliceString:(from:number,to:number)=>string}){
  if(!text||doc.sliceString(from,from+text.length)!==text)throw Error('Inserted fixture block does not match the editor')
  const entry={id:++this.serial,from,to:from+text.length,text,valid:true};this.entries.push(entry);if(this.entries.length>128)this.entries.shift();return entry.id
 }
 map(changes:any){for(const entry of this.entries){if(!entry.valid)continue;changes.iterChanges((from:number,to:number)=>{if(from<entry.to&&to>entry.from||from===to&&from>entry.from&&from<entry.to)entry.valid=false});if(entry.valid){entry.from=changes.mapPos(entry.from,1);entry.to=changes.mapPos(entry.to,-1)}}}
 last(doc:{sliceString:(from:number,to:number)=>string}){const entry=this.entries.at(-1);if(!entry)throw Error('No fixture-owned paragraph or formula is available');if(!entry.valid||doc.sliceString(entry.from,entry.to)!==entry.text)throw Error('The latest fixture block was edited; deletion refused to protect other text');return {...entry}}
 forget(id:number){this.entries=this.entries.filter(entry=>entry.id!==id)}
}
