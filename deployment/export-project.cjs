#!/usr/bin/env node
'use strict';
// Administrator-side metadata export for exactly one explicitly selected project.
const fs=require('node:fs/promises'),path=require('node:path'),{createRequire}=require('node:module');
async function main(){
 const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
 if(args.length!==6||!args.includes('--project-id')||!args.includes('--web-root')||!args.includes('--output'))throw Error('Usage: --project-id ID --web-root /overleaf/services/web --output NEW_PRIVATE_FILE');
 const id=value('--project-id'),web=path.resolve(value('--web-root')),output=path.resolve(value('--output'));
 if(!/^[a-f0-9]{24}$/.test(id))throw Error('Explicit project ID required');
 const parent=await fs.lstat(path.dirname(output));if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)||parent.uid!==process.getuid()||await fs.realpath(path.dirname(output))!==path.dirname(output))throw Error('Output parent must be private0700');
 process.chdir(web);process.env.NODE_ENV='production';const rw=createRequire(path.join(web,'package.json')),settings=rw('@overleaf/settings'),{MongoClient,ObjectId}=rw('mongodb'),client=new MongoClient(settings.mongo.url,{serverSelectionTimeoutMS:5000,maxPoolSize:1});
 try{await client.connect();const project=await client.db().collection('projects').findOne({_id:new ObjectId(id)},{projection:{rootFolder:1,rootDoc_id:1,compiler:1}});if(!project||!project.rootFolder||!project.rootDoc_id)throw Error('Project metadata missing');let entries=0;const ident=v=>{const id=String(v);if(!/^[a-f0-9]{24}$/.test(id))throw Error('Invalid entity identity');return id;};const named=v=>{if(typeof v.name!=='string'||!v.name||v.name==='.'||v.name==='..'||/[\\/\x00]/.test(v.name))throw Error('Invalid entity name');if(++entries>10000)throw Error('Entity budget');return{_id:ident(v._id),name:v.name};};const folder=(v,root=false)=>{const o=root?{_id:ident(v._id)}:named(v);for(const k of ['docs','fileRefs','folders']){if(!Array.isArray(v[k]??[]))throw Error('Invalid entity list');o[k]=(v[k]??[]).map(x=>k==='folders'?folder(x):named(x));}return o;};if(!Array.isArray(project.rootFolder)||project.rootFolder.length!==1)throw Error('Invalid root folder');const json=JSON.stringify({project:{_id:ident(project._id),rootDoc_id:ident(project.rootDoc_id),rootFolder:project.rootFolder.map(v=>folder(v,true))}},null,2)+'\n';if(Buffer.byteLength(json)>2000000)throw Error('Metadata budget exceeded');const file=await fs.open(output,'wx',0o600);try{await file.writeFile(json);}finally{await file.close();}console.log(JSON.stringify({exported:true,projectId:id,sourceTextIncluded:false}));}finally{await client.close();}
}
main().catch(e=>{console.error('Metadata export failed: '+e.name);process.exitCode=1;});
