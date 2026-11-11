#!/usr/bin/env python3
"""Prepare/activate/stop a single-project integration inside the supported CE container."""
import argparse,hashlib,importlib.util,json,os,re,secrets,shutil,subprocess,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.dont_write_bytecode=True
class Refusal(Exception):pass
def require(v,m):
 if not v:raise Refusal(m)
def mod(name,file):
 s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def run(argv):return subprocess.run([str(x)for x in argv],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
def private(p,data):
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:os.fchmod(f.fileno(),0o600);f.write(data);f.flush();os.fsync(f.fileno())
def clean_path(p):
 p=p.absolute();require(re.fullmatch(r'/[A-Za-z0-9_./-]+',str(p)) and '..'not in p.parts,'Unsafe container path');require(p.parent.resolve(strict=True)==p.parent,'Path parent is not canonical');return p
def overlap(a,b):return a==b or a in b.parents or b in a.parents
def input_directory(p):
 p=clean_path(p);require(p.resolve(strict=True)==p and p.is_dir()and not p.is_symlink(),'Canonical input directory required');return p
def layout(a):
 state=clean_path(a.state);runtime=input_directory(a.runtime);source=input_directory(a.source);frontend=input_directory(a.frontend);assets=clean_path(a.assets)
 require(not any(overlap(state,p)for p in (runtime,source,frontend,assets)),'Private state overlaps input or public assets')
 require(not any(overlap(runtime,p)for p in (source,frontend,assets)),'Runtime overlaps source or frontend')
 require(not overlap(source,frontend),'Frontend output must be isolated from canonical source')
 require(assets.parent==source/'services/web/public'and assets.name=='rtex-app-assets','Dedicated assets must belong to supported web public directory')
 return state,runtime,source,frontend,assets

def copy_frontend(frontend,assets,verified):
 # Publish only the verified manifest inventory, never arbitrary build-directory files.
 require(not any(p.is_symlink()for p in frontend.rglob('*')),'Frontend symlink refused')
 expected={n:e['sha256']for n,e in verified['files'].items()};expected['manifest.json']=verified['manifestAfterSHA256']
 for name in expected:require(name and not Path(name).is_absolute()and all(x not in ('','.','..')for x in name.split('/')),'Unsafe scoped frontend path')
 assets.mkdir(mode=0o755)
 for name,pin in expected.items():
  source=frontend/name;require(source.resolve(strict=True)==source and source.is_file()and source.stat().st_nlink==1,'Unsafe frontend file')
  data=source.read_bytes();require(hashlib.sha256(data).hexdigest()==pin,'Frontend changed since verification')
  destination=assets/name;destination.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
  for parent in [destination.parent,*destination.parent.parents]:
   if parent==assets.parent:break
   parent.chmod(0o755)
  private(destination,data);destination.chmod(0o644)
 assets.chmod(0o755)

RUNIT_ENTRY=Path('/etc/service')
RUNIT_FINAL=Path('/etc/runit/runsvdir/default')
RUNIT_LINKS={'/etc/service':'/etc/runit/runsvdir/current','/etc/runit/runsvdir/current':'/etc/runit/runsvdir/default'}
def runit_layout(entry=None,links=None,final=None,owner=0):
 # Only the stock CE link chain is accepted; recorded inode identities detect relinking.
 entry=RUNIT_ENTRY if entry is None else entry;links=RUNIT_LINKS if links is None else links;final=RUNIT_FINAL if final is None else final
 current=entry;records=[];seen=set()
 while True:
  require(str(current)not in seen,'Cyclic runit link chain');seen.add(str(current))
  parent=current.parent;require(parent.resolve(strict=True)==parent and parent.is_dir()and parent.stat().st_uid==owner and not parent.stat().st_mode&0o022,'Unsafe runit parent')
  info=current.lstat();require(info.st_uid==owner,'runit path must be owned by root')
  if current.is_symlink():
   expected=links.get(str(current));require(expected is not None,'Unexpected runit symlink')
   text=os.readlink(current);require(text in (expected,os.path.relpath(expected,current.parent)),'runit link target differs from supported chain')
   records.append({'path':str(current),'text':text,'uid':info.st_uid,'gid':info.st_gid,'mode':info.st_mode&0o777,'inode':info.st_ino,'device':info.st_dev})
   current=Path(expected);continue
  require(current==final and current.is_dir()and current.resolve(strict=True)==current and not info.st_mode&0o022,'Unexpected canonical runit service root')
  require(len(records)==len(links),'Incomplete standard runit link chain')
  return {'entry':str(entry),'canonical':str(current),'links':records,'uid':info.st_uid,'gid':info.st_gid,'mode':info.st_mode&0o777,'inode':info.st_ino,'device':info.st_dev}

def prepare(a):
 state,runtime,source,frontend,assets=layout(a)
 require(not state.exists()and not state.is_symlink(),'State must be new');require(not assets.exists()and not assets.is_symlink(),'Scoped assets directory must be new')
 require(assets.name=='rtex-app-assets','Dedicated rtex-app-assets directory required')
 require(re.fullmatch('[a-f0-9]{24}',a.project_id),'Explicit project ID required')
 u=__import__('urllib.parse',fromlist=['urlsplit']).urlsplit(a.origin);require(u.hostname and not u.username and not u.password and not u.query and not u.fragment and u.path=='' and (u.scheme=='https'or u.scheme=='http'and u.hostname in ('localhost','127.0.0.1','::1')),'Expected HTTPS origin or loopback HTTP origin')
 for port in [a.bridge_port,a.web_port,a.document_updater_port,a.nginx_port]:require(1024<=port<=65535 or port==80,'Invalid port')
 require(len({a.bridge_port,a.web_port,a.document_updater_port,a.nginx_port})==4,'Service ports must differ')
 require(shutil.which('sv'),'Supported runit-based CE container required')
 runit=runit_layout();service_dir=Path(runit['canonical'])/'overleaf-realtime'
 require(not service_dir.exists()and not service_dir.is_symlink(),'An integration service already exists')
 native=mod('install_native',HERE.parent/'integration/source-patch/patch-native-bridge.py');native.preflight(source)
 verifier=mod('install_assets',HERE/'verify-staged-assets.py');verified_frontend=verifier.verify(a.manifest_before,a.frontend/'manifest.json',a.frontend)
 require(a.manifest_before.resolve()==source/'services/web/public/manifest.json','Original manifest must belong to verified source')
 require(assets.parent==source/'services/web/public','Scoped assets must be inside supported web public directory')
 require(runtime.resolve()==runtime and runtime.is_dir(),'Immutable runtime directory required')
 service_checker=mod('prepare_service_validation',HERE/'service.py');service_checker.validate_runtime(runtime)
 state.mkdir(mode=0o700);state.chmod(0o700);(state/'control').mkdir(mode=0o700)
 # No existing source, config or assets are overwritten by preparation.
 for name in ['service.py','proxy-transaction.py']:shutil.copy2(HERE/name,state/'control'/name)
 importer=mod('install_import',HERE/'import-project.py');importer.import_project(a.project_zip,state/'project',a.main,a.project_id)
 binder=mod('install_binding',HERE/'prepare-binding.py');docs,config=binder.prepare(json.loads(a.tree.read_text()),state/'project',a.project_id,a.main)
 (state/'binding').mkdir(mode=0o700)
 for name,data in [('document-map.json',docs),('project-config.json',config)]:private(state/'binding'/name,(json.dumps(data,indent=2)+'\n').encode())
 private(state/'token',(secrets.token_hex(32)+'\n').encode())
 copy_frontend(frontend,assets,verified_frontend)
 # Attach launcher before rendering final manifest replacements.
 attach=mod('install_attach',HERE/'attach-trusted-launcher.py');manifest=assets/'manifest.json';mapping=json.loads(manifest.read_text());entry=assets/mapping['pages/ide.js'][len('/rtex-app-assets/'):]
 result=attach.prepare(assets,manifest,hashlib.sha256(manifest.read_bytes()).hexdigest(),hashlib.sha256(entry.read_bytes()).hexdigest())
 private(result['newFile'],result['updated']);result['newFile'].chmod(0o644);result['manifest'].write_bytes(result['after']);result['manifest'].chmod(0o644)
 verifier.verify(a.manifest_before,manifest,assets)
 cfg={'schema':1,'projectId':a.project_id,'publicOrigin':a.origin,'bridgePort':a.bridge_port,'documentUpdaterPort':a.document_updater_port,'nginxPort':a.nginx_port,'runtime':str(runtime),'state':str(state),'main':a.main,'webRoot':str(source/'services/web'),'node':str(Path(shutil.which('node')).resolve(strict=True)),'texLiveBin':a.texlive_bin,'fontRoots':a.font_roots,'assets':str(assets),'serviceDirectory':str(service_dir),'runitLayout':runit,'python':str(Path(sys.executable).resolve(strict=True)),'controlSHA256':{n:hashlib.sha256((state/'control'/n).read_bytes()).hexdigest()for n in ('service.py','proxy-transaction.py')}}
 private(state/'service.json',(json.dumps(cfg,indent=2)+'\n').encode())
 fragment=state/'nginx-locations.conf'
 run([sys.executable,'-B',HERE/'render-nginx.py','--project-id',a.project_id,'--token-file',state/'token','--bundle',runtime,'--port',a.bridge_port,'--web-port',a.web_port,'--manifest-before',a.manifest_before,'--manifest-after',manifest,'--assets-dir',assets,'--enable-websocket','--output',fragment])
 run([sys.executable,'-B',state/'control/proxy-transaction.py','prepare','--state',state/'proxy','--fragment',fragment])
 service=mod('install_service',state/'control/service.py');cfg=service.read_config(state/'service.json');expected=service.stable(cfg)
 require(all((state/'project'/name).read_bytes()==raw for name,raw in expected.items()),'ZIP is behind canonical source; re-export before activation')
 # A down-marked runit service cannot start until explicit activation.
 require(runit_layout()==cfg['runitLayout'],'runit chain changed during preparation')
 directory=Path(cfg['serviceDirectory']);directory.mkdir(mode=0o755)
 private(directory/'down',b'')
 script='#!/bin/sh\nexec '+cfg['python']+' -B '+str(state/'control/service.py')+' run --config '+str(state/'service.json')+'\n'
 private(directory/'run',script.encode());(directory/'run').chmod(0o755)
 print(json.dumps({'prepared':True,'activated':False,'state':str(state),'projectId':a.project_id}))
def routing_original(proxy,state):
 # A running bridge must remain available whenever the live route is uncertain.
 reply=run(proxy+['status','--state',state/'proxy'])
 try:status=json.loads(reply.stdout)
 except (ValueError,UnicodeError):raise Refusal('Proxy status is unreadable; service retained')
 if status.get('status')=='active':
  run(proxy+['rollback','--state',state/'proxy'])
  try:status=json.loads(run(proxy+['status','--state',state/'proxy']).stdout)
  except (ValueError,UnicodeError):raise Refusal('Proxy rollback is unverified; service retained')
 require(status.get('status')=='original','Proxy routing is uncertain; service retained')

def down_service(service,c,directory):
 down=directory/'down'
 if down.exists():service.regular(down)
 else:private(down,b'')
 run(['sv','-w','45','down',directory]);service.stop(c)

def control(a):
 a.state=clean_path(a.state);require(a.state.is_dir()and not a.state.is_symlink()and a.state.stat().st_mode&0o777==0o700 and a.state.stat().st_uid==os.geteuid(),'Owned private installation state required')
 config_file=a.state/'service.json';require(not config_file.is_symlink()and config_file.is_file()and config_file.stat().st_mode&0o777==0o600,'Owned private configuration required')
 raw=json.loads(config_file.read_text());require(set(raw.get('controlSHA256',{}))=={'service.py','proxy-transaction.py'},'Control source pins absent')
 for n,h in raw['controlSHA256'].items():
  file=a.state/'control'/n;require(file.resolve(strict=True)==file and file.is_file()and not file.is_symlink()and hashlib.sha256(file.read_bytes()).hexdigest()==h,'Control source identity changed')
 service=mod('integration_service',a.state/'control/service.py');c=service.read_config(a.state/'service.json');directory=Path(c['serviceDirectory'])
 require(c.get('runitLayout')==runit_layout(),'Recorded standard runit link chain differs')
 require(directory==Path(c['runitLayout']['canonical'])/'overleaf-realtime'and directory.resolve(strict=True)==directory and directory.is_dir()and not directory.is_symlink()and directory.stat().st_uid==os.geteuid()and not directory.stat().st_mode&0o022,'Service directory differs')
 expected_run='#!/bin/sh\nexec '+c['python']+' -B '+str(a.state/'control/service.py')+' run --config '+str(a.state/'service.json')+'\n'
 require(service.regular(directory/'run').read_text()==expected_run,'runit service entry differs')
 proxy=[sys.executable,'-B',a.state/'control/proxy-transaction.py']
 if a.action=='status':service.health(c);r=run(proxy+['status','--state',a.state/'proxy']);print(r.stdout.decode());return
 if a.action=='activate':
  # Repeating activation must not roll back an already active healthy deployment.
  try:initial_proxy=json.loads(run(proxy+['status','--state',a.state/'proxy']).stdout)
  except (ValueError,UnicodeError):raise Refusal('Initial proxy state unreadable; activation refused')
  require(initial_proxy.get('status')in ('original','active'),'Initial proxy routing is uncertain')
  if initial_proxy['status']=='active':
   service.health(c);print(json.dumps({'activated':True,'alreadyActive':True,'projectId':c['projectId']}));return
  # Ensure runsv has observed the new down-marked service before requesting up.
  for _ in range(60):
   if (directory/'supervise/ok').exists():break
   time.sleep(.25)
  require((directory/'supervise/ok').exists(),'runit did not discover the service')
  if (directory/'down').exists()or(directory/'down').is_symlink():service.regular(directory/'down').unlink()
  try:
   run(['sv','up',directory])
   for _ in range(240):
    try:service.health(c);break
    except (OSError,ValueError,service.Refusal):time.sleep(.25)
   else:raise Refusal('Integration not ready; inspect private logs')
   run(proxy+['activate','--state',a.state/'proxy']);service.health(c)
  except BaseException:
   # If proxy activation succeeded, remove it before stopping the live service.
   routing_original(proxy,a.state)
   down_service(service,c,directory);raise
  print(json.dumps({'activated':True,'projectId':c['projectId']}));return
 # Rollback only routing and service; never restore project sources.
 routing_original(proxy,a.state);down_service(service,c,directory)
 print(json.dumps({'rolledBack':True,'sourceRestored':False,'privateBackupRetained':True}))
def main():
 p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='action',required=True);q=sub.add_parser('prepare')
 for name in ['state','runtime','source','frontend','manifest-before','assets','project-zip','tree']:q.add_argument('--'+name,required=True,type=Path)
 q.add_argument('--project-id',required=True);q.add_argument('--origin',required=True);q.add_argument('--main',default='main.tex');q.add_argument('--bridge-port',type=int,default=44175);q.add_argument('--web-port',type=int,default=4000);q.add_argument('--document-updater-port',type=int,default=3003);q.add_argument('--nginx-port',type=int,default=80);q.add_argument('--texlive-bin',default='/usr/local/bin');q.add_argument('--font-roots',default='/usr/local/share/fonts,/usr/share/fonts')
 for name in ['activate','rollback','status']:sub.add_parser(name).add_argument('--state',required=True,type=Path)
 a=p.parse_args();os.umask(0o077)
 if a.action=='prepare':prepare(a)
 else:control(a)
if __name__=='__main__':
 try:main()
 except Refusal as e:print('Refused: '+str(e),file=sys.stderr);raise SystemExit(1)
 except subprocess.CalledProcessError as e:print('Deployment command failed; inspect private state. Return code '+str(e.returncode),file=sys.stderr);raise SystemExit(1)
