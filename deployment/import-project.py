#!/usr/bin/env python3
"""Safely import an authenticated Overleaf ZIP into a new isolated project directory."""
import argparse, hashlib, json, os, pathlib, shutil, stat, tempfile, zipfile
MAX_TOTAL=256*1024*1024
MAX_FILE=64*1024*1024
MAX_FILES=10000

def import_project(archive,destination,main='main.tex',project_id='local-import'):
    dest=pathlib.Path(destination).absolute()
    if dest.exists() or dest.is_symlink(): raise ValueError('Destination already exists; original project will not be overwritten')
    dest.parent.mkdir(parents=True,exist_ok=True)
    temporary=pathlib.Path(tempfile.mkdtemp(prefix='.rtex-import-',dir=dest.parent))
    try:
        total=0;seen=set();count=0;entries=[]
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                name=entry.filename
                if name=='.rtex-import.json':raise ValueError('Reserved import metadata path')
                if '\\' in name or '\0' in name or name.startswith('/') or any(p in ('.','..','') for p in name.rstrip('/').split('/')): raise ValueError('Unsafe ZIP path')
                rel=pathlib.PurePosixPath(name)
                if rel.parts[0].endswith(':'): raise ValueError('Unsafe drive path')
                if str(rel) in seen: raise ValueError('Duplicate ZIP entry')
                seen.add(str(rel));count+=1
                mode=(entry.external_attr>>16)&0xffff
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR)): raise ValueError('Special ZIP entries are not supported')
                if entry.flag_bits&1: raise ValueError('Encrypted ZIP entries are not supported')
                if count>MAX_FILES or entry.file_size>MAX_FILE or total+entry.file_size>MAX_TOTAL: raise ValueError('ZIP size budget exceeded')
                target=temporary.joinpath(*rel.parts)
                if entry.is_dir(): target.mkdir(parents=True,exist_ok=True);continue
                target.parent.mkdir(parents=True,exist_ok=True)
                written=0;digest=hashlib.sha256()
                with source.open(entry) as reader,target.open('xb') as writer:
                    while True:
                        chunk=reader.read(1024*1024)
                        if not chunk:break
                        written+=len(chunk);total+=len(chunk)
                        if written>MAX_FILE or total>MAX_TOTAL:raise ValueError('Expanded ZIP size budget exceeded')
                        writer.write(chunk);digest.update(chunk)
                if written!=entry.file_size:raise ValueError('ZIP entry size mismatch')
                target.chmod(0o600)
                entries.append({'path':str(rel),'bytes':written,'sha256':digest.hexdigest()})
        main_path=pathlib.PurePosixPath(main)
        if main_path.is_absolute() or '..' in main_path.parts or not temporary.joinpath(*main_path.parts).is_file():raise ValueError('Main source is missing')
        if not project_id or len(project_id)>128:raise ValueError('Invalid project identity')
        (temporary/'.rtex-import.json').write_text(json.dumps({'projectId':project_id,'main':main,'files':count,'bytes':total,'entries':entries},indent=2))
        temporary.rename(dest)
        return {'project':str(dest),'projectId':project_id,'main':main,'files':count,'bytes':total}
    except BaseException:
        shutil.rmtree(temporary,ignore_errors=True);raise

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive');parser.add_argument('destination');parser.add_argument('--main',default='main.tex');parser.add_argument('--project-id',required=True)
    args=parser.parse_args()
    print(json.dumps(import_project(args.archive,args.destination,args.main,args.project_id)))
