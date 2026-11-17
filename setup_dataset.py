"""Connect the unmodified original dataset to the portable gallery."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import webbrowser

from app import HERE, FILE_PATTERN

DATASET_URL = 'https://tools.frrazers.com/dataset/'


def configure_dataset(root, candidate):
    root, candidate = Path(root), Path(candidate).expanduser()
    folders = [path for path in (candidate, candidate / 'roblox-icons-thumbnails', candidate / 'images')
               if (path / 'icons').is_dir() and (path / 'thumbs').is_dir()]
    if not folders:
        raise ValueError('Choose the extracted folder containing both icons and thumbs.')
    with closing(sqlite3.connect('file:' + (root / 'library.sqlite3').resolve().as_posix() + '?mode=ro', uri=True)) as db:
        expected = set(db.execute('SELECT kind,filename FROM images'))
    if not expected:
        raise ValueError('The saved dataset inventory is missing. Extract the application download again.')
    for folder in folders:
        actual = set()
        for kind in ('icons', 'thumbs'):
            with os.scandir(folder / kind) as entries:
                actual.update((kind, entry.name) for entry in entries if FILE_PATTERN.fullmatch(entry.name) and entry.is_file(follow_symlinks=False))
        if actual == expected:
            folder = folder.resolve()
            temporary = root / 'dataset-path.txt.partial'
            temporary.write_text(str(folder) + '\n', encoding='utf-8')
            temporary.replace(root / 'dataset-path.txt')
            return folder
    raise ValueError('These filenames do not match the saved index. Use the original Everything dataset from ' + DATASET_URL)


def setup(root):
    saved = root / 'dataset-path.txt'
    candidates = ([Path(saved.read_text(encoding='utf-8').strip())] if saved.is_file() else [])
    candidates += [root / 'images', Path.home() / 'Downloads' / 'roblox-icons-thumbnails']
    for candidate in candidates:
        try:
            return configure_dataset(root, candidate)
        except (OSError, ValueError):
            pass
    print('\nDownload the original Everything dataset from:', DATASET_URL, flush=True)
    print('Extract it without renaming its images. The app will use the existing files in place.', flush=True)
    while True:
        value = input('Paste the extracted folder path, or enter D to open the download page (Enter to exit): ').strip().strip('"')
        if not value:
            raise ValueError('Download and extract the dataset, then run Start Gallery.cmd again.')
        if value.lower() == 'd':
            webbrowser.open(DATASET_URL)
            continue
        try:
            return configure_dataset(root, value)
        except (OSError, ValueError) as error:
            print(error, flush=True)


if __name__ == '__main__':
    try:
        print('Using dataset:', setup(HERE), flush=True)
    except (OSError, ValueError, sqlite3.Error) as error:
        print(error, flush=True)
        raise SystemExit(1)
