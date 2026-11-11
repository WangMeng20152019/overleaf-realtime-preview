import hashlib,importlib.util,json,pathlib,tempfile,unittest
spec=importlib.util.spec_from_file_location('attach',pathlib.Path(__file__).parents[1]/'deployment/attach-trusted-launcher.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Attach(unittest.TestCase):
 def fixture(self,root):
  root=root.resolve()
  assets=root/'public/rtex-app-assets';(assets/'js/pages').mkdir(parents=True);file=assets/'js/pages/ide-aaaaaaaa.js';file.write_bytes(b'// verified staged IDE\n');manifest=assets/'manifest.json';manifest.write_text(json.dumps({'pages/ide.js':'/rtex-app-assets/js/pages/ide-aaaaaaaa.js','entrypoints':{'ide':{'assets':{'js':['/rtex-app-assets/js/pages/ide-aaaaaaaa.js']}}}}));return assets,manifest,file
 def test_content_hashed_new_entry_updates_all_url_references_without_mutation(self):
  with tempfile.TemporaryDirectory() as d:
   assets,manifest,file=self.fixture(pathlib.Path(d));raw=manifest.read_bytes();old=file.read_bytes();plan=m.prepare(assets,manifest,m.sha(raw),m.sha(old))
   self.assertEqual(file.read_bytes(),old);self.assertEqual(manifest.read_bytes(),raw);self.assertFalse(plan['newFile'].exists())
   output=json.loads(plan['after']);self.assertEqual(output['pages/ide.js'],plan['newURL']);self.assertEqual(output['entrypoints']['ide']['assets']['js'],[plan['newURL']]);self.assertIn(b"import('/rtex-test/integration.js')",plan['updated']);self.assertIn(m.sha(plan['updated'])[:20],plan['newFile'].name)
 def test_changed_sha_or_unscoped_manifest_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   assets,manifest,file=self.fixture(pathlib.Path(d))
   with self.assertRaises(ValueError):m.prepare(assets,manifest,'0'*64,m.sha(file.read_bytes()))
   manifest.write_text(json.dumps({'pages/ide.js':'/js/pages/ide-aaaaaaaa.js'}))
   with self.assertRaises(ValueError):m.prepare(assets,manifest,m.sha(manifest.read_bytes()),m.sha(file.read_bytes()))
if __name__=='__main__':unittest.main()
