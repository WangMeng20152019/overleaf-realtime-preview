#!/usr/bin/env python3
"""Plan or execute an isolated Overleaf frontend build; never run npm in production."""
import argparse,hashlib,json,os,pathlib,re,shutil,subprocess,sys,time,shlex
EXCLUDED={'node_modules','.git','.cache'}
SEMVER=re.compile(r'^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')

def plan_dependencies(source):
 source=pathlib.Path(source).resolve();root=json.loads((source/'package.json').read_text());web=json.loads((source/'services/web/package.json').read_text());lock_path=source/'package-lock.json'
 if not lock_path.is_file():
  lock_path=source/'yarn.lock'
  if not lock_path.is_file() or '__metadata:' not in lock_path.read_text():raise ValueError('Installed npm lock or Yarn Berry lock required')
  manager=root.get('packageManager','');match=re.fullmatch(r'yarn@(\d+\.\d+\.\d+)(?:\+[^ ]+)?',manager)
  workspace=web.get('name','')
  if not match or not re.fullmatch(r'(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+',workspace):raise ValueError('Pinned Yarn packageManager and verified web workspace name required')
  declared={relative:metadata.get('devDependencies',{}) for relative,metadata in [('package.json',root),('services/web/package.json',web)]}
  if not all(isinstance(value,dict) for value in declared.values()):raise ValueError('Invalid development dependency declarations')
  combined={**declared['package.json'],**declared['services/web/package.json']}
  return {'source':str(source),'lockFile':'yarn.lock','lockKind':'yarn-berry-native','packageLockSHA256':hashlib.sha256(lock_path.read_bytes()).hexdigest(),'packageManager':manager,'yarnVersion':match.group(1),'webWorkspace':workspace,'dependencies':combined,'declaredDevDependencies':declared,'skippedInternal':[],'repositoryPatches':[],'patchDescriptors':sorted({spec for value in [*declared.values(),root.get('resolutions',{})] for spec in value.values() if isinstance(spec,str) and spec.startswith('patch:')}),'note':'Native pinned Yarn performs immutable resolution in the isolated full source copy, honoring original Git forks, repository patches, workspaces and all transitive lock entries. No manual npm replacement or production dependency links are used.'}
 lock_bytes=lock_path.read_bytes();lock=json.loads(lock_bytes);packages=lock.get('packages',{});selected={};origins={};internal=[]
 for relative,metadata in [('package.json',root),('services/web/package.json',web)]:
  for name,spec in sorted(metadata.get('devDependencies',{}).items()):
   if not re.fullmatch(r'(?:@[a-zA-Z0-9_.-]+/)?[a-zA-Z0-9_.-]+',name):raise ValueError('Invalid package name')
   lookup=(['services/web/node_modules/'+name,'node_modules/'+name] if relative.startswith('services/') else ['node_modules/'+name])
   info=next((packages[key] for key in lookup if key in packages),None) or lock.get('dependencies',{}).get(name)
   if info and info.get('link') or isinstance(spec,str) and spec.startswith(('workspace:','file:','link:')):
    internal.append({'name':name,'declaredBy':relative,'reason':'Internal workspace/file package remains an existing fallback'});continue
   version=info.get('version') if isinstance(info,dict) else None
   if not isinstance(version,str) or not SEMVER.fullmatch(version):raise ValueError('No exact locked registry version for '+name)
   if name in selected and selected[name]!=version:raise ValueError('Conflicting exact root/web devDependency versions for '+name)
   selected[name]=version;origins.setdefault(name,[]).append(relative)
 if 'webpack' not in selected or 'webpack-cli' not in selected:raise ValueError('Installed declarations do not identify webpack and webpack-cli')
 return {'source':str(source),'lockFile':'package-lock.json','lockKind':'npm','packageLockSHA256':hashlib.sha256(lock_bytes).hexdigest(),'dependencies':selected,'declaredBy':origins,'skippedInternal':internal,'repositoryPatches':[],'note':'Direct npm build dependency versions are pinned; the isolated npm install creates its own transitive lock.'}

def prepare(source,trial):
 source=pathlib.Path(source).resolve();trial=pathlib.Path(trial).absolute();plan=plan_dependencies(source)
 if trial.exists() or trial.is_symlink():raise ValueError('Trial prefix must be new')
 if source==trial or source in trial.parents or trial.resolve() in source.parents:raise ValueError('Trial prefix must be outside production source')
 trial.mkdir(parents=True,mode=0o700);trial.chmod(0o700)
 try:
  # Keep public static inputs (SCSS imports images/fonts there); webpack output is a separate trial directory.
  shutil.copytree(source,trial/'source',symlinks=False,ignore=lambda directory,names:[n for n in names if n in EXCLUDED or pathlib.Path(directory).name=='.yarn' and n=='cache'])
  tools=trial/'build-tools';tools.mkdir(mode=0o700)
  package={'name':'overleaf-rtex-isolated-frontend-tools','private':True,'version':'0.0.0','dependencies':plan['dependencies']} if plan['lockKind']=='npm' else {'private':True,'description':'Native Yarn installs only in the separate source copy, not this directory.'}
  (tools/'package.json').write_text(json.dumps(package,indent=2)+'\n')
  (trial/'dependency-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
  staged_web=trial/'source/services/web';wrapper='const base=require('+json.dumps(str(staged_web/'webpack.config.prod.js'))+');\nmodule.exports={...base,context:'+json.dumps(str(staged_web))+',output:{...base.output,path:'+json.dumps(str(trial/'frontend-public'))+',publicPath:"/rtex-app-assets/",workerPublicPath:"/rtex-app-assets/"}};\n'
  wrapper=wrapper.replace('module.exports={...base,context:', '''for(const plugin of base.optimization?.minimizer??[])if(plugin?.options&&"parallel" in plugin.options)plugin.options.parallel=1;
function capRules(rules){for(const rule of rules??[]){for(const loader of Array.isArray(rule.use)?rule.use:rule.use?[rule.use]:[])if(loader&&typeof loader==="object"&&String(loader.loader).includes("thread-loader"))loader.options={...loader.options,workers:1,workerParallelJobs:1,poolParallelJobs:1};capRules(rule.oneOf);capRules(rule.rules);}}
capRules(base.module?.rules);
module.exports={...base,parallelism:2,context:''')
  (trial/'webpack.rtex.cjs').write_text(wrapper)
  return plan
 except BaseException:
  shutil.rmtree(trial,ignore_errors=True);raise

def load_prepared(source,trial):
 source=pathlib.Path(source).resolve();trial=pathlib.Path(trial).resolve(strict=True);plan=json.loads((trial/'dependency-plan.json').read_text())
 if plan.get('source')!=str(source) or plan.get('packageLockSHA256')!=hashlib.sha256((source/plan.get('lockFile','package-lock.json')).read_bytes()).hexdigest():raise ValueError('Prepared stage no longer matches the verified production source/lock')
 return plan

def overlay(target,roots):
 target.mkdir(parents=True,exist_ok=True)
 for source,allowed in roots:
  source=pathlib.Path(source)
  if not source.is_dir():continue
  for item in source.iterdir():
   if item.name.startswith('.') and item.name!='.bin':continue
   dest=target/item.name
   if item.name.startswith('@') or item.name=='.bin':
    if dest.is_symlink():dest.unlink()
    dest.mkdir(exist_ok=True)
    for package in item.iterdir():
     fullname=item.name+'/'+package.name
     if allowed is not None and fullname not in allowed:continue
     link=dest/package.name
     if link.is_symlink():link.unlink()
     elif link.exists():raise ValueError('Refusing to replace a real overlay entry: '+str(link))
     link.symlink_to(package.resolve())
   else:
    if allowed is not None and item.name not in allowed:continue
    if dest.is_symlink():dest.unlink()
    elif dest.exists():raise ValueError('Refusing to replace a real overlay entry: '+str(dest))
    dest.symlink_to(item.resolve())

def resource_environment():
 return {**os.environ,'NODE_OPTIONS':(os.environ.get('NODE_OPTIONS','')+' --max-old-space-size=4096').strip(),'UV_THREADPOOL_SIZE':'2','RAYON_NUM_THREADS':'2'}

def limit_child_cpu():
 if hasattr(os,'sched_getaffinity') and hasattr(os,'sched_setaffinity'):os.sched_setaffinity(0,set(sorted(os.sched_getaffinity(0))[:2]))
 if hasattr(os,'nice'):os.nice(10)

def install(source,trial,npm,yarn='yarn',full_yarn=False):
 plan=load_prepared(source,trial);trial=pathlib.Path(trial).resolve();tools=trial/'build-tools';log=trial/'install.log'
 if plan['lockKind']=='yarn-berry-native':
  command=shlex.split(yarn)
  if not command:raise ValueError('Explicit Yarn command required')
  environment={**resource_environment(),'YARN_IGNORE_PATH':'1','YARN_ENABLE_GLOBAL_CACHE':'false','YARN_CACHE_FOLDER':str(trial/'yarn-cache'),'YARN_GLOBAL_FOLDER':str(trial/'yarn-global'),'COREPACK_HOME':str(trial/'corepack-cache'),'COREPACK_ENABLE_DOWNLOAD_PROMPT':'0','COREPACK_ENABLE_NETWORK':'1','YARN_ENABLE_SCRIPTS':'false','YARN_NODE_LINKER':'node-modules','YARN_ENABLE_IMMUTABLE_INSTALLS':'true','YARN_ENABLE_TELEMETRY':'0'}
  version=subprocess.run([*command,'--version'],cwd=trial/'source',env=environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,preexec_fn=limit_child_cpu)
  if version.returncode or version.stdout.strip()!=plan['yarnVersion']:raise ValueError('Pinned Yarn '+plan['yarnVersion']+' is required; version probe failed or mismatched')
  arguments=['install','--immutable'] if full_yarn else ['workspaces','focus',plan['webWorkspace']]
  with log.open('w') as output:result=subprocess.run([*command,*arguments],cwd=trial/'source',env=environment,stdout=output,stderr=subprocess.STDOUT,preexec_fn=limit_child_cpu)
  if result.returncode:raise ValueError('Isolated native immutable Yarn installation failed; inspect '+str(log))
  if hashlib.sha256((trial/'source/yarn.lock').read_bytes()).hexdigest()!=plan['packageLockSHA256']:raise ValueError('Yarn changed the supposedly immutable staged lock')
  return {'log':str(log),'mode':'native-yarn-immutable','workspace':None if full_yarn else plan['webWorkspace'],'productionWrites':False,'productionDependencyLinks':False}
 # No workspace packages, file dependencies, scripts, or production npm cwd/prefix are used.
 command=[npm,'install','--prefix',str(tools),'--workspaces=false','--ignore-scripts','--no-audit','--no-fund','--legacy-peer-deps']
 environment={**resource_environment(),'npm_config_cache':str(trial/'npm-cache'),'CYPRESS_INSTALL_BINARY':'0','PUPPETEER_SKIP_DOWNLOAD':'true','PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD':'1'}
 with log.open('w') as output:result=subprocess.run(command,cwd=tools,env=environment,stdout=output,stderr=subprocess.STDOUT,preexec_fn=limit_child_cpu)
 if result.returncode:raise ValueError('Isolated npm installation failed; inspect '+str(log))
 production=pathlib.Path(source).resolve();isolated=tools/'node_modules'
 allowed=set(plan['dependencies']);overlay(trial/'source/node_modules',[(production/'node_modules',None),(isolated,allowed)])
 overlay(trial/'source/services/web/node_modules',[(production/'services/web/node_modules',None),(isolated,allowed)])
 return {'log':str(log),'directDependencies':len(plan['dependencies']),'productionNpmWrites':False,'prescribedPatchesApplied':0}

def build(source,trial,node):
 plan=load_prepared(source,trial);trial=pathlib.Path(trial).resolve();candidates=[trial/'source/services/web/node_modules/webpack/bin/webpack.js',trial/'source/node_modules/webpack/bin/webpack.js'] if plan['lockKind']=='yarn-berry-native' else [trial/'build-tools/node_modules/webpack/bin/webpack.js'];cli=next((p for p in candidates if p.is_file()),candidates[0])
 if not cli.is_file():raise ValueError('Isolated webpack is missing; install the prepared build tools first')
 extension=trial/'source/services/web/frontend/js/features/source-editor/extensions/third-party-extensions.ts'
 if not extension.is_file() or 'rtexDocumentId' not in extension.read_text():raise ValueError('Apply the verified --frontend-only identity source patch to the staged source before compiling')
 log=trial/'build.log';start=time.monotonic()
 with log.open('w') as output:result=subprocess.run([node,str(cli),'--config',str(trial/'webpack.rtex.cjs'),'--stats','errors-warnings'],cwd=trial/'source/services/web',env={**resource_environment(),'NODE_ENV':'production'},stdout=output,stderr=subprocess.STDOUT,preexec_fn=limit_child_cpu)
 if result.returncode:raise ValueError('Isolated frontend compilation failed; inspect '+str(log))
 public=trial/'frontend-public';manifest=public/'manifest.json'
 if not manifest.is_file():raise ValueError('Compilation did not produce the staged asset manifest')
 data=json.loads(manifest.read_text());paths=[]
 def visit(value):
  if isinstance(value,str) and value.startswith('/rtex-app-assets/'):
   relative=value[len('/rtex-app-assets/'):].split('?',1)[0]
   if '..' in pathlib.PurePosixPath(relative).parts or not (public/relative).is_file():raise ValueError('Manifest references missing/unsafe staged asset: '+relative)
   paths.append(relative)
  elif isinstance(value,dict):
   for child in value.values():visit(child)
  elif isinstance(value,list):
   for child in value:visit(child)
 visit(data)
 if not paths:raise ValueError('No explicit trial-prefixed staged assets found in manifest')
 return {'wallSeconds':round(time.monotonic()-start,2),'manifest':str(manifest),'verifiedAssetReferences':len(paths),'log':str(log),'activated':False,'cpuAffinityLimit':2,'nodeHeapLimitMB':4096,'webpackParallelism':2,'loaderWorkers':1,'minimizerWorkers':1}

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source',required=True,type=pathlib.Path);parser.add_argument('--trial',required=True,type=pathlib.Path);parser.add_argument('--prepare',action='store_true');parser.add_argument('--install',action='store_true');parser.add_argument('--build',action='store_true');parser.add_argument('--npm',default='npm');parser.add_argument('--node',default='node');parser.add_argument('--patch-script',type=pathlib.Path,help='Apply this already-reviewed source patch with --frontend-only to the new source copy');parser.add_argument('--summary',action='store_true');parser.add_argument('--yarn',default='yarn',help='Pinned Yarn command, e.g. yarn or corepack yarn');parser.add_argument('--full-yarn',action='store_true',help='Install all workspaces immutably instead of focusing the verified web workspace');args=parser.parse_args()
 try:
  if not(args.prepare or args.install or args.build):
   plan=plan_dependencies(args.source);print(json.dumps({'source':plan['source'],'packageLockSHA256':plan['packageLockSHA256'],'lockFile':plan['lockFile'],'lockKind':plan['lockKind'],'packageManager':plan.get('packageManager'),'webWorkspace':plan.get('webWorkspace'),'patchDescriptors':plan.get('patchDescriptors',[]),'repositoryPatches':plan['repositoryPatches'],'directDependencies':len(plan['dependencies']),'skippedInternal':plan['skippedInternal']} if args.summary else plan,indent=2));return
  if args.prepare:plan=prepare(args.source,args.trial);print(json.dumps({'prepared':str(args.trial),'directDependencies':len(plan['dependencies']),'internalPackagesSkipped':len(plan['skippedInternal'])}),flush=True)
  if args.patch_script:
   if not args.prepare:raise ValueError('--patch-script requires a newly prepared source copy')
   subprocess.run([sys.executable,str(args.patch_script.resolve()),str(args.trial/'source'),'--frontend-only','--check'],check=True)
   subprocess.run([sys.executable,str(args.patch_script.resolve()),str(args.trial/'source'),'--frontend-only'],check=True)
  if args.install:print(json.dumps({'installed':install(args.source,args.trial,args.npm,args.yarn,args.full_yarn)}),flush=True)
  if args.build:print(json.dumps({'compiled':build(args.source,args.trial,args.node)}),flush=True)
 except (OSError,ValueError,subprocess.SubprocessError) as error:parser.exit(1,str(error)+'\n')
if __name__=='__main__':main()
