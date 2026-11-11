import importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('ce_settings',Path(__file__).resolve().parents[1]/'deployment/ce-settings.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class CESettingsTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.config=self.root/'config';self.config.mkdir();self.source_dir=self.root/'source';self.source_dir.mkdir();self.active=self.config/'settings.js';self.source=self.source_dir/'settings.js';self.state=self.root/'backup'
  self.before=b'const settings = {};\n'+m.OLD+b' cipherLabel: "synthetic" };\nmodule.exports = settings;\n';self.after=self.before.replace(m.OLD,m.NEW)
  self.active.write_bytes(self.before);self.active.chmod(0o640);self.source.write_bytes(self.after);self.source.chmod(0o644)
  for key,value in {'OWNER':os.geteuid(),'OLD_SHA':m.digest(self.before),'NEW_SHA':m.digest(self.after),'OLD_BLOB':m.blob(self.before),'NEW_BLOB':m.blob(self.after)}.items():p=patch.object(m,key,value);p.start();self.addCleanup(p.stop)
 def apply(self,hook=lambda phase:None):return m.apply(self.state,self.active,self.source,hook)
 def test_exact_patch_preserves_metadata_and_private_backup(self):
  before=self.active.stat();result=self.apply();after=self.active.stat();self.assertEqual(self.active.read_bytes(),self.after);self.assertEqual((before.st_uid,before.st_gid,before.st_mode&0o777),(after.st_uid,after.st_gid,after.st_mode&0o777));self.assertEqual((self.state/'settings.before.js').read_bytes(),self.before);self.assertEqual((self.state/'settings.before.js').stat().st_mode&0o777,0o600);self.assertEqual(self.state.stat().st_mode&0o777,0o700);self.assertFalse(result['restartPerformed']);record=json.loads((self.state/'transaction.json').read_text());self.assertEqual(record['officialPatch'],m.PATCH);self.assertEqual(record['before']['gitBlobSHA'],m.OLD_BLOB);self.assertEqual(record['after']['sha256'],m.NEW_SHA);self.assertTrue(record['applied'])
 def test_unknown_active_refused_before_backup_creation(self):self.active.write_bytes(self.before+b'custom');self.assertRaises(m.Refusal,self.apply);self.assertFalse(self.state.exists())
 def test_unknown_corrected_source_refused(self):self.source.write_bytes(self.after+b'custom');self.assertRaises(m.Refusal,self.apply);self.assertFalse(self.state.exists());self.assertEqual(self.active.read_bytes(),self.before)
 def test_active_symlink_refused(self):self.active.unlink();self.active.symlink_to(self.source);self.assertRaises(m.Refusal,self.apply);self.assertEqual(self.source.read_bytes(),self.after)
 def test_source_symlink_refused(self):outside=self.root/'outside';outside.write_bytes(self.after);self.source.unlink();self.source.symlink_to(outside);self.assertRaises(m.Refusal,self.apply)
 def test_existing_state_never_overwritten(self):self.state.mkdir();(self.state/'keep').write_bytes(b'keep');self.assertRaises(m.Refusal,self.apply);self.assertEqual((self.state/'keep').read_bytes(),b'keep')
 def test_concurrent_active_edit_is_retained(self):
  def hook(phase):self.active.write_bytes(b'unrelated owner edit')
  self.assertRaises(m.Refusal,self.apply,hook);self.assertEqual(self.active.read_bytes(),b'unrelated owner edit');self.assertEqual((self.state/'settings.before.js').read_bytes(),self.before)
 def test_concurrent_mode_change_is_not_overwritten(self):
  def hook(phase):self.active.chmod(0o600)
  self.assertRaises(m.Refusal,self.apply,hook);self.assertEqual(self.active.stat().st_mode&0o777,0o600);self.assertEqual(self.active.read_bytes(),self.before)
 def test_concurrent_source_change_refused_before_patch(self):
  def hook(phase):self.source.write_bytes(b'unrelated source edit')
  self.assertRaises(m.Refusal,self.apply,hook);self.assertEqual(self.active.read_bytes(),self.before)
 def test_after_swap_error_restores_original(self):
  def hook(phase):
   if phase=='after-swap':raise OSError('injected')
  self.assertRaises(OSError,self.apply,hook);self.assertEqual(self.active.read_bytes(),self.before);self.assertEqual(self.active.stat().st_mode&0o777,0o640)
 def test_swap_commit_then_error_restores_original(self):
  original=m.atomic;calls=0
  def atomic(*args):
   nonlocal calls
   original(*args);calls+=1
   if calls==1:raise OSError('injected after replace')
  with patch.object(m,'atomic',side_effect=atomic):self.assertRaises(OSError,self.apply)
  self.assertEqual(self.active.read_bytes(),self.before)
 def test_after_swap_unrelated_edit_never_restored_over(self):
  def hook(phase):
   if phase=='after-swap':self.active.write_bytes(b'unrelated active edit');raise OSError('injected')
  self.assertRaises(m.Refusal,self.apply,hook);self.assertEqual(self.active.read_bytes(),b'unrelated active edit')
 def test_already_corrected_check_and_apply_refusal(self):
  self.active.write_bytes(self.after);self.assertEqual(m.inspect(self.active,self.source)[2]['sha256'],m.NEW_SHA);self.assertRaises(m.Refusal,self.apply);self.assertFalse(self.state.exists())
 def test_backup_cannot_overlap_input_config(self):self.state=self.config/'backup';self.assertRaises(m.Refusal,self.apply);self.assertFalse(self.state.exists())
 def test_writable_source_parent_refused(self):self.source_dir.chmod(0o777);self.assertRaises(m.Refusal,self.apply)
if __name__=='__main__':unittest.main()
