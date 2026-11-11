#!/usr/bin/env python3
"""Attach one trusted dynamic import to the trial-only IDE entry, preserving old assets."""
import argparse,hashlib,json,os,pathlib,re,tempfile

PREFIX='/rtex-app-assets/'
APPEND=b"\n;import('/rtex-test/integration.js').catch(error=>console.error('Realtime preview launcher failed',error));\n"
def sha(data):return hashlib.sha256(data).hexdigest()
def prepare(assets,manifest,expected_manifest,expected_asset):
 assets=pathlib.Path(assets).absolute();manifest=pathlib.Path(manifest).absolute()
 if assets.name!='rtex-app-assets' or not assets.is_dir() or assets.is_symlink() or assets.resolve()!=assets:raise ValueError('Expected the dedicated real public rtex-app-assets directory')
 if manifest.parent!=assets or manifest.is_symlink() or not manifest.is_file():raise ValueError('Manifest must be the owned asset directory manifest')
 raw=manifest.read_bytes()
 if sha(raw)!=expected_manifest:raise ValueError('Manifest changed from verified SHA256')
 mapping=json.loads(raw);old=mapping.get('pages/ide.js')
 if not isinstance(old,str) or not old.startswith(PREFIX):raise ValueError('Missing explicit scoped pages/ide.js mapping')
 relative=old[len(PREFIX):];match=re.fullmatch(r'(?P<base>(?:js/)?pages/ide)-[a-f0-9]{8,64}\.js',relative)
 if not match:raise ValueError('Unexpected IDE entry path')
 file=assets/relative
 for part in [file,*file.parents]:
  if part==assets:break
  if part.is_symlink():raise ValueError('IDE entry symlinks are not supported')
 original=file.read_bytes()
 if sha(original)!=expected_asset:raise ValueError('IDE entry changed from verified SHA256')
 if b'/rtex-test/integration.js' in original:raise ValueError('Entry already contains a launcher import')
 updated=original+APPEND;new_relative=match.group('base')+'-'+sha(updated)[:20]+'.js';new=PREFIX+new_relative
 if (assets/new_relative).exists():raise ValueError('New hashed entry already exists')
 def replace(value):
  if isinstance(value,str):return new if value==old else value
  if isinstance(value,dict):return {k:replace(v) for k,v in value.items()}
  if isinstance(value,list):return [replace(v) for v in value]
  return value
 next_manifest=(json.dumps(replace(mapping),indent=2)+'\n').encode()
 return {'manifest':manifest,'before':raw,'after':next_manifest,'file':file,'original':original,'newFile':assets/new_relative,'updated':updated,'oldURL':old,'newURL':new}

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ['assets-dir','manifest','state']:p.add_argument('--'+name,type=pathlib.Path,required=True)
 p.add_argument('--manifest-sha256',required=True);p.add_argument('--asset-sha256',required=True);p.add_argument('--apply',action='store_true')
 a=p.parse_args()
 try:
  if any(not re.fullmatch('[a-f0-9]{64}',v) for v in [a.manifest_sha256,a.asset_sha256]):raise ValueError('Explicit verified SHA256 values are required')
  plan=prepare(a.assets_dir,a.manifest,a.manifest_sha256,a.asset_sha256)
  if a.apply:
   state=a.state.absolute()
   if state.exists() or state.is_symlink():raise ValueError('Backup state must be new')
   if state==a.assets_dir or a.assets_dir in state.parents:raise ValueError('Backup must be outside public assets')
   state.mkdir(mode=0o700)
   for name,data in [('manifest-before.json',plan['before']),('ide-before.js',plan['original'])]:
    target=state/name
    with target.open('xb') as stream:stream.write(data)
    target.chmod(0o600)
   if plan['manifest'].read_bytes()!=plan['before'] or plan['file'].read_bytes()!=plan['original']:raise ValueError('Trial asset changed after verification')
   with plan['newFile'].open('xb') as stream:stream.write(plan['updated']);stream.flush();os.fsync(stream.fileno())
   plan['newFile'].chmod(plan['file'].stat().st_mode&0o777)
   fd,tmp=tempfile.mkstemp(prefix='.rtex-manifest-',dir=plan['manifest'].parent)
   try:
    with os.fdopen(fd,'wb') as stream:stream.write(plan['after']);stream.flush();os.fsync(stream.fileno())
    os.chmod(tmp,plan['manifest'].stat().st_mode&0o777);os.replace(tmp,plan['manifest'])
   finally:
    if os.path.exists(tmp):os.unlink(tmp)
  print(json.dumps({'applied':a.apply,'oldURL':plan['oldURL'],'newURL':plan['newURL'],'oldSHA256':sha(plan['original']),'newSHA256':sha(plan['updated']),'manifestSHA256':sha(plan['after']),'oldAssetPreserved':True,'sourceMapPreserved':True},indent=2))
 except (OSError,ValueError) as error:p.exit(1,str(error)+'\n')
if __name__=='__main__':main()
