import importlib.util,pathlib,tempfile,unittest
from unittest import mock
spec=importlib.util.spec_from_file_location('patcher',pathlib.Path(__file__).parent.parent/'integration/source-patch/patch-editor.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class PatchTests(unittest.TestCase):
 def fixture(self,root):
  originals={
   module.EXTENSIONS+'index.ts':b'// original index\r\nthirdPartyExtensions(),\r\n',
   module.EXTENSIONS+'third-party-extensions.ts':b'''// original extension\nconst dispatchEvent = (extensions: Extension[]) => {\n detail: { CodeMirror, CodeMirrorVim, extensions },\n}\nexport const thirdPartyExtensions = (): Extension => {\n dispatchEvent(extensions)\n return [thirdPartyExtensionsConf.of(extensions), extensionLoaded]\n}\nconst extensionLoaded = ViewPlugin.define(view => {\n dispatchEvent(extensions)\n})\n''',
   'services/web/app/src/Features/Project/ProjectController.mjs':b'// original controller\nres.json({ project_id: projectId, entities })\n',
  }
  for relative,data in originals.items():
   file=root/relative;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(data);file.chmod(0o640)
  return originals
 def tree(self,root):return {str(p.relative_to(root)):(p.read_bytes(),p.stat().st_mode) for p in root.rglob('*') if p.is_file()}
 def test_check_makes_no_writes_and_apply_rollback_restores_exact_bytes(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);originals=self.fixture(root);before=self.tree(root)
   self.assertEqual(module.execute(root,check=True),3);self.assertEqual(self.tree(root),before)
   self.assertEqual(module.execute(root),3)
   for relative,data in originals.items():
    file=root/relative;self.assertEqual(file.read_bytes(),module.transform(relative,data));self.assertEqual(file.with_name(file.name+'.before-rtex').read_bytes(),data);self.assertEqual(file.stat().st_mode&0o777,0o640)
   patched=self.tree(root)
   with self.assertRaises(module.PatchError):module.execute(root,check=True)
   self.assertEqual(self.tree(root),patched)
   self.assertEqual(module.execute(root,rollback=True),3);self.assertEqual(self.tree(root),before)
   self.assertEqual(module.execute(root,check=True),3)
 def test_all_anchor_and_backup_checks_complete_before_any_write(self):
  for failure in ['last-anchor','existing-last-backup','duplicate-call','missing-dispatch-call']:
   with self.subTest(failure=failure),tempfile.TemporaryDirectory() as t:
    root=pathlib.Path(t);originals=self.fixture(root);last=root/list(originals)[-1];extension=root/(module.EXTENSIONS+'third-party-extensions.ts')
    if failure=='last-anchor':last.write_bytes(b'incompatible controller')
    elif failure=='existing-last-backup':last.with_name(last.name+'.before-rtex').write_bytes(b'not ours')
    elif failure=='duplicate-call':first=root/(module.EXTENSIONS+'index.ts');first.write_bytes(first.read_bytes()+b'thirdPartyExtensions(),')
    else:extension.write_bytes(extension.read_bytes().replace(b'dispatchEvent(extensions)',b'changedCall()',1))
    before=self.tree(root)
    with self.assertRaises(module.PatchError):module.execute(root)
    self.assertEqual(self.tree(root),before)
 def test_rollback_refuses_unrelated_source_changes_or_corrupt_backup_before_any_write(self):
  for failure in ['changed-source','changed-backup','missing-backup']:
   with self.subTest(failure=failure),tempfile.TemporaryDirectory() as t:
    root=pathlib.Path(t);originals=self.fixture(root);module.execute(root);file=root/list(originals)[-1];backup=file.with_name(file.name+'.before-rtex')
    if failure=='changed-source':file.write_bytes(file.read_bytes()+b'\n// unrelated later edit\n')
    elif failure=='changed-backup':backup.write_bytes(b'not a recognized original')
    else:backup.unlink()
    before=self.tree(root)
    with self.assertRaises(module.PatchError):module.execute(root,rollback=True)
    self.assertEqual(self.tree(root),before)
 def test_replace_failure_restores_all_pretransaction_sources(self):
  for rollback in [False,True]:
   with self.subTest(rollback=rollback),tempfile.TemporaryDirectory() as t:
    root=pathlib.Path(t);self.fixture(root)
    if rollback:module.execute(root)
    before=self.tree(root);replace=module.os.replace;calls=0
    def fail_second(source,target):
     nonlocal calls
     calls+=1
     if calls==2:raise OSError('simulated replacement failure')
     return replace(source,target)
    with mock.patch.object(module.os,'replace',side_effect=fail_second):
     with self.assertRaisesRegex(module.PatchError,'pre-transaction contents restored'):module.execute(root,rollback=rollback)
    self.assertEqual(self.tree(root),before);self.assertFalse(list(root.rglob('*.rtex-stage-*')))
 def test_failed_transaction_preserves_a_concurrent_unrelated_change(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);originals=self.fixture(root);first=root/next(iter(originals));replace=module.os.replace;calls=0
   def fail_after_concurrent_change(source,target):
    nonlocal calls
    calls+=1
    if calls==2:
     first.write_bytes(b'concurrent unrelated edit')
     raise OSError('simulated failure after concurrent source change')
    return replace(source,target)
   with mock.patch.object(module.os,'replace',side_effect=fail_after_concurrent_change):
    with self.assertRaisesRegex(module.PatchError,'incomplete; backups retained'):module.execute(root)
   self.assertEqual(first.read_bytes(),b'concurrent unrelated edit');self.assertEqual(len(list(root.rglob('*.before-rtex'))),3)
 def test_backup_creation_failure_never_changes_sources(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);self.fixture(root);before=self.tree(root);open_file=pathlib.Path.open
   def fail_backup(file,*args,**kwargs):
    if str(file).endswith('ProjectController.mjs.before-rtex'):raise OSError('simulated backup failure')
    return open_file(file,*args,**kwargs)
   with mock.patch.object(pathlib.Path,'open',new=fail_backup):
    with self.assertRaises(module.PatchError):module.execute(root)
   self.assertEqual(self.tree(root),before)
 def test_frontend_only_check_apply_rollback_leaves_backend_unread_and_untouched(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);originals=self.fixture(root)
   backend=root/'services/web/app/src/Features/Project/ProjectController.mjs'
   backend.write_bytes(b'unrelated installed backend without any expected anchor')
   before=self.tree(root)
   self.assertEqual(module.execute(root,check=True,frontend_only=True),2)
   self.assertEqual(self.tree(root),before)
   self.assertEqual(module.execute(root,frontend_only=True),2)
   self.assertEqual(backend.read_bytes(),before[str(backend.relative_to(root))][0])
   self.assertFalse(backend.with_name(backend.name+'.before-rtex').exists())
   self.assertEqual(len(list(root.rglob('*.before-rtex'))),2)
   self.assertEqual(module.execute(root,rollback=True,frontend_only=True),2)
   self.assertEqual(self.tree(root),before)
 def test_frontend_only_requires_no_backend_file_and_still_refuses_unrelated_editor_edits(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);self.fixture(root)
   (root/'services/web/app/src/Features/Project/ProjectController.mjs').unlink()
   self.assertEqual(module.execute(root,frontend_only=True),2)
   first=root/(module.EXTENSIONS+'index.ts');first.write_bytes(first.read_bytes()+b'// unrelated')
   before=self.tree(root)
   with self.assertRaises(module.PatchError):module.execute(root,rollback=True,frontend_only=True)
   self.assertEqual(self.tree(root),before)
if __name__=='__main__':unittest.main()
