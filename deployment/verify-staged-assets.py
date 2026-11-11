#!/usr/bin/env python3
"""Read-only verification of an isolated frontend build before scoped deployment."""
import argparse,hashlib,json,pathlib,re,shlex,sys

PREFIX='/rtex-app-assets/'
def entry_mapping(before,after):
 entries={k:v for k,v in before.items() if v.endswith(('.js','.css'))};pairs={}
 if not entries or not any(v.endswith('.js') for v in entries.values()):raise ValueError('Missing original script/style mappings')
 for key,old in entries.items():
  target=key
  if key not in after:
   match=re.fullmatch(r'(?P<directory>(?:[A-Za-z0-9_-]+/)*)?(?P<chunk>[0-9]+)-[a-f0-9]{8,64}\.(?P<ext>js|css)',key)
   if not match or old!='/'+key:raise ValueError('Missing named or noncanonical original asset key: '+key)
   directory=match.group('directory') or '';pattern=re.escape(directory+match.group('chunk'))+r'-[a-f0-9]{8,64}\.'+match.group('ext')
   candidates=[k for k,v in after.items() if re.fullmatch(pattern,k) and v==PREFIX+k]
   if len(candidates)!=1:raise ValueError('Ambiguous or missing numeric chunk replacement: '+key)
   target=candidates[0]
  new=after[target]
  if pathlib.PurePosixPath(old).suffix!=pathlib.PurePosixPath(new).suffix:raise ValueError('Staged entry changed asset type')
  if old in pairs and pairs[old]!=new:raise ValueError('Conflicting original asset replacements')
  pairs[old]=new
 return pairs

def check_entrypoint_positions(before_file,after_file,pairs):
 before=json.loads(pathlib.Path(before_file).read_text()).get('entrypoints',{});after=json.loads(pathlib.Path(after_file).read_text()).get('entrypoints',{})
 if set(before)!=set(after):raise ValueError('Entrypoint names changed')
 for name,entry in before.items():
  original=entry['assets'];staged=after[name]['assets']
  if set(original)!=set(staged):raise ValueError('Entrypoint asset types changed')
  for kind,urls in original.items():
   if [pairs.get(url) for url in urls]!=staged[kind]:raise ValueError('Entrypoint script/style positions do not match validated replacements: '+name)

def read_manifest(file):
 def unique(pairs):
  result={}
  for key,value in pairs:
   if key in result:raise ValueError('Duplicate manifest key')
   result[key]=value
  return result
 value=json.loads(pathlib.Path(file).read_text(),object_pairs_hook=unique)
 if not isinstance(value,dict) or not value:raise ValueError('Expected a nonempty asset manifest')
 metadata=value.pop('entrypoints',{});urls=[]
 if not isinstance(metadata,dict):raise ValueError('Invalid entrypoints metadata')
 for name,entry in metadata.items():
  if not isinstance(name,str) or not name or not isinstance(entry,dict) or set(entry)!={'assets'} or not isinstance(entry['assets'],dict) or not entry['assets'] or not set(entry['assets']).issubset({'js','css'}):raise ValueError('Unexpected entrypoints structure')
  for kind,assets in entry['assets'].items():
   if not isinstance(assets,list) or any(not isinstance(v,str) or not v.endswith('.'+kind) for v in assets):raise ValueError('Invalid entrypoint asset list')
   urls.extend(assets)
 if any(not isinstance(k,str) or not k or not isinstance(v,str) for k,v in value.items()) or not value:raise ValueError('Expected string asset mappings outside entrypoints')
 return value,urls

def verify(before_file,after_file,source):
 source=pathlib.Path(source).resolve(strict=True)
 if not source.is_dir():raise ValueError('Missing staged public directory')
 (before,before_metadata),(after,after_metadata)=read_manifest(before_file),read_manifest(after_file)
 if not set(before_metadata).issubset(before.values()) or not set(after_metadata).issubset(after.values()):raise ValueError('Entrypoint metadata references assets absent from string mappings')
 for value in [*before.values(),*before_metadata]:
  if not re.fullmatch(r'/[A-Za-z0-9_./\[\]-]+',value) or any(p in ('','.','..') for p in value.split('/')[1:]):raise ValueError('Unsafe original asset URL')
 pairs=entry_mapping(before,after);check_entrypoint_positions(before_file,after_file,pairs)
 files={};markers=[]
 for value in [*after.values(),*after_metadata]:
  if not re.fullmatch(r'/rtex-app-assets/[A-Za-z0-9_./\[\]-]+',value):raise ValueError('Unscoped staged asset URL')
  relative=value[len(PREFIX):]
  if any(p in ('','.','..') for p in relative.split('/')):raise ValueError('Unsafe staged path')
  if relative in files:continue
  file=source/relative
  for part in [file,*file.parents]:
   if part==source:break
   if part.is_symlink():raise ValueError('Staged asset symlink is not supported')
  if not file.is_file() or not file.resolve().is_relative_to(source):raise ValueError('Missing or escaping staged asset: '+relative)
  digest=hashlib.sha256();size=0;marker=False;carry=b''
  with file.open('rb') as stream:
   while True:
    block=stream.read(1024*1024)
    if not block:break
    digest.update(block);size+=len(block)
    if file.suffix=='.js' and b'rtexDocumentId' in carry+block:marker=True
    carry=block[-32:]
  files[relative]={'bytes':size,'sha256':digest.hexdigest()}
  if marker:markers.append(relative)
 if not markers:raise ValueError('Compiled JavaScript lacks the immutable document identity patch marker')
 return {'verifiedFiles':len(files),'scriptStyleMappings':len(pairs),'identityMarkerFiles':markers,'files':files,'manifestBeforeSHA256':hashlib.sha256(pathlib.Path(before_file).read_bytes()).hexdigest(),'manifestAfterSHA256':hashlib.sha256(pathlib.Path(after_file).read_bytes()).hexdigest(),'activated':False}

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ['manifest-before','manifest-after','assets-source','assets-dir','token-file','bundle','render-output']:p.add_argument('--'+name,type=pathlib.Path,required=True)
 p.add_argument('--project-id',required=True);p.add_argument('--web-port',type=int,required=True);p.add_argument('--port',type=int,default=4173)
 a=p.parse_args()
 try:
  if not re.fullmatch('[a-f0-9]{24}',a.project_id):raise ValueError('Expected the verified copied project ID')
  if not a.assets_dir.is_absolute() or a.assets_dir.name!='rtex-app-assets':raise ValueError('Expected a dedicated absolute public rtex-app-assets directory')
  result=verify(a.manifest_before,a.manifest_after,a.assets_source)
  command=[sys.executable,str(pathlib.Path(__file__).with_name('render-nginx.py')),'--project-id',a.project_id,'--token-file',str(a.token_file),'--bundle',str(a.bundle),'--web-port',str(a.web_port),'--port',str(a.port),'--manifest-before',str(a.manifest_before),'--manifest-after',str(a.manifest_after),'--assets-dir',str(a.assets_dir),'--output',str(a.render_output)]
  result['rendererCommand']=shlex.join(command)
  print(json.dumps(result,indent=2))
 except (OSError,ValueError) as error:p.exit(1,str(error)+'\n')
if __name__=='__main__':main()
