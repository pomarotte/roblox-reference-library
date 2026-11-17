"""Resumable local CLIP image indexing and cosine-similarity search."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import os
from pathlib import Path
import threading

MODEL = 'openai/clip-vit-base-patch32'
REVISION = '3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268'


def scene_image(image, size=224, background=(123, 117, 104)):
    from PIL import Image, ImageOps
    fitted = ImageOps.contain(image, (size, size), method=Image.Resampling.BICUBIC)
    canvas = Image.new('RGB', (size, size), background)
    canvas.paste(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    fitted.close()
    return canvas


def palette_features(image):
    import numpy as np
    small = image.resize((64, 64))
    histogram = np.asarray(small.histogram(), dtype=np.float32).reshape(3, 16, 16).sum(axis=2)
    small.close()
    return np.sqrt(histogram.ravel() / histogram.sum()).astype(np.float16).tobytes()


def rank_candidates(rows, seed, limit=480, grouped=True, seed_palette=None):
    import numpy as np
    if not rows:
        return []
    vector = np.frombuffer(seed, dtype=np.float16).astype(np.float32)
    matrix = np.stack([np.frombuffer(row['embedding'], dtype=np.float16) for row in rows]).astype(np.float32)
    scores = matrix @ vector
    if seed_palette is not None:
        palette = np.frombuffer(seed_palette, dtype=np.float16).astype(np.float32)
        colors = np.stack([np.frombuffer(row['palette'], dtype=np.float16) if row['palette'] is not None else np.zeros_like(palette) for row in rows]).astype(np.float32)
        # Color can only overturn scene scores that differ by at most 0.03.
        scores = (scores + 0.03 * (colors @ palette)) / 1.03
    return rank_rows(rows, scores, limit, grouped)


def rank_rows(rows, scores, limit=480, grouped=True):
    import numpy as np
    results, seen_games = [], set()
    for index in np.argsort(-scores, kind='stable'):
        row = rows[int(index)]
        if grouped and row['id'] in seen_games:
            continue
        seen_games.add(row['id'])
        result = {k: row[k] for k in row.keys() if k not in ('embedding', 'hash', 'palette')}
        result['similarity_score'] = round(float(scores[index]), 3)
        results.append(result)
        if len(results) == limit:
            break
    return results


class VisualIndex:
    def __init__(self, library):
        self.library = library
        self.lock = threading.Lock()
        self.search_lock = threading.Lock()
        self.search_cache = None
        self.search_path = Path(library.database).parent / 'search-index.npz'
        self.state = {'running': False, 'message': 'Visual indexing has not started.'}
        with library.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS visual_embeddings (hash TEXT PRIMARY KEY, embedding BLOB NOT NULL, scene_embedding BLOB, palette BLOB);
                CREATE TABLE IF NOT EXISTS image_vectors (image_id INTEGER PRIMARY KEY, hash TEXT, error TEXT, refined INTEGER NOT NULL DEFAULT 0);
            ''')
            columns = {row['name'] for row in db.execute('PRAGMA table_info(visual_embeddings)')}
            for column in ('scene_embedding', 'palette'):
                if column not in columns:
                    db.execute(f'ALTER TABLE visual_embeddings ADD COLUMN {column} BLOB')
            if 'refined' not in {row['name'] for row in db.execute('PRAGMA table_info(image_vectors)')}:
                db.execute('ALTER TABLE image_vectors ADD COLUMN refined INTEGER NOT NULL DEFAULT 0')
                db.execute('''UPDATE image_vectors SET refined=1 WHERE hash IN
                    (SELECT hash FROM visual_embeddings WHERE scene_embedding IS NOT NULL AND palette IS NOT NULL)''')

    def status(self):
        with self.library.connect() as db:
            counts = dict(db.execute('''SELECT COUNT(*) total, COALESCE(SUM(v.refined),0) ready,
                COALESCE(SUM(v.error IS NOT NULL),0) failed FROM images i LEFT JOIN image_vectors v ON v.image_id=i.id''').fetchone())
        return {**counts, **self.state}

    def start(self):
        threading.Thread(target=self.build, daemon=True).start()

    def prepare_search_index(self):
        import numpy as np
        with self.library.connect() as db:
            images = db.execute('''SELECT i.id,v.hash FROM images i JOIN image_vectors v ON v.image_id=i.id
                WHERE v.refined=1 AND v.error IS NULL ORDER BY i.id''').fetchall()
            ids = np.asarray([row['id'] for row in images], dtype=np.int64)
            scenes = np.empty((len(images), 512), dtype=np.float16)
            palettes = np.empty((len(images), 48), dtype=np.float16)
            positions = {}
            for index, row in enumerate(images):
                positions.setdefault(row['hash'], []).append(index)
            for row in db.execute('SELECT hash,scene_embedding,palette FROM visual_embeddings WHERE scene_embedding IS NOT NULL AND palette IS NOT NULL'):
                for index in positions.pop(row['hash'], []):
                    scenes[index] = np.frombuffer(row['scene_embedding'], dtype=np.float16)
                    palettes[index] = np.frombuffer(row['palette'], dtype=np.float16)
            if positions:
                raise ValueError('Some saved scene vectors are missing.')
        temporary = self.search_path.with_suffix('.npz.partial')
        with temporary.open('wb') as stream:
            np.savez(stream, image_ids=ids, scenes=scenes, palettes=palettes)
        temporary.replace(self.search_path)

    def search_candidates(self, rows, seed_id, grouped=True):
        if not self.search_path.is_file():
            return None
        import numpy as np
        stamp = self.search_path.stat().st_mtime_ns
        with self.search_lock:
            if self.search_cache is None or self.search_cache[0] != stamp:
                with np.load(self.search_path, allow_pickle=False) as saved:
                    ids = saved['image_ids']
                    scenes = saved['scenes'].astype(np.float32)
                    palettes = saved['palettes'].astype(np.float32)
                if scenes.shape != (len(ids), 512) or palettes.shape != (len(ids), 48):
                    raise ValueError('The saved search index is damaged.')
                self.search_cache = (stamp, {int(image_id): i for i, image_id in enumerate(ids)}, scenes, palettes)
            _, lookup, scenes, palettes = self.search_cache
        seed = lookup.get(seed_id)
        if seed is None:
            return None
        scores = (scenes @ scenes[seed] + 0.03 * (palettes @ palettes[seed])) / 1.03
        selected, indices = [], []
        for row in rows:
            index = lookup.get(row['image_id'])
            if index is not None:
                selected.append(row)
                indices.append(index)
        return rank_rows(selected, scores[indices], grouped=grouped)

    def build(self):
        if not self.lock.acquire(blocking=False):
            return
        self.state = {'running': True, 'message': 'Loading the local image model…'}
        try:
            with self.library.connect() as db:
                pending = db.execute('''SELECT 1 FROM images i LEFT JOIN image_vectors v ON v.image_id=i.id
                    WHERE v.error IS NULL AND COALESCE(v.refined,0)=0 LIMIT 1''').fetchone()
            if not pending:
                if not self.search_path.is_file():
                    self.state['message'] = 'Preparing the saved search index…'
                    self.prepare_search_index()
                self.state['message'] = 'Visual index is ready.'
                return
            os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
            os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
            os.environ.setdefault('DO_NOT_TRACK', '1')
            import numpy as np
            from PIL import Image
            import torch
            from transformers import CLIPImageProcessor, CLIPVisionModelWithProjection
            from transformers.utils import logging as model_logging
            model_logging.set_verbosity_error()
            model_logging.disable_progress_bar()
            torch.set_num_threads(4)
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
            dtype = torch.float16 if device == 'cuda' else torch.float32
            cache = Path(__file__).resolve().parent / 'models'
            snapshot = cache / 'models--openai--clip-vit-base-patch32' / 'snapshots' / REVISION
            cached = all((snapshot / name).is_file() for name in ('config.json', 'preprocessor_config.json', 'pytorch_model.bin'))
            processor = CLIPImageProcessor.from_pretrained(MODEL, revision=REVISION, cache_dir=cache, local_files_only=cached)
            model = CLIPVisionModelWithProjection.from_pretrained(MODEL, revision=REVISION, cache_dir=cache, local_files_only=cached, weights_only=True).to(device=device, dtype=dtype).eval()
            background = tuple(round(value * 255) for value in processor.image_mean)
            self.state['message'] = f'Building full-scene matches locally on {"your GPU" if device == "cuda" else "the CPU"}… Scene content comes first, colors second.'
            with self.library.connect() as db:
                known = {row[0] for row in db.execute('SELECT hash FROM visual_embeddings WHERE scene_embedding IS NOT NULL AND palette IS NOT NULL')}

            def read_image(row):
                try:
                    path = (self.library.source / row['kind'] / row['filename']).resolve()
                    if not path.is_relative_to(self.library.source):
                        raise ValueError('Image path outside the source folder')
                    raw = path.read_bytes()
                    digest = hashlib.sha256(raw).hexdigest()
                    if digest in known:
                        return row['id'], digest, None, None, None
                    with Image.open(BytesIO(raw)) as image:
                        rgb = image.convert('RGB')
                        palette = palette_features(rgb)
                        full = scene_image(rgb, background=background)
                        rgb.close()
                        return row['id'], digest, full, palette, None
                except Exception as error:
                    return row['id'], None, None, None, str(error)[:300]

            with self.library.connect() as db:
                pending_rows = db.execute('''SELECT i.* FROM images i JOIN games g ON g.id=i.game_id
                    LEFT JOIN image_vectors v ON v.image_id=i.id
                    WHERE v.error IS NULL AND COALESCE(v.refined,0)=0
                    ORDER BY CASE WHEN i.id=g.thumb_id OR i.id=g.icon_id THEN 0 ELSE 1 END,
                    g.visits IS NULL,g.visits DESC,i.kind DESC,i.id''').fetchall()
            with ThreadPoolExecutor(max_workers=6) as readers:
                for offset in range(0, len(pending_rows), 128):
                    rows = pending_rows[offset:offset + 128]
                    loaded = list(readers.map(read_image, rows))
                    unique = {}
                    for _, digest, image, palette, error in loaded:
                        if not error and digest not in known and digest not in unique:
                            unique[digest] = (image, palette)
                    embeddings = []
                    items = list(unique.items())
                    for start in range(0, len(items), 128):
                        batch = items[start:start + 128]
                        inputs = processor(images=[image for _, (image, _) in batch], return_tensors='pt', do_resize=False, do_center_crop=False)
                        with torch.inference_mode():
                            vectors = model(pixel_values=inputs['pixel_values'].to(device=device, dtype=dtype)).image_embeds.float()
                            vectors = vectors / vectors.norm(dim=-1, keepdim=True).clamp_min(1e-12)
                        values = vectors.cpu().numpy().astype(np.float16)
                        if not np.isfinite(values).all():
                            raise ValueError('The image model produced an invalid embedding.')
                        embeddings.extend((digest, value.tobytes(), value.tobytes(), palette) for (digest, (_, palette)), value in zip(batch, values))
                    with self.library.connect() as db:
                        db.executemany('''INSERT INTO visual_embeddings(hash,embedding,scene_embedding,palette) VALUES (?,?,?,?)
                            ON CONFLICT(hash) DO UPDATE SET scene_embedding=excluded.scene_embedding,palette=excluded.palette''', embeddings)
                        db.executemany('INSERT OR REPLACE INTO image_vectors(image_id,hash,error,refined) VALUES (?,?,?,?)', ((image_id, digest, error, int(error is None)) for image_id, digest, _, _, error in loaded))
                    known.update(unique)
                    for _, _, image, _, _ in loaded:
                        if image is not None:
                            image.close()
            del model
            if device == 'cuda':
                torch.cuda.empty_cache()
            self.state['message'] = 'Saving the fast scene-search index…'
            self.prepare_search_index()
            self.state['message'] = 'Visual index is ready. Full-scene content comes first, colors second.'
        except Exception as error:
            self.state['message'] = f'Visual indexing paused: {error}. Resume the visual index to retry.'
        finally:
            self.state['running'] = False
            self.lock.release()


if __name__ == '__main__':
    from app import DEFAULT_SOURCE, HERE, Library
    library = Library(DEFAULT_SOURCE, HERE / 'library.sqlite3')
    library.visual.build()
    print(library.visual.status(), flush=True)
