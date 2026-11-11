#!/usr/bin/env python3
"""Build only an isolated copy of a known Overleaf frontend with both patches."""
import argparse,importlib.util,json,subprocess,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.dont_write_bytecode=True
def module(name,file):
 s=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def prepare(source,stage):
 staging=module('frontend_staging',HERE/'stage-frontend-build.py')
 legacy=module('frontend_identity',HERE.parent/'integration/source-patch/patch-editor.py')
 native=module('frontend_native',HERE.parent/'integration/source-patch/patch-native-bridge.py')
 # Both transformations must be authorized before copying or writing anything.
 plan=legacy.preflight(source,frontend_only=True)
 native.preflight(source)
 # Check that the identity transform's index is also an explicitly allowed tuple.
 index=next(p for p in plan if str(p['file']).endswith('/extensions/index.ts'))
 if native.digest(index['after']) not in native.SOURCE_PROFILES:raise ValueError('Combined identity/native source profile is not audited')
 dependency=staging.prepare(source,stage)
 try:
  legacy.execute(stage/'source',frontend_only=True)
  native.execute(stage/'source')
 except BaseException:
  # Keep the new isolated build directory for diagnosis; production was never written.
  raise
 return dependency

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--stage',type=Path,required=True);p.add_argument('--prepare',action='store_true');p.add_argument('--install',action='store_true');p.add_argument('--build',action='store_true');a=p.parse_args()
 if a.prepare:print(json.dumps({'prepared':True,'dependencies':prepare(a.source.resolve(strict=True),a.stage.absolute())}))
 command=[sys.executable,'-B',str(HERE/'stage-frontend-build.py'),'--source',str(a.source),'--trial',str(a.stage)]
 if a.install:subprocess.run(command+['--install'],check=True)
 if a.build:subprocess.run(command+['--build'],check=True)
 if not any([a.prepare,a.install,a.build]):p.error('Select --prepare, --install or --build')
if __name__=='__main__':main()
