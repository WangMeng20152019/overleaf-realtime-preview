#!/usr/bin/env python3
"""Render project-scoped nginx locations; never edits a running nginx config."""
import argparse,pathlib,re,json
p=argparse.ArgumentParser();p.add_argument('--project-id',required=True);p.add_argument('--token-file',type=pathlib.Path,required=True);p.add_argument('--bundle',type=pathlib.Path,required=True);p.add_argument('--port',type=int,default=4173);p.add_argument('--web-port',type=int,required=True,help='Verified existing Overleaf HTTP upstream port');p.add_argument('--output',type=pathlib.Path,required=True)
for option in ['manifest-before','manifest-after','assets-dir']:p.add_argument('--'+option,type=pathlib.Path)
p.add_argument('--bridge-only',action='store_true',help='Expose only project-authorized bridge routes; do not alter editor HTML or frontend assets')
p.add_argument('--enable-websocket',action='store_true',help='Enable the exact authenticated realtime socket upgrade route')
a=p.parse_args()
if not re.fullmatch('[0-9a-f]{24}',a.project_id):raise SystemExit('Expected verified Overleaf project id')
if not 1024<=a.port<=65535:raise SystemExit('Invalid bridge port')
if not 1024<=a.web_port<=65535 or a.web_port==a.port:raise SystemExit('Invalid or colliding Overleaf web port')
token=a.token_file.read_text().strip()
if not re.fullmatch('[0-9a-f]{64,128}',token) or a.token_file.stat().st_mode&0o077:raise SystemExit('Token file must be mode0600 and contain hex secret')
bundle=str(a.bundle.resolve())
if not re.fullmatch(r'/[A-Za-z0-9_./-]+',bundle):raise SystemExit('Unsafe bundle path')
asset_location='';asset_filters=''
socket_location=''
if a.enable_websocket:
 socket_location=f'''location = /rtex-test/api/socket {{
    auth_request /_rtex_test_authorize;
    proxy_pass http://127.0.0.1:{a.port};
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Authorization "Bearer {token}";
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600;
    proxy_send_timeout 30;
}}
'''
launcher_filter='''    sub_filter '</body>' '<script type="module" src="/rtex-test/integration.js"></script></body>';\n'''
asset_options=[a.manifest_before,a.manifest_after,a.assets_dir]
if a.bridge_only and any(asset_options):raise SystemExit('--bridge-only cannot enable staged editor assets')
if any(asset_options) and not all(asset_options):raise SystemExit('Provide --manifest-before, --manifest-after and --assets-dir together')
if all(asset_options):
 launcher_filter='' # The nonce-trusted staged IDE entry imports the launcher.
 def asset_url(value,prefix='/'):
  if not isinstance(value,str) or not re.fullmatch(r'/[A-Za-z0-9_./\[\]-]+',value) or any(part in ('','.','..') for part in value.split('/')[1:]) or not value.startswith(prefix):raise SystemExit('Unsafe or incorrectly namespaced manifest asset URL')
  return value
 def manifest(file):
  def unique(pairs):
   result={}
   for key,value in pairs:
    if key in result:raise SystemExit('Duplicate asset manifest key')
    result[key]=value
   return result
  value=json.loads(file.read_text(),object_pairs_hook=unique)
  if not isinstance(value,dict) or not value:raise SystemExit('Expected nonempty asset manifest mapping')
  metadata=value.pop('entrypoints',{});urls=[]
  if not isinstance(metadata,dict):raise SystemExit('Invalid entrypoints metadata')
  for name,entry in metadata.items():
   if not isinstance(name,str) or not name or not isinstance(entry,dict) or set(entry)!={'assets'} or not isinstance(entry['assets'],dict) or not entry['assets'] or not set(entry['assets']).issubset({'js','css'}):raise SystemExit('Unexpected entrypoints structure')
   for kind,assets in entry['assets'].items():
    if not isinstance(assets,list) or any(not isinstance(v,str) or not v.endswith('.'+kind) for v in assets):raise SystemExit('Invalid entrypoint asset list')
    urls.extend(assets)
  if not value or any(not isinstance(k,str) or not k or not isinstance(v,str) for k,v in value.items()):raise SystemExit('Expected string asset mappings outside entrypoints')
  return value,urls
 (before,before_metadata),(after,after_metadata)=manifest(a.manifest_before),manifest(a.manifest_after)
 if not set(before_metadata).issubset(before.values()) or not set(after_metadata).issubset(after.values()):raise SystemExit('Entrypoint metadata references assets absent from string mappings')
 for value in [*before.values(),*before_metadata]:asset_url(value)
 for value in [*after.values(),*after_metadata]:asset_url(value,'/rtex-app-assets/')
 # Reuse the read-only verifier's strict numeric-chunk identity and ordered
 # entrypoint checks; named entry keys are never guessed or fuzzy-matched.
 import importlib.util
 helper=pathlib.Path(__file__).with_name('verify-staged-assets.py')
 if not helper.is_file():raise SystemExit('Staged asset verification helper is required')
 spec=importlib.util.spec_from_file_location('rtex_verified_assets',helper);verified=importlib.util.module_from_spec(spec);spec.loader.exec_module(verified)
 try:
  replacements=verified.entry_mapping(before,after)
  verified.check_entrypoint_positions(a.manifest_before,a.manifest_after,replacements)
 except ValueError as error:raise SystemExit(str(error))
 assets=str(a.assets_dir)
 if not a.assets_dir.is_absolute() or a.assets_dir.name!='rtex-app-assets' or not re.fullmatch(r'/[A-Za-z0-9_./-]+',assets) or any(part in ('.','..') for part in a.assets_dir.parts):raise SystemExit('Use an absolute dedicated rtex-app-assets public directory')
 asset_location=f'''location /rtex-app-assets/ {{
    auth_request /_rtex_test_authorize;
    alias {assets}/;
    add_header Cache-Control "no-store" always;
}}
'''
 # Match complete double-quoted HTML attribute values, never a URL substring.
 # URL validation excludes nginx variables, quotes, escapes and directives.
 asset_filters=''.join(f'''    sub_filter '"{old}"' '"{new}"';\n''' for old,new in sorted(replacements.items()))
 # Overleaf's webpack-public-path module overrides output.publicPath from this
 # exact observed meta tag; scope the override to the copied editor response.
 asset_filters+='''    sub_filter '<meta name="ol-baseAssetPath" content="/">' '<meta name="ol-baseAssetPath" content="/rtex-app-assets/">';\n'''
# Existing Overleaf endpoint explicitly requires login and read-project permission.
# The target project is constant here, never chosen by the client request.
s=f'''# Include INSIDE the existing Overleaf server block. Run nginx -t before reload.
location = /_rtex_test_authorize {{
    internal;
    proxy_pass http://127.0.0.1:{a.web_port}/project/{a.project_id}/entities;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Authorization "";
    proxy_set_header Upgrade "";
    proxy_set_header Connection "";
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_intercept_errors on;
    error_page 301 302 303 307 308 404 = @rtex_test_denied;
    proxy_cache off;
}}
location @rtex_test_denied {{
    return 401;
}}
{asset_location}{socket_location}\
location /rtex-test/ {{
    auth_request /_rtex_test_authorize;
    proxy_pass http://127.0.0.1:{a.port};
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header Authorization "Bearer {token}";
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600;
    client_max_body_size 2m;
}}
'''
if not a.bridge_only:s+=f'''# Only the copied test editor receives the opt-in launcher.
location = /project/{a.project_id} {{
    proxy_pass http://127.0.0.1:{a.web_port};
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header Accept-Encoding "";
    sub_filter_once off;
{asset_filters}{launcher_filter}\
}}
'''
a.output.parent.mkdir(parents=True,exist_ok=True)
with a.output.open('x') as f:f.write(s)
a.output.chmod(0o600)
print('Wrote scoped nginx include; it contains a secret and must remain private')
