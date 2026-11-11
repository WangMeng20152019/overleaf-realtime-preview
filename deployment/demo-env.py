#!/usr/bin/env python3
"""Create a new private Compose secret file, matching the pinned CE recommendation."""
import argparse,base64,json,os,secrets,stat,sys
from pathlib import Path
KEY='OVERLEAF_INVITE_TOKEN_SECRET'
# Official CE init script recommends `openssl rand -base64 32`.
# The v3 encryptor uses the resulting password string with HKDF, not as a raw key.
SECRET_BYTES=32
DEFAULT=Path(__file__).resolve().parents[1]/'examples/.env'
class Refusal(ValueError):pass

def generate(output):
 if os.name!='posix' or not hasattr(os,'O_NOFOLLOW')or not hasattr(os,'O_DIRECTORY'):raise Refusal('POSIX private-file permissions required')
 output=Path(output).absolute();parent=output.parent
 if '..'in output.parts or parent.resolve(strict=True)!=parent:raise Refusal('Canonical output parent required; symlinks are refused')
 info=parent.lstat()
 if not stat.S_ISDIR(info.st_mode)or info.st_uid!=os.geteuid()or info.st_mode&0o022:raise Refusal('Output parent must be owned by this user and not writable by group or others')
 directory=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 created=None
 try:
  now=os.fstat(directory)
  if(now.st_dev,now.st_ino)!=(info.st_dev,info.st_ino):raise Refusal('Output directory changed')
  fd=os.open(output.name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
  created=os.fstat(fd)
  try:
   os.fchmod(fd,0o600)
   raw=secrets.token_bytes(SECRET_BYTES)
   if len(raw)!=SECRET_BYTES:raise Refusal('Random generator returned an invalid byte count')
   value=base64.b64encode(raw).decode('ascii')
   with os.fdopen(fd,'w',encoding='ascii',newline='\n')as stream:
    fd=None;stream.write(f'{KEY}={value}\n');stream.flush();os.fsync(stream.fileno())
   os.fsync(directory)
  finally:
   if fd is not None:os.close(fd)
 except BaseException:
  if created is not None:
   try:
    current=os.stat(output.name,dir_fd=directory,follow_symlinks=False)
    if(current.st_dev,current.st_ino)==(created.st_dev,created.st_ino):os.unlink(output.name,dir_fd=directory)
   except FileNotFoundError:pass
  raise
 finally:os.close(directory)
 return {'created':True,'file':str(output),'mode':'0600','secretPrinted':False}

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=DEFAULT);args=parser.parse_args()
 try:print(json.dumps(generate(args.output)))
 except FileExistsError:parser.exit(1,'Refused: output already exists; its persistent secret was not changed.\n')
 except (OSError,ValueError):parser.exit(1,'Refused: could not create a new private environment file; inspect its path and permissions.\n')
if __name__=='__main__':main()
