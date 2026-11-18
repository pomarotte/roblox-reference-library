# Thumbnails Explorer

By [Poom](https://www.roblox.com/users/48069218/profile).

Explore Roblox game icons and thumbnails locally, filter by game type and popularity,
and find references with similar scenes. The software is open source under the MIT license;
see NOTICE.md for the separate rights associated with game artwork.

## Browser edition

[Open the website](https://pomarotte.github.io/roblox-reference-library/), download and extract
the original **Everything** dataset from [frrazers tools](https://tools.frrazers.com/dataset/),
then choose its folder containing **icons** and **thumbs**. No application installation or local
server is needed. Image files are read on the visitor's computer; they are never uploaded or changed.
Chrome and Edge can remember the folder with permission; other desktop browsers can use the
standard folder picker and select it again on each visit. Partial collections show available images
only, with missing files reported. The browser must support directory selection and gzip decompression.

The website includes the saved game catalogue. Visual search downloads about 143 MiB of prepared
scene features the first time it is used, caching them when browser storage is available. Searching
runs in a browser worker, prioritizing scenes over palette just like the desktop edition. There is
no GPU service, image upload, or paid search API. Desktop browsers are recommended for the full index.
Browser storage eviction or private browsing can require downloading the index again.

Build the static website with `python build_web.py` (NumPy required). The output is `.web-build/`.
The GitHub Pages workflow builds from the checksum-pinned public app release, extracting only the
saved database and visual index. Images and machine-specific paths never enter the website bundle.

## Portable Windows download

[Download the Windows app](https://github.com/pomarotte/roblox-reference-library/releases/latest)
and extract the application ZIP. Get the original **Everything** dataset from
[frrazers tools](https://tools.frrazers.com/dataset/) and extract it without renaming the images.
Run **Start Gallery.cmd** in the app folder. It finds the dataset in Downloads when possible;
otherwise, paste the extracted folder path. Enter D at the prompt to open the download page.
The path is remembered. Existing copies of the original dataset can be used directly.
See **START HERE.txt** for the short instructions.

The application does not redistribute the image dataset. It reads the selected original files
in place without changing filenames, image contents, or embedded metadata. Both icons/ and
thumbs/ are required so the dataset matches the saved cache. Wrong or incomplete collections
are rejected before cached records are changed.

The Windows x64 package includes its own isolated CPython runtime, NumPy, saved game metadata,
and the complete precomputed visual index. Recipients do not need Codex, a Python installation,
a GPU, an account, or an API key. The included collection can be browsed and searched offline.
Game information and image analysis are not repeated when opening the downloaded collection.

The gallery opens in the normal browser at http://127.0.0.1:8765. Keep its console window open.
Close the console or click **Stop gallery** to stop it. Running the launcher again opens the
existing gallery if it is already running. It listens on the local computer only.

The dataset folder contains icons/ and thumbs/. Game metadata and visual features are
stored separately in library.sqlite3 and search-index.npz. The machine-specific folder path
is kept in dataset-path.txt, excluded from release builds and source control.
SHA256SUMS.txt contains the application-download checksum.

## Browsing

- Search by game name or universe ID; filter by genre, subgenre, and an inclusive From/To visit range.
- Switch between thumbnails and icons, change preview size, and sort results.
- Choose 60, 120, 240, or 480 results per page (default 240).
- Hover over a card to cycle through that game's images. Moving away restores the original.
  Keyboard focus also cycles previews. Automatic cycling respects reduced-motion preferences.
- Enable **Show every saved image** to see all images directly in the grid. Otherwise, one card
  represents each game. Open a card to browse that game's saved images of the selected type.
- Use the arrow keys inside the preview or Show in Explorer to select the original file.
- The browser preview includes Game page and Play links for verified Roblox place IDs.
  When a place ID is unavailable, Find on Roblox searches by the saved game name.
- Saved metadata and visual features are included with the portable release. When processing a
  custom collection, use Refresh results to apply newly collected information.
- Unfinished collection resumes on the next launch. Resume metadata retries a paused collection.
- Image filenames are rescanned on launch. An incomplete or incompatible source dataset is detected before
  any cached records are removed.

## Favorites and collections (website)

Use the heart on an image to favorite it, or **+** / **Add to collection** to save that
individual image in one or more named collections. The sidebar switches between Explore,
Favorites, and your collections. These lists persist in this browser, including after
disconnecting the image folder. They do not sync across devices; clearing site data removes them.
After choosing a collection once, **+** adds images to the last collection you used.
Choose **Change** in the confirmation to adjust which collections contain that image.

Open a collection and choose **Download ZIP** to export all its images, including icons and
thumbnails regardless of the current filters. Reconnect the original dataset folder first.
Original filenames are preserved directly in the ZIP, without subfolders. Desktop browsers with a
file-save picker stream the archive to disk; other browsers support exports up to 512 MB.
Split collections above 4 GB or 65,535 files into smaller exports. Downloads do not modify originals.

## Find similar

Open a card, choose an image, and click **Find similar**. Choose **Visual appearance**, **Game type**,
or **Visual + game type**. Game type uses the same genre and, when available, subgenre. The combined
mode ranks visually within that game type. Visit ranges continue to apply; other filters can
further narrow the results. The source game is excluded. Visual search returns up to 480 closest
matches. Visual and combined searches always show individual saved images, displaying the
exact matched thumbnail. Hover cycling is paused in these results. Game-type-only searches
can still be grouped by game. Exiting similarity restores the previous gallery view.

Matching prioritizes the scene: people, objects, and actions, as represented by CLIP. The complete
thumbnail is fitted into the model input with padding; its sides are not cropped off. The dominant
score is cosine similarity between full-scene embeddings. A small palette tie-breaker can only
reverse scene scores that differ by at most 0.03, keeping colors secondary to scene content.
Scores are relative similarities, not probabilities. CLIP can confuse exact actions or family
relationships; results are visual references rather than verified scene descriptions.

The portable release includes precomputed embeddings, so no image model is downloaded or run for
normal browsing. For new-image analysis from source, the official OpenAI CLIP ViT-B/32 model is
downloaded into `models/`. Its revision is pinned in `visual.py`. Analysis stays local and uses an
NVIDIA GPU when available, otherwise the CPU. Identical files reuse their features. Progress is
saved in SQLite; unreadable images are reported and skipped.

Genre and visits describe the game when metadata was fetched, not when the image was saved.
Unavailable games retain their images and appear with unknown metadata. Visit filters exclude
unknown counts. Metadata stays cached; the app does not automatically refresh old counts or retry
unavailable games. "Unavailable" means the API returned no usable record, not that deletion was confirmed.

## Running or extending the source

Use Python 3.11 or newer and install NumPy for searches over an existing visual cache.
To analyze new images, install `requirements-visual.txt` in a normal Python environment,
with a suitable PyTorch build from https://pytorch.org/get-started/locally/.
The portable runtime is isolated; use a normal Python installation for development.

Without a packaged `collection.json`, the default source is
`%USERPROFILE%\Downloads\roblox-icons-thumbnails`. Override the folder or port as needed:

```powershell
python app.py --source "D:\my-images" --port 8766
```

Run the self-checks with `python -m unittest -v` (NumPy and Pillow required).

To rebuild the public distribution after metadata and visual indexing finish:

```powershell
python build_release.py runtime
python build_release.py app
```

The builder makes a consistent SQLite backup and includes source, notices, the saved
fast-search matrix, and a portable Python/NumPy runtime. It refuses to package unfinished
metadata or scene features. Only the application ZIP is distributed; users obtain the image
dataset directly from its original publisher.
