import type {MathStep} from './math-construction'
export function textSequencePlan(mode:string,cadence:number){
 if(mode!=='blank-line'||![100,450,1000].includes(cadence))throw Error('Use blank-line cadence')
 const steps:MathStep[]=[];let finalBlock=''
 for(let i=0;i<5;i++){
  const at=finalBlock.length
  steps.push({at,insert:'\n\n',delayBeforeMs:i?cadence:0,label:'blank-line '+(i+1)})
  finalBlock+='\n\n'
  steps.push({at,insert:'你好',delayBeforeMs:80,label:'Chinese commit '+(i+1)})
  finalBlock=finalBlock.slice(0,at)+'你好'+finalBlock.slice(at)
 }
 return{scenario:`five-Chinese-blankline-${cadence}ms`,steps,finalBlock,intervalMs:cadence,typedCharacters:steps.reduce((n,s)=>n+s.insert.length,0)}
}
