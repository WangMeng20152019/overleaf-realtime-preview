#!/usr/bin/env python3
"""Bind a fresh isolated ZIP import to an authenticated Overleaf project tree snapshot."""
import argparse,hashlib,json,pathlib,re,shutil,tempfile
IDENTITY=re.compile(r'^[a-fA-F0-9]{24}$')

def prepare(snapshot,import_root,project_id,main_override=None,base_url='/rtex-test/'):
    if not IDENTITY.fullmatch(project_id):raise ValueError('Expected an explicit 24-character Overleaf project ID')
    if not isinstance(snapshot,dict):raise ValueError('Expected a project object or {project: object}')
    flat=snapshot.get('kind')=='overleaf-dom-tree-v1'
    if 'kind' in snapshot and not flat:raise ValueError('Unsupported snapshot kind')
    project={'_id':snapshot.get('projectId'),'rootDoc_id':snapshot.get('mainDocId')} if flat else snapshot.get('project',snapshot)
    if not isinstance(project,dict) or project.get('_id')!=project_id:raise ValueError('Authenticated snapshot project ID mismatch')
    root=pathlib.Path(import_root)
    manifest=json.loads((root/'.rtex-import.json').read_text())
    if manifest.get('projectId')!=project_id or not isinstance(manifest.get('entries'),list):raise ValueError('Import identity or hash manifest missing')
    def identifier(value):
        if not isinstance(value,str) or not IDENTITY.fullmatch(value):raise ValueError('Invalid Overleaf entity ID')
        return value
    def name(value):
        if not isinstance(value,str) or not value or value in ('.','..') or '/' in value or '\\' in value or '\0' in value:raise ValueError('Unsafe entity name')
        return value
    roots=project.get('rootFolder')
    if not flat:
        if isinstance(roots,list):
            if len(roots)!=1:raise ValueError('Expected exactly one rootFolder')
            roots=roots[0]
        if not isinstance(roots,dict):raise ValueError('Missing rootFolder tree')
    seen_ids=set();paths={}
    def walk(folder,prefix='',is_root=False):
        if not isinstance(folder,dict):raise ValueError('Invalid folder')
        folder_id=identifier(folder.get('_id'))
        if folder_id in seen_ids:raise ValueError('Duplicate entity ID')
        seen_ids.add(folder_id)
        if not is_root:prefix=prefix+name(folder.get('name'))+'/'
        for key,kind in [('docs','doc'),('fileRefs','file')]:
            entries=folder.get(key,[])
            if not isinstance(entries,list):raise ValueError('Invalid tree collection')
            for entity in entries:
                if not isinstance(entity,dict):raise ValueError('Invalid tree entity')
                eid=identifier(entity.get('_id'));p=prefix+name(entity.get('name'))
                if eid in seen_ids or p in paths:raise ValueError('Duplicate entity ID or path')
                seen_ids.add(eid);paths[p]={'path':p,'id':eid,'type':kind}
        children=folder.get('folders',[])
        if not isinstance(children,list):raise ValueError('Invalid folders collection')
        sibling_names=set()
        for child in children:
            child_name=name(child.get('name'))
            if child_name in sibling_names or prefix+child_name in paths:raise ValueError('Duplicate folder or file path')
            sibling_names.add(child_name);walk(child,prefix)
    if flat:
        # Explicit DOM provenance schema: no invented root/folder identity. Completeness
        # is established below against the entire imported ZIP file/hash manifest.
        if not isinstance(snapshot.get('entities'),list) or not snapshot['entities']:raise ValueError('Missing complete DOM file inventory')
        for entity in snapshot['entities']:
            if not isinstance(entity,dict):raise ValueError('Invalid DOM entity')
            eid=identifier(entity.get('id'));p=entity.get('path');kind=entity.get('type')
            if not isinstance(p,str) or p.startswith('/') or '\\' in p or '\0' in p or any(part in ('','.','..') for part in p.split('/')):raise ValueError('Unsafe DOM entity path')
            if kind not in ('doc','file'):raise ValueError('DOM inventory must contain files/documents only')
            if eid in seen_ids or p in paths:raise ValueError('Duplicate DOM entity ID or path')
            seen_ids.add(eid);paths[p]={'path':p,'id':eid,'type':kind}
        for p in paths:
            if any('/'.join(p.split('/')[:i]) in paths for i in range(1,len(p.split('/')))):raise ValueError('DOM file/folder path collision')
        identifier(snapshot.get('mainDocId'))
    else:walk(roots,is_root=True)
    entries={}
    for entry in manifest['entries']:
        p=entry.get('path')
        if not isinstance(p,str) or p.startswith('/') or '\\' in p or any(part in ('','.','..') for part in p.split('/')) or p in entries:raise ValueError('Invalid imported path')
        if p not in paths:raise ValueError('Imported file missing from authenticated tree: '+p)
        target=root.joinpath(*p.split('/'));resolved=target.resolve()
        if root.resolve() not in resolved.parents or any(root.joinpath(*p.split('/')[:n]).is_symlink() for n in range(1,len(p.split('/'))+1)):raise ValueError('Imported file symlink escape')
        data=target.read_bytes()
        if len(data)!=entry.get('bytes') or hashlib.sha256(data).hexdigest()!=entry.get('sha256'):raise ValueError('Imported source/resource hash mismatch: '+p)
        entries[p]=entry
    if set(paths)!=set(entries):raise ValueError('Authenticated tree and imported ZIP file set differ')
    documents={};resources=[]
    for p,entity in paths.items():
        if p.lower().endswith('.tex'):
            if entity['type']!='doc':raise ValueError('Editable .tex source must be an Overleaf document')
            documents[entity['id']]=p
        else:resources.append(entity)
    root_doc=project.get('rootDoc_id')
    if flat and documents.get(root_doc) is None:raise ValueError('DOM mainDocId is not a mapped .tex document')
    if main_override:
        if main_override not in documents.values():raise ValueError('Explicit main is not a known source')
        if flat and main_override!=documents.get(root_doc):raise ValueError('Explicit main differs from verified DOM main')
        main=main_override
    else:
        main=documents.get(identifier(root_doc))
        if not main:raise ValueError('rootDoc_id is not an imported .tex document; supply --main explicitly')
    if manifest.get('main')!=main:raise ValueError('Import main differs from authenticated main; reimport with correct --main')
    if not isinstance(base_url,str) or not base_url.startswith('/') or base_url.startswith('//') or not base_url.endswith('/') or '?' in base_url or '#' in base_url or '\\' in base_url or '\0' in base_url or any(part in ('.','..','') for part in base_url.strip('/').split('/')):raise ValueError('Expected an explicit same-origin base path ending in /')
    return documents,{'projectId':project_id,'main':main,'baseURL':base_url,'resourceMap':sorted(resources,key=lambda e:e['path'])}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('snapshot');parser.add_argument('import_root');parser.add_argument('output_directory');parser.add_argument('--project-id',required=True);parser.add_argument('--main');parser.add_argument('--base-url',default='/rtex-test/')
    args=parser.parse_args();docs,config=prepare(json.loads(pathlib.Path(args.snapshot).read_text()),args.import_root,args.project_id,args.main,args.base_url)
    out=pathlib.Path(args.output_directory).absolute()
    if out.exists() or out.is_symlink():raise ValueError('Configuration destination already exists')
    out.parent.mkdir(parents=True,exist_ok=True)
    staging=pathlib.Path(tempfile.mkdtemp(prefix='.rtex-binding-',dir=out.parent))
    try:
        staging.chmod(0o700)
        for filename,value in [('document-map.json',docs),('project-config.json',config)]:
            target=staging/filename
            with target.open('x') as f:json.dump(value,f,indent=2);f.write('\n')
            target.chmod(0o600)
        staging.rename(out)
    except BaseException:
        shutil.rmtree(staging,ignore_errors=True);raise
    print(json.dumps({'documents':len(docs),'resources':len(config['resourceMap']),'main':config['main'],'output':str(out)}))
