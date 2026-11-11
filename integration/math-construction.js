import {verifyNativeProof} from '../src/native-edits.ts'
const BLANK_END=/(?:\r?\n)[\t ]*(?:\r?\n)[\t ]*$/
const BLANK_START=/^[\t ]*(?:\r?\n)[\t ]*(?:\r?\n)/
const trim=s=>s.replace(/^[\t \r\n]+|[\t \r\n]+$/g,'')
const OUTER_ENVIRONMENTS=['equation','equation*']
const NESTED_ENVIRONMENTS=['aligned']
const hold=reason=>({state:'hold',reason}),optout=reason=>({state:'optout',reason})
function skipSpaceComments(text,at){
 while(at<text.length){if(/\s/.test(text[at])){at++;continue}if(text[at]==='%'){const next=text.indexOf('\n',at);if(next<0)return text.length;at=next+1;continue}break}return at
}
// A finite literal environment grammar, not macro expansion or generic TeX.
function constructionBoundary(text,at){const rest=text.slice(skipSpaceComments(text,at));return !rest||rest.startsWith('\\end')||rest.startsWith('$')||rest.startsWith('\\]')}
function environmentAt(text,at,command,names){
 const marker='\\'+command,remaining=text.slice(at)
 if(marker.startsWith(remaining))return hold('partial-environment-command')
 const word=/^\\([A-Za-z@]*)/.exec(remaining)?.[1]
 if(word&&command.startsWith(word)&&word!==command&&constructionBoundary(text,at+word.length+1))return hold('partial-environment-command')
 if(!remaining.startsWith(marker)||/[A-Za-z@]/.test(text[at+marker.length]??''))return optout('unsupported-environment-command')
 let i=skipSpaceComments(text,at+marker.length)
 if(i===text.length||constructionBoundary(text,i)&&text[i]!=='{')return hold('partial-environment-name')
 if(text[i]!=='{')return optout('invalid-environment-name')
 let end=i+1;while(end<text.length&&/[A-Za-z*]/.test(text[end]))end++
 const name=text.slice(i+1,end)
 if(text[end]!=='}')return names.some(value=>value.startsWith(name))&&constructionBoundary(text,end)?hold('partial-environment-name'):optout('unsupported-environment')
 if(!names.includes(name))return optout('unsupported-or-mismatched-environment')
 return{state:'parsed',name,end:end+1}
}
function alignedPositionAt(text,at){
 let next=skipSpaceComments(text,at+1)
 if(text[next]===']'||constructionBoundary(text,next))return hold('partial-aligned-position')
 if(!['t','b','c'].includes(text[next]))return optout('unsupported-aligned-position')
 next=skipSpaceComments(text,next+1)
 if(text[next]===']')return{state:'parsed',end:next+1}
 return constructionBoundary(text,next)?hold('partial-aligned-position'):optout('unsupported-aligned-position')
}
function mathStart(text){
 text=trim(text);if(!text)return false
 if(text.startsWith('$'))return true
 if(text.startsWith('\\['))return true
 const marker='\\begin',word=/^\\([A-Za-z@]*)/.exec(text)?.[1];return marker.startsWith(text)||text.startsWith(marker)&&!/[A-Za-z@]/.test(text[marker.length]??'')||word&&'begin'.startsWith(word)&&constructionBoundary(text,word.length+1)
}
/** Outer delimiter/environment structure only; unknown macro arity is not guessed. */
function parseMath(source,structuralOnly=false){
 const text=trim(source);if(text==='\\')return hold('partial-display-opener')
 let open,close,start=0,environmentSeen=false;const environments=[]
 if(text.startsWith('$$'))open=close='$$'
 else if(text.startsWith('$'))open=close='$'
 else if(text.startsWith('\\[')){open='\\[';close='\\]'}
 else if(mathStart(text)){
  const parsed=environmentAt(text,0,'begin',OUTER_ENVIRONMENTS);if(parsed.state!=='parsed')return parsed
  open='\\begin{'+parsed.name+'}';start=parsed.end;environmentSeen=true;environments.push({name:parsed.name,content:false,depth:0,position:false})
 }else return optout('not-math-start')
 if(close)start=open.length
 let braces=0,content=false,lastControl=null,unknownControl=false,emptyMathbb=false,emptyEnvironment=false,pendingMathbb=false
 const groups=[]
 const markContent=()=>{content=true;if(groups.length)groups.at(-1).content=true;for(const environment of environments)environment.content=true}
 const finish=end=>{
  if(braces)return hold('unclosed-brace')
  if(!content||emptyEnvironment)return hold('empty-or-ambiguous-math')
  if(pendingMathbb)return hold('mathbb-argument-pending')
  const tail=skipSpaceComments(text,end)
  // Extra environment delimiters are malformed even in the ordinary-text mode.
  if(text.slice(tail).startsWith('\\end')||text.slice(tail).startsWith('\\begin'))return optout('trailing-environment')
  if(structuralOnly)return tail===text.length&&environmentSeen&&!emptyMathbb?{state:'complete',delimiter:open}:optout('not-one-closed-supported-environment')
  if(lastControl)return 'mathbb'.startsWith(lastControl)?hold('mathbb-argument-pending'):optout('unknown-or-zero-argument-control-word')
  if(unknownControl)return optout('unverified-control-word-arity')
  if(emptyMathbb)return hold('empty-mathbb-argument')
  return{state:'complete',delimiter:open}
 }
 for(let i=start;i<text.length;){
  const c=text[i]
  if(c==='%'){const end=text.indexOf('\n',i);if(end<0)return hold('comment-before-close');i=end+1;continue}
  if(/\s/.test(c)){i++;continue}
  const current=environments.at(-1)
  if(current?.position){current.position=false;if(c==='['){const position=alignedPositionAt(text,i);if(position.state!=='parsed')return position;i=position.end;continue}}
  if(close&&text.startsWith(close,i)){
   if(environments.length)return hold('unclosed-environment')
   return finish(i+close.length)
  }
  if(c==='\\'){
   if(i+1===text.length)return hold('partial-control-sequence')
   if(/[A-Za-z@]/.test(text[i+1])){
    let end=i+2;while(end<text.length&&/[A-Za-z@]/.test(text[end]))end++
    const word=text.slice(i+1,end)
    if(word==='begin'||word==='end'){
     const names=word==='begin'?NESTED_ENVIRONMENTS:current?[current.name]:[]
     const parsed=environmentAt(text,i,word,names);if(parsed.state!=='parsed')return parsed
     if(word==='begin'){
      if(lastControl)unknownControl=true
      if(environments.length>=16)return optout('environment-depth-budget')
      environments.push({name:parsed.name,content:false,depth:braces,position:parsed.name==='aligned'});environmentSeen=true
     }else{
      if(lastControl&&'mathbb'.startsWith(lastControl))pendingMathbb=true
      if(braces!==current.depth)return hold('unclosed-brace')
      if(!current.content)emptyEnvironment=true
      environments.pop()
      if(!close&&!environments.length)return finish(parsed.end)
     }
     if(word==='begin')lastControl=null;i=parsed.end;continue
    }
    if(constructionBoundary(text,end)&&('begin'.startsWith(word)||current&&'end'.startsWith(word)))return hold('partial-environment-command')
    lastControl=word;if(word!=='mathbb')unknownControl=true;markContent();i=end;continue
   }
   // Escaped tokens cannot introduce begin/end; a row separator is not content.
   if(text[i+1]!=='\\')markContent();else if(lastControl&&'mathbb'.startsWith(lastControl))pendingMathbb=true
   lastControl=null;i+=2;continue
  }
  if(c==='{'){groups.push({mathbb:lastControl==='mathbb',content:false});braces++;lastControl=null;i++;continue}
  if(c==='}'){if(!braces)return optout('unmatched-closing-brace');braces--;const group=groups.pop();if(group.mathbb&&!group.content)emptyMathbb=true;if(group.content)markContent();lastControl=null;i++;continue}
  if(c==='$')return optout('different-math-delimiter')
  if(c!=='&')markContent();lastControl=null;i++
 }
 return hold(braces?'unclosed-brace':environments.length?'unclosed-environment':'unclosed-math')
}
export function scanOuterMath(source){return parseMath(source)}
/** Structure authorization only; engine success/material checks remain mandatory. */
export function isClosedMathEnvironment(source){return parseMath(source,true).state==='complete'}
/** Exact native evidence is mandatory; source bytes are never corrected or completed here. */
export function inspectMathConstruction(before,after,proof){
 if(!proof||!Array.isArray(proof.records)||proof.records.length>128)return{state:'optout',reason:'missing-or-bounded-proof'}
 // Reject ordinary typing before verifying a whole-document native proof. This
 // cheap prefix gate is only an optimization; all held candidates are verified.
 let prefix='';for(const record of proof.records){if(!Array.isArray(record.changes))return{state:'optout',reason:'proof-gap'};for(const change of record.changes){if(typeof change.inserted!=='string')return{state:'optout',reason:'proof-gap'};if(change.inserted.length>65536)return{state:'optout',reason:'insert-budget'};prefix=(prefix+change.inserted.slice(0,8)).replace(/^[\t \r\n]+/,'');if(prefix.length>=2)break}if(prefix.length>=2)break}
 if(!mathStart(prefix))return{state:'optout',reason:'not-math-start'}
 let verified;try{verified=verifyNativeProof(before,after,proof)}catch{return{state:'optout',reason:'proof-gap'}}
 if(verified.origins.some(origin=>origin!=='local'))return{state:'optout',reason:'nonlocal-or-history-change'}
 if(verified.pureInsertions?.length!==1)return{state:'optout',reason:'not-single-insertion'}
 const inserted=verified.pureInsertions[0];if(inserted.text.length>65536)return{state:'optout',reason:'insert-budget'}
 const leading=inserted.text.match(/^[\t \r\n]*/)[0],trailing=inserted.text.match(/[\t \r\n]*$/)[0]
 if(!BLANK_END.test(before.slice(0,inserted.at)+leading)||!(BLANK_END.test(trailing)||BLANK_START.test(before.slice(inserted.at))))return{state:'optout',reason:'not-fresh-paragraph-boundary'}
 const math=trim(inserted.text),decision=scanOuterMath(math);if(/\n[\t ]*\r?\n/.test(math)&&!(decision.state==='hold'&&decision.reason==='empty-or-ambiguous-math'&&math.includes('\\begin')))return{state:'optout',reason:'multiple-inserted-paragraphs'}
 return{...decision,at:inserted.at,viewEpoch:proof.viewEpoch,baseTransactionId:proof.baseTransactionId}
}
