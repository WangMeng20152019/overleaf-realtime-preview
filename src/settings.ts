import {constants,promises as fs} from 'node:fs';
const unavailable=(reason:string)=>Object.assign(Error('Verified project settings unavailable: '+reason),{status:503});
/** Read one fixed, private provider file. The bridge never connects to MongoDB. */
export async function readProjectSettings(file:string|undefined,projectId:string,now=Date.now()) {
 if(!file)throw unavailable('provider not configured');
 let raw:string;
 try{
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const metadata=await handle.stat();
   if(!metadata.isFile()||metadata.size>4096||(metadata.mode&0o077))throw unavailable('provider file is not private or bounded');
   const data=await handle.readFile();if(data.length>4096)throw unavailable('provider file exceeds size budget');
   raw=new TextDecoder('utf-8',{fatal:true}).decode(data);
  }finally{await handle.close();}
 }catch(error:any){if(error.status===503)throw error;throw unavailable('provider file cannot be read');}
 let value:any;try{value=JSON.parse(raw);}catch{throw unavailable('invalid provider JSON');}
 if(!value||Array.isArray(value)||typeof value!=='object'||value.projectId!==projectId)throw unavailable('project identity mismatch');
 if(typeof value.rootDocId!=='string'||!/^[a-f0-9]{24}$/i.test(value.rootDocId)||!['pdflatex','xelatex','lualatex','latex'].includes(value.compiler))throw unavailable('invalid main document or compiler');
 if(!Number.isSafeInteger(value.observedAt)||value.observedAt<0||now-value.observedAt>10000||value.observedAt-now>1000)throw unavailable('provider observation is stale or in the future');
 return {projectId,rootDocId:value.rootDocId,compiler:value.compiler,observedAt:value.observedAt};
}
