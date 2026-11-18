import gzip
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import numpy as np
from build_web import build


class WebExportTests(unittest.TestCase):
    def test_static_export_has_cached_data_and_no_images_or_private_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with closing(sqlite3.connect(root / 'library.sqlite3')) as db, db:
                db.executescript('''CREATE TABLE games(id,name,genre,subgenre,visits,status,fetched_at);
                    CREATE TABLE images(id,game_id,kind,filename,captured);
                    INSERT INTO games VALUES(11,'A <game>','Simulation','Tycoon',201,'ready','2026-11-17');
                    INSERT INTO images VALUES(1,11,'thumbs','11_20260101_120000.webp','20260101_120000');''')
            np.savez(root / 'search-index.npz', image_ids=[1], scenes=np.ones((1,512),dtype=np.float16), palettes=np.ones((1,48),dtype=np.float16))
            (root / 'dataset-path.txt').write_text('C:/private-path')
            (root / 'secret.webp').write_bytes(b'never copy')
            output = root / 'site'
            build(root, output)
            catalog = json.loads(gzip.decompress(next((output / 'data').glob('catalog.*.json.gz')).read_bytes()))
            self.assertEqual(catalog['games'][0]['name'], 'A <game>')
            self.assertEqual(catalog['image_count'],1)
            self.assertEqual(len(gzip.decompress((output / catalog['visual']['parts'][0]['url']).read_bytes())),560*2)
            self.assertFalse(list(output.rglob('*.webp')))
            self.assertFalse((output / 'dataset-path.txt').exists())
            html = (output / 'index.html').read_text(encoding='utf-8')
            self.assertIn('webkitdirectory',html)
            self.assertIn('class="web-disconnected"',html)
            self.assertIn('id="dataset-loading" class="dataset-loading" role="status" aria-live="polite" hidden',html)
            self.assertIn('blob:',html)
            self.assertNotIn('src="/',html)
            self.assertNotIn('src="./app.js"',html)
            self.assertNotIn('src="./collections.js"',html)
            self.assertIn('id="saved-view"',html)
            self.assertIn('id="download-collection"',html)
            self.assertEqual(len(list(output.glob('collections.*.js'))),1)
            np.savez(root / 'search-index.npz',image_ids=[999],scenes=np.ones((1,512)),palettes=np.ones((1,48)))
            with self.assertRaisesRegex(ValueError,'every image'):
                build(root,output)


if __name__ == '__main__':
    unittest.main()
