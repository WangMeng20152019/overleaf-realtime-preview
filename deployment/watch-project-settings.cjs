#!/usr/bin/env node
'use strict';
// Read one configured project only. Never expose Mongo credentials or source data.
const fs=require('node:fs/promises'),path=require('node:path');
const {createRequire}=require('node:module');
async function main(){
 const projectId=process.env.RTEX_PROJECT_ID,output=process.env.RTEX_SETTINGS_FILE;
 if(!/^[0-9a-f]{24}$/.test(projectId??'')||!output||!path.isAbsolute(output))throw Error('Explicit project ID and absolute private settings path required');
 const directory=path.dirname(output),parent=await fs.lstat(directory);
 if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077))throw Error('Settings directory must be private and regular');
 try{if((await fs.lstat(output)).isSymbolicLink())throw Error('Settings symlink refused');}catch(e){if(e.code!=='ENOENT')throw e;}
 const web=process.env.OVERLEAF_WEB_DIR??'/overleaf/services/web';
 process.chdir(web);process.env.NODE_ENV='production';
 const requireWeb=createRequire(path.join(web,'package.json'));
 const settings=requireWeb('@overleaf/settings'),{MongoClient,ObjectId}=requireWeb('mongodb');
 const client=new MongoClient(settings.mongo.url,{serverSelectionTimeoutMS:5000,socketTimeoutMS:5000,maxPoolSize:1,readPreference:'primary'});
 let stopped=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopped=true;});
 const temporary=output+'.'+process.pid+'.tmp';
 try{
  await client.connect();
  do{
   try{
    const p=await client.db().collection('projects').findOne({_id:new ObjectId(projectId)},{projection:{rootDoc_id:1,compiler:1},maxTimeMS:2000});
    const rootDocId=String(p?.rootDoc_id??'');
    if(String(p?._id)!==projectId||!/^[0-9a-f]{24}$/.test(rootDocId)||!['pdflatex','latex','xelatex','lualatex'].includes(p?.compiler))throw Error('Project settings unavailable');
    await fs.writeFile(temporary,JSON.stringify({projectId,rootDocId,compiler:p.compiler,observedAt:Date.now()}),{mode:0o600,flag:'w'});
    await fs.chmod(temporary,0o600);await fs.rename(temporary,output);
    if(process.argv.includes('--once')){console.log('Private project settings snapshot updated');break;}
   }catch(error){await fs.unlink(output).catch(()=>{});console.error('Project settings observation failed: '+error.name);if(process.argv.includes('--once'))throw Error('Settings observation failed');}
   if(!stopped)await new Promise(resolve=>setTimeout(resolve,1000));
  }while(!stopped);
 }finally{await client.close();await fs.unlink(temporary).catch(()=>{});if(!process.argv.includes('--once'))await fs.unlink(output).catch(()=>{});}
}
main().catch(error=>{console.error('Settings watcher stopped: '+error.name);process.exitCode=1;});
