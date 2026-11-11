import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {copyFile,readFile} from 'node:fs/promises';
import path from 'node:path';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
const local=createRequire(import.meta.url);
const dependencyRequire=local;
const esbuild=dependencyRequire('esbuild');
const wsLicense=await readFile(path.join(path.dirname(local.resolve('ws/package.json')),'LICENSE'),'utf8');
const nodePaths=[path.dirname(path.dirname(dependencyRequire.resolve('opentype.js/package.json'))),path.dirname(path.dirname(dependencyRequire.resolve('pdfjs-dist/package.json')))];
await esbuild.build({entryPoints:['src/server.ts'],outfile:'dist/server.mjs',platform:'node',format:'esm',bundle:true,external:['bufferutil','utf-8-validate'],banner:{js:"import {createRequire as __nodeRequire} from 'node:module';const require=__nodeRequire(import.meta.url);\n/* ws dependency license:\n"+wsLicense+"\n*/"}});
await esbuild.build({entryPoints:['src/browser.ts'],outfile:'public/app.js',platform:'browser',format:'iife',bundle:true,nodePaths});
await copyFile(dependencyRequire.resolve('pdfjs-dist/build/pdf.worker.mjs'),'public/pdf.worker.mjs');
await esbuild.build({entryPoints:['src/adapter.ts'],outfile:'dist/adapter.mjs',platform:'node',format:'esm',bundle:true});

await esbuild.build({entryPoints:['integration/launcher.js'],outfile:'public/integration.js',platform:'browser',format:'esm',bundle:true});
