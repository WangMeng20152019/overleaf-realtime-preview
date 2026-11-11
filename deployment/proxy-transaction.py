#!/usr/bin/env python3
"""Prepare/test/activate/rollback one explicit nginx server include transaction."""
import argparse,contextlib,fcntl,glob,hashlib,json,os,re,stat,subprocess,tempfile
from pathlib import Path
class Refusal(ValueError):pass
SAFE=re.compile(r'/[A-Za-z0-9_./-]+')
STANDARD_LINKS={'/etc/nginx/sites-enabled/overleaf.conf':'/etc/nginx/sites-available/overleaf.conf'}
def sha(data):return hashlib.sha256(data).hexdigest()
def path(value):
 p=Path(value)
 if not p.is_absolute() or not SAFE.fullmatch(str(p)) or '..'in p.parts:raise Refusal('Expected safe absolute path')
 return p
def parents(p):
 for q in [*reversed(p.parent.parents),p.parent]:
  s=q.lstat()
  if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode):raise Refusal('Symlink or non-directory parent refused')
def regular(p,limit=5000000):
 p=path(p);parents(p);s=p.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>limit or s.st_mode&0o022:raise Refusal('Unsafe, writable, linked or oversized regular file')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  now=os.fstat(fd)
  if (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)!=(now.st_dev,now.st_ino,now.st_size,now.st_mtime_ns):raise Refusal('File changed while reading')
  with os.fdopen(fd,'rb',closefd=False)as f:data=f.read(limit+1)
  if len(data)!=s.st_size:raise Refusal('File size changed')
 finally:os.close(fd)
 return data,{'sha256':sha(data),'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid}
def link_identity(p):
 parents(p);s=p.lstat()
 if not stat.S_ISLNK(s.st_mode):raise Refusal('Expected recorded standard symlink')
 return {'text':os.readlink(p),'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'inode':s.st_ino,'device':s.st_dev}
def resolve_target(p):
 parents(p)
 if not p.is_symlink():return p,{}
 expected=STANDARD_LINKS.get(str(p))
 if not expected:raise Refusal('Unexpected target symlink refused')
 identity=link_identity(p);destination=Path(expected)
 if identity['text'] not in (expected,os.path.relpath(destination,p.parent)):raise Refusal('Standard target symlink points elsewhere')
 _,actual=regular(destination)
 if identity['uid']!=actual['uid']:raise Refusal('Standard target link owner differs')
 return destination,{str(p):{'identity':identity,'target':expected}}
def tokens(text):
 out=[];i=0
 while i<len(text):
  if text[i].isspace():i+=1;continue
  if text[i]=='#':
   i=text.find('\n',i)
   if i<0:break
   continue
  start=i;c=text[i]
  if c in '{};':out.append((c,i,i+1,True));i+=1;continue
  if c in '\"\'':
   quote=c;i+=1;value=''
   while i<len(text)and text[i]!=quote:
    if text[i]=='\\':
     i+=1
     if i>=len(text):raise Refusal('Incomplete escape')
    value+=text[i];i+=1
   if i>=len(text):raise Refusal('Unterminated configuration string')
   i+=1;out.append((value,start,i,False));continue
  while i<len(text)and not text[i].isspace()and text[i]not in '{};#':i+=1
  out.append((text[start:i],start,i,False))
 return out
def directives(data):
 try:text=data.decode('utf-8')
 except UnicodeError as error:raise Refusal('Configuration must be UTF-8')from error
 current=[];depth=0;out=[]
 for value,start,end,symbol in tokens(text):
  if symbol and value in (';','{'):
   if not current:raise Refusal('Empty configuration directive')
   out.append({'name':current[0][0],'args':[x[0]for x in current[1:]],'depth':depth,'block':value=='{','start':current[0][1],'end':end})
   if value=='{':depth+=1
   current=[]
  elif symbol and value=='}':
   if current or depth<=0:raise Refusal('Unexpected configuration closing brace')
   depth-=1
  else:current.append((value,start,end))
 if current or depth:raise Refusal('Incomplete configuration')
 return out
def include_path(value):
 if not re.fullmatch(r'/[A-Za-z0-9_./*-]+',value) or '..'in Path(value).parts or '*'in str(Path(value).parent):raise Refusal('Unsafe include path')
 return value
def server_candidate(original,fragment):
 ds=directives(original);servers=[d for d in ds if d['name']=='server']
 if len(servers)!=1 or servers[0]['depth']!=0 or not servers[0]['block'] or any(d['depth']==0 and d['name']!='server'for d in ds):raise Refusal('Exactly one top-level server block required')
 if any(d['name']=='location'and any('/rtex-test/'in a or '_rtex_test_'in a or '/rtex-app-assets/'in a for a in d['args'])for d in ds):raise Refusal('Existing realtime proxy route refused')
 for d in ds:
  if d['name']=='include':
   if len(d['args'])!=1:raise Refusal('Unexpected include arguments')
   include_path(d['args'][0])
 text=original.decode();index=[start for value,start,end,symbol in tokens(text)if symbol and value=='}'][-1]
 return (text[:index]+'\n    include '+str(fragment)+';\n'+text[index:]).encode()
def validate_fragment(data):
 ds=directives(data)
 if not ds or any(d['name']in ('include','server','http','events','upstream','map')for d in ds)or any(d['depth']==0 and(d['name']!='location'or not d['block'])for d in ds):raise Refusal('Fragment must contain only location blocks without includes')
def include_parents(pattern):
 for q in [*reversed(Path(pattern).parent.parents),Path(pattern).parent]:
  try:s=q.lstat()
  except FileNotFoundError:continue
  if not stat.S_ISDIR(s.st_mode)or stat.S_ISLNK(s.st_mode):raise Refusal('Unsafe include parent')
def config_tree(main,links=None):
 links=links or {};entries={};patterns={};pending=[main];budget=0
 while pending:
  p=pending.pop()
  if str(p)in links:p=Path(links[str(p)]['target'])
  name=str(p)
  if name in entries:continue
  if len(entries)>200:raise Refusal('Configuration include budget exceeded')
  data,identity=regular(p);budget+=len(data)
  if budget>10000000:raise Refusal('Configuration byte budget exceeded')
  entries[name]=identity
  for d in directives(data):
   if d['name']!='include':continue
   if len(d['args'])!=1:raise Refusal('Unexpected include arguments')
   pattern=include_path(d['args'][0]);base=Path(pattern[:-1]if pattern.endswith('*')else pattern)
   include_parents(pattern)
   names=sorted(glob.glob(pattern))
   if not names and '*'not in pattern:raise Refusal('Required include absent')
   patterns[pattern]=names;pending.extend(Path(n)for n in names)
 return {'files':entries,'patterns':patterns,'links':links}
def alternate_main(main_data,target,replacement,snapshot):
 matches=[]
 for d in directives(main_data):
  if d['name']=='include'and len(d['args'])==1 and str(target)in snapshot['patterns'].get(d['args'][0],[]):matches.append(d)
 if len(matches)!=1:raise Refusal('Main must include the target exactly once, directly or through one wildcard')
 d=matches[0];names=snapshot['patterns'][d['args'][0]]
 replacement_text='\n'.join('include '+str(replacement if n==str(target)else n)+';'for n in names)
 text=main_data.decode();return(text[:d['start']]+replacement_text+text[d['end']:]).encode()
def private(p,data):
 parents(p);fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
def atomic(p,data,identity):
 regular(p);fd,tmp=tempfile.mkstemp(prefix='.rtex-proxy-',dir=p.parent)
 try:
  os.fchmod(fd,identity['mode']);os.fchown(fd,identity['uid'],identity['gid'])
  with os.fdopen(fd,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.replace(tmp,p)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def command(nginx,main,reload=False):
 argv=[str(nginx),'-c',str(main)]+(['-s','reload']if reload else['-t'])
 result=subprocess.run(argv,capture_output=True,timeout=30)
 if result.returncode:raise Refusal('nginx reload failed'if reload else'nginx configuration test failed')
def check_file(p,expected):
 if regular(p,32000000)[1]!=expected:raise Refusal('Pinned file identity differs')
def check_tree(snapshot,target,expected):
 for name,record in snapshot.get('links',{}).items():
  if link_identity(Path(name))!=record['identity']:raise Refusal('Recorded standard link identity changed')
 for name,identity in snapshot['files'].items():check_file(Path(name),expected if name==str(target)else identity)
 for pattern,names in snapshot['patterns'].items():
  include_parents(pattern)
  if sorted(glob.glob(pattern))!=names:raise Refusal('Configuration include inventory changed')
def state_dir(state):
 path(state);parents(state);s=state.lstat()
 if not stat.S_ISDIR(s.st_mode)or stat.S_IMODE(s.st_mode)!=0o700 or s.st_uid!=os.geteuid():raise Refusal('Owned private state directory required')
@contextlib.contextmanager
def locked(state):
 state_dir(state);lock=state/'transaction.lock'
 if lock.exists():regular(lock)
 fd=os.open(lock,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:fcntl.flock(fd,fcntl.LOCK_EX);yield
 finally:os.close(fd)
def load(state):
 state_dir(state);data,identity=regular(state/'transaction.json')
 if identity['mode']!=0o600 or identity['uid']!=os.geteuid():raise Refusal('Private transaction metadata required')
 m=json.loads(data)
 for key in ('main','target','fragment','nginx'):path(m[key])
 for name,expected in m['privateFiles'].items():check_file(state/name,expected)
 check_file(Path(m['nginx']),m['nginxIdentity'])
 return m
def prepare(main,target,fragment,state,nginx,run=command):
 for p in (main,target,fragment,nginx,state):path(p)
 if len({main,target,fragment,nginx,state})!=5:raise Refusal('Transaction paths must be distinct')
 if any(state==p or state in p.parents for p in (main,target,fragment,nginx)):raise Refusal('State must not contain input configuration or executable')
 include_target=target;target,links=resolve_target(target)
 raw,original=regular(target);fragment_data,fragment_id=regular(fragment);main_data,main_id=regular(main);_,nginx_id=regular(nginx,32000000)
 if not nginx_id['mode']&0o111 or nginx_id['mode']&0o6000:raise Refusal('Normal executable nginx file required')
 if fragment_id['mode']!=0o600 or fragment_id['uid']!=os.geteuid():raise Refusal('Owned mode0600 fragment required')
 validate_fragment(fragment_data);candidate=server_candidate(raw,fragment)
 snapshot=config_tree(main,links)
 if snapshot['files'].get(str(main))!=main_id:raise Refusal('Main changed during preparation')
 if str(target)not in snapshot['files']:raise Refusal('Target is absent from configuration tree')
 parents(state);state.mkdir(mode=0o700)
 with locked(state):
  private(state/'original.conf',raw);private(state/'candidate.conf',candidate)
  private(state/'candidate-main.conf',alternate_main(main_data,include_target,state/'candidate.conf',snapshot))
  private(state/'rollback-main.conf',alternate_main(main_data,include_target,state/'original.conf',snapshot))
  # Validate both variants before writing any live configuration.
  run(nginx,state/'candidate-main.conf');run(nginx,state/'rollback-main.conf')
  check_tree(snapshot,target,original);check_file(fragment,fragment_id);check_file(nginx,nginx_id)
  m={'format':1,'main':str(main),'target':str(target),'fragment':str(fragment),'nginx':str(nginx),'original':original,'candidate':{**original,'sha256':sha(candidate)},'snapshot':snapshot,'fragmentIdentity':fragment_id,'nginxIdentity':nginx_id,'privateFiles':{n:regular(state/n)[1]for n in ('original.conf','candidate.conf','candidate-main.conf','rollback-main.conf')}}
  private(state/'transaction.json',json.dumps(m,indent=2).encode())
 return {'prepared':True,'liveChanged':False}
def transition(state,rollback=False,run=command,swap=atomic):
 with locked(state):
  m=load(state);target=Path(m['target']);main=Path(m['main']);nginx=Path(m['nginx']);old=m['candidate'if rollback else'original'];new=m['original'if rollback else'candidate']
  check_tree(m['snapshot'],target,old);check_file(Path(m['fragment']),m['fragmentIdentity'])
  isolated=state/('rollback-main.conf'if rollback else'candidate-main.conf');run(nginx,isolated)
  check_tree(m['snapshot'],target,old);check_file(Path(m['fragment']),m['fragmentIdentity']);check_file(nginx,m['nginxIdentity'])
  before=regular(target)[0];after=regular(state/('original.conf'if rollback else'candidate.conf'))[0]
  swapped=False
  try:
   # Set before mutation; an injected swap can commit then raise.
   swapped=True;swap(target,after,new);check_tree(m['snapshot'],target,new);run(nginx,main);run(nginx,main,True)
  except BaseException as error:
   if swapped:
    current=regular(target)[1]
    if current not in (old,new):raise Refusal('Concurrent target edits; automatic restore refused')from error
    try:
     if current!=old:swap(target,before,old)
     check_tree(m['snapshot'],target,old);run(nginx,main);run(nginx,main,True)
    except BaseException as recovery:raise Refusal('Recovery failed; target state requires inspection')from recovery
   raise
  return {'rolledBack':True,'liveChanged':True}if rollback else{'activated':True,'liveChanged':True}
def status(state):
 with locked(state):
  m=load(state);target=Path(m['target']);actual=regular(target)[1]
  stage=None
  if actual==m['original']:stage='original'
  elif actual==m['candidate']:stage='active'
  else:raise Refusal('Unrelated live target edits')
  check_tree(m['snapshot'],target,actual);check_file(Path(m['fragment']),m['fragmentIdentity'])
  return {'status':stage,'liveChanged':False}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['prepare','activate','rollback','status']);p.add_argument('--state',type=path,required=True);p.add_argument('--main',type=path,default=Path('/etc/nginx/nginx.conf'));p.add_argument('--target',type=path,default=Path('/etc/nginx/sites-enabled/overleaf.conf'));p.add_argument('--fragment',type=path);p.add_argument('--nginx',type=path,default=Path('/usr/sbin/nginx'));a=p.parse_args()
 if a.action=='prepare':
  if not a.fragment:p.error('--fragment is required for prepare')
  result=prepare(a.main,a.target,a.fragment,a.state,a.nginx)
 elif a.action=='status':result=status(a.state)
 else:result=transition(a.state,a.action=='rollback')
 print(json.dumps(result))
if __name__=='__main__':main()
