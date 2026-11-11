#!/usr/bin/env python3
"""Preflight, apply, or roll back the exact reversible Overleaf trial source patch."""
import argparse
import os
from pathlib import Path
import stat
import tempfile

EXTENSIONS='services/web/frontend/js/features/source-editor/extensions/'
TRANSFORMS={
 EXTENSIONS+'index.ts':[
  ('thirdPartyExtensions(),','thirdPartyExtensions(options),',1),
 ],
 EXTENSIONS+'third-party-extensions.ts':[
  ('const dispatchEvent = (extensions: Extension[]) => {','const dispatchEvent = (extensions: Extension[], options: Record<string, any>) => {',1),
  ('detail: { CodeMirror, CodeMirrorVim, extensions },','detail: { CodeMirror, CodeMirrorVim, extensions, rtexDocumentId: options.currentDoc?.currentDoc?.doc_id ?? null },',1),
  ('export const thirdPartyExtensions = (): Extension => {','export const thirdPartyExtensions = (options: Record<string, any>): Extension => {',1),
  ('dispatchEvent(extensions)','dispatchEvent(extensions, options)',2),
  ('thirdPartyExtensionsConf.of(extensions), extensionLoaded]','thirdPartyExtensionsConf.of(extensions), extensionLoaded(options)]',1),
  ('const extensionLoaded = ViewPlugin.define(view => {','const extensionLoaded = (options: Record<string, any>) => ViewPlugin.define(view => {',1),
 ],
 'services/web/app/src/Features/Project/ProjectController.mjs':[
  ('res.json({ project_id: projectId, entities })',"res.json({ project_id: projectId, entities, rtexSettings: { rootDocId: String(project.rootDoc_id ?? ''), compiler: project.compiler } })",1),
 ],
}
class PatchError(Exception):pass

def transform(relative,data):
 try:text=data.decode('utf-8')
 except UnicodeDecodeError as error:raise PatchError('Source is not UTF-8: '+relative) from error
 if 'rtexDocumentId' in text or 'rtexSettings' in text:raise PatchError('Already patched or incompatible source: '+relative)
 for old,new,count in TRANSFORMS[relative]:
  actual=text.count(old)
  if actual!=count:raise PatchError(f'Unexpected anchor count in {relative}: expected {count}, found {actual}: {old!r}')
  text=text.replace(old,new)
 return text.encode('utf-8')

def safe_file(root,relative):
 file=root/relative
 for part in [file,*file.parents]:
  if part==root:break
  if part.is_symlink():raise PatchError('Source/backup symlinks are not supported: '+str(file))
 if not file.is_file():raise PatchError('Missing regular source/backup file: '+str(file))
 return file

def preflight(overleaf_root,rollback=False,frontend_only=False):
 root=Path(overleaf_root).resolve(strict=True)
 if not root.is_dir():raise PatchError('Expected an Overleaf source directory')
 plan=[]
 for relative in TRANSFORMS:
  if frontend_only and not relative.startswith(EXTENSIONS):continue
  file=safe_file(root,relative);backup=file.with_name(file.name+'.before-rtex')
  current=file.read_bytes()
  if rollback:
   safe_file(root,str(backup.relative_to(root)))
   original=backup.read_bytes();patched=transform(relative,original)
   if current!=patched:raise PatchError('Rollback refused: current source differs from our exact expected patch: '+relative)
   before,after=patched,original
  else:
   if backup.exists() or backup.is_symlink():raise PatchError('Backup already exists; no edits made: '+str(backup))
   before=current;after=transform(relative,current)
  plan.append({'file':file,'backup':backup,'before':before,'after':after,'mode':stat.S_IMODE(file.stat().st_mode)})
 return plan

def stage(file,data,mode):
 descriptor,name=tempfile.mkstemp(prefix='.'+file.name+'.rtex-stage-',dir=file.parent)
 temporary=Path(name)
 try:
  with os.fdopen(descriptor,'wb') as stream:
   stream.write(data);stream.flush();os.fsync(stream.fileno())
  temporary.chmod(mode)
  return temporary
 except BaseException:
  temporary.unlink(missing_ok=True);raise

def execute(overleaf_root,rollback=False,check=False,frontend_only=False):
 plan=preflight(overleaf_root,rollback=rollback,frontend_only=frontend_only)
 if check:return len(plan)
 staged=[];created_backups=[];replaced=[]
 try:
  # Stage every output before creating backups or changing a source file.
  for item in plan:staged.append(stage(item['file'],item['after'],item['mode']))
  for item in plan:
   if item['file'].read_bytes()!=item['before']:raise PatchError('Source changed after preflight; aborting')
   if rollback:
    if item['backup'].read_bytes()!=item['after']:raise PatchError('Backup changed after preflight; aborting')
   else:
    with item['backup'].open('xb') as stream:
     created_backups.append(item['backup']);stream.write(item['before']);stream.flush();os.fsync(stream.fileno())
    item['backup'].chmod(item['mode'])
  for item,temporary in zip(plan,staged):
   if item['file'].read_bytes()!=item['before']:raise PatchError('Source changed during transaction; aborting')
   os.replace(temporary,item['file']);replaced.append(item)
 except BaseException as original_error:
  recovery_errors=[]
  for item in reversed(replaced):
   try:
    if item['file'].read_bytes()!=item['after']:raise PatchError('Concurrent source change prevents safe recovery: '+str(item['file']))
    recovery=stage(item['file'],item['before'],item['mode'])
    try:os.replace(recovery,item['file'])
    finally:recovery.unlink(missing_ok=True)
   except BaseException as error:recovery_errors.append(str(error))
  if not recovery_errors:
   for backup in created_backups:backup.unlink(missing_ok=True)
  if recovery_errors:raise PatchError('Transaction incomplete; backups retained. '+ '; '.join(recovery_errors)) from original_error
  raise PatchError('Transaction aborted and original pre-transaction contents restored: '+str(original_error)) from original_error
 finally:
  for temporary in staged:temporary.unlink(missing_ok=True)
 if rollback:
  # Delete only the validated trial backups, after every source was restored successfully.
  for item in plan:item['backup'].unlink()
 return len(plan)

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('overleaf_root',type=Path)
 parser.add_argument('--frontend-only',action='store_true',help='Select only the two editor identity files; leave the existing web backend untouched and use the authenticated settings provider')
 mode=parser.add_mutually_exclusive_group();mode.add_argument('--check',action='store_true',help='Validate all exact anchors and absence of backups without writing anything');mode.add_argument('--rollback',action='store_true',help='Restore our validated backups only if every current source matches its expected patch')
 args=parser.parse_args()
 try:count=execute(args.overleaf_root,rollback=args.rollback,check=args.check,frontend_only=args.frontend_only)
 except (PatchError,OSError) as error:parser.exit(1,str(error)+'\n')
 if args.check:print(f'Preflight passed for {count} files; no writes made')
 elif args.rollback:print(f'Restored {count} original files; validated trial backups removed')
 else:print(f'Patched {count} files; .before-rtex backups retained')
if __name__=='__main__':main()
