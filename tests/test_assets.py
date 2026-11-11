import importlib.util,json,pathlib,tempfile,unittest
spec=importlib.util.spec_from_file_location('assets',pathlib.Path(__file__).parents[1]/'deployment/verify-staged-assets.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Assets(unittest.TestCase):
 def fixture(self,root):
  source=root/'public';(source/'js').mkdir(parents=True);(source/'js/new.js').write_text('const x={rtexDocumentId:"captured"};')
  before=root/'before.json';before.write_text(json.dumps({'main.js':'/js/old.js'}))
  after=root/'after.json';after.write_text(json.dumps({'main.js':'/rtex-app-assets/js/new.js'}))
  return before,after,source
 def test_hashes_real_files_and_requires_compiled_identity_marker(self):
  with tempfile.TemporaryDirectory() as d:
   before,after,source=self.fixture(pathlib.Path(d));result=module.verify(before,after,source)
   self.assertEqual(result['verifiedFiles'],1);self.assertEqual(result['identityMarkerFiles'],['js/new.js']);self.assertFalse(result['activated'])
   (source/'js/new.js').write_text('unpatched build')
   with self.assertRaises(ValueError):module.verify(before,after,source)
 def test_missing_scoped_coverage_and_symlink_rejected(self):
  for kind in ['missing-key','unscoped','missing-file','symlink']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as d:
    before,after,source=self.fixture(pathlib.Path(d))
    if kind=='missing-key':after.write_text(json.dumps({'other.js':'/rtex-app-assets/js/new.js'}))
    elif kind=='unscoped':after.write_text(json.dumps({'main.js':'/js/new.js'}))
    elif kind=='missing-file':(source/'js/new.js').unlink()
    else:
     (source/'js/new.js').unlink();outside=pathlib.Path(d)/'outside.js';outside.write_text('rtexDocumentId');(source/'js/new.js').symlink_to(outside)
    with self.assertRaises(ValueError):module.verify(before,after,source)
 def test_recognized_entrypoints_and_rejected_unscoped_or_unknown_metadata(self):
  with tempfile.TemporaryDirectory() as d:
   before,after,source=self.fixture(pathlib.Path(d))
   b=json.loads(before.read_text());a=json.loads(after.read_text())
   b['entrypoints']={'main':{'assets':{'js':['/js/old.js']}}};a['entrypoints']={'main':{'assets':{'js':['/rtex-app-assets/js/new.js']}}}
   before.write_text(json.dumps(b));after.write_text(json.dumps(a));self.assertEqual(module.verify(before,after,source)['verifiedFiles'],1)
   (source/'fonts').mkdir();(source/'fonts/NotoSerif[wght]-hash.woff2').write_bytes(b'font')
   b['fonts/NotoSerif[wght].woff2']='/fonts/NotoSerif[wght]-old.woff2';a['fonts/NotoSerif[wght].woff2']='/rtex-app-assets/fonts/NotoSerif[wght]-hash.woff2'
   before.write_text(json.dumps(b));after.write_text(json.dumps(a));self.assertEqual(module.verify(before,after,source)['verifiedFiles'],2)
   for metadata in [{'main':{'assets':{'js':['https://evil.example/a.js']}}},{'main':{'unexpected':[]}},{'main':{'assets':{'js':['/rtex-app-assets/js/unknown.js']}}}]:
    after.write_text(json.dumps({**a,'entrypoints':metadata}))
    with self.assertRaises(ValueError):module.verify(before,after,source)
 def test_numeric_hashed_keys_map_by_exact_chunk_identity_and_entrypoint_position(self):
  before={'main.js':'/js/main-old.js','stylesheets/6698-aaaaaaaa.css':'/stylesheets/6698-aaaaaaaa.css'}
  after={'main.js':'/rtex-app-assets/js/main-new.js','stylesheets/6698-bbbbbbbb.css':'/rtex-app-assets/stylesheets/6698-bbbbbbbb.css'}
  pairs=module.entry_mapping(before,after)
  self.assertEqual(pairs['/stylesheets/6698-aaaaaaaa.css'],'/rtex-app-assets/stylesheets/6698-bbbbbbbb.css')
  with self.assertRaises(ValueError):module.entry_mapping(before,{**after,'stylesheets/6698-cccccccc.css':'/rtex-app-assets/stylesheets/6698-cccccccc.css'})
  with self.assertRaises(ValueError):module.entry_mapping({'named.js':'/js/main-old.js'},after)
  with tempfile.TemporaryDirectory() as d:
   b=pathlib.Path(d)/'before.json';a=pathlib.Path(d)/'after.json'
   b.write_text(json.dumps({'entrypoints':{'main':{'assets':{'js':['/js/main-old.js'],'css':['/stylesheets/6698-aaaaaaaa.css']}}}}))
   a.write_text(json.dumps({'entrypoints':{'main':{'assets':{'js':['/rtex-app-assets/js/main-new.js'],'css':['/rtex-app-assets/stylesheets/6698-bbbbbbbb.css']}}}}))
   module.check_entrypoint_positions(b,a,pairs)
   a.write_text(json.dumps({'entrypoints':{'main':{'assets':{'js':['/rtex-app-assets/js/wrong.js'],'css':['/rtex-app-assets/stylesheets/6698-bbbbbbbb.css']}}}}))
   with self.assertRaises(ValueError):module.check_entrypoint_positions(b,a,pairs)
if __name__=='__main__':unittest.main()
