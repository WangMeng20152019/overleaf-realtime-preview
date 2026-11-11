#!/usr/bin/env python3
"""Check/apply the exact official CE 6.2.2 invite-options correction; never restart services."""
import argparse,fcntl,hashlib,json,os,stat,sys,tempfile
from pathlib import Path
ACTIVE=Path('/etc/overleaf/settings.js')
SOURCE=Path('/overleaf/server-ce/config/settings.js')
OWNER=0
OLD_SHA='05557f517e76bfb212fbe8e558ebd5e2e70f6fe70635a4ac9860d3d0b931d937'
NEW_SHA='2794b50b4d38c8a0319b21349332752dab0701e47a6b4d3491496139441d3f19'
OLD_BLOB='160a0b8cb012d3bf2e6562f93ef2f4f644f8f8c4'
NEW_BLOB='3ecb620a33995ae35b70bc8ca459d0024c72ce0d'
PATCH={'url':'https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/server-ce/hotfix/6.2.2/fix_invite_token_secret.patch','sha256':'6293da33dad447579f18cc21dc64e8c2457aa6c1ccd4e711dca99f0cd800f455','gitBlobSHA':'6769acc3c7cb36893f0ba4751224ebd1e63589b0'}
OLD=b'module.exports.projectInviteEncryptorOptions = {'
NEW=b'settings.projectInviteEncryptorOptions = {'
class Refusal(ValueError):pass
def require(ok,message):
 if not ok:raise Refusal(message)
def digest(data):return hashlib.sha256(data).hexdigest()
def blob(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def directory(p,private=False):
 p=Path(p);require(p.is_absolute()and '..'not in p.parts and p.resolve(strict=True)==p and p.is_dir(),'Canonical nonsymlink directory required');s=p.stat()
 require(s.st_uid==OWNER and not s.st_mode&0o022,'Owned non-writable directory required')
 if private:require(stat.S_IMODE(s.st_mode)==0o700,'Private mode0700 directory required')
 return p
def read(p):
 p=Path(p);directory(p.parent);s=p.lstat()
 require(stat.S_ISREG(s.st_mode)and s.st_nlink==1 and s.st_uid==OWNER and not s.st_mode&0o022 and s.st_size<=1000000,'Owned nonsymlink settings file required')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  now=os.fstat(fd);require((s.st_dev,s.st_ino,s.st_mtime_ns)==(now.st_dev,now.st_ino,now.st_mtime_ns),'Settings changed while opening')
  with os.fdopen(fd,'rb',closefd=False)as stream:data=stream.read(1000001)
  require(len(data)==s.st_size,'Settings changed while reading')
 finally:os.close(fd)
 return data,{'sha256':digest(data),'gitBlobSHA':blob(data),'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid,'device':s.st_dev,'inode':s.st_ino,'modifiedNS':s.st_mtime_ns}
def inspect(active=ACTIVE,source=SOURCE):
 source_data,source_id=read(source);active_data,active_id=read(active)
 require(source_id['sha256']==NEW_SHA and source_id['gitBlobSHA']==NEW_BLOB,'Official corrected source differs from pinned profile')
 require((active_id['sha256'],active_id['gitBlobSHA'])in ((OLD_SHA,OLD_BLOB),(NEW_SHA,NEW_BLOB)),'Custom or unknown active settings refused')
 if active_id['sha256']==OLD_SHA:
  require(active_data.count(OLD)==1 and active_data.replace(OLD,NEW)==source_data,'Official one-line correction differs')
 return active_data,source_data,active_id,source_id

def private(p,data):
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as stream:os.fchmod(stream.fileno(),0o600);stream.write(data);stream.flush();os.fsync(stream.fileno())
def atomic(p,data,metadata):
 fd,name=tempfile.mkstemp(prefix='.rtex-ce-settings-',dir=p.parent)
 try:
  os.fchmod(fd,metadata['mode']);os.fchown(fd,metadata['uid'],metadata['gid'])
  with os.fdopen(fd,'wb')as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
  os.replace(name,p)
 finally:
  if os.path.exists(name):os.unlink(name)
def apply(state,active=ACTIVE,source=SOURCE,hook=lambda phase:None):
 require(os.geteuid()==OWNER,'Run as the owner of the pinned CE configuration')
 state=Path(state);directory(state.parent)
 require(state.is_absolute()and '..'not in state.parts,'Absolute new backup directory required')
 require(not state.exists()and not state.is_symlink(),'Backup directory must be new')
 require(not any(state==p or state in p.parents or p in state.parents for p in (active.parent,source.parent)),'Backup overlaps configuration inputs')
 # Lock the current inode, then revalidate its name to refuse a concurrent helper.
 directory(active.parent);read(active);fd=os.open(active,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  fcntl.flock(fd,fcntl.LOCK_EX);locked=os.fstat(fd)
  before,after,old,source_id=inspect(active,source)
  require((old['device'],old['inode'])==(locked.st_dev,locked.st_ino),'Active settings changed before lock')
  require(old['sha256']==OLD_SHA,'Active settings already corrected; no change needed')
  state.mkdir(mode=0o700);state.chmod(0o700);private(state/'settings.before.js',before)
  record={'schema':1,'active':str(active),'source':str(source),'before':old,'correctedSource':source_id,'afterSHA256':NEW_SHA,'afterGitBlobSHA':NEW_BLOB,'officialPatch':PATCH,'applied':False}
  private(state/'transaction.json',json.dumps(record,indent=2).encode())
  hook('before-swap')
  require(read(active)[1]==old and read(source)[1]==source_id,'Settings/source changed after preparation; no overwrite')
  attempted=False
  try:
   attempted=True;atomic(active,after,old);hook('after-swap')
   actual,identity=read(active)
   require(actual==after and all(identity[k]==old[k]for k in ('mode','uid','gid')),'Corrected settings verification failed')
   record.update(applied=True,after=identity);atomic(state/'transaction.json',json.dumps(record,indent=2).encode(),{'mode':0o600,'uid':OWNER,'gid':os.getegid()})
  except BaseException:
   if attempted:
    actual,identity=read(active)
    if actual==before and identity==old:raise
    require(actual==after and all(identity[k]==old[k]for k in ('mode','uid','gid')),'Unrelated active settings change; automatic recovery refused')
    atomic(active,before,old);require(read(active)[0]==before,'Settings recovery failed')
   raise
 finally:os.close(fd)
 return {'applied':True,'changed':True,'restartPerformed':False,'backup':str(state),'secretPrinted':False}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['check','apply']);p.add_argument('--state',type=Path);a=p.parse_args();os.umask(0o077)
 try:
  if a.action=='apply':
   if a.state is None:p.error('--state NEW_PRIVATE_BACKUP_DIRECTORY is required')
   result=apply(a.state)
  else:
   _,_,active,_=inspect();result={'checked':True,'correctionNeeded':active['sha256']==OLD_SHA,'activeSHA256':active['sha256'],'officialPatch':PATCH,'changed':False,'secretPrinted':False}
  print(json.dumps(result))
 except (OSError,ValueError):p.exit(1,'Refused: pinned stock settings/ownership differs, backup exists, or a concurrent change occurred; no custom configuration is overwritten.\n')
if __name__=='__main__':main()
