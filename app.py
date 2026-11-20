"""Local Roblox reference library. Python standard library only."""
import argparse
from contextlib import contextmanager
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
import webbrowser

HERE = Path(__file__).resolve().parent


def default_source(root=HERE):
    saved = root / 'dataset-path.txt'
    if saved.is_file():
        return Path(saved.read_text(encoding='utf-8').strip())
    return root / 'images' if (root / 'images').is_dir() else Path.home() / 'Downloads' / 'roblox-icons-thumbnails'


DEFAULT_SOURCE = default_source()
FILE_PATTERN = re.compile(r'^(\d+)_(\d{8}_\d{6})(?:_\d+)?\.webp$')


def validate_collection(database, counts):
    manifest = Path(database).parent / 'collection.json'
    if manifest.is_file():
        data = json.loads(manifest.read_text(encoding='utf-8'))
        expected = data['image_counts']
        if any(counts.get(kind, 0) < count for kind, count in expected.items()) or (data.get('cache_included') and counts != expected):
            raise ValueError('This folder does not match the saved dataset. Download and extract the Everything collection from https://tools.frrazers.com/dataset/ and run Start Gallery.cmd again.')
        return bool(data.get('cache_included'))
    return False


class Library:
    def __init__(self, source, database):
        self.source = Path(source).resolve()
        self.database = str(database)
        self.sync_lock = threading.Lock()
        self.state = {'running': False, 'message': 'Ready to collect game information.'}
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS games (
                    id INTEGER PRIMARY KEY, name TEXT, genre TEXT, subgenre TEXT,
                    visits INTEGER, fetched_at TEXT, status TEXT NOT NULL DEFAULT 'pending',
                    icon_id INTEGER, thumb_id INTEGER, image_count INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS images (
                    id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL, kind TEXT NOT NULL,
                    filename TEXT NOT NULL, captured TEXT NOT NULL,
                    UNIQUE(kind, filename)
                );
                CREATE INDEX IF NOT EXISTS image_game ON images(game_id, kind, captured DESC, filename DESC);
                CREATE INDEX IF NOT EXISTS game_genre ON games(genre, subgenre);
                CREATE INDEX IF NOT EXISTS game_visits ON games(visits DESC);
            ''')
        from visual import VisualIndex
        self.visual = VisualIndex(self)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        try:
            with db:
                yield db
        finally:
            db.close()

    def scan(self):
        if not self.source.is_dir():
            raise ValueError(f'Image folder does not exist: {self.source}')
        rows = []
        for kind in ('icons', 'thumbs'):
            folder = self.source / kind
            if not folder.is_dir():
                continue
            with os.scandir(folder) as entries:
                for entry in entries:
                    match = FILE_PATTERN.fullmatch(entry.name)
                    if match and entry.is_file(follow_symlinks=False):
                        rows.append((int(match[1]), kind, entry.name, match[2]))
        if not rows:
            raise ValueError('No matching WebP images found in icons/ or thumbs/.')
        counts = {kind: sum(row[1] == kind for row in rows) for kind in ('icons', 'thumbs')}
        fixed_collection = validate_collection(self.database, counts)
        with self.connect() as db:
            db.execute('CREATE TEMP TABLE seen(kind TEXT, filename TEXT, PRIMARY KEY(kind, filename))')
            db.executemany('INSERT INTO seen VALUES (?,?)', ((r[1], r[2]) for r in rows))
            if fixed_collection and db.execute('SELECT 1 FROM images WHERE NOT EXISTS (SELECT 1 FROM seen WHERE seen.kind=images.kind AND seen.filename=images.filename) LIMIT 1').fetchone():
                raise ValueError('The image filenames do not match the saved dataset. Choose the original Everything collection; the saved cache has been preserved.')
            db.executemany('INSERT OR IGNORE INTO images(game_id,kind,filename,captured) VALUES (?,?,?,?)', rows)
            db.execute('DELETE FROM images WHERE NOT EXISTS (SELECT 1 FROM seen WHERE seen.kind=images.kind AND seen.filename=images.filename)')
            db.execute('INSERT OR IGNORE INTO games(id) SELECT DISTINCT game_id FROM images')
            db.execute('DELETE FROM games WHERE id NOT IN (SELECT game_id FROM images)')
            db.execute('DELETE FROM image_vectors WHERE image_id NOT IN (SELECT id FROM images)')
            db.execute('''UPDATE games SET
                icon_id=(SELECT id FROM images WHERE game_id=games.id AND kind='icons' ORDER BY captured DESC,filename DESC LIMIT 1),
                thumb_id=(SELECT id FROM images WHERE game_id=games.id AND kind='thumbs' ORDER BY captured DESC,filename DESC LIMIT 1),
                image_count=(SELECT COUNT(*) FROM images WHERE game_id=games.id)''')

    def stats(self):
        with self.connect() as db:
            row = dict(db.execute('''SELECT COUNT(*) games, COALESCE(SUM(image_count),0) images,
                COALESCE(SUM(status='ready'),0) ready, COALESCE(SUM(status='pending'),0) pending,
                COALESCE(SUM(status='unavailable'),0) unavailable FROM games''').fetchone())
            counts = dict(db.execute('SELECT kind, COUNT(*) FROM images GROUP BY kind'))
            row.update(thumbnails=counts.get('thumbs', 0), icons=counts.get('icons', 0))
            row['facets'] = [dict(r) for r in db.execute('SELECT DISTINCT genre,subgenre FROM games WHERE status=\'ready\' ORDER BY genre,subgenre')]
        return {**row, **self.state, 'source': str(self.source), 'application': 'roblox-reference-library', 'visual': self.visual.status()}

    def query(self, params):
        def number(key, default=None):
            value = params.get(key, [''])[0]
            if value == '':
                return default
            if not value.isascii() or not value.isdigit() or len(value) > 18:
                raise ValueError(f'Invalid {key}')
            return int(value)
        kind = params.get('kind', ['thumbs'])[0]
        if kind not in ('icons', 'thumbs'):
            raise ValueError('Invalid image type')
        all_images = params.get('all_images', ['0'])[0]
        if all_images not in ('0', '1'):
            raise ValueError('Invalid image grouping')
        all_images = all_images == '1'
        minimum = number('min_visits')
        maximum = number('max_visits')
        if minimum is not None and maximum is not None and minimum > maximum:
            raise ValueError('Minimum visits must not exceed maximum visits.')
        where, values = ['i.id IS NOT NULL'], []
        mode = params.get('similarity', [''])[0]
        if mode not in ('', 'visual', 'type', 'both'):
            raise ValueError('Invalid similarity mode')
        if mode in ('visual', 'both'):
            all_images = True
        seed_id = number('seed_image')
        seed = None
        if mode:
            with self.connect() as db:
                seed = db.execute('SELECT i.game_id,g.genre,g.subgenre,v.hash,COALESCE(e.scene_embedding,e.embedding) embedding,e.palette FROM images i JOIN games g ON g.id=i.game_id LEFT JOIN image_vectors v ON v.image_id=i.id LEFT JOIN visual_embeddings e ON e.hash=v.hash WHERE i.id=?', (seed_id,)).fetchone()
            if not seed:
                raise ValueError('Select a reference image first.')
            where.append('g.id != ?')
            values.append(seed['game_id'])
            if mode in ('type', 'both'):
                if not seed['genre'] or seed['genre'] == 'Unknown':
                    raise ValueError('This game has no genre metadata yet. Choose Visual or wait for metadata.')
                where.append('g.genre=?')
                values.append(seed['genre'])
                if seed['subgenre'] and seed['subgenre'] != 'Unknown':
                    where.append('g.subgenre=?')
                    values.append(seed['subgenre'])
        for key, column in (('genre', 'genre'), ('subgenre', 'subgenre')):
            value = params.get(key, [''])[0]
            if value:
                where.append(f'COALESCE(g.{column},\'Unknown\')=?')
                values.append(value)
        search = params.get('search', [''])[0].strip()[:200]
        if search:
            where.append("(g.name LIKE ? ESCAPE '\\' OR CAST(g.id AS TEXT)=?)")
            escaped = search.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
            values.extend((f'%{escaped}%', search))
        if minimum is not None:
            where.append('g.visits >= ?')
            values.append(minimum)
        if maximum is not None:
            where.append('g.visits <= ?')
            values.append(maximum)
        sorts = {'visits': 'g.visits DESC,g.id,i.captured DESC,i.id DESC', 'least': 'g.visits IS NULL,g.visits,g.id,i.id DESC',
                 'name': 'g.name IS NULL,g.name COLLATE NOCASE,g.id,i.id DESC', 'recent': 'i.captured DESC,g.id,i.id DESC'}
        sort = sorts.get(params.get('sort', ['visits'])[0])
        if not sort:
            raise ValueError('Invalid sort order')
        offset, limit = number('offset', 0), min(number('limit', 240), 480)
        column = 'icon_id' if kind == 'icons' else 'thumb_id'
        with self.connect() as db:
            if mode in ('visual', 'both'):
                if seed['embedding'] is None:
                    raise ValueError('This image has not been visually indexed yet. Choose Game type or wait for the visual index.')
                base = 'FROM games g JOIN images i ON i.game_id=g.id WHERE i.kind=? AND ' + ' AND '.join(where)
                rows = db.execute('SELECT g.id,i.id image_id ' + base, [kind] + values).fetchall()
                matches = self.visual.search_candidates(rows, seed_id, grouped=not all_images)
                if matches is None:
                    base = 'FROM games g JOIN images i ON i.game_id=g.id JOIN image_vectors v ON v.image_id=i.id JOIN visual_embeddings e ON e.hash=v.hash WHERE i.kind=? AND ' + ' AND '.join(where)
                    rows = db.execute('SELECT g.id,i.id image_id,COALESCE(e.scene_embedding,e.embedding) embedding,e.palette,v.hash ' + base, [kind] + values).fetchall()
                    from visual import rank_candidates
                    matches = rank_candidates(rows, seed['embedding'], grouped=not all_images, seed_palette=seed['palette'])
                selected = matches[offset:offset + limit]
                if not selected:
                    return {'total': len(matches), 'items': [], 'similarity': mode}
                ids = [match['image_id'] for match in selected]
                details = db.execute('''SELECT g.id,g.name,g.genre,g.subgenre,g.visits,g.status,
                    (SELECT COUNT(*) FROM images x WHERE x.game_id=g.id AND x.kind=?) image_count,
                    i.id image_id,i.captured FROM images i JOIN games g ON g.id=i.game_id
                    WHERE i.id IN (''' + ','.join('?' for _ in ids) + ')', [kind] + ids)
                by_image = {row['image_id']: dict(row) for row in details}
                items = [{**by_image[match['image_id']], 'similarity_score': match['similarity_score']} for match in selected]
                return {'total': len(matches), 'items': items, 'similarity': mode}
            join = 'i.game_id=g.id AND i.kind=?' if all_images else f'i.id=g.{column}'
            base = f'FROM games g JOIN images i ON {join} WHERE ' + ' AND '.join(where)
            if all_images:
                values = [kind] + values
            total = db.execute('SELECT COUNT(*) ' + base, values).fetchone()[0]
            rows = db.execute('SELECT g.id,g.name,g.genre,g.subgenre,g.visits,g.status,(SELECT COUNT(*) FROM images x WHERE x.game_id=g.id AND x.kind=?) image_count,i.id image_id,i.captured ' + base + f' ORDER BY {sort} LIMIT ? OFFSET ?', [kind] + values + [limit, offset])
            return {'total': total, 'items': [dict(r) for r in rows]}

    def game(self, game_id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM games WHERE id=?', (game_id,)).fetchone()
            if not row:
                raise FileNotFoundError('Game not found')
            images = db.execute('SELECT id,kind,filename,captured FROM images WHERE game_id=? ORDER BY captured DESC,filename DESC', (game_id,))
            return {**dict(row), 'images': [dict(r) for r in images]}

    def image_path(self, image_id):
        with self.connect() as db:
            row = db.execute('SELECT kind,filename FROM images WHERE id=?', (image_id,)).fetchone()
        if not row:
            raise FileNotFoundError('Image not found')
        if row['kind'] not in ('icons', 'thumbs') or not FILE_PATTERN.fullmatch(row['filename']):
            raise FileNotFoundError('Invalid image path')
        path = (self.source / row['kind'] / row['filename']).resolve()
        if not path.is_relative_to(self.source) or not path.is_file():
            raise FileNotFoundError('Image no longer exists')
        return path

    def save_batch(self, ids, payload):
        data = payload.get('data') if isinstance(payload, dict) else None
        if not isinstance(data, list):
            raise ValueError('Roblox returned an unexpected response; progress was preserved.')
        allowed, records = set(ids), {}
        for game in data:
            # Roblox uses id=0 placeholders for some unavailable games.
            if isinstance(game, dict) and game.get('id') == 0:
                continue
            if not isinstance(game, dict) or type(game.get('id')) is not int or game['id'] not in allowed:
                raise ValueError('Invalid game ID in API response')
            visits = game.get('visits')
            if type(visits) is not int or not 0 <= visits <= 9223372036854775807:
                raise ValueError('Invalid visits in API response')
            fields = [game.get('name'), game.get('genre_l1') or 'Unknown', game.get('genre_l2') or 'Unknown']
            if any(not isinstance(v, str) for v in fields):
                raise ValueError('Invalid game fields in API response')
            records[game['id']] = (*fields, visits, game['id'])
        with self.connect() as db:
            db.executemany("UPDATE games SET name=?,genre=?,subgenre=?,visits=?,status='ready',fetched_at=datetime('now') WHERE id=?", records.values())
            db.executemany("UPDATE games SET status='unavailable',fetched_at=datetime('now') WHERE id=?", ((i,) for i in ids if i not in records))

    def sync(self):
        if not self.sync_lock.acquire(blocking=False):
            return
        self.state = {'running': True, 'message': 'Collecting game information…'}
        try:
            while True:
                with self.connect() as db:
                    ids = [r[0] for r in db.execute("SELECT id FROM games WHERE status='pending' ORDER BY id LIMIT 50")]
                if not ids:
                    self.state['message'] = 'Game information is up to date.'
                    break
                request = Request('https://games.roblox.com/v1/games?universeIds=' + ','.join(map(str, ids)), headers={'User-Agent': 'RobloxReferenceGallery/1.0'})
                for attempt in range(5):
                    try:
                        with urlopen(request, timeout=30) as response:
                            payload = json.load(response)
                        self.save_batch(ids, payload)
                        self.state['message'] = 'Collecting game information… You can browse while this runs.'
                        break
                    except (HTTPError, URLError, TimeoutError, OSError) as error:
                        if attempt == 4:
                            raise
                        delay = min(60, 3 * 2**attempt)
                        if isinstance(error, HTTPError):
                            if error.code not in (429, 500, 502, 503, 504):
                                raise
                            retry_after = error.headers.get('Retry-After', '')
                            if retry_after.isdigit():
                                delay = max(delay, min(int(retry_after), 120))
                        reason = 'Roblox is limiting requests' if isinstance(error, HTTPError) and error.code == 429 else 'Connection interrupted'
                        self.state['message'] = f'{reason}. Retrying in {delay} seconds; saved progress is safe.'
                        time.sleep(delay)
                time.sleep(1)
        except Exception as error:
            self.state['message'] = f'Collection paused: {error}. Use Resume metadata to retry.'
        finally:
            self.state['running'] = False
            self.sync_lock.release()


def make_handler(library):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def valid_host(self):
            return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

        def send(self, status, body, content_type='application/json; charset=utf-8', cache='no-store'):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', cache)
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.valid_host():
                return self.send(403, {'error': 'Local access only'})
            url = urlparse(self.path)
            try:
                if url.path == '/api/status':
                    return self.send(200, library.stats())
                if url.path == '/api/library':
                    return self.send(200, library.query(parse_qs(url.query)))
                if re.fullmatch(r'/api/game/\d+', url.path):
                    return self.send(200, library.game(int(url.path.rsplit('/', 1)[1])))
                if re.fullmatch(r'/image/\d+', url.path):
                    path = library.image_path(int(url.path.rsplit('/', 1)[1]))
                    return self.send(200, path.read_bytes(), 'image/webp', 'private, max-age=3600')
                assets = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/logo.svg': 'logo.svg', '/rolibrary.svg': 'rolibrary.svg'}
                if url.path in assets:
                    path = HERE / assets[url.path]
                    return self.send(200, path.read_bytes(), mimetypes.guess_type(path)[0] or 'text/plain')
                return self.send(404, {'error': 'Not found'})
            except ValueError as error:
                self.send(400, {'error': str(error)})
            except FileNotFoundError as error:
                self.send(404, {'error': str(error)})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception:
                self.send(500, {'error': 'Unable to read the library. Check the server console.'})

        def do_POST(self):
            if not self.valid_host() or self.headers.get('Origin') != f'http://{self.headers.get("Host")}':
                return self.send(403, {'error': 'Local access only'})
            if self.path == '/api/sync':
                threading.Thread(target=library.sync, daemon=True).start()
                return self.send(200, {'ok': True})
            if self.path == '/api/visual-start':
                library.visual.start()
                return self.send(200, {'ok': True})
            if self.path == '/api/quit':
                self.send(200, {'ok': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if re.fullmatch(r'/api/reveal/\d+', self.path):
                try:
                    path = library.image_path(int(self.path.rsplit('/', 1)[1]))
                    if os.name != 'nt':
                        return self.send(400, {'error': 'Show in Explorer requires Windows.'})
                    subprocess.Popen(['explorer.exe', '/select,', str(path)])
                    return self.send(200, {'ok': True})
                except (OSError, ValueError) as error:
                    return self.send(400, {'error': str(error)})
            self.send(404, {'error': 'Not found'})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--no-sync', action='store_true')
    parser.add_argument('--sync-only', action='store_true')
    args = parser.parse_args()
    url = f'http://127.0.0.1:{args.port}'
    if not args.sync_only:
        try:
            with urlopen(url + '/api/status', timeout=1) as response:
                existing = json.load(response)
            if existing.get('application') == 'roblox-reference-library' and existing.get('source') == str(args.source.resolve()):
                print(f'Gallery already running: {url}', flush=True)
                if not args.no_browser:
                    webbrowser.open(url)
                return
        except (OSError, ValueError):
            pass
    library = Library(args.source, HERE / 'library.sqlite3')
    print('Indexing image filenames…', flush=True)
    library.scan()
    print(json.dumps({k: v for k, v in library.stats().items() if k != 'facets'}), flush=True)
    if args.sync_only:
        library.sync()
        print(json.dumps({k: v for k, v in library.stats().items() if k != 'facets'}), flush=True)
        return
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(library))
    if not args.no_sync:
        threading.Thread(target=library.sync, daemon=True).start()
    library.visual.start()
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'Gallery: {url}\nClose this window or press Ctrl+C to stop.', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()

