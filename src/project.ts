import {promises as fs} from 'node:fs';
import path from 'node:path';
import {RevisionDocument} from './adapter';
export function projectPath(value:unknown):string {
 if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||path.posix.isAbsolute(value)||value.split('/').some(p=>p==='..'||p==='.'||p===''))throw Object.assign(Error('Invalid project-relative path'),{status:400});
 return value;
}
export async function loadDocuments(root:string,main:string,mapping:Record<string,string>={}) {
 const documents=new Map<string,RevisionDocument>();let total=0,count=0;
 async function visit(dir:string){for(const item of await fs.readdir(dir,{withFileTypes:true})){if(['build','.git','node_modules'].includes(item.name))continue;const absolute=path.join(dir,item.name);if(item.isSymbolicLink())throw Error('Project symlinks are not supported');if(item.isDirectory())await visit(absolute);else if(item.isFile()&&/\.tex$/i.test(item.name)){const stat=await fs.stat(absolute);if(stat.size>2000000||(total+=stat.size)>20000000||++count>2000)throw Error('Project text budget exceeded');documents.set(path.relative(root,absolute).split(path.sep).join('/'),new RevisionDocument(await fs.readFile(absolute,'utf8')));}}}
 await visit(root);if(!documents.has(main))throw Error('Main document is not an imported .tex file');
 for(const [id,p]of Object.entries(mapping)){if(!id||!documents.has(projectPath(p)))throw Error('Document mapping references unknown source');}
 return documents;
}

export async function importedResources(root:string,projectId:string,main:string) {
 const raw=await fs.readFile(path.join(root,'.rtex-import.json'),'utf8').catch(()=>null);if(!raw)return {verified:false,resources:[]};
 const manifest=JSON.parse(raw);if(manifest.projectId!==projectId||manifest.main!==main||!Array.isArray(manifest.entries)||manifest.entries.length>10000)throw Error('Import resource manifest identity mismatch');
 const seen=new Set<string>();const resources=[];for(const entry of manifest.entries){const name=projectPath(entry.path);if(seen.has(name)||!Number.isInteger(entry.bytes)||entry.bytes<0||entry.bytes>67108864||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid import resource manifest');seen.add(name);if(!/\.tex$/i.test(name))resources.push({path:name,bytes:entry.bytes,sha256:entry.sha256});}
 return {verified:true,resources};
}
