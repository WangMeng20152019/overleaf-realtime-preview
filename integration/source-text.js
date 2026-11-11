/** Editable Overleaf documents are exact UTF-8 source, including an initial U+FEFF.
 * Response.text() strips the UTF-8 BOM; decoding bytes with ignoreBOM:true keeps it.
 * Invalid UTF-8 is a synchronization error, never replacement source text.
 */
export async function readSourceText(response){
 const bytes=await response.arrayBuffer();
 return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
