/** A load owns one distinct PDF base bitmap. A lease keeps that bitmap valid
 * until its caller finishes its synchronous copy/draw and releases in finally. */
export interface PDFBaseBitmap {width:number;height:number}
export interface PDFBaseLease<T extends PDFBaseBitmap> {promise:Promise<T>;release():void}
interface Entry<T extends PDFBaseBitmap> {key:string;promise:Promise<T>;pins:number;retired:boolean;released:boolean;value?:T}
export class PDFBaseCache<T extends PDFBaseBitmap=HTMLCanvasElement> {
 private entries=new Map<string,Entry<T>>();private readonly maxEntries:number;
 constructor(maxEntries=8){this.maxEntries=maxEntries;if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>1024)throw RangeError('Invalid PDF base cache capacity');}
 private free(entry:Entry<T>){if(entry.retired&&entry.pins===0&&entry.value&&!entry.released){entry.released=true;entry.value.width=entry.value.height=0;}}
 private retire(entry:Entry<T>){if(this.entries.get(entry.key)===entry)this.entries.delete(entry.key);entry.retired=true;this.free(entry);}
 private trim(){
  while(this.entries.size>this.maxEntries){const idle=[...this.entries.values()].find(entry=>entry.pins===0);if(!idle)break;this.retire(idle);}
 }
 acquire(key:string,load:()=>Promise<T>):PDFBaseLease<T>{
  let entry=this.entries.get(key);
  if(entry){entry.pins++;this.entries.delete(key);this.entries.set(key,entry);}
  else{
   const fresh:Entry<T>={key,promise:null!,pins:1,retired:false,released:false};entry=fresh;this.entries.set(key,fresh);
   fresh.promise=Promise.resolve().then(load).then(value=>{fresh.value=value;this.free(fresh);this.trim();return value;},error=>{this.retire(fresh);throw error;});
   // Released/retired callers may abandon a failed load. Keep its rejection
   // observable on the lease without an unhandled internal cache rejection.
   void fresh.promise.catch(()=>{});
  }
  this.trim();const owned=entry;let released=false;
  return{promise:owned.promise,release:()=>{if(released)return;released=true;owned.pins--;this.free(owned);this.trim();}};
 }
 /** Retire a generation immediately, but never zero a bitmap still in use. */
 clear(){for(const entry of [...this.entries.values()])this.retire(entry);}
}
