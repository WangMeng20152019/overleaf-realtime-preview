/** Overleaf integration boundary: feed the authoritative document after OT acknowledgement.
 * Never derive content from editor DOM or assume UTF-16 offsets are UTF-8 bytes. */
export function utf8Range(text:string,start:number,end:number) {
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>text.length)throw Object.assign(Error('Invalid UTF-16 range'),{status:400});
 for(const n of [start,end])if(n>0&&n<text.length&&/[\uD800-\uDBFF]/.test(text[n-1])&&/[\uDC00-\uDFFF]/.test(text[n]))throw Object.assign(Error('Range splits surrogate pair'),{status:400});
 return {start:Buffer.byteLength(text.slice(0,start)),end:Buffer.byteLength(text.slice(0,end))};
}
export class RevisionDocument {
 revision=0;
 constructor(public text:string){}
 edit(base:number,start:number,end:number,text:string,documentPath='main.tex'){
 if(base!==this.revision)throw Object.assign(Error('Revision conflict; fetch current document before retry'),{status:409});
 const bytes=utf8Range(this.text,start,end);
 return {command:{cmd:'edit',path:documentPath,...bytes,text},next:this.text.slice(0,start)+text+this.text.slice(end)};
 }
 commit(text:string){this.text=text;return ++this.revision;}
}
