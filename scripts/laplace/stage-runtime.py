"""Stage a relocatable feasibility runtime from a reviewed Laplace build environment.

Run with that environment's Python. Copies only distribution-owned files and tracked
Laplace inputs, never local credentials, logs, editable-install hooks or training data.
This records a local build; release wheel/source reproducibility is a separate gate.
"""
import argparse
import hashlib
import importlib.metadata as metadata
import json
import pathlib
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
REVISION = '8b4173dfdabff12e9228310ba25e3fd2ed5117df'
PYTHON_SHA = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def stage(source):
    from packaging.requirements import Requirement
    if sys.platform != 'win32' or sys.version_info[:2] != (3, 12):
        raise RuntimeError('Use the reviewed Windows x64 Python 3.12 build environment.')
    if git(source, 'rev-parse', 'HEAD') != REVISION or git(source, 'status', '--porcelain'):
        raise RuntimeError('Laplace source must be clean at the pinned revision.')
    destination = ROOT / 'vendor/laplace/dist'
    if destination.exists():
        raise RuntimeError('Runtime already exists; preserve it or move it before staging another build.')
    destination.mkdir(parents=True)
    archive = ROOT / 'out/laplace/python-3.12.10-embed-amd64.zip'
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        urllib.request.urlretrieve('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', archive)
    if digest(archive) != PYTHON_SHA:
        raise RuntimeError('Embedded Python archive checksum mismatch.')
    python = destination / 'python'
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(python)
    (python / 'python312._pth').write_text('python312.zip\n.\nLib/site-packages\n../laplace/src\nimport site\n', encoding='utf-8')
    site = python / 'Lib/site-packages'
    site.mkdir(parents=True)
    versions = {}
    pending = ['poke-env', 'poke-engine', 'torch', 'numpy']
    while pending:
        name = pending.pop().lower().replace('_', '-')
        if name in versions:
            continue
        distribution = metadata.distribution(name)
        versions[name] = distribution.version
        for dependency in distribution.requires or []:
            requirement = Requirement(dependency)
            if requirement.marker is None or requirement.marker.evaluate({'extra': ''}):
                pending.append(requirement.name)
        for file in distribution.files or []:
            relative = pathlib.PurePosixPath(str(file).replace('\\', '/'))
            if '..' in relative.parts or relative.suffix in ('.pyc', '.pth') or '__pycache__' in relative.parts:
                continue
            original = pathlib.Path(distribution.locate_file(file))
            if not original.is_file():
                continue
            target = site / str(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, target)
    for name in git(source, 'ls-files', 'src', 'data', 'models/value_net.pt', 'LICENSE', 'pyproject.toml', 'README.md').splitlines():
        target = destination / 'laplace' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
    # Source package metadata is needed for diagnostics without editable-install hooks.
    info = site / 'laplace-1.1.0.dist-info'
    info.mkdir()
    (info / 'METADATA').write_text('Metadata-Version: 2.1\nName: laplace\nVersion: 1.1.0\n', encoding='utf-8')
    sets = pathlib.Path('server/data/random-battles/gen9/sets.json')
    (destination / 'laplace' / sets).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / sets, destination / 'laplace' / sets)
    manifest = {'version': 1, 'purpose': 'local feasibility build', 'laplaceRevision': REVISION,
                'python': '3.12.10', 'pythonArchiveSha256': PYTHON_SHA, 'packages': versions,
                'files': {str(p.relative_to(destination)).replace('\\', '/'): digest(p)
                          for p in sorted(destination.rglob('*')) if p.is_file()}}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'runtime': str(destination), 'packages': versions,
                      'bytes': sum(p.stat().st_size for p in destination.rglob('*') if p.is_file())}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=pathlib.Path, required=True)
    stage(parser.parse_args().source.resolve())
