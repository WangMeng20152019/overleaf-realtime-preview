export type MathStep={at:number;insert:string;delayBeforeMs:number;label:string;mathReady?:boolean}
export function mathConstructionPlan(scenario:string){
 const math='\\mathbb{R}+x^2',steps:MathStep[]=[]
 if(scenario==='character'){
  const prefix='Step-by-step formula: ',typed='$'+math+'$ and ordinary text.'
  steps.push({at:0,insert:prefix+'\n\n',delayBeforeMs:0,label:'new body paragraph'})
  for(let i=0;i<typed.length;i++)steps.push({at:prefix.length+i,insert:typed[i],delayBeforeMs:60,label:'character '+(i+1),mathReady:i===math.length+1})
 }else if(['dollar-sequential','double-dollar-sequential','bracket-sequential'].includes(scenario)){
  const open=scenario==='dollar-sequential'?'$':scenario==='double-dollar-sequential'?'$$':'\\[',close=scenario==='bracket-sequential'?'\\]':open
  steps.push({at:0,insert:open+'\n\n',delayBeforeMs:0,label:'open delimiter'},{at:open.length,insert:math,delayBeforeMs:450,label:'insert formula body'},{at:open.length+math.length,insert:close,delayBeforeMs:450,label:'close delimiter',mathReady:true})
 }else if(scenario==='paired-fill'){
  const command='\\mathbb'
  steps.push({at:0,insert:'$$\n\n',delayBeforeMs:0,label:'empty inline dollar pair'},{at:1,insert:command,delayBeforeMs:450,label:'insert incomplete command'},{at:1+command.length,insert:'{}',delayBeforeMs:450,label:'insert braces'},{at:2+command.length,insert:'R',delayBeforeMs:450,label:'fill argument',mathReady:true})
 }else if(['equation-sequential','equation-paired','equation-aligned-sequential','equation-aligned-paired'].includes(scenario)){
  const aligned=scenario.includes('-aligned-'),paired=scenario.endsWith('-paired')
  const open='\\begin{equation}\n'+(aligned?'\\begin{aligned}\n':''),close=(aligned?'\n\\end{aligned}':'')+'\n\\end{equation}'
  const body=aligned?'a &= '+math+' \\\\\nb &= x \\cdot x':math
  steps.push({at:0,insert:open+(paired?close:'')+'\n\n',delayBeforeMs:0,label:paired?'paired environment shell':'open environment'})
  steps.push({at:open.length,insert:body,delayBeforeMs:450,label:'fill environment body',mathReady:paired})
  if(!paired)steps.push({at:open.length+body.length,insert:close,delayBeforeMs:450,label:'close environment',mathReady:true})
 }else throw Error('Unknown synthetic math scenario')
 let finalBlock='';for(const step of steps)finalBlock=finalBlock.slice(0,step.at)+step.insert+finalBlock.slice(step.at)
 return{scenario,steps,finalBlock,intervalMs:scenario==='character'?60:450,typedCharacters:steps.slice(1).reduce((n,step)=>n+step.insert.length,0)}
}
