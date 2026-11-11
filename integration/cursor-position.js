/** Locate the engine-owned paragraph containing a CodeMirror UTF-16 cursor. */
export function cursorParagraph(text,head,spans){if(!Number.isInteger(head)||head<0||head>text.length)return null;if(head>0&&head<text.length&&/[\uD800-\uDBFF]/.test(text[head-1])&&/[\uDC00-\uDFFF]/.test(text[head]))return null;const byte=new TextEncoder().encode(text.slice(0,head)).length;return spans.find(s=>s.range.start<=byte&&byte<s.range.end)??(byte===new TextEncoder().encode(text).length?spans.find(s=>s.range.end===byte):null)??null;}
/** Body-only endpoint for insertion/geometry scheduling. */
export function cursorParagraphEnd(text,head,span){return span?.kind==='Body'&&cursorSpanEnd(text,head,span);}
/** Navigation can use a complete Env's last fragment only at its proven source end. */
export function cursorNavigationEnd(text,head,span){return ['Body','Env'].includes(span?.kind)&&cursorSpanEnd(text,head,span);}
/** Exact byte suffix through the mapped span must contain ASCII whitespace only. */
function cursorSpanEnd(text,head,span){
 if(typeof text!=='string'||!Number.isInteger(head)||head<0||head>text.length||!Number.isSafeInteger(span.range?.start)||!Number.isSafeInteger(span.range?.end)||span.range.start<0||span.range.end<span.range.start)return false;
 if(head>0&&head<text.length&&/[\uD800-\uDBFF]/.test(text[head-1])&&/[\uDC00-\uDFFF]/.test(text[head]))return false;
 const encoder=new TextEncoder(),bytes=encoder.encode(text),at=encoder.encode(text.slice(0,head)).length;
 if(at<span.range.start||at>span.range.end||span.range.end>bytes.length)return false;
 // Reject engine ranges that cut inside a UTF-8 code point.
 if(span.range.end<bytes.length&&(bytes[span.range.end]&192)===128)return false;
 return bytes.slice(at,span.range.end).every(byte=>byte===32||byte>=9&&byte<=13);
}
