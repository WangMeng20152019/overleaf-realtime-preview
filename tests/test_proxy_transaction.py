import importlib.util,json,os,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('proxy_transaction',Path(__file__).resolve().parents[1]/'deployment/proxy-transaction.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class ProxyTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.sites=self.root/'sites';self.sites.mkdir();self.target=self.sites/'overleaf.conf';self.original=b'server {\n listen 80;\n location / { return 200; }\n}\n';self.target.write_bytes(self.original);self.target.chmod(0o640)
  self.main=self.root/'nginx.conf';self.main.write_text('events {}\nhttp { include '+str(self.sites/'*')+'; }\n')
  self.fragment=self.root/'fragment.conf';self.fragment.write_text('location /rtex-test/ { return 401; }\n');self.fragment.chmod(0o600)
  self.binary=self.root/'nginx';self.binary.write_text('#!/bin/sh\nexit 0\n');self.binary.chmod(0o755);self.state=self.root/'state';self.calls=[]
 def tearDown(self):self.temp.cleanup()
 def nginx_run(self,nginx,main,reload=False):self.calls.append((str(main),reload))
 def prepare(self,run=None):return mod.prepare(self.main,self.target,self.fragment,self.state,self.binary,run or self.nginx_run)
 def activate(self,run=None,swap=mod.atomic):return mod.transition(self.state,run=run or self.nginx_run,swap=swap)
 def test_prepare_no_live_write(self):
  self.prepare();self.assertEqual(self.target.read_bytes(),self.original);self.assertEqual(len(self.calls),2);self.assertEqual(self.state.stat().st_mode&0o777,0o700);self.assertEqual(mod.status(self.state)['status'],'original')
 def test_activate_rollback_roundtrip_permissions(self):
  self.prepare();self.activate();self.assertEqual(mod.status(self.state)['status'],'active');self.assertEqual(self.target.stat().st_mode&0o777,0o640);mod.transition(self.state,True,run=self.nginx_run);self.assertEqual(self.target.read_bytes(),self.original)
 def test_unrelated_live_edit_refused(self):
  self.prepare();self.activate();self.target.write_bytes(b'server { listen 81; }');before=self.target.read_bytes();self.assertRaises(mod.Refusal,mod.transition,self.state,True,run=self.nginx_run);self.assertEqual(self.target.read_bytes(),before)
 def test_main_drift_refused(self):
  self.prepare();self.main.write_text('events {} http {}');self.assertRaises(mod.Refusal,self.activate);self.assertEqual(self.target.read_bytes(),self.original)
 def test_fragment_drift_refused(self):
  self.prepare();self.fragment.write_text('location /rtex-test/ { return 403; }');self.assertRaises(mod.Refusal,self.activate)
 def test_include_inventory_drift_refused(self):
  self.prepare();(self.sites/'other.conf').write_text('server { listen 81; }');self.assertRaises(mod.Refusal,self.activate)
 def test_backup_tamper_refused(self):
  self.prepare();(self.state/'original.conf').write_text('server {}');self.assertRaises(mod.Refusal,self.activate)
 def test_executable_drift_refused(self):
  self.prepare();self.binary.write_text('#!/bin/sh\nexit 1');self.assertRaises(mod.Refusal,self.activate)
 def test_candidate_invalid_before_swap(self):
  self.prepare()
  def fail(*args):raise mod.Refusal('invalid')
  self.assertRaises(mod.Refusal,self.activate,fail);self.assertEqual(self.target.read_bytes(),self.original)
 def test_reload_failure_restores_and_reloads_original(self):
  self.prepare();failures=0
  def fail_once(nginx,main,reload=False):
   nonlocal failures
   self.nginx_run(nginx,main,reload)
   if reload and not failures:failures+=1;raise mod.Refusal('injected reload failure')
  self.assertRaises(mod.Refusal,self.activate,fail_once);self.assertEqual(self.target.read_bytes(),self.original);self.assertEqual(sum(r for _,r in self.calls),2)
 def test_swap_commit_then_error_restores(self):
  self.prepare();n=0
  def swap(*args):
   nonlocal n
   mod.atomic(*args);n+=1
   if n==1:raise OSError('injected post-swap failure')
  self.assertRaises(OSError,self.activate,None,swap);self.assertEqual(self.target.read_bytes(),self.original)
 def test_concurrent_edit_never_overwritten(self):
  self.prepare()
  def run(nginx,main,reload=False):
   if main==self.main and not reload:self.target.write_bytes(b'concurrent owner edit');raise mod.Refusal('concurrent')
  self.assertRaisesRegex(mod.Refusal,'Concurrent target edits',self.activate,run);self.assertEqual(self.target.read_bytes(),b'concurrent owner edit')
 def test_restore_failure_is_reported(self):
  self.prepare();n=0
  def swap(*args):
   nonlocal n
   n+=1
   if n==2:raise OSError('restore blocked')
   mod.atomic(*args)
  def run(nginx,main,reload=False):
   if reload:raise mod.Refusal('reload failed')
  self.assertRaisesRegex(mod.Refusal,'Recovery failed',self.activate,run,swap);self.assertNotEqual(self.target.read_bytes(),self.original)
 def test_symlink_target_refused(self):
  other=self.root/'other';self.target.rename(other);self.target.symlink_to(other);self.assertRaises(mod.Refusal,self.prepare)
 def test_symlink_include_refused(self):
  other=self.root/'other';other.write_text('server {}');(self.sites/'bad.conf').symlink_to(other);self.assertRaises(mod.Refusal,self.prepare)
 def test_multiple_server_blocks_refused(self):
  self.target.write_bytes(self.original+b'server {}');self.assertRaises(mod.Refusal,self.prepare)
 def test_fragment_include_injection_refused(self):
  self.fragment.write_text('location /rtex-test/ { include /etc/passwd; }');self.assertRaises(mod.Refusal,self.prepare)
 def test_unsafe_main_include_refused(self):
  self.main.write_text('events {} http { include $unsafe; }');self.assertRaises(mod.Refusal,self.prepare)
 def test_quoted_braces_comments_and_globs(self):
  self.target.write_text('server { # server {\n location / { sub_filter "}" "{"; }\n }\n')
  conf=self.root/'conf';conf.mkdir();self.main.write_text('events {} http { include '+str(conf/'*.conf')+'; include '+str(self.sites/'*')+'; }')
  self.prepare();self.activate();self.assertEqual(mod.status(self.state)['status'],'active')
 def test_exact_recorded_standard_link_roundtrip(self):
  actual=self.root/'available.conf';self.target.rename(actual);self.target.symlink_to('../available.conf');old=mod.STANDARD_LINKS;mod.STANDARD_LINKS={str(self.target):str(actual)}
  try:
   self.prepare();self.activate();self.assertTrue(self.target.is_symlink());mod.transition(self.state,True,run=self.nginx_run);self.assertEqual(actual.read_bytes(),self.original)
  finally:mod.STANDARD_LINKS=old
 def test_recorded_link_repoint_refused(self):
  actual=self.root/'available.conf';self.target.rename(actual);self.target.symlink_to('../available.conf');old=mod.STANDARD_LINKS;mod.STANDARD_LINKS={str(self.target):str(actual)}
  try:
   self.prepare();self.target.unlink();self.target.symlink_to(str(actual));self.assertRaises(mod.Refusal,self.activate);self.assertEqual(actual.read_bytes(),self.original)
  finally:mod.STANDARD_LINKS=old
 def test_comment_trailing_brace_not_insertion_point(self):
  self.target.write_bytes(self.original+b'# trailing } comment\n');self.prepare();candidate=(self.state/'candidate.conf').read_text();self.assertLess(candidate.index('include '+str(self.fragment)),candidate.index('# trailing'))
 def test_absent_wildcard_directories_are_valid(self):
  self.main.write_text('events {} http { include '+str(self.root/'absent/more/*.conf')+'; include '+str(self.sites/'*')+'; }')
  self.prepare();self.activate()
 def test_new_symlink_parent_on_empty_include_refused(self):
  self.main.write_text('events {} http { include '+str(self.root/'absent/more/*.conf')+'; include '+str(self.sites/'*')+'; }')
  self.prepare();other=self.root/'other';other.mkdir();(other/'more').mkdir();(self.root/'absent').symlink_to(other);self.assertRaises(mod.Refusal,self.activate)
 def test_uid_mode_guard(self):
  self.prepare();self.target.chmod(0o600);self.assertRaises(mod.Refusal,self.activate)
if __name__=='__main__':unittest.main()
