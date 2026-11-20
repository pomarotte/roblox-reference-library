"""Export the saved collection as a static, browser-only gallery. Never reads images."""
import argparse
from contextlib import closing, contextmanager
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
from urllib.request import urlopen
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
RELEASE_URL = 'https://github.com/pomarotte/roblox-reference-library/releases/download/v0.1.0/Roblox-Reference-Library-Windows-x64.zip'
RELEASE_SHA256 = '0304116829f096926f3c8dad65d04412c9dd758ef08a837ceec3a793c60eb95d'


def build(cache, output, extend=None):
    import numpy as np
    cache, output = Path(cache), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    data_dir = output / 'data'
    data_dir.mkdir(exist_ok=True)
    with closing(sqlite3.connect(f'{(cache / "library.sqlite3").resolve().as_uri()}?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        if db.execute("SELECT COUNT(*) FROM games WHERE status='pending'").fetchone()[0]:
            raise ValueError('Finish metadata collection before exporting the website.')
        games = [dict(row) for row in db.execute('SELECT id,name,genre,subgenre,visits,status,fetched_at FROM games ORDER BY id')]
        by_id = {g['id']: g for g in games}
        images = [dict(row) for row in db.execute('SELECT id,game_id,kind,filename,captured FROM images ORDER BY id')]
    links_path = HERE / 'web' / 'game-links.json.gz'
    links = json.loads(gzip.decompress(links_path.read_bytes()))['places'] if links_path.is_file() else {}
    for game in games:
        game['images'] = []
        place_id = links.get(str(game['id']))
        if place_id is not None and (type(place_id) is not int or not 0 < place_id < 2**53):
            raise ValueError('Invalid saved game-page ID.')
        game['root_place_id'] = place_id
    for image in images:
        by_id[image.pop('game_id')]['images'].append(image)
    with np.load(cache / 'search-index.npz', allow_pickle=False) as index:
        ids = index['image_ids']
        if not np.array_equal(ids, [i['id'] for i in images]):
            raise ValueError('The visual index must cover every image in catalogue order.')
        scenes, palettes = index['scenes'], index['palettes']
        if scenes.shape != (len(images), 512) or palettes.shape != (len(images), 48):
            raise ValueError('Unexpected visual feature dimensions.')
        if extend:
            scenes, palettes = extend(games, images, scenes, palettes)
            if len(scenes) != len(images) or len(palettes) != len(images):
                raise ValueError('Daily images and visual features do not align.')
        parts = []
        for start in range(0, len(images), 8192):
            block = np.concatenate((scenes[start:start + 8192], palettes[start:start + 8192]), axis=1)
            compressed = gzip.compress(block.astype('<f2').tobytes(), compresslevel=6, mtime=0)
            digest = hashlib.sha256(compressed).hexdigest()
            filename = f'scenes-{start}-{digest[:12]}.bin.gz'
            (data_dir / filename).write_bytes(compressed)
            parts.append({'url': f'data/{filename}', 'rows': len(block), 'bytes': len(compressed), 'sha256': digest})
    catalogue = {'schema': 1, 'games': games, 'image_count': len(images), 'visual': {'dimensions': 560, 'parts': parts}}
    raw = json.dumps(catalogue, separators=(',', ':'), ensure_ascii=False).encode()
    compressed_catalogue = gzip.compress(raw, mtime=0)
    catalogue_name = f'catalog.{hashlib.sha256(compressed_catalogue).hexdigest()[:12]}.json.gz'
    (data_dir / catalogue_name).write_bytes(compressed_catalogue)
    for filename in ('LICENSE', 'NOTICE.md'):
        shutil.copyfile(HERE / filename, output / filename)
    assets = {'catalog.json.gz': catalogue_name}
    for filename in ('web-core.mjs', 'search-worker.js', 'collections.js', 'web-host.js', 'app.js', 'style.css', 'web.css'):
        source = HERE / filename if filename in ('app.js', 'style.css') else HERE / 'web' / filename
        content = source.read_text(encoding='utf-8')
        for original, hashed in assets.items():
            content = content.replace(original, hashed)
        digest = hashlib.sha256(content.encode()).hexdigest()[:12]
        hashed = f'{source.stem}.{digest}{source.suffix}'
        (output / hashed).write_text(content, encoding='utf-8')
        assets[filename] = hashed
    html = (HERE / 'index.html').read_text(encoding='utf-8')
    html = html.replace('href="/style.css"', 'href="./style.css"').replace('href="/"', 'href="./"')
    html = html.replace('<script src="/app.js" defer></script>', '<link rel="stylesheet" href="./web.css">\n  <script src="./collections.js" defer></script>\n  <script src="./web-host.js" defer></script>\n  <script src="./app.js" defer></script>')
    html = html.replace('<input id="search" type="search" placeholder="Game name or universe ID" autocomplete="off">', '<input id="search" type="search" placeholder="Game name or universe ID" autocomplete="off"><button id="upload-search" class="secondary" type="button">Search by image</button><input id="upload-input" type="file" accept="image/*" hidden>')
    html = html.replace('<section class="sync-panel"', (HERE / 'web' / 'setup.html').read_text(encoding='utf-8') + '\n    <section class="sync-panel"', 1)
    html = html.replace('<section class="sync-panel"', '<section hidden class="sync-panel"')
    html = html.replace('<section class="visual-panel"', '<section hidden class="visual-panel"')
    html = html.replace('>Stop gallery</button>', '>Disconnect folder</button>')
    html = html.replace('<button id="reveal"', '<button hidden id="reveal"')
    html = html.replace('<body>', '<body class="web-disconnected">')
    html = html.replace('Games still waiting for metadata appear when no metadata filters are applied.', 'Choose your dataset folder above to show its saved images.')
    html = html.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src \'self\' blob:; script-src \'self\' \'wasm-unsafe-eval\' https://cdn.jsdelivr.net; style-src \'self\'; connect-src \'self\' https://cdn.jsdelivr.net https://huggingface.co https://*.hf.co; worker-src \'self\' blob:; object-src \'none\'; base-uri \'self\'; form-action \'none\'">\n</head>')
    for original, hashed in assets.items():
        html = html.replace(original, hashed)
    (output / 'index.html').write_text(html, encoding='utf-8')
    (output / '.nojekyll').write_text('')
    print(f'Built {len(games):,} games / {len(images):,} images. No image files copied. Visual download: {sum(p["bytes"] for p in parts) / 1048576:.1f} MiB.')


@contextmanager
def release_cache():
    with tempfile.TemporaryDirectory() as folder:
        cache = Path(folder)
        archive = cache / 'app.zip'
        digest = hashlib.sha256()
        with urlopen(RELEASE_URL, timeout=60) as response, archive.open('wb') as target:
            while block := response.read(1024 * 1024):
                digest.update(block)
                target.write(block)
        if digest.hexdigest() != RELEASE_SHA256:
            raise ValueError('Release checksum mismatch; refusing to build.')
        with ZipFile(archive) as saved:
            for name in ('library.sqlite3', 'search-index.npz'):
                with saved.open(name) as source, (cache / name).open('wb') as target:
                    shutil.copyfileobj(source, target)
        yield cache


def from_release(output):
    with release_cache() as cache:
        build(cache, output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=HERE)
    parser.add_argument('--output', type=Path, default=HERE / '.web-build')
    parser.add_argument('--from-release', action='store_true')
    args = parser.parse_args()
    if args.from_release:
        from_release(args.output)
    else:
        build(args.cache, args.output)


