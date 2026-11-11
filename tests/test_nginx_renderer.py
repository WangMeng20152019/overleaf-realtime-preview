import re,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class NginxRendererTests(unittest.TestCase):
 def render(self,extra=None):
  with tempfile.TemporaryDirectory()as t:
   base=Path(t).resolve();token=base/'token';token.write_text('a'*64);token.chmod(0o600);output=base/'fragment.conf'
   subprocess.run([sys.executable,'-B',str(ROOT/'deployment/render-nginx.py'),'--project-id','0123456789abcdef01234567','--token-file',str(token),'--bundle',str(base),'--port','4173','--web-port','4000','--output',str(output),*(extra or[])],capture_output=True,check=True)
   self.assertEqual(output.stat().st_mode&0o777,0o600);return output.read_text()
 def test_original_host_with_nondefault_port_preserved_for_all_routes(self):
  fragment=self.render(['--enable-websocket'])
  for location in ['location = /_rtex_test_authorize {','location = /rtex-test/api/socket {','location /rtex-test/ {','location = /project/0123456789abcdef01234567 {']:
   block=fragment.split(location,1)[1].split('\n}',1)[0]
   self.assertIn('proxy_set_header Host $http_host;',block)
   self.assertIn('proxy_set_header X-Forwarded-Host $http_host;',block)
   self.assertNotIn('proxy_set_header Host $host;',block)
  self.assertIn('proxy_set_header Origin $http_origin;',fragment)
 def test_bridge_only_keeps_project_authorization_and_original_host(self):
  fragment=self.render(['--bridge-only','--enable-websocket'])
  self.assertEqual(fragment.count('proxy_set_header Host $http_host;'),3)
  self.assertEqual(fragment.count('auth_request /_rtex_test_authorize;'),2)
  self.assertIn('proxy_pass http://127.0.0.1:4000/project/0123456789abcdef01234567/entities;',fragment)
  self.assertNotIn('location = /project/0123456789abcdef01234567 {',fragment)
 def test_default_authority_and_access_guards_are_preserved(self):
  fragment=self.render()
  self.assertEqual(fragment.count('proxy_set_header Host $http_host;'),3)
  self.assertIn('internal;',fragment);self.assertIn('return 401;',fragment)
  self.assertIn('proxy_set_header Cookie $http_cookie;',fragment)
  self.assertIn('proxy_set_header Authorization "";',fragment)
  self.assertNotIn('proxy_set_header Origin "";',fragment)
if __name__=='__main__':unittest.main()
