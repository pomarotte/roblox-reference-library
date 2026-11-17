from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import numpy as np
from PIL import Image

from app import Library, default_source
from setup_dataset import configure_dataset
from visual import palette_features, rank_candidates, scene_image


class SceneMatchingTests(unittest.TestCase):
    def test_full_frame_keeps_subjects_at_both_edges(self):
        image = Image.new('RGB', (400, 100), 'black')
        image.paste('red', (0, 0, 100, 100))
        image.paste('blue', (300, 0, 400, 100))
        result = scene_image(image)
        self.assertEqual(result.size, (224, 224))
        self.assertGreater(result.getpixel((0, 112))[0], 200)
        self.assertGreater(result.getpixel((223, 112))[2], 200)
        self.assertEqual(result.getpixel((0, 0)), (123, 117, 104))
        image.close()
        result.close()

    def test_color_breaks_close_ties_and_cannot_override_clear_scene_match(self):
        red = palette_features(Image.new('RGB', (20, 20), 'red'))
        blue = palette_features(Image.new('RGB', (20, 20), 'blue'))
        seed = np.array([1, 0], dtype=np.float16).tobytes()

        def row(game_id, similarity, palette):
            vector = np.array([similarity, np.sqrt(1 - similarity**2)], dtype=np.float16)
            return {'id': game_id, 'image_id': game_id, 'hash': str(game_id), 'embedding': vector.tobytes(), 'palette': palette}

        results = rank_candidates([row(1, .8, blue), row(2, .8, red)], seed, seed_palette=red)
        self.assertEqual([r['id'] for r in results], [2, 1])
        results = rank_candidates([row(1, .95, blue), row(2, .8, red)], seed, seed_palette=red)
        self.assertEqual(results[0]['id'], 1)
        self.assertNotIn('palette', results[0])

    def test_old_cache_migration_preserves_original_embeddings(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / 'legacy.sqlite3'
            with closing(sqlite3.connect(database)) as db, db:
                db.execute('CREATE TABLE visual_embeddings(hash TEXT PRIMARY KEY,embedding BLOB NOT NULL)')
                db.execute('INSERT INTO visual_embeddings VALUES (?,?)', ('old', b'original'))
            library = Library(folder, database)
            with library.connect() as db:
                row = db.execute('SELECT * FROM visual_embeddings').fetchone()
                self.assertEqual(row['embedding'], b'original')
                self.assertIsNone(row['scene_embedding'])
                self.assertIsNone(row['palette'])

    def test_progress_migration_recognizes_precomputed_scene_features(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / 'legacy.sqlite3'
            with closing(sqlite3.connect(database)) as db, db:
                db.execute('CREATE TABLE visual_embeddings(hash TEXT PRIMARY KEY,embedding BLOB NOT NULL,scene_embedding BLOB,palette BLOB)')
                db.execute('CREATE TABLE image_vectors(image_id INTEGER PRIMARY KEY,hash TEXT,error TEXT)')
                db.execute('INSERT INTO visual_embeddings VALUES (?,?,?,?)', ('ready', b'old', b'scene', b'palette'))
                db.execute('INSERT INTO image_vectors VALUES (1,\'ready\',NULL)')
                db.execute('INSERT INTO image_vectors VALUES (2,\'missing\',NULL)')
            library = Library(folder, database)
            with library.connect() as db:
                self.assertEqual([row[0] for row in db.execute('SELECT refined FROM image_vectors ORDER BY image_id')], [1, 0])

    def test_saved_matrix_preserves_scene_ranking_without_loading_a_model(self):
        with tempfile.TemporaryDirectory() as folder:
            library = Library(folder, Path(folder) / 'cache.sqlite3')
            palette = np.zeros(48, dtype=np.float16)
            palette[0] = 1
            original = []
            with library.connect() as db:
                for game, similarity in [(1, 1), (2, .8), (3, .6)]:
                    image_id = game * 10
                    vector = np.zeros(512, dtype=np.float16)
                    vector[:2] = [similarity, np.sqrt(1 - similarity**2)]
                    digest = str(game)
                    db.execute('INSERT INTO games(id) VALUES (?)', (game,))
                    db.execute('INSERT INTO images(id,game_id,kind,filename,captured) VALUES (?,?,\'thumbs\',?,\'20260401_120000\')', (image_id, game, f'{game}_20260401_120000_0.webp'))
                    db.execute('INSERT INTO image_vectors(image_id,hash,refined) VALUES (?,?,1)', (image_id, digest))
                    db.execute('INSERT INTO visual_embeddings(hash,embedding,scene_embedding,palette) VALUES (?,?,?,?)', (digest, vector.tobytes(), vector.tobytes(), palette.tobytes()))
                    original.append({'id': game, 'image_id': image_id, 'embedding': vector.tobytes(), 'palette': palette.tobytes(), 'hash': digest})
            library.visual.prepare_search_index()
            candidates = [{'id': row['id'], 'image_id': row['image_id']} for row in original[1:]]
            fast = library.visual.search_candidates(candidates, 10)
            reference = rank_candidates(original[1:], original[0]['embedding'], seed_palette=palette.tobytes())
            self.assertEqual(fast, reference)
            self.assertIsNone(library.visual.search_candidates(candidates, 999))


class DatasetSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.app = self.root / 'application'
        self.app.mkdir()
        self.source = self.root / 'downloads' / 'roblox-icons-thumbnails'
        self.files = [('icons', '11_20260401_120000.webp'), ('thumbs', '11_20260401_120001_0.webp')]
        for kind, name in self.files:
            path = self.source / kind / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'original-image-and-metadata')
        self.library = Library(self.source, self.app / 'library.sqlite3')
        self.library.scan()

    def tearDown(self):
        self.temporary.cleanup()

    def test_existing_dataset_is_used_in_place_without_changing_images(self):
        before = {name: ((self.source / kind / name).read_bytes(), (self.source / kind / name).stat().st_mtime_ns) for kind, name in self.files}
        selected = configure_dataset(self.app, self.source)
        self.assertEqual(selected, self.source.resolve())
        self.assertEqual(default_source(self.app), selected)
        for kind, name in self.files:
            path = self.source / kind / name
            self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before[name])
        self.assertFalse((self.app / 'images').exists())

    def test_extracted_parent_folder_is_recognized(self):
        self.assertEqual(configure_dataset(self.app, self.source.parent), self.source.resolve())

    def test_different_dataset_does_not_replace_saved_folder(self):
        configure_dataset(self.app, self.source)
        saved = (self.app / 'dataset-path.txt').read_bytes()
        other = self.root / 'different'
        for kind, name in self.files:
            path = other / kind / name.replace('11_', '22_')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'different')
        with self.assertRaises(ValueError):
            configure_dataset(self.app, other)
        self.assertEqual((self.app / 'dataset-path.txt').read_bytes(), saved)
        self.assertEqual(self.library.stats()['images'], 2)

    def test_incomplete_dataset_preserves_cached_records(self):
        (self.app / 'collection.json').write_text(json.dumps({'cache_included': True, 'image_counts': {'icons': 1, 'thumbs': 1}}))
        (self.source / self.files[1][0] / self.files[1][1]).unlink()
        with self.assertRaises(ValueError):
            self.library.scan()
        self.assertEqual(self.library.stats()['images'], 2)

    def test_same_counts_with_wrong_names_preserves_cached_records(self):
        (self.app / 'collection.json').write_text(json.dumps({'cache_included': True, 'image_counts': {'icons': 1, 'thumbs': 1}}))
        path = self.source / self.files[1][0] / self.files[1][1]
        path.rename(path.with_name(path.name.replace('11_', '22_')))
        with self.assertRaises(ValueError):
            self.library.scan()
        self.assertEqual(self.library.stats()['images'], 2)


if __name__ == '__main__':
    unittest.main()
