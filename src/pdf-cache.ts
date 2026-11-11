import {randomBytes} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
export interface CachedPDF {readonly data:Buffer;readonly etag:string;readonly createdAt:number}
/** Immutable per-layout bytes. Only the current authoritative PDF survives idle expiry. */
export class PDFCache {
 private entries=new Map<string,CachedPDF>();private total=0;private latest:string|null=null;
 private maxEntries:number;private maxBytes:number;private ttl:number;private now:()=>number;
 constructor(options:{maxEntries?:number;maxBytes?:number;ttlMs?:number;now?:()=>number}={}){this.maxEntries=options.maxEntries??12;this.maxBytes=options.maxBytes??64000000;this.ttl=options.ttlMs??300000;this.now=options.now??Date.now;if(![this.maxEntries,this.maxBytes,this.ttl].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('Invalid PDF cache limits');}
 private remove(id:string){const entry=this.entries.get(id);if(entry){this.total-=entry.data.length;this.entries.delete(id);if(this.latest===id)this.latest=null;}}
 private expire(){const now=this.now();for(const [id,entry]of this.entries)if(id!==this.latest&&now-entry.createdAt>=this.ttl)this.remove(id);}
 put(bytes:Buffer){if(!bytes.length||bytes.length>this.maxBytes)throw Error('PDF exceeds immutable cache budget');this.expire();let id:string;do{id=randomBytes(12).toString('hex');}while(this.entries.has(id));const entry={data:Buffer.from(bytes),etag:'"'+id+'"',createdAt:this.now()};this.entries.set(id,entry);this.total+=bytes.length;this.latest=id;this.expire();while(this.entries.size>this.maxEntries||this.total>this.maxBytes){const victim=[...this.entries.keys()].find(key=>key!==this.latest);if(!victim)throw Error('PDF cache budget invariant');this.remove(victim);}return id;}
 get(id:string){this.expire();if(!/^[a-f0-9]{24}$/.test(id))return undefined;const entry=this.entries.get(id);if(entry){this.entries.delete(id);this.entries.set(id,entry);}return entry;}
 get stats(){this.expire();return {entries:this.entries.size,bytes:this.total,latest:this.latest};}
 get maxPDFBytes(){return this.maxBytes;}
}
/** Single byte range only. Never combine bytes from different immutable PDF IDs. */
export function pdfRange(length:number,range?:string):{start:number;end:number}|null{
 if(!range||range.length>128)return null;const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2]))return null;
 const first=match[1]?Number(match[1]):null,last=match[2]?Number(match[2]):null;if((first!==null&&!Number.isSafeInteger(first))||(last!==null&&!Number.isSafeInteger(last)))return null;
 if(first===null){if(last===null||last<=0)return null;return {start:Math.max(0,length-last),end:length-1};}
 if(first>=length||first<0||(last!==null&&last<first))return null;return {start:first,end:Math.min(length-1,last??length-1)};
}
export function sendPDF(req:IncomingMessage,res:ServerResponse,pdf:CachedPDF){
 const length=pdf.data.length;const headers:Record<string,string|number>={'Content-Type':'application/pdf','Cache-Control':'no-store, no-transform','Accept-Ranges':'bytes','Content-Length':length,ETag:pdf.etag,'X-Content-Type-Options':'nosniff'};
 // If-Range dates are deliberately unsupported: only this exact strong validator matches.
 const range=req.headers.range;if(range&&(!req.headers['if-range']||req.headers['if-range']===pdf.etag)){const selected=pdfRange(length,range);if(!selected){res.writeHead(416,{...headers,'Content-Range':`bytes */${length}`,'Content-Length':0});res.end();return;}res.writeHead(206,{...headers,'Content-Range':`bytes ${selected.start}-${selected.end}/${length}`,'Content-Length':selected.end-selected.start+1});res.end(pdf.data.subarray(selected.start,selected.end+1));return;}
 res.writeHead(200,headers);res.end(pdf.data);
}
