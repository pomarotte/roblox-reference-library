"""Capture Roblox charts and publish a matching catalogue and visual index."""
import argparse
from contextlib import closing
from datetime import date, datetime, timezone
import hashlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import shutil
import tempfile

import numpy as np
from build_cloud import HERE, GALLERY, build_cloud
from visual import MODEL, REVISION, palette_features, scene_image

DEFAULT_COLLECTOR = HERE / 'collector.py'
if not DEFAULT_COLLECTOR.is_file():
    DEFAULT_COLLECTOR = Path.home() / 'Downloads/roblox_daily_collector_fair_queue/collector.py'
DEFAULT_RCLONE = next((Path.home() / 'Downloads').glob('rclone-*/rclone-*/rclone.exe'), 'rclone')
REMOTE = os.environ.get('DAILY_R2_REMOTE', 'roblox-thumbnails-upload:roblox-thumbnails')


def capture(script, state, limit):
    spec = importlib.util.spec_from_file_location('chart_collector', script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = state
    module.DATA = state
    module.DB_FILE = state / 'dataset.sqlite3'
    module.IMAGES = state / 'images'
    module.EXPORT = state / 'exports'
    module.FLAT_EXPORT = state / 'flat'
    collector = module.Collector(argparse.Namespace(
        request_delay=.4, cloud_mode=True, max_image_mb=12, batch_size=20, thumbs_per_game=20))
    collector.open_database()
    db = collector.db
    try:
        previous_thumbnails = db.execute("SELECT COUNT(*) FROM game_images WHERE kind='thumbnail' AND first_seen=?", (collector.day,)).fetchone()[0]
        db.execute('CREATE TABLE IF NOT EXISTS metadata (universe_id INTEGER PRIMARY KEY, genre TEXT, subgenre TEXT)')
        sorts = collector.request_json(module.ROBLOX + '/explore-api/v1/get-sorts',
                                       {'sessionId': collector.session_id, 'device': 'computer', 'country': 'all'})
        ids = set()
        for sort in sorts['sorts']:
            if not sort.get('sortDisplayName') or not sort.get('sortId'):
                continue
            content = collector.request_json(module.ROBLOX + '/explore-api/v1/get-sort-content',
                {'sessionId': collector.session_id, 'device': 'computer', 'country': 'all', 'sortId': sort['sortId']})
            ids.update(module.extract_universe_ids(content))
        if not ids:
            raise RuntimeError('Roblox returned no chart games.')
        selected = sorted(ids)[:limit or None]
        print(f'Checking {len(selected)} of {len(ids)} games in public Roblox charts.', flush=True)
        db.executemany('''INSERT INTO games(universe_id,first_discovered,last_discovered) VALUES (?,?,?)
                          ON CONFLICT(universe_id) DO UPDATE SET last_discovered=excluded.last_discovered''',
                       [(uid, collector.day, collector.day) for uid in selected])
        db.commit()
        for group in module.chunks(selected, 40):
            response = collector.request_json(module.GAMES + '/v1/games', {'universeIds': ','.join(map(str,group))})
            for game in response['data']:
                if game['id'] not in group:
                    continue
                db.execute('UPDATE games SET name=?, visits=?, root_place_id=? WHERE universe_id=?',
                           (game.get('name'), game.get('visits'), game.get('rootPlaceId'), game['id']))
                db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?,?)',
                           (game['id'], game.get('genre_l1') or 'Unknown', game.get('genre_l2') or 'Unknown'))
            db.commit()
        collector.collect_images(selected)
        if collector.errors:
            raise RuntimeError(f'{collector.errors} collection errors. The last published catalogue is still available.')
        if not db.execute('SELECT 1 FROM observations WHERE observed_date=? LIMIT 1', (collector.day,)).fetchone():
            raise RuntimeError('No chart images were observed.')
        current_thumbnails = db.execute("SELECT COUNT(*) FROM game_images WHERE kind='thumbnail' AND first_seen=?", (collector.day,)).fetchone()[0]
        if current_thumbnails > previous_thumbnails:
            db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
                       ('thumbnail_update_' + collector.day, datetime.now(timezone.utc).isoformat(timespec='seconds')))
            db.commit()
        return collector.day
    finally:
        db.close()
        collector.session.close()


def encode_images(paths):
    from PIL import Image
    import torch
    from transformers import CLIPImageProcessor, CLIPVisionModelWithProjection

    torch.set_num_threads(4)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if device == 'cuda' else torch.float32
    options = dict(revision=REVISION, cache_dir=GALLERY / 'models')
    processor = CLIPImageProcessor.from_pretrained(MODEL, **options)
    model = CLIPVisionModelWithProjection.from_pretrained(MODEL, **options).to(device=device, dtype=dtype).eval()
    background = tuple(round(x * 255) for x in processor.image_mean)
    print(f'Indexing {len(paths)} new image files on {device}.', flush=True)
    for start in range(0, len(paths), 16):
        batch = paths[start:start + 16]
        scenes, palettes = [], []
        for path in batch:
            with Image.open(path) as source, source.convert('RGB') as rgb:
                scenes.append(scene_image(rgb, background=background))
                palettes.append(palette_features(rgb))
        try:
            pixels = processor(images=scenes, return_tensors='pt', do_resize=False, do_center_crop=False)['pixel_values']
            with torch.inference_mode():
                vectors = model(pixel_values=pixels.to(device=device, dtype=dtype)).image_embeds.float()
                vectors = torch.nn.functional.normalize(vectors, dim=-1).cpu().numpy().astype('<f2')
            if vectors.shape != (len(batch), 512) or not np.isfinite(vectors).all():
                raise ValueError('Invalid visual features.')
            yield from zip((vector.tobytes() for vector in vectors), palettes)
        finally:
            for scene in scenes:
                scene.close()


def prepare_assets(state, rclone, encode=encode_images):
    with closing(sqlite3.connect(state / 'dataset.sqlite3')) as db, db:
        db.execute('''CREATE TABLE IF NOT EXISTS indexed_assets (
            sha256 TEXT PRIMARY KEY, object_key TEXT NOT NULL, scene BLOB NOT NULL, palette BLOB NOT NULL)''')
        rows = db.execute('''SELECT sha256,relative_path FROM assets a WHERE NOT EXISTS (
            SELECT 1 FROM indexed_assets i WHERE i.sha256=a.sha256) ORDER BY sha256''').fetchall()
        if not rows:
            return
        staging = state / 'upload'
        staging.mkdir(exist_ok=True)
        files = []
        for digest, relative in rows:
            source = (state / relative).resolve()
            if not source.is_relative_to(state.resolve()) or hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                raise ValueError('Collector image failed hash verification.')
            target = staging / (digest + source.suffix)
            if not target.exists():
                os.link(source, target)
            files.append(target)
        vectors = list(encode(files))
        if len(vectors) != len(rows):
            raise ValueError('Missing visual features.')
        subprocess.run([str(rclone), 'copy', str(staging), REMOTE + '/daily',
                        '--s3-no-check-bucket', '--transfers', '4'], check=True)
        db.executemany('INSERT INTO indexed_assets VALUES (?,?,?,?)',
                       [(row[0], f'daily/{file.name}', *vector)
                        for row, file, vector in zip(rows, files, vectors)])
        db.commit()
        for file in files:
            file.unlink()


def merge_daily(database, day, games, images, scenes, palettes, historical_images):
    day = date.fromisoformat(day).isoformat()
    game_map = {game['id']: game for game in games}
    historical_games = set(game_map)
    used_ids = {image['id'] for image in images}
    additions = []
    with closing(sqlite3.connect(database)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute('''SELECT gi.*, g.name,g.visits,g.root_place_id,m.genre,m.subgenre,
                   i.object_key,i.scene,i.palette,
                   MIN(gi.first_seen) OVER (PARTITION BY gi.universe_id) AS game_first_seen,
                   EXISTS(SELECT 1 FROM observations o WHERE o.observed_date=? AND
                     o.universe_id=gi.universe_id AND o.kind=gi.kind AND o.sha256=gi.sha256) AS latest
            FROM game_images gi JOIN games g USING(universe_id)
            LEFT JOIN metadata m USING(universe_id)
            LEFT JOIN indexed_assets i USING(sha256)''', (day,))
        for row in rows:
            uid, kind, digest = row['universe_id'], row['kind'], row['sha256']
            if not row['object_key']:
                raise ValueError('A daily image has not been indexed and uploaded.')
            game = game_map.get(uid)
            if game is None:
                game = dict(id=uid, name=None, genre=None, subgenre=None, visits=None, fetched_at=None,
                            status='unavailable', root_place_id=None, images=[])
                games.append(game)
                game_map[uid] = game
            if row['name']:
                game.update(name=row['name'], status='ready', fetched_at=row['last_seen'])
                for field in ('genre', 'subgenre', 'visits', 'root_place_id'):
                    if row[field] is not None and (row[field] != 'Unknown' or not game[field]):
                        game[field] = row[field]
            key = hashlib.sha256(f'{uid}:{kind}:{digest}'.encode()).hexdigest()
            image_id = (1 << 52) + int(key[:13], 16)
            if image_id in used_ids:
                raise ValueError('Daily image ID collision.')
            used_ids.add(image_id)
            category = None
            if row['latest'] and row['first_seen'] == day:
                if uid not in historical_games and row['game_first_seen'] == day:
                    category = 'new-games'
                elif (uid, kind, digest) not in historical_images:
                    category = 'new-images'
            image = dict(id=image_id, kind={'icon': 'icons', 'thumbnail': 'thumbs'}[kind],
                         filename=f'{uid}_{kind}_{digest}{Path(row["object_key"]).suffix}',
                         captured=row['first_seen'].replace('-', '') + '_000000',
                         object_key=row['object_key'], daily_category=category)
            game['images'].append(image)
            additions.append((image, row['scene'], row['palette']))
    additions.sort(key=lambda item: item[0]['id'])
    if not additions:
        return scenes, palettes
    images.extend(image for image, _, _ in additions)
    return (np.concatenate((scenes, np.stack([np.frombuffer(s, '<f2') for _, s, _ in additions]))),
            np.concatenate((palettes, np.stack([np.frombuffer(p, '<f2') for _, _, p in additions]))))


def publish(output, database, day, cache):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect((cache / 'library.sqlite3').resolve().as_uri() + '?mode=ro', uri=True)) as archive:
        historical_images = set(archive.execute("""
            SELECT i.game_id, CASE i.kind WHEN 'icons' THEN 'icon' ELSE 'thumbnail' END, v.hash
            FROM images i JOIN image_vectors v ON v.image_id=i.id
            WHERE v.hash IS NOT NULL
        """))
    with tempfile.TemporaryDirectory(dir=output.parent) as stage:
        stage = Path(stage)
        build_cloud(stage, extend=lambda *data: merge_daily(database, day, *data, historical_images), cache=cache)
        with closing(sqlite3.connect(database)) as daily:
            latest_day = daily.execute("SELECT MAX(first_seen) FROM game_images WHERE kind='thumbnail'").fetchone()[0]
            row = daily.execute("SELECT value FROM settings WHERE key=?", ('thumbnail_update_' + str(latest_day),)).fetchone()
        if row:
            stamp = datetime.fromisoformat(row[0]).astimezone(timezone.utc)
            if stamp.date().isoformat() == latest_day:
                page = stage / 'index.html'
                html = page.read_text(encoding='utf-8')
                html = html.replace('id="last-updated" hidden', f'id="last-updated" data-time="{stamp.strftime("%H:%M")} UTC" hidden')
                page.write_text(html, encoding='utf-8')
        for asset in stage.iterdir():
            if asset.is_dir():
                shutil.copytree(asset, output / asset.name, dirs_exist_ok=True)
            elif asset.name != 'index.html':
                shutil.copy2(asset, output / asset.name)
        (stage / 'index.html').replace(output / 'index.html')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collector', type=Path, default=DEFAULT_COLLECTOR)
    parser.add_argument('--state', type=Path, default=HERE / 'daily-state')
    parser.add_argument('--output', type=Path, default=HERE / 'dist')
    parser.add_argument('--rclone', default=DEFAULT_RCLONE)
    parser.add_argument('--limit', type=int, default=0, help='Test with this many chart games; 0 checks all.')
    parser.add_argument('--rebuild-day', help='Publish a previously captured date without running discovery.')
    parser.add_argument('--cache', type=Path, default=GALLERY, help='Historical database and saved visual index.')
    args = parser.parse_args()
    if args.limit < 0:
        parser.error('--limit must be nonnegative')
    args.state.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(args.state / 'run-lock.sqlite3', timeout=0)) as lock:
        lock.execute('BEGIN EXCLUSIVE')
        day = args.rebuild_day or capture(args.collector, args.state.resolve(), args.limit)
        prepare_assets(args.state, args.rclone)
        publish(args.output, args.state / 'dataset.sqlite3', day, args.cache)
    print(f'Preview updated with chart captures for {day}.', flush=True)


if __name__ == '__main__':
    main()

