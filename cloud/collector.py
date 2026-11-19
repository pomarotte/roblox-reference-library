#!/usr/bin/env python3
"""Daily Roblox icon/thumbnail collector, with exact-byte deduplication."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import os
import random
import shutil
import sqlite3
import sys
import tempfile
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
DB_FILE = DATA / 'dataset.sqlite3'
EXPORT = DATA / 'exports'
IMAGES = DATA / 'images'
FLAT_EXPORT = ROOT / 'roblox-icons-thumbnails'
ROBLOX = 'https://apis.roblox.com'
THUMBNAILS = 'https://thumbnails.roblox.com'
GAMES = 'https://games.roblox.com'

# Core searches run daily. Extra searches rotate to find less popular games.
CORE_TERMS = [
    'simulator', 'obby', 'tycoon', 'horror', 'roleplay', 'survival',
    'anime', 'tower defense', 'brainrot', 'escape', 'fighting', 'racing',
]
ROTATING_TERMS = [
    'adventure', 'story', 'sports', 'football', 'basketball', 'soccer',
    'parkour', 'pvp', 'shooter', 'fps', 'zombie', 'tower', 'city', 'fashion',
    'dress to impress', 'pets', 'obby but', 'grow', 'steal', 'collect',
    'hunting', 'fishing', 'mining', 'factory', 'driving', 'cars', 'bikes',
    'train', 'plane', 'restaurant', 'school', 'hospital', 'house', 'hotel',
    'prison', 'police', 'detective', 'murder mystery', 'find', 'build',
    'battle', 'arena', 'rpg', 'mmorpg', 'strategy', 'idle', 'clicker',
    'incremental', 'puzzle', 'puzzles', 'monster', 'ghost', 'scary',
    'co-op', 'multiplayer', 'hangout', 'social', 'rp', 'life', 'cafe',
    'farm', 'garden', 'trading', 'luck', 'rng', 'random', 'drawing',
    'music', 'rhythm', 'party', 'minigame', 'speedrun', 'speed',
    'obby race', 'escape room', 'cart', 'boat', 'tank', 'battle royale',
    'park', 'theme park', 'rollercoaster', 'quest', 'questing',
    'winter', 'christmas', '2026', 'new', 'update', 'event',
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def chunks(values: Iterable[int], count: int) -> Iterable[list[int]]:
    values = list(values)
    for i in range(0, len(values), count):
        yield values[i:i + count]


def recursive_values(data: Any, target: str):
    if isinstance(data, dict):
        for key, value in data.items():
            if key == target:
                yield value
            if isinstance(value, (dict, list)):
                yield from recursive_values(value, target)
    elif isinstance(data, list):
        for item in data:
            yield from recursive_values(item, target)


def extract_universe_ids(data: Any) -> set[int]:
    # Never treat generic "id" or a Roblox placeId as a universeId.
    results = set()
    for raw in recursive_values(data, 'universeId'):
        if isinstance(raw, (int, str)) and str(raw).isdigit():
            value = int(raw)
            if value > 0:
                results.add(value)
    return results


def next_page_token(payload: Any) -> str | None:
    for token in recursive_values(payload, 'nextPageToken'):
        if isinstance(token, str) and token:
            return token
    return None


def session_factory() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=4, backoff_factor=2,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=('GET',), respect_retry_after_header=True,
    )
    session.mount('https://', HTTPAdapter(max_retries=retry, pool_maxsize=5))
    session.headers.update({'User-Agent': 'RobloxDailyImageCollector/1.0 (personal research)'})
    return session


class Collector:
    def __init__(self, args, session=None):
        self.args = args
        self.session = session or session_factory()
        self.db = None
        self.day = datetime.now(timezone.utc).date().isoformat()
        self.started = utc_now()
        self.capture_stamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
        self.session_id = str(uuid.uuid4())
        self.errors = 0
        self.new_files = 0
        self.new_links = 0
        self.discovered = 0

    def open_database(self):
        IMAGES.mkdir(parents=True, exist_ok=True)
        EXPORT.mkdir(parents=True, exist_ok=True)
        (FLAT_EXPORT / 'icons').mkdir(parents=True, exist_ok=True)
        (FLAT_EXPORT / 'thumbs').mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(DB_FILE)
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY, value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS games (
                universe_id INTEGER PRIMARY KEY,
                name TEXT, root_place_id INTEGER, creator_name TEXT,
                created TEXT, updated TEXT, playing INTEGER, visits INTEGER,
                first_discovered TEXT NOT NULL, last_discovered TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS assets (
                sha256 TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE,
                size_bytes INTEGER NOT NULL,
                first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS game_images (
                universe_id INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('icon','thumbnail')),
                sha256 TEXT NOT NULL,
                first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
                PRIMARY KEY (universe_id, kind, sha256),
                FOREIGN KEY (universe_id) REFERENCES games(universe_id),
                FOREIGN KEY (sha256) REFERENCES assets(sha256)
            );
            CREATE TABLE IF NOT EXISTS observations (
                observed_date TEXT NOT NULL, universe_id INTEGER NOT NULL,
                kind TEXT NOT NULL, sha256 TEXT NOT NULL, slot INTEGER NOT NULL,
                PRIMARY KEY (observed_date, universe_id, kind, sha256),
                FOREIGN KEY (universe_id) REFERENCES games(universe_id)
            );
            CREATE TABLE IF NOT EXISTS url_cache (
                url TEXT PRIMARY KEY, sha256 TEXT NOT NULL,
                FOREIGN KEY (sha256) REFERENCES assets(sha256)
            );
            CREATE TABLE IF NOT EXISTS flat_exports (
                universe_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                export_path TEXT NOT NULL UNIQUE,
                PRIMARY KEY(universe_id,kind,sha256),
                FOREIGN KEY (universe_id,kind,sha256)
                    REFERENCES game_images(universe_id,kind,sha256)
            );
            CREATE INDEX IF NOT EXISTS idx_flat_exports_sha ON flat_exports(sha256);
            CREATE TABLE IF NOT EXISTS runs (
                day TEXT PRIMARY KEY, started TEXT NOT NULL, ended TEXT NOT NULL,
                new_files INTEGER NOT NULL, new_links INTEGER NOT NULL,
                tracked_games INTEGER NOT NULL, errors INTEGER NOT NULL
            );
        ''')
        # Migrate an existing Drive database without losing its dedupe history.
        existing = {row[1] for row in self.db.execute('PRAGMA table_info(games)')}
        if 'last_checked' not in existing:
            self.db.execute('ALTER TABLE games ADD COLUMN last_checked TEXT')
        if 'scan_count' not in existing:
            self.db.execute(
                'ALTER TABLE games ADD COLUMN scan_count INTEGER NOT NULL DEFAULT 0'
            )
        self.db.execute(
            "INSERT OR IGNORE INTO settings(key,value) VALUES('first_day',?)",
            (self.day,),
        )
        self.db.commit()

    def closed_for_collection(self):
        started = self.db.execute(
            "SELECT value FROM settings WHERE key='first_day'"
        ).fetchone()[0]
        elapsed = (date.fromisoformat(self.day) - date.fromisoformat(started)).days
        if elapsed >= self.args.days:
            logging.info('FINISHED: collection started %s and reached %s days.', started, self.args.days)
            return True
        completed = self.db.execute('SELECT 1 FROM runs WHERE day=?', (self.day,)).fetchone()
        if completed and not self.args.force:
            logging.info('Already completed today (%s). Use --force to rescan.', self.day)
            return True
        return False

    def request_json(self, url, params=None):
        time.sleep(self.args.request_delay)
        response = self.session.get(url, params=params, timeout=45)
        response.raise_for_status()
        return response.json()

    def discover(self):
        ids = set()
        source_ok = 0
        try:
            result = self.request_json(
                ROBLOX + '/explore-api/v1/get-sorts',
                {'sessionId': self.session_id, 'device': 'computer', 'country': 'all'},
            )
            sorts = result.get('sorts', []) if isinstance(result, dict) else []
            sort_ids = {s.get('sortId') or s.get('token') for s in sorts if isinstance(s, dict)}
            sort_ids.discard(None)
            # Game IDs may also be embedded directly in the sorts response.
            ids.update(extract_universe_ids(result))
            source_ok += 1
            for sort_id in sorted(sort_ids):
                try:
                    content = self.request_json(
                        ROBLOX + '/explore-api/v1/get-sort-content',
                        {'sessionId': self.session_id, 'sortId': sort_id,
                         'device': 'computer', 'country': 'all'},
                    )
                    ids.update(extract_universe_ids(content))
                except (requests.RequestException, ValueError) as exc:
                    self.errors += 1
                    logging.warning('Chart %s failed: %s', sort_id, exc)
        except (requests.RequestException, ValueError) as exc:
            self.errors += 1
            logging.warning('Roblox charts unavailable: %s', exc)

        # Rotate additional terms. The core terms are searched every run.
        started = date.fromisoformat(
            self.db.execute("SELECT value FROM settings WHERE key='first_day'").fetchone()[0]
        )
        offset = max(0, (date.fromisoformat(self.day) - started).days)
        rotated = [ROTATING_TERMS[(offset * self.args.extra_terms + i) % len(ROTATING_TERMS)]
                   for i in range(self.args.extra_terms)]
        terms = list(dict.fromkeys(CORE_TERMS + rotated))
        for term in terms:
            page_token = None
            for page in range(self.args.search_pages):
                try:
                    params = {'searchQuery': term, 'sessionId': self.session_id, 'pageType': 'all'}
                    if page_token:
                        params['pageToken'] = page_token
                    result = self.request_json(ROBLOX + '/search-api/omni-search', params)
                    ids.update(extract_universe_ids(result))
                    source_ok += 1
                    next_token = next_page_token(result)
                    if not next_token or next_token == page_token:
                        break
                    page_token = next_token
                except (requests.RequestException, ValueError) as exc:
                    self.errors += 1
                    logging.warning('Search %r page %s failed: %s', term, page + 1, exc)
                    break

        # Optional personal universe-ID list for specific games to always watch.
        seeds = ROOT / 'seed_universe_ids.txt'
        if seeds.exists():
            for line in seeds.read_text(encoding='utf-8').splitlines():
                entry = line.split('#', 1)[0].strip()
                if entry.isdigit():
                    ids.add(int(entry))
        if source_ok == 0 and not ids:
            logging.error('Every discovery source failed; previously tracked games will still be scanned.')
        logging.info('Discovered %s universe IDs from current sources.', len(ids))
        self.discovered = len(ids)
        for uid in ids:
            self.db.execute('''
                INSERT INTO games(universe_id, first_discovered, last_discovered)
                VALUES (?,?,?)
                ON CONFLICT(universe_id) DO UPDATE SET last_discovered=excluded.last_discovered
            ''', (uid, self.day, self.day))
        self.db.commit()
        return ids

    def game_metadata(self, game_ids):
        for batch in chunks(game_ids, 40):
            try:
                result = self.request_json(GAMES + '/v1/games', {
                    'universeIds': ','.join(map(str, batch)),
                })
                for game in result.get('data', []):
                    uid = game.get('id')
                    if not uid:
                        continue
                    creator = game.get('creator') or {}
                    self.db.execute('''
                        UPDATE games SET name=?, root_place_id=?, creator_name=?,
                        created=?, updated=?, playing=?, visits=?
                        WHERE universe_id=?
                    ''', (game.get('name'), game.get('rootPlaceId'),
                          creator.get('name'), game.get('created'), game.get('updated'),
                          game.get('playing'), game.get('visits'), uid))
                self.db.commit()
            except (requests.RequestException, ValueError) as exc:
                self.errors += 1
                logging.warning('Metadata batch failed: %s', exc)

    @staticmethod
    def image_extension(raw: bytes) -> str | None:
        if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
            return '.webp'
        if raw.startswith(b'\x89PNG\r\n\x1a\n'):
            return '.png'
        if raw.startswith(b'\xff\xd8\xff'):
            return '.jpg'
        if raw.startswith((b'GIF87a', b'GIF89a')):
            return '.gif'
        return None

    def fetch_image(self, url):
        cached = self.db.execute('SELECT sha256 FROM url_cache WHERE url=?', (url,)).fetchone()
        if cached:
            row = self.db.execute('SELECT relative_path FROM assets WHERE sha256=?', cached).fetchone()
            if row and (self.args.cloud_mode or (DATA / row[0]).is_file()):
                # Cloud runners only restore the database, not historic images.
                # A cached CDN URL already represents a known content hash.
                return cached[0]

        # Roblox returns content-addressed CDN URLs; cache only exact URLs.
        # URLs are public. Do not send any Roblox login cookie.
        host = (urlparse(url).hostname or '').lower()
        if not (host == 'rbxcdn.com' or host.endswith('.rbxcdn.com') or
                host == 'roblox.com' or host.endswith('.roblox.com')):
            logging.warning('Skipped unexpected image URL host: %s', host)
            return None

        time.sleep(self.args.request_delay)
        with self.session.get(url, timeout=60, stream=True) as response:
            response.raise_for_status()
            h = hashlib.sha256()
            prefix = bytearray()
            size = 0
            fd, temp_name = tempfile.mkstemp(prefix='roblox-img-', suffix='.tmp', dir=DATA)
            try:
                import os
                with os.fdopen(fd, 'wb') as output:
                    for block in response.iter_content(chunk_size=65536):
                        if not block:
                            continue
                        if len(prefix) < 16:
                            prefix.extend(block[:16 - len(prefix)])
                        size += len(block)
                        if size > self.args.max_image_mb * 1024 * 1024:
                            raise ValueError('Image larger than max-image-mb')
                        h.update(block)
                        output.write(block)
                extension = self.image_extension(bytes(prefix))
                if not extension or size < 100:
                    raise ValueError('Response is not a usable image')
                digest = h.hexdigest()
                relative = Path('images') / digest[:2] / f'{digest}{extension}'
                target = DATA / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                present = self.db.execute('SELECT 1 FROM assets WHERE sha256=?', (digest,)).fetchone()
                if present and self.args.cloud_mode:
                    # This asset already lives on Drive. Do not re-stage its bytes.
                    Path(temp_name).unlink(missing_ok=True)
                    temp_name = ''
                elif not target.is_file():
                    shutil.move(temp_name, target)
                    temp_name = ''
                if not present:
                    self.db.execute('''
                        INSERT INTO assets(sha256,relative_path,size_bytes,first_seen,last_seen)
                        VALUES (?,?,?,?,?)
                    ''', (digest, relative.as_posix(), size, self.day, self.day))
                    self.new_files += 1
                self.db.execute('''
                    INSERT INTO url_cache(url,sha256) VALUES (?,?)
                    ON CONFLICT(url) DO UPDATE SET sha256=excluded.sha256
                ''', (url, digest))
                return digest
            finally:
                if temp_name:
                    Path(temp_name).unlink(missing_ok=True)

    def record_image(self, uid: int, kind: str, url: str, slot: int):
        try:
            digest = self.fetch_image(url)
            if not digest:
                return
            existing = self.db.execute('''
                SELECT 1 FROM game_images WHERE universe_id=? AND kind=? AND sha256=?
            ''', (uid, kind, digest)).fetchone()
            if not existing:
                self.new_links += 1
            self.db.execute('''
                UPDATE assets SET last_seen=? WHERE sha256=?
            ''', (self.day, digest))
            self.db.execute('''
                INSERT INTO game_images(universe_id,kind,sha256,first_seen,last_seen)
                VALUES (?,?,?,?,?)
                ON CONFLICT(universe_id,kind,sha256)
                DO UPDATE SET last_seen=excluded.last_seen
            ''', (uid, kind, digest, self.day, self.day))
            self.db.execute('''
                INSERT INTO observations(observed_date,universe_id,kind,sha256,slot)
                VALUES (?,?,?,?,?)
                ON CONFLICT(observed_date,universe_id,kind,sha256)
                DO UPDATE SET slot=MIN(observations.slot, excluded.slot)
            ''', (self.day, uid, kind, digest, slot))
        except (requests.RequestException, ValueError, OSError) as exc:
            self.errors += 1
            logging.warning('Image %s %s failed: %s', uid, kind, exc)

    def collect_images(self, game_ids):
        for index, batch in enumerate(chunks(game_ids, self.args.batch_size), 1):
            errors_before_batch = self.errors
            icons_ok = False
            thumbs_ok = False
            params = {'universeIds': ','.join(map(str, batch)),
                      'format': 'Webp', 'isCircular': 'false'}
            try:
                icons = self.request_json(THUMBNAILS + '/v1/games/icons', {
                    **params, 'size': '256x256',
                })
                icons_ok = isinstance(icons.get('data'), list)
                for item in icons.get('data', []):
                    if item.get('state') == 'Completed' and item.get('imageUrl'):
                        uid = item.get('targetId')
                        if uid in batch:
                            self.record_image(uid, 'icon', item['imageUrl'], 0)
            except (requests.RequestException, ValueError) as exc:
                self.errors += 1
                logging.warning('Icons batch %s failed: %s', index, exc)
            try:
                thumbs = self.request_json(THUMBNAILS + '/v1/games/multiget/thumbnails', {
                    **params, 'size': '768x432',
                    'defaults': 'false', 'countPerUniverse': self.args.thumbs_per_game,
                })
                thumbs_ok = isinstance(thumbs.get('data'), list)
                for game in thumbs.get('data', []):
                    uid = game.get('universeId')
                    if uid not in batch:
                        continue
                    for slot, item in enumerate(game.get('thumbnails') or []):
                        if item.get('state') == 'Completed' and item.get('imageUrl'):
                            self.record_image(uid, 'thumbnail', item['imageUrl'], slot)
            except (requests.RequestException, ValueError) as exc:
                self.errors += 1
                logging.warning('Thumbnails batch %s failed: %s', index, exc)
            # A failed batch remains due for retry. Merely appearing on a chart
            # never advances the last-checked timestamp.
            if icons_ok and thumbs_ok and self.errors == errors_before_batch:
                self.db.executemany('''
                    UPDATE games SET last_checked=?, scan_count=scan_count+1
                    WHERE universe_id=?
                ''', [(self.day, uid) for uid in batch])
            self.db.commit()
            if index % 10 == 0:
                logging.info('Processed %s of %s games, %s new image files',
                             min(index * self.args.batch_size, len(game_ids)),
                             len(game_ids), self.new_files)

    def sync_flat_export(self):
        """Create just icons/ and thumbs/ inside the user-facing image export.

        The SHA-based backing store remains separate under data/images.
        Hardlinks avoid duplicate disk usage when the filesystem supports them.
        Also works for data collected by earlier versions of the script.
        """
        (FLAT_EXPORT / 'icons').mkdir(parents=True, exist_ok=True)
        (FLAT_EXPORT / 'thumbs').mkdir(parents=True, exist_ok=True)
        rows = self.db.execute('''
            SELECT gi.universe_id, gi.kind, gi.sha256, gi.first_seen,
                   a.relative_path, fe.export_path
            FROM game_images gi
            JOIN assets a ON gi.sha256 = a.sha256
            LEFT JOIN flat_exports fe
              ON fe.universe_id=gi.universe_id AND fe.kind=gi.kind
                AND fe.sha256=gi.sha256
            ORDER BY gi.universe_id, gi.kind, gi.first_seen, gi.sha256
        ''').fetchall()
        created = 0
        missing = 0
        for uid, kind, digest, first_seen, source_rel, saved_export in rows:
            source = DATA / source_rel
            if saved_export and (self.args.cloud_mode or (ROOT / saved_export).is_file()):
                continue
            if self.args.cloud_mode:
                # Globally unique Drive dataset: 1 file per SHA-256, even when
                # different games or image slots reuse exactly the same bytes.
                already_exported = self.db.execute(
                    'SELECT 1 FROM flat_exports WHERE sha256=? LIMIT 1',
                    (digest,),
                ).fetchone()
                if already_exported:
                    continue
            if not source.is_file():
                missing += 1
                logging.warning('Original image missing, cannot export %s: %s', uid, source)
                continue
            folder = 'icons' if kind == 'icon' else 'thumbs'
            extension = source.suffix.lower()
            # Older databases did not capture time, only the first_seen date.
            stamp = (self.capture_stamp if first_seen == self.day else
                     first_seen.replace('-', '') + '_000000')
            slot_row = self.db.execute('''
                SELECT slot FROM observations
                WHERE universe_id=? AND kind=? AND sha256=?
                ORDER BY observed_date, slot LIMIT 1
            ''', (uid, kind, digest)).fetchone()
            slot = slot_row[0] if slot_row else 0
            candidate_time = datetime.strptime(stamp, '%Y%m%d_%H%M%S')
            if saved_export:
                target = ROOT / saved_export
            else:
                while True:
                    timestamp = candidate_time.strftime('%Y%m%d_%H%M%S')
                    suffix = f'_{slot}' if kind == 'thumbnail' else ''
                    filename = f'{uid}_{timestamp}{suffix}{extension}'
                    target = FLAT_EXPORT / folder / filename
                    used_in_database = self.db.execute(
                        'SELECT 1 FROM flat_exports WHERE export_path=?',
                        (target.relative_to(ROOT).as_posix(),),
                    ).fetchone()
                    if not target.exists() and not used_in_database:
                        break
                    candidate_time += timedelta(seconds=1)
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    try:
                        os.link(source, target)
                    except OSError:
                        shutil.copy2(source, target)
            except OSError as exc:
                self.errors += 1
                logging.warning('Could not create flat image %s: %s', target, exc)
                continue
            relative = target.relative_to(ROOT).as_posix()
            self.db.execute('''
                INSERT INTO flat_exports(universe_id,kind,sha256,export_path)
                VALUES (?,?,?,?)
                ON CONFLICT(universe_id,kind,sha256)
                DO UPDATE SET export_path=excluded.export_path
            ''', (uid, kind, digest, relative))
            created += 1
        self.db.commit()
        logging.info('Flat export: %s files added/restored, %s sources missing.',
                     created, missing)

    def export_csv(self):
        exports = {
            'games.csv': '''
                SELECT universe_id,name,root_place_id,creator_name,created,updated,
                       playing,visits,first_discovered,last_discovered,
                       last_checked,scan_count FROM games
                ORDER BY universe_id''',
            'unique_images.csv': '''
                SELECT gi.universe_id,g.name,gi.kind,gi.sha256,a.relative_path,
                       a.size_bytes,gi.first_seen,gi.last_seen
                FROM game_images gi
                JOIN games g ON g.universe_id=gi.universe_id
                JOIN assets a ON a.sha256=gi.sha256
                ORDER BY gi.universe_id, gi.kind, gi.first_seen''',
            'daily_observations.csv': '''
                SELECT observed_date,universe_id,kind,sha256,slot
                FROM observations ORDER BY observed_date,universe_id,kind,slot''',
            'flat_images.csv': '''
                SELECT fe.universe_id,g.name,fe.kind,fe.sha256,fe.export_path,
                       gi.first_seen,gi.last_seen
                FROM flat_exports fe
                JOIN game_images gi ON fe.universe_id=gi.universe_id
                    AND fe.kind=gi.kind AND fe.sha256=gi.sha256
                JOIN games g ON g.universe_id=fe.universe_id
                ORDER BY fe.universe_id,fe.kind,gi.first_seen''',
            'game_image_map.csv': '''
                SELECT gi.universe_id,g.name,gi.kind,gi.sha256,
                  (SELECT fe.export_path FROM flat_exports fe
                   WHERE fe.sha256=gi.sha256 ORDER BY fe.export_path LIMIT 1)
                  AS exported_image_path,gi.first_seen,gi.last_seen
                FROM game_images gi JOIN games g ON g.universe_id=gi.universe_id
                ORDER BY gi.universe_id,gi.kind,gi.sha256''',
            'daily_runs.csv': '''
                SELECT day,started,ended,new_files,new_links,tracked_games,errors
                FROM runs ORDER BY day''',
        }
        for filename, query in exports.items():
            cursor = self.db.execute(query)
            with (EXPORT / filename).open('w', encoding='utf-8', newline='') as output:
                writer = csv.writer(output)
                writer.writerow([field[0] for field in cursor.description])
                writer.writerows(cursor)

    def select_games_for_scan(self):
        """Persistent fair queue: unscanned first, then least recently checked.

        A game repeated on Discover every day stays a single row and does not
        move ahead of older unscanned games. This works across GitHub runners
        because the ordering state is stored in the Drive-backed SQLite file.
        """
        query = """
            SELECT universe_id FROM games
            ORDER BY (last_checked IS NOT NULL) ASC,
                     last_checked ASC,
                     first_discovered ASC,
                     universe_id ASC
        """
        limits = [x for x in (self.args.scan_per_run, self.args.max_games) if x > 0]
        if limits:
            return [row[0] for row in self.db.execute(query + ' LIMIT ?', (min(limits),))]
        return [row[0] for row in self.db.execute(query)]

    def run(self):
        self.open_database()
        try:
            if self.args.export_only:
                self.sync_flat_export()
                self.export_csv()
                return
            if self.closed_for_collection():
                # An older collection can still be exported after day 30.
                self.sync_flat_export()
                self.export_csv()
                return
            today_ids = self.discover()
            tracked_ids = self.select_games_for_scan()
            if not tracked_ids:
                raise RuntimeError('No universe IDs discovered. Check API availability and retry.')
            logging.info('Tracking %s games today (%s discovered in this run).',
                         len(tracked_ids), len(today_ids))
            self.game_metadata(tracked_ids)
            self.collect_images(tracked_ids)
            ended = utc_now()
            self.db.execute('''
                INSERT OR REPLACE INTO runs(day,started,ended,new_files,new_links,tracked_games,errors)
                VALUES (?,?,?,?,?,?,?)
            ''', (self.day, self.started, ended, self.new_files, self.new_links,
                  len(tracked_ids), self.errors))
            self.db.commit()
            self.sync_flat_export()
            self.export_csv()
            logging.info('Done: %s new files, %s new game-image links, %s errors.',
                         self.new_files, self.new_links, self.errors)
            if self.errors:
                logging.warning('Some requests failed. Rerun with --force today to retry;'
                                ' previously downloaded files are deduplicated.')
        finally:
            self.db.close()
            self.session.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--days', type=int, default=30,
                        help='Calendar days to collect starting with the first run (default 30)')
    parser.add_argument('--search-pages', type=int, default=2,
                        help='Search pages per keyword, default 2')
    parser.add_argument('--extra-terms', type=int, default=8,
                        help='Number of rotating keyword queries per day, default 8')
    parser.add_argument('--batch-size', type=int, default=20,
                        help='Universe IDs per thumbnail request, default 20')
    parser.add_argument('--thumbs-per-game', type=int, default=20)
    parser.add_argument('--request-delay', type=float, default=0.4,
                        help='Seconds between HTTP requests, default 0.4')
    parser.add_argument('--max-image-mb', type=int, default=12)
    parser.add_argument('--max-games', type=int, default=0,
                        help='Testing only: scan the first N games, 0 means all')
    parser.add_argument('--export-only', action='store_true',
                        help='Populate the flat icons/ and thumbs/ folders, no API requests')
    parser.add_argument('--cloud-mode', action='store_true',
                        help='Ephemeral runner: restore only SQLite from remote storage, '
                             'export only newly seen unique assets')
    parser.add_argument('--scan-per-run', type=int, default=0,
                        help='Check at most N games daily, prioritizing never scanned and oldest checked; 0 scans all')
    parser.add_argument('--force', action='store_true',
                        help='Allow a second collection run today')
    args = parser.parse_args(argv)
    if args.days < 1 or args.batch_size < 1 or args.search_pages < 1 or args.thumbs_per_game < 1:
        parser.error('days, batch-size, search-pages and thumbs-per-game must be positive')
    if args.scan_per_run < 0:
        parser.error('scan-per-run must be nonnegative')
    if args.request_delay < 0 or args.extra_terms < 0:
        parser.error('request-delay and extra-terms must be nonnegative')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    Collector(args).run()


if __name__ == '__main__':
    main()
