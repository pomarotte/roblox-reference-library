import gzip
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from build_web import build
from cloud.build_cloud import build_cloud
from cloud.charts import add_thumbnails, chart_entries, make_charts


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
            generator_html = (output / 'gen' / 'index.html').read_text(encoding='utf-8')
            self.assertNotIn('thumbnail-generator.', html)
            self.assertNotIn('id="thumbnail-dialog"', html)
            self.assertIn('<base href="../">', generator_html)
            self.assertEqual(len(list((output / 'character-references').iterdir())), 6)
            self.assertIn('id="thumbnail-upload"', generator_html)
            self.assertIn('id="thumbnail-collection"', generator_html)
            self.assertIn('id="thumbnail-game-url"', generator_html)
            self.assertIn('id="thumbnail-allow-text"', generator_html)
            self.assertIn('https://references.rolibrary.win', generator_html)
            self.assertNotIn('BMC-Widget', generator_html)
            generator = next(output.glob('thumbnail-generator.*.js'))
            prompt = next(output.glob('thumbnail-prompt.*.txt'))
            self.assertIn(generator.name, generator_html)
            self.assertIn(prompt.name, generator.read_text(encoding='utf-8'))
            self.assertRegex(generator_html, r'<script src="\./app\.[a-f0-9]+\.js" defer></script>')
            self.assertIn('webkitdirectory',html)
            self.assertNotIn('data-name="BMC-Widget"', html)
            self.assertIn('https://buymeacoffee.com/winpo1', html)
            self.assertNotIn('https://cdnjs.buymeacoffee.com', html)
            self.assertIn('<title>RoLibrary</title>', html)
            self.assertIn('href="./blacklogo.svg?v=2"', html)
            self.assertIn('src="./rolibrary.svg"', html)
            self.assertTrue((output / 'blacklogo.svg').is_file())
            self.assertTrue((output / 'logo.svg').is_file())
            self.assertTrue((output / 'rolibrary.svg').is_file())
            self.assertIn('class="web-disconnected"',html)
            self.assertIn('id="dataset-loading" class="dataset-loading" role="status" aria-live="polite" hidden',html)
            self.assertIn('blob:',html)
            self.assertNotIn('src="/',html)
            self.assertNotIn('src="./app.js"',html)
            self.assertNotIn('src="./collections.js"',html)
            self.assertIn('id="saved-view"',html)
            self.assertIn('id="download-collection"',html)
            self.assertEqual(len(list(output.glob('collections.*.js'))),1)
            cloud_output = root / 'cloud'
            for commit in ('1' * 40, '2' * 40):
                with patch.dict('os.environ', GITHUB_SHA=commit):
                    build_cloud(cloud_output, cache=root)
                cloud_html = (cloud_output / 'index.html').read_text(encoding='utf-8')
                self.assertIn('id="open-charts" class="secondary" type="button" aria-pressed="false">Top charts</button>', cloud_html)
                self.assertIn('id="chart-controls" class="chart-controls" hidden', cloud_html)
                self.assertIn(f'id="last-updated" hidden></span><span id="site-version">Site version {commit[:12]}</span>', cloud_html)
            np.savez(root / 'search-index.npz',image_ids=[999],scenes=np.ones((1,512)),palettes=np.ones((1,48)))
            with self.assertRaisesRegex(ValueError,'every image'):
                build(root,output)

    def test_charts_rank_genres_and_subgenres_independently(self):
        games = [dict(id=i, rootPlaceId=i, name=f'Game {i}', genre_l1='Simulation', thumbnail=f'https://tr.rbxcdn.com/image-{i}',
                      genre_l2='Tycoon' if i < 3 else 'Idle', playing=i) for i in range(1, 105)]
        games.append(dict(games[0], id=105, rootPlaceId=105, playing=2))
        games.append(dict(games[0], id=106, rootPlaceId=106, playing=None))
        charts = make_charts(games)
        self.assertEqual([row['place'] for row in charts['Simulation']['games']], list(range(104, 4, -1)))
        self.assertEqual([row['place'] for row in charts['Simulation']['subgenres']['Tycoon']], [2, 105, 1])
        self.assertEqual(charts['Education']['games'], [])
        self.assertEqual(charts['Simulation']['games'][0]['image'], 'https://tr.rbxcdn.com/image-104')

    def test_charts_get_thumbnails_for_games_without_a_ranking_image(self):
        charts = make_charts([dict(id=11, rootPlaceId=22, name='Missing image', genre_l1='Shooter',
                                   genre_l2='PvE Shooter', playing=200)])
        url = 'https://tr.rbxcdn.com/ranked-thumbnail'
        response = {'data': [{'universeId': 11, 'thumbnails': [
            {'state': 'Completed', 'imageUrl': url}, {'state': 'Completed', 'imageUrl': url},
            {'state': 'Pending', 'imageUrl': 'https://tr.rbxcdn.com/pending'},
        ]}]}
        with patch('cloud.charts.request_json', return_value=response) as request, patch('cloud.charts.time.sleep'):
            add_thumbnails(chart_entries(charts))
        self.assertEqual(request.call_args.args[1]['universeIds'], '11')
        self.assertEqual(charts['Shooter']['games'][0]['thumbnails'], [url])
        self.assertEqual(charts['Shooter']['subgenres']['PvE Shooter'][0]['thumbnails'], [url])


if __name__ == '__main__':
    unittest.main()
