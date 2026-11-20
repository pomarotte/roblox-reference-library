"""Build the portable application with its saved metadata and search index."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import zipfile
from urllib.request import urlopen

from app import HERE
from setup_dataset import DATASET_URL

BUILD = HERE / '.release-build'
PORTABLE = BUILD / 'portable'
RELEASES = HERE / 'releases'
PYTHON_VERSION = '3.13.17'
NUMPY_VERSION = '2.3.5'


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def download(url, digest):
    folder = BUILD / 'downloads'
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / url.rsplit('/', 1)[1]
    if not target.is_file() or sha256(target) != digest:
        temporary = target.with_suffix(target.suffix + '.partial')
        print(f'Downloading {target.name}', flush=True)
        with urlopen(url, timeout=120) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        if sha256(temporary) != digest:
            raise ValueError(f'Checksum mismatch: {target.name}')
        temporary.replace(target)
    return target


def runtime():
    runtime_dir = PORTABLE / 'runtime'
    runtime_dir.mkdir(parents=True, exist_ok=True)
    with urlopen(f'https://www.python.org/ftp/python/{PYTHON_VERSION}/windows-{PYTHON_VERSION}.json', timeout=30) as response:
        releases = json.load(response)
    python = next(item for item in releases['versions'] if item['id'] == 'pythonembed-3.13-64')
    with zipfile.ZipFile(download(python['url'], python['hash']['sha256'])) as archive:
        archive.extractall(runtime_dir)
    with urlopen(f'https://pypi.org/pypi/numpy/{NUMPY_VERSION}/json', timeout=30) as response:
        packages = json.load(response)
    numpy = next(item for item in packages['urls'] if item['filename'].endswith('cp313-cp313-win_amd64.whl'))
    with zipfile.ZipFile(download(numpy['url'], numpy['digests']['sha256'])) as archive:
        archive.extractall(runtime_dir / 'Lib' / 'site-packages')
    (runtime_dir / 'python313._pth').write_text('python313.zip\n.\nLib/site-packages\n..\n', encoding='utf-8')
    provenance = {'python': {'version': PYTHON_VERSION, 'url': python['url'], 'sha256': python['hash']['sha256']},
                  'numpy': {'version': NUMPY_VERSION, 'url': numpy['url'], 'sha256': numpy['digests']['sha256']}}
    (PORTABLE / 'runtime-sources.json').write_text(json.dumps(provenance, indent=2) + '\n', encoding='utf-8')
    print('Portable Python and NumPy ready.', flush=True)


def application():
    RELEASES.mkdir(exist_ok=True)
    manifest = {'format': 1, 'created_at': datetime.now(timezone.utc).isoformat(), 'source_url': DATASET_URL, 'visual_index': 'clip-full-scene-palette-v2'}
    if not (PORTABLE / 'runtime' / 'python.exe').is_file():
        raise ValueError('Run build_release.py runtime first.')
    PORTABLE.mkdir(parents=True, exist_ok=True)
    sources = ['app.py', 'visual.py', 'app.js', 'index.html', 'style.css', 'logo.svg', 'rolibrary.svg', 'setup_dataset.py',
               'Start Gallery.cmd', 'START HERE.txt', 'README.md', 'LICENSE', 'NOTICE.md',
               'requirements-visual.txt', 'build_release.py', 'test_app.py', 'test_release.py']
    for name in sources:
        shutil.copyfile(HERE / name, PORTABLE / name)
    if not (HERE / 'search-index.npz').is_file():
        raise ValueError('The fast scene-search index has not been saved yet.')
    shutil.copyfile(HERE / 'search-index.npz', PORTABLE / 'search-index.npz')
    with closing(sqlite3.connect(HERE / 'library.sqlite3')) as original:
        with closing(sqlite3.connect(PORTABLE / 'library.sqlite3')) as snapshot, snapshot:
            original.backup(snapshot)
            pending = snapshot.execute("SELECT COUNT(*) FROM games WHERE status='pending'").fetchone()[0]
            missing = snapshot.execute('''SELECT COUNT(*) FROM images i LEFT JOIN image_vectors v ON v.image_id=i.id
                LEFT JOIN visual_embeddings e ON e.hash=v.hash WHERE v.error IS NULL
                AND (e.scene_embedding IS NULL OR e.palette IS NULL)''').fetchone()[0]
            if pending or missing:
                raise ValueError(f'Wait for the saved index to finish: {pending:,} games and {missing:,} refined images remain.')
            actual = dict(snapshot.execute('SELECT kind,COUNT(*) FROM images GROUP BY kind'))
            manifest['image_counts'] = actual
            snapshot.execute("UPDATE image_vectors SET error='Image could not be decoded.' WHERE error IS NOT NULL")
            snapshot.execute('UPDATE visual_embeddings SET embedding=scene_embedding WHERE scene_embedding IS NOT NULL')
            manifest['metadata'] = dict(snapshot.execute('SELECT status,COUNT(*) FROM games GROUP BY status'))
            if snapshot.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Database snapshot failed its integrity check.')
    manifest['cache_included'] = True
    (PORTABLE / 'collection.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    (RELEASES / 'collection.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    target = RELEASES / 'Roblox-Reference-Library-Windows-x64.zip'
    temporary = target.with_suffix('.zip.partial')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        paths = [PORTABLE / name for name in sources + ['collection.json', 'library.sqlite3', 'search-index.npz', 'runtime-sources.json']]
        paths += list((PORTABLE / 'runtime').rglob('*'))
        for path in sorted(paths):
            if path.is_file() and '__pycache__' not in path.parts and not path.name.endswith(('-wal', '-shm')):
                archive.write(path, path.relative_to(PORTABLE).as_posix())
    temporary.replace(target)
    files = [target]
    (RELEASES / 'SHA256SUMS.txt').write_text(''.join(f'{sha256(path)}  {path.name}\n' for path in files), encoding='ascii')
    shutil.copyfile(HERE / 'START HERE.txt', RELEASES / 'START HERE.txt')
    print(f'Application ready: {target.name} ({target.stat().st_size / 1024**2:.1f} MiB)', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step', choices=['runtime', 'app'])
    args = parser.parse_args()
    {'runtime': runtime, 'app': application}[args.step]()
