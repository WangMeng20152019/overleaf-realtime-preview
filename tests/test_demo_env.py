import base64,importlib.util,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('demo_env',Path(__file__).resolve().parents[1]/'deployment/demo-env.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class DemoEnvTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.output=self.root/'.env'
 def tearDown(self):self.temp.cleanup()
 def test_official_32byte_standard_base64_contract_and_private_mode(self):
  with patch.object(m.secrets,'token_bytes',return_value=bytes(range(32)))as random:
   result=m.generate(self.output);random.assert_called_once_with(32)
  line=self.output.read_text();key,value=line.rstrip('\n').split('=',1);self.assertEqual(key,m.KEY);self.assertEqual(base64.b64decode(value,validate=True),bytes(range(32)));self.assertEqual(len(value),44);self.assertEqual(self.output.stat().st_mode&0o777,0o600);self.assertFalse(result['secretPrinted'])
 def test_existing_secret_never_rotated_or_chmodded(self):
  self.output.write_bytes(b'keep this existing content');self.output.chmod(0o640)
  with patch.object(m.secrets,'token_bytes')as random:self.assertRaises(FileExistsError,m.generate,self.output);random.assert_not_called()
  self.assertEqual(self.output.read_bytes(),b'keep this existing content');self.assertEqual(self.output.stat().st_mode&0o777,0o640)
 def test_dangling_output_symlink_refused(self):
  outside=self.root/'outside';self.output.symlink_to(outside);self.assertRaises(FileExistsError,m.generate,self.output);self.assertFalse(outside.exists());self.assertTrue(self.output.is_symlink())
 def test_symlink_parent_refused(self):
  alias=self.root/'alias';actual=self.root/'actual';actual.mkdir();alias.symlink_to(actual,target_is_directory=True);self.assertRaises(m.Refusal,m.generate,alias/'.env');self.assertFalse((actual/'.env').exists())
 def test_group_writable_parent_refused(self):
  self.root.chmod(0o770);self.assertRaises(m.Refusal,m.generate,self.output);self.assertFalse(self.output.exists())
 def test_parent_owned_by_another_user_refused(self):
  with patch.object(m.os,'geteuid',return_value=os.geteuid()+1):self.assertRaises(m.Refusal,m.generate,self.output)
  self.assertFalse(self.output.exists())
 def test_random_failure_cleans_only_its_new_file(self):
  with patch.object(m.secrets,'token_bytes',side_effect=OSError('failure')):self.assertRaises(OSError,m.generate,self.output)
  self.assertFalse(self.output.exists())
 def test_mode_is_private_even_with_permissive_umask(self):
  previous=os.umask(0)
  try:m.generate(self.output)
  finally:os.umask(previous)
  self.assertEqual(self.output.stat().st_mode&0o777,0o600)
 def test_cli_never_prints_generated_secret_and_refuses_second_run(self):
  command=[sys.executable,'-B',str(Path(m.__file__)),'--output',str(self.output)];first=subprocess.run(command,capture_output=True,text=True);self.assertEqual(first.returncode,0)
  value=self.output.read_text().strip().split('=',1)[1];self.assertNotIn(value,first.stdout+first.stderr)
  before=self.output.read_bytes();second=subprocess.run(command,capture_output=True,text=True);self.assertNotEqual(second.returncode,0);self.assertEqual(self.output.read_bytes(),before);self.assertNotIn(value,second.stdout+second.stderr)
if __name__=='__main__':unittest.main()
