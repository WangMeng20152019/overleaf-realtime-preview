import hashlib,importlib.util,json,os,subprocess,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
spec=importlib.util.spec_from_file_location('installer',Path(__file__).resolve().parents[1]/'deployment/install.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class InstallTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.state=self.root/'state';self.state.mkdir(mode=0o700);(self.state/'control').mkdir(mode=0o700)
  controls={}
  for n in ('service.py','proxy-transaction.py'):
   p=self.state/'control'/n;p.write_text('fixture '+n);controls[n]=hashlib.sha256(p.read_bytes()).hexdigest()
  self.runit_root=self.root/'runit';self.runit_root.mkdir(mode=0o755);self.directory=self.runit_root/'overleaf-realtime';self.directory.mkdir(mode=0o755);(self.directory/'supervise').mkdir();(self.directory/'supervise/ok').touch();(self.directory/'down').touch(mode=0o600)
  self.config={'projectId':'a'*24,'serviceDirectory':str(self.directory),'runitLayout':{'canonical':str(self.runit_root),'links':[]},'python':'/usr/bin/python3','controlSHA256':controls}
  self.configfile=self.state/'service.json';self.configfile.write_text(json.dumps(self.config));self.configfile.chmod(0o600)
  (self.directory/'run').write_text('#!/bin/sh\nexec /usr/bin/python3 -B '+str(self.state/'control/service.py')+' run --config '+str(self.state/'service.json')+'\n');(self.directory/'run').chmod(0o755)
  self.service=Mock();self.service.Refusal=type('ServiceRefusal',(Exception,),{});self.service.read_config.return_value=self.config;self.service.regular.side_effect=lambda p:p;self.calls=[]
 def tearDown(self):self.tmp.cleanup()
 def path(self,p):return self.directory if str(p)=='/etc/service/overleaf-realtime'else Path(p)
 def control(self,action,handler):
  def run(argv):self.calls.append([str(x)for x in argv]);return handler([str(x)for x in argv])
  with patch.object(m,'Path',side_effect=self.path),patch.object(m,'mod',return_value=self.service),patch.object(m,'runit_layout',return_value=self.config['runitLayout']),patch.object(m,'run',side_effect=run),patch.object(m.time,'sleep'):
   return m.control(SimpleNamespace(state=self.state,action=action))
 def reply(self,status='original'):return SimpleNamespace(stdout=json.dumps({'status':status}).encode())
 def test_success_activate_keeps_service(self):
  self.control('activate',lambda argv:self.reply('original'));self.service.stop.assert_not_called();self.assertFalse((self.directory/'down').exists())
 def test_repeated_active_activation_is_idempotent(self):
  self.control('activate',lambda argv:self.reply('active'));self.service.stop.assert_not_called();self.assertFalse(any('activate'in a or 'rollback'in a or a[0]=='sv'for a in self.calls));self.service.health.assert_called_once()
 def test_proxy_activation_failure_already_restored_then_stops(self):
  def run(argv):
   if 'activate'in argv:raise subprocess.CalledProcessError(1,argv)
   return self.reply('original')
  self.assertRaises(subprocess.CalledProcessError,self.control,'activate',run);self.service.stop.assert_called_once();self.assertTrue((self.directory/'down').exists());self.assertTrue(any(a[:4]==['sv','-w','45','down']for a in self.calls))
 def test_proxy_rollback_failure_never_stops_service(self):
  statuses=iter(['original','active'])
  def run(argv):
   if 'activate'in argv or 'rollback'in argv:raise subprocess.CalledProcessError(1,argv)
   return self.reply(next(statuses))if 'status'in argv else self.reply()
  self.assertRaises(subprocess.CalledProcessError,self.control,'activate',run);self.service.stop.assert_not_called();self.assertFalse((self.directory/'down').exists());self.assertFalse(any('down'in a for a in self.calls))
 def test_unreadable_proxy_status_never_stops(self):
  first=True
  def run(argv):
   nonlocal first
   if first and 'status'in argv:first=False;return self.reply('original')
   if 'activate'in argv:raise subprocess.CalledProcessError(1,argv)
   return SimpleNamespace(stdout=b'not json')
  self.assertRaises(m.Refusal,self.control,'activate',run);self.service.stop.assert_not_called()
 def test_post_activation_health_failure_restores_route_before_stop(self):
  self.service.health.side_effect=[None,self.service.Refusal('changed')];statuses=iter(['original','active','original'])
  def run(argv):return self.reply(next(statuses))if 'status'in argv else self.reply()
  self.assertRaises(self.service.Refusal,self.control,'activate',run);self.service.stop.assert_called_once();rollback=next(i for i,a in enumerate(self.calls)if 'rollback'in a);down=next(i for i,a in enumerate(self.calls)if a[:1]==['sv']and 'down'in a);self.assertLess(rollback,down)
 def test_explicit_rollback_unknown_route_keeps_service(self):
  self.assertRaises(m.Refusal,self.control,'rollback',lambda argv:self.reply('unknown'));self.service.stop.assert_not_called();self.assertFalse(any('sv'in a for a in self.calls))
 def test_rollback_success_requires_status_after_rollback(self):
  statuses=iter(['active','original'])
  self.control('rollback',lambda argv:self.reply(next(statuses))if 'status'in argv else self.reply());self.service.stop.assert_called_once();self.assertEqual(sum('status'in a for a in self.calls),2)
 def test_rollback_claim_without_restored_status_refused(self):
  self.assertRaises(m.Refusal,self.control,'rollback',lambda argv:self.reply('active'));self.service.stop.assert_not_called()
 def test_control_source_tamper_refused_before_import(self):
  (self.state/'control/service.py').write_text('tamper')
  with patch.object(m,'mod')as module:self.assertRaises(m.Refusal,m.control,SimpleNamespace(state=self.state,action='status'));module.assert_not_called()
 def test_state_public_mode_refused_before_import(self):
  self.state.chmod(0o755)
  with patch.object(m,'mod')as module:self.assertRaises(m.Refusal,m.control,SimpleNamespace(state=self.state,action='status'));module.assert_not_called()
 def runit_fixture(self):
  etc=self.root/'etc';etc.mkdir();run=etc/'runit/runsvdir';run.mkdir(parents=True);final=run/'default';final.mkdir();entry=etc/'service';current=run/'current';entry.symlink_to('runit/runsvdir/current');current.symlink_to('default');links={str(entry):str(current),str(current):str(final)};return entry,links,final
 def test_record_standard_runit_chain_and_canonical_directory(self):
  entry,links,final=self.runit_fixture();record=m.runit_layout(entry,links,final,os.geteuid());self.assertEqual(record['canonical'],str(final));self.assertEqual(len(record['links']),2)
 def test_unexpected_runit_link_target_refused(self):
  entry,links,final=self.runit_fixture();entry.unlink();entry.symlink_to(final);self.assertRaises(m.Refusal,m.runit_layout,entry,links,final,os.geteuid())
 def test_runit_link_recreation_changes_recorded_identity(self):
  entry,links,final=self.runit_fixture();record=m.runit_layout(entry,links,final,os.geteuid());entry.unlink();entry.symlink_to(str(Path(links[str(entry)])));self.assertNotEqual(record,m.runit_layout(entry,links,final,os.geteuid()))
 def test_writable_runit_directory_refused(self):
  entry,links,final=self.runit_fixture();final.chmod(0o777);self.assertRaises(m.Refusal,m.runit_layout,entry,links,final,os.geteuid())
 def test_layout_overlap_refused_without_creating_state(self):
  source=self.root/'source';frontend=self.root/'frontend';runtime=self.root/'runtime';public=source/'services/web/public'
  for d in (source,frontend,runtime,public):d.mkdir(parents=True,exist_ok=True)
  args=SimpleNamespace(state=runtime/'state',runtime=runtime,source=source,frontend=frontend,assets=public/'rtex-app-assets')
  self.assertRaises(m.Refusal,m.layout,args);self.assertFalse(args.state.exists())
 def frontend_fixture(self):
  source=self.root/'frontend';source.mkdir();(source/'nested').mkdir();(source/'nested/app.js').write_bytes(b'public app');(source/'manifest.json').write_bytes(b'{}');(source/'.env').write_bytes(b'private fixture')
  report={'files':{'nested/app.js':{'sha256':hashlib.sha256(b'public app').hexdigest()}},'manifestAfterSHA256':hashlib.sha256(b'{}').hexdigest()};return source,report
 def test_frontend_copies_only_verified_inventory_with_public_modes(self):
  source,report=self.frontend_fixture();destination=self.root/'public-assets';old=__import__('os').umask(0o077)
  try:m.copy_frontend(source,destination,report)
  finally:__import__('os').umask(old)
  self.assertFalse((destination/'.env').exists());self.assertEqual((destination/'nested').stat().st_mode&0o777,0o755);self.assertEqual((destination/'nested/app.js').stat().st_mode&0o777,0o644)
 def test_unlisted_frontend_symlink_refused_before_public_write(self):
  source,report=self.frontend_fixture();(source/'secret-link').symlink_to(source/'.env');destination=self.root/'public-assets';self.assertRaises(m.Refusal,m.copy_frontend,source,destination,report);self.assertFalse(destination.exists())
 def test_frontend_hash_change_refused(self):
  source,report=self.frontend_fixture();(source/'nested/app.js').write_bytes(b'changed');destination=self.root/'public-assets';self.assertRaises(m.Refusal,m.copy_frontend,source,destination,report);self.assertFalse((destination/'nested/app.js').exists())
 def test_layout_distinct_private_and_public_paths(self):
  source=self.root/'source';frontend=self.root/'frontend';runtime=self.root/'runtime';public=source/'services/web/public'
  for d in (source,frontend,runtime,public):d.mkdir(parents=True,exist_ok=True)
  args=SimpleNamespace(state=self.root/'new-state',runtime=runtime,source=source,frontend=frontend,assets=public/'rtex-app-assets');self.assertEqual(m.layout(args)[0],args.state)
if __name__=='__main__':unittest.main()
