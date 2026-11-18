import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import parse_qs
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from app import Library, make_handler


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for kind in ('icons', 'thumbs'):
            (self.root / kind).mkdir()
        for kind, name in [('icons', '11_20260401_120000.webp'),
                           ('thumbs', '11_20260401_120001_0.webp'),
                           ('thumbs', '11_20260402_120001_0.webp'),
                           ('thumbs', '22_20260401_120001_0.webp'),
                           ('thumbs', '33_20260401_120001_0.webp')]:
            (self.root / kind / name).write_bytes(b'fixture')
        self.library = Library(self.root, self.root / 'test.sqlite3')
        self.library.scan()

    def tearDown(self):
        self.temp.cleanup()

    def populate(self):
        self.library.save_batch([11, 22, 33], {'data': [
            {'id': 11, 'name': '100% fun', 'genre_l1': 'Simulation', 'genre_l2': 'Tycoon', 'visits': 200},
            {'id': 22, 'name': 'Small game', 'genre_l1': 'Action', 'genre_l2': '', 'visits': 0},
            {'id': 0}
        ]})

    def test_scan_deduplicates_games_and_chooses_latest_image(self):
        self.library.scan()
        self.assertEqual(self.library.stats()['images'], 5)
        self.assertEqual(self.library.stats()['games'], 3)
        results = self.library.query({})
        game = next(r for r in results['items'] if r['id'] == 11)
        self.assertEqual(game['captured'], '20260402_120001')
        self.assertEqual(len(self.library.game(11)['images']), 3)
        all_images = self.library.query(parse_qs('all_images=1'))
        self.assertEqual(all_images['total'], 4)
        self.assertEqual(len({r['image_id'] for r in all_images['items']}), 4)
        self.assertEqual(self.library.query(parse_qs('all_images=1&limit=2&offset=2'))['items'], all_images['items'][2:4])

    def test_filtering_sorting_and_unknown_visits(self):
        self.populate()
        results = self.library.query(parse_qs('min_visits=0'))
        self.assertEqual([r['id'] for r in results['items']], [11,22])
        self.assertEqual(self.library.query(parse_qs('min_visits=200&max_visits=200'))['total'], 1)
        self.assertEqual(self.library.query(parse_qs('max_visits=0'))['items'][0]['id'],22)
        self.assertEqual(self.library.query(parse_qs('min_visits=201'))['total'],0)
        self.assertEqual(self.library.query(parse_qs('min_visits=199'))['total'], 1)
        self.assertEqual(self.library.query(parse_qs('genre=Simulation&subgenre=Tycoon'))['total'], 1)
        self.assertEqual(self.library.query(parse_qs('search=100%25'))['total'], 1)
        self.assertEqual(self.library.query(parse_qs("search=' OR 1=1 --"))['total'], 0)
        self.assertEqual(self.library.query(parse_qs('kind=icons'))['total'], 1)
        self.assertEqual(self.library.query(parse_qs('offset=1&limit=1'))['items'][0]['id'], 22)
        self.assertEqual(self.library.query(parse_qs('genre=Unknown'))['items'][0]['id'], 33)
        self.assertEqual(self.library.stats()['unavailable'], 1)

    def test_bad_response_does_not_overwrite_cached_metadata(self):
        self.populate()
        with self.assertRaises(ValueError):
            self.library.save_batch([11], {'data': [{'id': 11, 'name': 'Bad', 'visits': -1}]})
        self.assertEqual(self.library.game(11)['name'], '100% fun')
        with self.assertRaises(ValueError):
            self.library.save_batch([11], {'data': [{'id': 999, 'visits': 1}]})

    def test_invalid_query_is_rejected(self):
        for query in ('offset=-1', 'kind=../', 'sort=name;DELETE', 'min_visits=-1', 'max_visits=-1', 'min_visits=200&max_visits=100', 'min_visits=999999999999999999999999', 'all_images=maybe', 'similarity=magic'):
            with self.subTest(query=query), self.assertRaises(ValueError):
                self.library.query(parse_qs(query))

    def test_similarity_modes_rank_images_and_respect_game_type_and_visits(self):
        import numpy as np
        self.populate()
        seed = self.library.game(11)['images'][0]['id']
        other = self.library.game(22)['images'][0]['id']
        same_type = self.library.game(33)['images'][0]['id']
        with self.library.connect() as db:
            db.execute("UPDATE games SET genre='Simulation',subgenre='Tycoon',visits=100 WHERE id=33")
            for image_id, vector in [(seed, [1, 0]), (other, [.8, .6]), (same_type, [.6, .8])]:
                digest = str(image_id)
                db.execute('INSERT INTO visual_embeddings(hash,embedding) VALUES (?,?)', (digest, np.array(vector, dtype=np.float16).tobytes()))
                db.execute('INSERT INTO image_vectors(image_id,hash,error) VALUES (?,?,NULL)', (image_id, digest))
        base = f'seed_image={seed}&similarity='
        visual = self.library.query(parse_qs(base + 'visual'))['items']
        self.assertEqual([r['id'] for r in visual], [22, 33])
        self.assertAlmostEqual(visual[0]['similarity_score'], .8, places=2)
        self.assertNotIn('embedding', visual[0])
        for mode in ('both', 'type'):
            self.assertEqual([r['id'] for r in self.library.query(parse_qs(base + mode))['items']], [33])
        self.assertEqual(self.library.query(parse_qs(base + 'both&min_visits=100&max_visits=100'))['total'], 1)
        with self.library.connect() as db:
            duplicate = db.execute('INSERT INTO images(game_id,kind,filename,captured) VALUES (22,\'thumbs\',\'22_20260402_120001_0.webp\',\'20260402_120001\')').lastrowid
            db.execute('INSERT INTO image_vectors(image_id,hash) VALUES (?,?)', (duplicate, str(other)))
        matches = self.library.query(parse_qs(base + 'visual&all_images=0'))['items']
        self.assertEqual([r['id'] for r in matches], [22, 22, 33])
        self.assertEqual(len({r['image_id'] for r in matches}), 3)
        unindexed = next(image['id'] for image in self.library.game(11)['images'] if image['kind'] == 'icons')
        with self.assertRaises(ValueError):
            self.library.query(parse_qs(f'seed_image={unindexed}&similarity=visual'))

    def test_similarity_deduplicates_games_only_in_grouped_mode(self):
        import numpy as np
        from visual import rank_candidates
        seed = np.array([1, 0], dtype=np.float16).tobytes()
        rows = [{'id': 1, 'image_id': 10, 'hash': 'a', 'embedding': seed},
                {'id': 1, 'image_id': 11, 'hash': 'a', 'embedding': seed},
                {'id': 2, 'image_id': 12, 'hash': 'a', 'embedding': seed}]
        self.assertEqual(len(rank_candidates(rows, seed)), 2)
        self.assertEqual(len(rank_candidates(rows, seed, grouped=False)), 3)

    def test_missing_files_reconciled_and_paths_confined(self):
        image = self.library.game(11)['images'][0]
        path = self.library.image_path(image['id'])
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.library.image_path(image['id'])
        self.library.scan()
        self.assertEqual(self.library.stats()['images'], 4)
        with self.library.connect() as db:
            db.execute("UPDATE images SET filename='../test.sqlite3' WHERE id=?", (image['id'] + 1,))
        with self.assertRaises(FileNotFoundError):
            self.library.image_path(image['id'] + 1)

    def test_http_local_access_boundary_and_paging(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.library))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            with urlopen(base + '/api/library?limit=1') as response:
                self.assertEqual(len(json.load(response)['items']), 1)
            for request in [Request(base + '/api/status', headers={'Host': 'attacker.example'}),
                            Request(base + '/api/sync', method='POST', headers={'Origin': 'https://attacker.example'}),
                            Request(base + '/api/sync', method='POST')]:
                with self.assertRaises(HTTPError) as error:
                    urlopen(request)
                self.assertEqual(error.exception.code, 403)
            with self.assertRaises(HTTPError) as error:
                urlopen(base + '/../app.py')
            self.assertEqual(error.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == '__main__':
    unittest.main()
