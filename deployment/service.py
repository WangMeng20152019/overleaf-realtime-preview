#!/usr/bin/env python3
"""Linux-only lifecycle; start/run supervise in foreground, canonical sources stay read-only."""
import argparse,contextlib,ctypes,fcntl,hashlib,http.client,json,os,re,signal,stat,subprocess,sys,tempfile,time
from pathlib import Path
from urllib.parse import urlsplit,urlencode
class Refusal(Exception):pass
CANCELLED=False
SUBREAPER=False
CONTROLLER=None
RUN_ID=str(os.getpid())+'-'+str(time.time_ns())
def cancelled():require(not CANCELLED,'Service shutdown requested')
def require(v,m):
 if not v:
  error=Refusal(m);error.safe_message=True;raise error
def canonical(p):
 p=Path(p);require(p.is_absolute()and p.resolve()==p and '..'not in p.parts,'Canonical absolute path required');return p
def directory(p,private=False):
 p=canonical(p);s=p.lstat();require(stat.S_ISDIR(s.st_mode)and not p.is_symlink(),'Safe directory required')
 if private:require(stat.S_IMODE(s.st_mode)==0o700 and s.st_uid==os.geteuid(),'Owned mode0700 state required')
 return p
def regular(p,private=False):
 p=canonical(p);s=p.lstat();require(stat.S_ISREG(s.st_mode)and s.st_nlink==1 and not s.st_mode&0o022,'Safe non-writable regular file required')
 if private:require(stat.S_IMODE(s.st_mode)==0o600 and s.st_uid==os.geteuid(),'Owned mode0600 file required')
 return p
@contextlib.contextmanager
def lifecycle(c):
 state=directory(c['state'],True);lock=state/'lifecycle.lock'
 if lock.exists()or lock.is_symlink():regular(lock,True)
 fd=os.open(lock,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:os.fchmod(fd,0o600);fcntl.flock(fd,fcntl.LOCK_EX);yield
 finally:os.close(fd)
def subreaper():
 global SUBREAPER,CONTROLLER
 require(sys.platform=='linux','Linux process supervision required')
 require(ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0,'Owned child adoption unavailable')
 SUBREAPER=True;CONTROLLER=identity(os.getpid())
def atomic(p,data):
 p=Path(p);directory(p.parent)
 if p.exists()or p.is_symlink():regular(p)
 fd,name=tempfile.mkstemp(prefix='.rtex-',dir=p.parent)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.replace(name,p)
 finally:
  if os.path.exists(name):os.unlink(name)
def atomic_if_changed(p,data):
 p=Path(p)
 if p.exists()or p.is_symlink():
  if regular(p,True).read_bytes()==data:return False
 atomic(p,data);return True

def diagnostic(c,phase,error):
 # Preserve the first cause before cleanup can fail. Arbitrary exception payloads
 # may contain source text or credentials, so only our fixed guard messages pass.
 try:
  private=directory(c['state'],True);target=private/'service-failure.json'
  direct={'Owned process identity unavailable','Bridge readiness/source check timed out','Owned child did not stop; duplicate start refused'}
  raw=str(error);safe=isinstance(error,Refusal)and(getattr(error,'safe_message',False)or raw in direct)
  item={'phase':phase,'time':time.time(),'type':type(error).__name__,'message':raw if safe else 'Exception details redacted','messageRedacted':not safe}
  if isinstance(error,OSError)and isinstance(error.errno,int):item['errno']=error.errno;item['message']=os.strerror(error.errno)
  previous=json.loads(regular(target,True).read_text())if target.exists()else None
  if not isinstance(previous,dict)or previous.get('runId')!=RUN_ID:previous={'runId':RUN_ID,'controllerPID':os.getpid(),'primary':item,'secondary':[]}
  else:previous['secondary']=(previous.get('secondary',[])+[item])[-4:]
  atomic_if_changed(target,json.dumps(previous,sort_keys=True).encode())
 except (OSError,ValueError,Refusal):
  # Diagnostic failure must not replace the lifecycle error being handled.
  pass

def identity(pid):
 p=Path('/proc')/str(pid);tail=(p/'stat').read_text().rsplit(')',1)[1].split();argv=[os.fsdecode(x)for x in (p/'cmdline').read_bytes().split(b'\0')if x]
 require(pid>1 and tail[0]!='Z','Process exited');return {'pid':pid,'start':tail[19],'argv':argv}
def alive(i):
 try:return identity(i['pid'])==i
 except (FileNotFoundError,ProcessLookupError,Refusal):return False
def signal_owned(i):
 # A pidfd binds the signal to the opened process even if the numeric PID is reused.
 require(hasattr(os,'pidfd_open')and hasattr(signal,'pidfd_send_signal'),'Linux pidfd signalling required')
 try:fd=os.pidfd_open(i['pid'],0)
 except ProcessLookupError:return
 try:
  if alive(i):
   try:signal.pidfd_send_signal(fd,signal.SIGTERM,None,0)
   except ProcessLookupError:pass
 finally:os.close(fd)
def descendants(i):
 if not alive(i):return []
 result=[]
 try:tokens=(Path('/proc')/str(i['pid'])/'task'/str(i['pid'])/'children').read_text().split()
 except FileNotFoundError:return []
 for token in tokens:
  try:child=identity(int(token))
  except (FileNotFoundError,ProcessLookupError,Refusal):continue
  result.append(child);result.extend(descendants(child))
 return result
def validate_runtime(runtime):
 runtime=directory(runtime);manifest=json.loads(regular(runtime/'runtime-manifest.json').read_text())
 require(manifest.get('schema')==1 and isinstance(manifest.get('files'),dict)and 0<len(manifest['files'])<=10000,'Runtime manifest schema differs')
 expected=manifest['files'];required={'dist/server.mjs','deployment/watch-project-settings.cjs','deployment/runtime-linux/bin/rtex'}
 require(required.issubset(expected),'Runtime lacks required executable sources')
 actual=set();dirs={'.'};expected_dirs={'.'}
 for n,h in expected.items():
  require(isinstance(n,str)and n and not Path(n).is_absolute()and '\\'not in n and all(x not in ('','.','..')for x in n.split('/'))and n!='runtime-manifest.json','Unsafe runtime entry')
  require(isinstance(h,str)and re.fullmatch('[a-f0-9]{64}',h),'Invalid runtime content hash')
  expected_dirs.update(str(x)for x in Path(n).parents)
 for p in runtime.rglob('*'):
  require(not p.is_symlink(),'Runtime symlink refused')
  if p.is_dir():directory(p);dirs.add(str(p.relative_to(runtime)))
  else:regular(p);actual.add(str(p.relative_to(runtime)))
 require(actual==set(expected)|{'runtime-manifest.json'}and dirs==expected_dirs,'Runtime inventory differs, including extra entries')
 for n,h in expected.items():require(hashlib.sha256(regular(runtime/n).read_bytes()).hexdigest()==h,'Runtime content differs')
 require((runtime/'deployment/runtime-linux/bin/rtex').stat().st_mode&0o100,'Runtime engine is not executable')
 return manifest

def read_config(p):
 p=regular(p,True);c=json.loads(p.read_text());require(c.get('schema')==1,'Unsupported service schema')
 require(isinstance(c.get('projectId'),str)and re.fullmatch('[a-f0-9]{24}',c['projectId']),'Invalid project identity')
 state=directory(c['state'],True);runtime=directory(c['runtime']);require(state!=runtime and state not in runtime.parents and runtime not in state.parents,'Runtime/state paths overlap')
 validate_runtime(runtime)
 for name in ('bridgePort','documentUpdaterPort','nginxPort'):require(type(c.get(name))is int and 1<=c[name]<=65535,'Invalid service port')
 require(len({c[n]for n in ('bridgePort','documentUpdaterPort','nginxPort')})==3,'Service ports collide')
 origin=urlsplit(c['publicOrigin']);require(origin.hostname and not origin.username and not origin.password and not origin.query and not origin.fragment and origin.path==''and(origin.scheme=='https'or origin.scheme=='http'and origin.hostname in ('127.0.0.1','localhost','::1')),'Invalid public origin')
 node=regular(c['node']);require(node.stat().st_mode&0o111,'Node executable required')
 directory(c['webRoot']);require(state!=Path(c['webRoot'])and state not in Path(c['webRoot']).parents and Path(c['webRoot'])not in state.parents,'State/web source overlap')
 regular(state/'token',True);require(re.fullmatch('[a-fA-F0-9]{64,128}',(state/'token').read_text().strip()),'Private token format differs')
 c['configFile']=str(p);mapping(c)
 project=json.loads(regular(state/'binding/project-config.json',True).read_text());require(project.get('projectId')==c['projectId']and project.get('main')==c['main']and project.get('baseURL')=='/rtex-test/','Project binding identity differs')
 require(p==state/'service.json','Configuration must be inside its owned state')
 return c
def request(port,path,headers=None):
 con=http.client.HTTPConnection('127.0.0.1',port,timeout=10)
 try:
  con.request('GET',path,headers=headers or {});r=con.getresponse();data=r.read(22000001);require(r.status==200 and len(data)<=22000000,'Loopback request refused');return json.loads(data)
 finally:con.close()
def mapping(c):
 state=directory(c['state'],True);bound=json.loads(regular(state/'binding/document-map.json',True).read_text())
 require(isinstance(bound,dict)and 0<len(bound)<=10000 and all(isinstance(n,str)for n in bound.values())and len(set(bound.values()))==len(bound),'Invalid bound document inventory')
 for doc,name in bound.items():
  require(isinstance(doc,str)and re.fullmatch('[a-f0-9]{24}',doc)and isinstance(name,str)and name.endswith('.tex')and '\\'not in name and '\x00'not in name and not Path(name).is_absolute()and all(x not in ('','.','..')for x in name.split('/')),'Unsafe bound source path')
  regular(state/'project'/name,True)
 require(c.get('main')in bound.values(),'Main source is not bound')
 return bound
def authority(c):
 out={}
 for doc,name in mapping(c).items():
  cancelled();d=request(c['documentUpdaterPort'],'/project/'+c['projectId']+'/doc/'+doc)
  require(isinstance(d.get('lines'),list)and all(isinstance(x,str)for x in d['lines']),'Invalid canonical source response');raw='\n'.join(d['lines']).encode();require(len(raw)<=2000000,'Source budget exceeded');out[name]=raw
 return out
def stable(c):
 a=authority(c);require(a==authority(c),'Source changed during checkpoint; retry after editing settles');return a
def headers(c):return {'Host':urlsplit(c['publicOrigin']).netloc,'Origin':c['publicOrigin'],'Authorization':'Bearer '+regular(Path(c['state'])/'token').read_text().strip()}
def create_startup_checkpoint(c,sources):
 state=directory(c['state'],True);bound=mapping(c)
 require(set(sources)==set(bound.values()),'Startup source inventory differs from binding')
 require(all(regular(state/'project'/name,True).read_bytes()==raw for name,raw in sources.items()),'Startup disk snapshot verification failed')
 record={'schema':1,'projectId':c['projectId'],'main':c['main'],'runId':RUN_ID,'bindingSHA256':hashlib.sha256(regular(state/'binding/document-map.json',True).read_bytes()).hexdigest(),'files':{name:hashlib.sha256(raw).hexdigest()for name,raw in sources.items()}}
 raw=json.dumps(record,sort_keys=True).encode();atomic(state/'startup-checkpoint.json',raw)
 pin=hashlib.sha256(raw).hexdigest();verify_startup_checkpoint(c,pin)
 return pin

def verify_startup_checkpoint(c,expected=None):
 state=directory(c['state'],True);bound=mapping(c)
 if expected is None:
  expected=process_data(c).get('startupCheckpointSHA256')
  if c.get('_startupCheckpointSHA256')is not None:require(expected==c['_startupCheckpointSHA256'],'Startup checkpoint identity changed during service lifetime')
 require(isinstance(expected,str)and re.fullmatch('[a-f0-9]{64}',expected),'Pinned startup checkpoint identity missing')
 raw=regular(state/'startup-checkpoint.json',True).read_bytes();require(hashlib.sha256(raw).hexdigest()==expected,'Startup checkpoint seal changed')
 record=json.loads(raw)
 require(record.get('schema')==1 and record.get('projectId')==c['projectId']and record.get('main')==c['main'],'Startup checkpoint binding differs')
 require(record.get('bindingSHA256')==hashlib.sha256(regular(state/'binding/document-map.json',True).read_bytes()).hexdigest(),'Document binding changed since startup checkpoint')
 files=record.get('files');require(isinstance(files,dict)and set(files)==set(bound.values()),'Startup checkpoint source inventory differs')
 for name,pin in files.items():
  require(isinstance(pin,str)and re.fullmatch('[a-f0-9]{64}',pin),'Invalid startup source hash')
  require(hashlib.sha256(regular(state/'project'/name,True).read_bytes()).hexdigest()==pin,'Private source file differs from sealed startup baseline')
 return record

def health(c):
 p=request(c['bridgePort'],'/rtex-test/api/project',headers(c));require(p.get('projectId')==c['projectId']and p.get('engineAlive')is True and p.get('nativeBridgeProtocol')==1,'Bridge identity/engine differs')
 expected=stable(c)
 for doc,name in mapping(c).items():
  d=request(c['bridgePort'],'/rtex-test/api/document?'+urlencode({'projectId':c['projectId'],'docId':doc,'path':name}),headers(c));require(d.get('projectId')==c['projectId']and d.get('path')==name and isinstance(d.get('text'),str)and d['text'].encode()==expected[name],'Bridge source differs from canonical authority')
 require(stable(c)==expected,'Canonical source advanced during health check')
 # Live edits belong to the engine VFS. Disk files retain the sealed startup
 # baseline; only the bridge's current memory must match canonical documents.
 verify_startup_checkpoint(c)
 return p
def start(c):
 with lifecycle(c):return _start(c)
def _start(c):
 state=Path(c['state']);meta=state/'processes.json'
 if meta.exists():
  old=process_data(c);require(not old.get('uncertainSpawn')and not any(alive(i)for i in old['processes']+old.get('children',[])),'Owned process active or prior child cleanup uncertain')
 # Checkpoint current canonical sources. Old ZIP snapshots are never restored on restart.
 cancelled();subreaper();sources=stable(c)
 for name,raw in sources.items():atomic(regular(state/'project'/name),raw)
 require(stable(c)==sources,'Canonical source advanced during checkpoint')
 c['_startupCheckpointSHA256']=create_startup_checkpoint(c,sources)
 runtime=Path(c['runtime']);env={**os.environ,'PORT':str(c['bridgePort']),'BIND_HOST':'127.0.0.1','PUBLIC_ORIGIN':c['publicOrigin'],'PUBLIC_BASE_PATH':'/rtex-test/','OVERLEAF_ORIGIN':c['publicOrigin'],'RTEX_PROJECT':str(state/'project'),'RTEX_MAIN':c['main'],'RTEX_PROJECT_ID':c['projectId'],'RTEX_DOCUMENT_MAP':str(state/'binding/document-map.json'),'RTEX_PROJECT_CONFIG':str(state/'binding/project-config.json'),'RTEX_SETTINGS_FILE':str(state/'settings.json'),'RTEX_TOKEN_FILE':str(state/'token'),'RTEX_REQUIRE_BINDING':'true','RTEX_NATIVE_INSERTIONS':'true','RTEX_BIN':str(runtime/'deployment/runtime-linux/bin/rtex'),'RTEX_TEXDIR':str(runtime/'deployment/runtime-support/tex'),'OVERLEAF_WEB_DIR':c['webRoot'],'TEXMFVAR':str(state/'texmf-var'),'TEXMFCACHE':str(state/'texmf-var')}
 if c.get('texLiveBin'):env['RTEX_TEXLIVE_BIN']=c['texLiveBin']
 if c.get('fontRoots'):env['RTEX_FONT_ROOTS']=c['fontRoots']
 # WebSocket authorization uses the project's own authenticated nginx route.
 env['RTEX_WS_AUTH_URL']='http://127.0.0.1:'+str(c['nginxPort'])+'/rtex-test/api/project'
 processes=[];known={};uncertain=False
 def save():
  for i in processes:
   for child in descendants(i):known[(child['pid'],child['start'])]=child
  if SUBREAPER and CONTROLLER and alive(CONTROLLER):
   for child in descendants(CONTROLLER):known[(child['pid'],child['start'])]=child
  children=[x for x in known.values()if x not in processes and alive(x)]
  atomic_if_changed(meta,json.dumps({'processes':processes,'children':children,'uncertainSpawn':uncertain,'controller':CONTROLLER,'startupCheckpointSHA256':c['_startupCheckpointSHA256']}).encode())
 def spawn(entry,label):
  nonlocal uncertain
  cancelled();logfile=state/(label+'.log')
  if logfile.exists()or logfile.is_symlink():regular(logfile,True)
  uncertain=True;save()
  fd=os.open(logfile,os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600);os.fchmod(fd,0o600)
  with os.fdopen(fd,'ab')as log:p=subprocess.Popen([c['node'],str(entry)],env=env,cwd=runtime,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
  for _ in range(40):
   try:i=identity(p.pid);break
   except (FileNotFoundError,Refusal):
    require(p.poll()is None,'Owned child exited before registration; cleanup must be verified');time.sleep(.025)
  else:raise Refusal('Owned process identity unavailable')
  require(i['argv']==[c['node'],str(entry)],'Spawn identity differs');processes.append(i);uncertain=False;save();cancelled()
 try:
  require(stable(c)==sources,'Canonical source advanced before service spawn')
  if (state/'settings.json').exists()or(state/'settings.json').is_symlink():regular(state/'settings.json',True).unlink()
  spawn(runtime/'deployment/watch-project-settings.cjs','settings')
  for _ in range(100):
   cancelled();save()
   if (state/'settings.json').is_file():break
   require(alive(processes[0]),'Settings provider exited');time.sleep(.1)
  require((state/'settings.json').is_file(),'Settings provider not ready')
  spawn(runtime/'dist/server.mjs','bridge')
  for _ in range(180):
   cancelled();save()
   require(all(alive(i)for i in processes),'Owned service exited')
   try:health(c);save();return
   except (OSError,ValueError,Refusal):time.sleep(.25)
  raise Refusal('Bridge readiness/source check timed out')
 except BaseException as error:
  diagnostic(c,'startup',error)
  save();_stop(c);raise

def valid_identity(i):
 return isinstance(i,dict)and type(i.get('pid'))is int and i['pid']>1 and isinstance(i.get('start'),str)and i['start'].isdigit()and isinstance(i.get('argv'),list)and all(isinstance(x,str)for x in i['argv'])
def process_data(c):
 data=json.loads(regular(Path(c['state'])/'processes.json',True).read_text());leaders=data.get('processes');children=data.get('children',[])
 require(isinstance(leaders,list)and len(leaders)<=2 and isinstance(children,list)and len(children)<=4096,'Invalid owned process inventory')
 allowed={str(Path(c['runtime'])/n)for n in ('deployment/watch-project-settings.cjs','dist/server.mjs')}
 require(all(valid_identity(i)and len(i['argv'])==2 and i['argv'][0]==c['node']and i['argv'][1]in allowed for i in leaders),'Owned leader command identity differs')
 require(all(valid_identity(i)for i in children),'Invalid descendant identity')
 require(len({i['pid']for i in leaders+children})==len(leaders+children),'Duplicate owned process identity')
 if 'startupCheckpointSHA256'in data:require(isinstance(data['startupCheckpointSHA256'],str)and re.fullmatch('[a-f0-9]{64}',data['startupCheckpointSHA256']),'Invalid startup checkpoint process pin')
 return data
def stop(c):
 with lifecycle(c):
  meta=Path(c['state'])/'processes.json'
  if meta.exists():
   controller=process_data(c).get('controller')
   require(controller is None or valid_identity(controller),'Invalid foreground controller identity')
   require(not(controller and controller['pid']!=os.getpid()and alive(controller)),'Stop the recorded foreground supervisor through runit first')
  return _stop(c)
def _stop(c):
 meta=Path(c['state'])/'processes.json'
 if not meta.exists():return
 data=process_data(c);leaders=data['processes'];known={i['pid']:i for i in leaders+data.get('children',[])}
 if SUBREAPER and CONTROLLER and alive(CONTROLLER):known.update({i['pid']:i for i in descendants(CONTROLLER)})
 for i in list(known.values()):
  if alive(i):known.update({x['pid']:x for x in descendants(i)})
 def record_stop():
  children=[i for i in known.values()if i not in leaders and alive(i)]
  require(len(children)<=4096,'Owned child inventory budget exceeded')
  atomic_if_changed(meta,json.dumps({**data,'children':children,'uncertainSpawn':True}).encode())
 def finish_stop():
  if data.get('uncertainSpawn'):require(SUBREAPER and CONTROLLER and alive(CONTROLLER)and not descendants(CONTROLLER),'Unregistered child cleanup uncertain; restart refused')
  atomic_if_changed(meta,json.dumps({**data,'children':[],'uncertainSpawn':False}).encode())
 record_stop()
 for i in reversed(leaders):
  if alive(i):signal_owned(i)
 for _ in range(100):
  if SUBREAPER and CONTROLLER and alive(CONTROLLER):known.update({i['pid']:i for i in descendants(CONTROLLER)})
  for i in list(known.values()):
   if alive(i):known.update({x['pid']:x for x in descendants(i)})
  record_stop()
  if not any(alive(i)for i in known.values()):finish_stop();return
  time.sleep(.1)
 # Only exact descendants captured from the owned processes may be signalled.
 for i in reversed(list(known.values())):
  if alive(i):signal_owned(i)
 for _ in range(100):
  if SUBREAPER and CONTROLLER and alive(CONTROLLER):known.update({i['pid']:i for i in descendants(CONTROLLER)})
  for i in list(known.values()):
   if alive(i):known.update({x['pid']:x for x in descendants(i)})
  record_stop()
  if not any(alive(i)for i in known.values()):finish_stop();return
  time.sleep(.1)
 raise Refusal('Owned child did not stop; duplicate start refused')
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['start','stop','status','run']);p.add_argument('--config',type=Path,required=True);a=p.parse_args();os.umask(0o077)
 c=read_config(a.config)
 if a.action=='stop':stop(c);print(json.dumps({'stopped':True}));return
 if a.action=='status':health(c);print(json.dumps({'healthy':True,'projectId':c['projectId']}));return
 global CANCELLED
 def finish(*_):
  global CANCELLED;CANCELLED=True
 signal.signal(signal.SIGTERM,finish);signal.signal(signal.SIGINT,finish)
 try:
  start(c)
  if a.action=='start':print(json.dumps({'started':True,'projectId':c['projectId']}),flush=True)
  while not CANCELLED:
   data=process_data(c);require(all(alive(i)for i in data['processes']),'Managed process exited')
   children={x['pid']:x for x in data.get('children',[])if alive(x)}
   for i in data['processes']:
    children.update({x['pid']:x for x in descendants(i)})
   if SUBREAPER and CONTROLLER:children.update({x['pid']:x for x in descendants(CONTROLLER)if x not in data['processes']})
   atomic_if_changed(Path(c['state'])/'processes.json',json.dumps({**data,'children':[x for x in children.values()if x not in data['processes']]}).encode());time.sleep(.5)
 except BaseException as error:
  if not(CANCELLED and isinstance(error,Refusal)):
   diagnostic(c,'supervisor',error);raise
 finally:
  try:stop(c)
  except BaseException as error:
   diagnostic(c,'shutdown',error);raise
if __name__=='__main__':
 try:main()
 except Refusal as e:print('Refused: '+str(e),file=sys.stderr);raise SystemExit(1)
