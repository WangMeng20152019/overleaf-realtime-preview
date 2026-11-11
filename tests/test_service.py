import hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,Mock
s=importlib.util.spec_from_file_location('service',Path(__file__).resolve().parents[1]/'deployment/service.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class ServiceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.state=self.root/'state';self.state.mkdir(mode=0o700);self.runtime=self.root/'runtime';self.runtime.mkdir();self.web=self.root/'web';self.web.mkdir();self.node=self.root/'node';self.put(self.node,b'node fixture',0o755)
  self.files=['dist/server.mjs','deployment/watch-project-settings.cjs','deployment/runtime-linux/bin/rtex']
  self.pins={}
  for n in self.files:self.put(self.runtime/n,n.encode(),0o755 if n.endswith('/rtex')else 0o644);self.pins[n]=hashlib.sha256(n.encode()).hexdigest()
  self.save_runtime();self.put(self.state/'project/main.tex',b'old ZIP')
  self.put(self.state/'binding/document-map.json',json.dumps({'a'*24:'main.tex'}).encode());self.put(self.state/'binding/project-config.json',json.dumps({'projectId':'b'*24,'main':'main.tex','baseURL':'/rtex-test/'}).encode());self.put(self.state/'token',b'a'*64)
  self.config={'schema':1,'projectId':'b'*24,'state':str(self.state),'runtime':str(self.runtime),'node':str(self.node),'webRoot':str(self.web),'main':'main.tex','publicOrigin':'https://overleaf.example.org','bridgePort':44175,'documentUpdaterPort':3003,'nginxPort':80};self.save_config();m.CANCELLED=False;m.SUBREAPER=False;m.CONTROLLER=None
 def tearDown(self):self.tmp.cleanup();m.CANCELLED=False;m.SUBREAPER=False;m.CONTROLLER=None
 def put(self,p,b,mode=0o600):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);p.chmod(mode)
 def save_config(self):self.put(self.state/'service.json',json.dumps(self.config).encode())
 def save_runtime(self):self.put(self.runtime/'runtime-manifest.json',json.dumps({'schema':1,'files':self.pins}).encode(),0o644)
 def proc(self,pid=100,start='1',entry='dist/server.mjs'):return {'pid':pid,'start':start,'argv':[str(self.node),str(self.runtime/entry)]}
 def processes(self,leaders=None,children=None,uncertain=False):self.put(self.state/'processes.json',json.dumps({'processes':leaders or [],'children':children or [],'uncertainSpawn':uncertain}).encode())
 def test_identical_metadata_preserves_inode_and_skips_atomic_write(self):
  target=self.state/'processes.json';raw=b'{"processes":[],"children":[]}'
  self.put(target,raw);before=target.stat()
  with patch.object(m,'atomic')as write:self.assertFalse(m.atomic_if_changed(target,raw));write.assert_not_called()
  after=target.stat();self.assertEqual((before.st_ino,before.st_mtime_ns),(after.st_ino,after.st_mtime_ns))
 def test_changed_metadata_still_written_and_private_mode_guard_kept(self):
  target=self.state/'processes.json';self.put(target,b'old')
  self.assertTrue(m.atomic_if_changed(target,b'new'));self.assertEqual(target.read_bytes(),b'new')
  target.chmod(0o644);self.assertRaises(m.Refusal,m.atomic_if_changed,target,b'new')
 def test_diagnostic_preserves_primary_before_cleanup_and_redacts_payload(self):
  try:m.require(False,'Managed process exited')
  except m.Refusal as error:m.diagnostic(self.config,'supervisor',error)
  m.diagnostic(self.config,'shutdown',ValueError('private source and Bearer credentials'))
  record=json.loads((self.state/'service-failure.json').read_text());self.assertEqual(record['primary']['message'],'Managed process exited');self.assertEqual(record['primary']['type'],'Refusal');self.assertEqual(record['secondary'][0]['type'],'ValueError');self.assertNotIn('private source',(self.state/'service-failure.json').read_text());self.assertNotIn('Bearer',(self.state/'service-failure.json').read_text());self.assertEqual((self.state/'service-failure.json').stat().st_mode&0o777,0o600)
 def test_startup_failure_recorded_before_stop_can_fail(self):
  with patch.object(m,'stable',return_value={'main.tex':b'new'}),patch.object(m,'subreaper'),patch.object(m.subprocess,'Popen',side_effect=OSError(28,'private credential payload')),patch.object(m,'_stop',side_effect=m.Refusal('cleanup failure')):self.assertRaises(m.Refusal,m.start,self.config)
  record=json.loads((self.state/'service-failure.json').read_text());self.assertEqual(record['primary']['type'],'OSError');self.assertEqual(record['primary']['errno'],28);self.assertNotIn('credential',(self.state/'service-failure.json').read_text())
 def sealed_baseline(self):
  pin=m.create_startup_checkpoint(self.config,{'main.tex':b'old ZIP'});self.processes([self.proc()]);record=json.loads((self.state/'processes.json').read_text());record['startupCheckpointSHA256']=pin;self.put(self.state/'processes.json',json.dumps(record).encode());return pin
 def current_api(self,current):
  def request(port,route,headers=None):
   if route=='/rtex-test/api/project':return {'projectId':self.config['projectId'],'engineAlive':True,'nativeBridgeProtocol':1}
   return {'projectId':self.config['projectId'],'path':'main.tex','text':current.decode()}
  return request
 def check_live_health(self,current=b'legitimate edited memory'):
  with patch.object(m,'stable',return_value={'main.tex':current}),patch.object(m,'request',side_effect=self.current_api(current)):return m.health(self.config)
 def test_active_vfs_edit_with_unchanged_sealed_disk_baseline_is_healthy(self):
  self.sealed_baseline();self.assertTrue(self.check_live_health()['engineAlive']);self.assertEqual((self.state/'project/main.tex').read_bytes(),b'old ZIP')
 def test_active_vfs_must_still_match_current_canonical(self):
  self.sealed_baseline()
  with patch.object(m,'stable',return_value={'main.tex':b'canonical newer'}),patch.object(m,'request',side_effect=self.current_api(b'wrong memory')):self.assertRaisesRegex(m.Refusal,'Bridge source differs',m.health,self.config)
 def test_sealed_disk_tamper_refused_even_when_memory_matches_authority(self):
  self.sealed_baseline();self.put(self.state/'project/main.tex',b'tampered baseline');self.assertRaisesRegex(m.Refusal,'sealed startup baseline',self.check_live_health)
 def test_checkpoint_file_tamper_refused(self):
  self.sealed_baseline();p=self.state/'startup-checkpoint.json';record=json.loads(p.read_text());record['files']['main.tex']=hashlib.sha256(b'tampered').hexdigest();self.put(p,json.dumps(record).encode());self.assertRaisesRegex(m.Refusal,'seal changed',self.check_live_health)
 def test_checkpoint_process_pin_tamper_refused(self):
  self.sealed_baseline();p=self.state/'processes.json';record=json.loads(p.read_text());record['startupCheckpointSHA256']='0'*64;self.put(p,json.dumps(record).encode());self.assertRaises(m.Refusal,self.check_live_health)
 def test_checkpoint_binding_drift_refused(self):
  self.sealed_baseline();self.put(self.state/'binding/document-map.json',json.dumps({'c'*24:'main.tex'}).encode());self.assertRaisesRegex(m.Refusal,'binding changed',self.check_live_health)
 def test_checkpoint_private_mode_still_required(self):
  self.sealed_baseline();(self.state/'startup-checkpoint.json').chmod(0o644);self.assertRaises(m.Refusal,self.check_live_health)
 def test_unsealed_active_state_is_not_silently_adopted(self):
  self.processes([self.proc()]);self.assertRaisesRegex(m.Refusal,'checkpoint identity missing',self.check_live_health)
 def test_restart_refreshes_sealed_baseline_from_current_authority(self):
  pins=[]
  for current in [b'first current canonical',b'latest canonical at restart']:
   if (self.state/'processes.json').exists():
    record=json.loads((self.state/'processes.json').read_text());record.update(processes=[],children=[],uncertainSpawn=False);self.put(self.state/'processes.json',json.dumps(record).encode())
   with patch.object(m,'stable',return_value={'main.tex':current}),patch.object(m,'subreaper'),patch.object(m,'_stop'),patch.object(m.subprocess,'Popen',side_effect=OSError('injected after checkpoint')):self.assertRaises(OSError,m.start,self.config)
   self.assertEqual((self.state/'project/main.tex').read_bytes(),current);seal=json.loads((self.state/'startup-checkpoint.json').read_text());self.assertEqual(seal['files']['main.tex'],hashlib.sha256(current).hexdigest());pins.append(json.loads((self.state/'processes.json').read_text())['startupCheckpointSHA256'])
  self.assertNotEqual(*pins)
 def test_checkpoint_creation_requires_verified_disk_snapshot(self):
  self.assertRaisesRegex(m.Refusal,'disk snapshot',m.create_startup_checkpoint,self.config,{'main.tex':b'not written yet'});self.assertFalse((self.state/'startup-checkpoint.json').exists())
 def test_valid_config(self):self.assertEqual(m.read_config(self.state/'service.json')['projectId'],self.config['projectId'])
 def test_extra_runtime_file_refused(self):self.put(self.runtime/'extra',b'x');self.assertRaises(m.Refusal,m.read_config,self.state/'service.json')
 def test_extra_empty_runtime_directory_refused(self):(self.runtime/'empty').mkdir();self.assertRaises(m.Refusal,m.validate_runtime,self.runtime)
 def test_runtime_hash_change_refused(self):self.put(self.runtime/self.files[0],b'changed');self.assertRaises(m.Refusal,m.validate_runtime,self.runtime)
 def test_runtime_symlink_refused(self):(self.runtime/'alias').symlink_to(self.node);self.assertRaises(m.Refusal,m.validate_runtime,self.runtime)
 def test_runtime_unsafe_entry_refused(self):self.pins['../node']=hashlib.sha256(b'node fixture').hexdigest();self.save_runtime();self.assertRaises(m.Refusal,m.validate_runtime,self.runtime)
 def test_unsafe_binding_refused_without_source_write(self):
  self.put(self.state/'binding/document-map.json',json.dumps({'a'*24:'../../outside.tex'}).encode());self.assertRaises(m.Refusal,m.mapping,self.config);self.assertEqual((self.state/'project/main.tex').read_bytes(),b'old ZIP')
 def test_private_state_modes_required(self):self.state.chmod(0o755);self.assertRaises(m.Refusal,m.read_config,self.state/'service.json')
 def test_state_runtime_overlap_refused(self):self.config['runtime']=str(self.state);self.save_config();self.assertRaises(m.Refusal,m.read_config,self.state/'service.json')
 def test_checkpoint_current_before_any_spawn_and_never_old_restore(self):
  current={'main.tex':b'new canonical'}
  def fail_spawn(*args,**kwargs):self.assertEqual((self.state/'project/main.tex').read_bytes(),current['main.tex']);raise OSError('injected spawn failure')
  with patch.object(m,'stable',return_value=current),patch.object(m,'subreaper'),patch.object(m,'_stop')as stop,patch.object(m.subprocess,'Popen',side_effect=fail_spawn):self.assertRaises(OSError,m.start,self.config);stop.assert_called_once()
  self.assertEqual((self.state/'project/main.tex').read_bytes(),current['main.tex']);self.assertTrue(json.loads((self.state/'processes.json').read_text())['uncertainSpawn'])
 def test_advancing_authority_refuses_before_spawn(self):
  with patch.object(m,'stable',side_effect=[{'main.tex':b'new'},{'main.tex':b'newer'}]),patch.object(m,'subreaper'),patch.object(m.subprocess,'Popen')as spawn:self.assertRaises(m.Refusal,m.start,self.config);spawn.assert_not_called()
 def test_stale_settings_removed_before_provider_spawn(self):
  self.put(self.state/'settings.json',b'old settings')
  def spawn(*a,**k):self.assertFalse((self.state/'settings.json').exists());raise OSError('injected')
  with patch.object(m,'stable',return_value={'main.tex':b'new'}),patch.object(m,'subreaper'),patch.object(m,'_stop'),patch.object(m.subprocess,'Popen',side_effect=spawn):self.assertRaises(OSError,m.start,self.config)
 def test_log_symlink_refused_without_spawn(self):
  (self.state/'settings.log').symlink_to(self.node)
  with patch.object(m,'stable',return_value={'main.tex':b'new'}),patch.object(m,'subreaper'),patch.object(m,'_stop'),patch.object(m.subprocess,'Popen')as spawn:self.assertRaises(m.Refusal,m.start,self.config);spawn.assert_not_called()
 def test_uncertain_previous_spawn_blocks_restart(self):
  self.processes(uncertain=True)
  with patch.object(m,'stable')as source:self.assertRaises(m.Refusal,m.start,self.config);source.assert_not_called()
 def test_command_identity_tamper_refuses_before_signal(self):
  bad=self.proc();bad['argv']=['/other','unrelated'];self.processes([bad])
  with patch.object(m,'signal_owned')as kill:self.assertRaises(m.Refusal,m.stop,self.config);kill.assert_not_called()
 def test_pid_reuse_never_signalled(self):
  self.processes([self.proc()])
  with patch.object(m,'identity',return_value=self.proc(start='2')),patch.object(m,'signal_owned')as kill:m.stop(self.config);kill.assert_not_called()
 def test_saved_orphan_descendant_stopped(self):
  leader=self.proc();child={'pid':200,'start':'2','argv':['engine']};self.processes([leader],[child]);alive={200}
  def kill(pid,sig):self.assertEqual(pid,200);alive.remove(pid)
  with patch.object(m,'alive',side_effect=lambda i:i['pid']in alive),patch.object(m,'descendants',return_value=[]),patch.object(m.time,'sleep'),patch.object(m,'signal_owned',side_effect=lambda i:kill(i['pid'],None)):m.stop(self.config)
  self.assertFalse(alive)
 def test_standalone_stop_refuses_live_other_supervisor(self):
  self.processes([self.proc()]);record=json.loads((self.state/'processes.json').read_text());record['controller']={'pid':900,'start':'9','argv':['python','service.py','run']};self.put(self.state/'processes.json',json.dumps(record).encode())
  with patch.object(m,'alive',side_effect=lambda i:i['pid']==900),patch.object(m,'signal_owned')as send:self.assertRaisesRegex(m.Refusal,'through runit',m.stop,self.config);send.assert_not_called()
 def test_pidfd_rechecks_exact_identity_before_signal(self):
  with patch.object(m.os,'pidfd_open',return_value=9,create=True),patch.object(m.signal,'pidfd_send_signal',create=True)as send,patch.object(m.os,'close')as close,patch.object(m,'alive',return_value=False):m.signal_owned(self.proc());send.assert_not_called();close.assert_called_once_with(9)
 def test_pidfd_signal_targets_open_handle(self):
  with patch.object(m.os,'pidfd_open',return_value=9,create=True),patch.object(m.signal,'pidfd_send_signal',create=True)as send,patch.object(m.os,'close'),patch.object(m,'alive',return_value=True):m.signal_owned(self.proc());self.assertEqual(send.call_args.args[0],9)
 def test_unverified_cleanup_retains_restart_blocker(self):
  self.processes(uncertain=True)
  with patch.object(m,'alive',return_value=False):self.assertRaisesRegex(m.Refusal,'cleanup uncertain',m.stop,self.config)
  self.assertTrue(json.loads((self.state/'processes.json').read_text())['uncertainSpawn'])
 def test_adopted_unregistered_child_cleaned(self):
  orphan={'pid':200,'start':'2','argv':['orphan']};controller={'pid':500,'start':'5','argv':['controller']};self.processes(uncertain=True);m.SUBREAPER=True;m.CONTROLLER=controller;live={200,500}
  def descendants(i):return [orphan]if i['pid']==500 and 200 in live else[]
  def kill(pid,sig):self.assertEqual(pid,200);live.remove(pid)
  with patch.object(m,'alive',side_effect=lambda i:i['pid']in live),patch.object(m,'descendants',side_effect=descendants),patch.object(m.time,'sleep'),patch.object(m,'signal_owned',side_effect=lambda i:kill(i['pid'],None)):m.stop(self.config)
  self.assertFalse(json.loads((self.state/'processes.json').read_text())['uncertainSpawn'])
if __name__=='__main__':unittest.main()
