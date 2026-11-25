# Thumbnails Explorer

By [Poom](https://www.roblox.com/users/48069218/profile).

Explore Roblox game icons and thumbnails locally, filter by game type and popularity,
and find references with similar scenes. The software is open source under the MIT license;
see NOTICE.md for the separate rights associated with game artwork.

## Browser edition

[Open the website](https://pomarotte.github.io/roblox-reference-library/), download and extract
the original **Everything** dataset from [frrazers tools](https://tools.frrazers.com/dataset/),
then choose its folder containing **icons** and **thumbs**. No application installation or local
server is needed. Image files are read on the visitor's computer and are not changed. Selected references are sent to Google only when you use thumbnail generation.
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

## Collections (website)

Use the heart on an image or **Add to collection** in its preview to save it in one or more
named collections. The sidebar switches between Explore and your collections.
Collections persist in this browser, including after
disconnecting the image folder. They do not sync across devices; clearing site data removes them.
After choosing a collection once, the heart adds images to the last collection you used.
Choose **Change** in the confirmation to adjust which collections contain that image.

Open a collection and choose **Download ZIP** to export all its images, including icons and
thumbnails regardless of the current filters. Reconnect the original dataset folder first.
Original filenames are preserved directly in the ZIP, without subfolders. Desktop browsers with a
file-save picker stream the archive to disk; other browsers support exports up to 512 MB.
Split collections above 4 GB or 65,535 files into smaller exports. Downloads do not modify originals.

## Generate a thumbnail (website)

Open the **Image generator** tab on the right edge of Explorer. Use **Full screen** to expand it. Add an image with **+** on a thumbnail or **Add as reference** in its preview. You can also choose a saved collection, paste a Roblox game page link, or upload your own reference images. These references are temporary. Use the Object, Logo, and Text style tags to direct how the generator uses each image. Enter a Gemini API key and scene description, and generate. Text is off by default. Turn on **Allow text** and optionally enter the exact wording. Download a PNG at 1920 × 1080 or 960 × 540. The key is saved in this browser and is sent directly to Google along with your description and selected reference images when you generate. Use **Forget API key** to remove it from this browser. Google may charge your API account. Use reference images you have permission to send. Download the result before closing the page. Generation requires internet access and does not train a model.

To refer to a specific character or object, choose **Add box** on a selected reference, drag around the subject, and save a name. Type `@` in the description to insert a box mention. For example, `@[Red Knight] rides ahead while @[Blue Wizard] casts a spell.`

Use **Edit thumbnail** to revise the current image. The arrows below the preview browse generations and edits from this page session. Edits start from the selected version, and each version retains its own download and upscale.

## Test thumbnails on Roblox Home

1. Open an archived thumbnail for your game and click **Draft Home thumbnails**. RoLibrary fills in the Universe ID and looks for up to two references from different similar games. You can also open **Roblox Home thumbnail test** in the generator and enter a Universe ID directly.
2. Describe your game, upload assets, and click **Generate 3 variants**. RoLibrary drafts all three at 960 × 540. Use the history arrows to review them and click **AI upscale to 1920 × 1080** on the ones you want to test. Review each upscaled image, click **Approve this version**, and download it from the approved-version list.
3. Set `ROBLOX_API_KEY` in your terminal environment. Scope it to the game and grant `universe.thumbnail:read` and `universe.thumbnail:write`. Add `universe.analytics:read` for ranking. From the repository, use Node.js 20+ to upload your approved files and check their moderation status.

   ```sh
   node cloud/home-thumbnails.mjs UNIVERSE_ID upload PATH_TO_APPROVED_FILE_1 PATH_TO_APPROVED_FILE_2
   node cloud/home-thumbnails.mjs UNIVERSE_ID status
   ```

4. After Roblox approves them, activate 2–5 Home thumbnail IDs. Include any existing thumbnail you want to keep in the active set. Roblox serves variants automatically. The command updates an existing configuration in place so its statistics are retained.

   ```sh
   node cloud/home-thumbnails.mjs UNIVERSE_ID activate HOME_ID_1 HOME_ID_2
   ```

5. After collecting traffic, rank variants using a full UTC start date on which every variant was active. The command compares shared reporting days and requires 1,000 impressions per variant by default. Match the leading Home ID to the filename printed during upload, load that image under **Roblox Home thumbnail test**, and generate variations from it for the next round. You approve and activate each new round.

   ```sh
   node cloud/home-thumbnails.mjs UNIVERSE_ID rank YYYY-MM-DD
   ```

The rank command reports observed qualified plays per impression across the available days. Roblox allocates exposure by audience segment, so the aggregate ranking is a guide for iteration. [Roblox Home personalization](https://create.roblox.com/docs/production/publishing/thumbnails) · [Open Cloud thumbnail management](https://create.roblox.com/docs/cloud/guides/experience-icons-and-thumbnails) · [Thumbnail analytics metrics](https://create.roblox.com/docs/cloud/guides/analytics/metrics#thumbnails)

### Rotate an approved challenger into Home

Approve and upload a challenger, then pass its Home thumbnail ID and the UTC time when you last changed the active set. Run a one-time review with `rotate`, or leave `watch` running to check immediately and every 12 hours. Pass `24` to check once a day. The watcher exits after the challenger becomes active.

```sh
node cloud/home-thumbnails.mjs UNIVERSE_ID rotate ACTIVATED_AT_UTC CHALLENGER_HOME_ID
node cloud/home-thumbnails.mjs UNIVERSE_ID watch ACTIVATED_AT_UTC CHALLENGER_HOME_ID 12
```

Enter the activation time as `YYYY-MM-DDTHH:MM:SSZ`. Once Roblox approves the challenger, an open slot can be filled immediately. When all five slots are full, rotation waits for at least 10,000 impressions per active thumbnail across shared, completed reporting hours. It keeps the leader by qualified plays per impression and replaces the lowest performer with the challenger. A tie across the entire set waits for more data. The active configuration is updated in place. Record the new activation time for the next challenger.

### Follow performance in the analytics dashboard

Sign in with a one-time code sent to an allowed email address, then connect the experience with its Universe ID and an Open Cloud key scoped to that experience. Grant `universe.thumbnail:read` and `universe.analytics:read` for the dashboard. Use **Add another game** and the **Selected game** menu to switch between experiences in one browser tab. The dashboard refreshes the selected game every five minutes while the tab is visible. It charts each thumbnail’s qualified play rate, progress toward the rotation threshold, and performance over time using shared completed reporting hours. Expand **Exact numbers** for the underlying totals. Enter the last activation time after changing the active set. The dashboard clears keys when you disconnect a game, reload, or leave the page.

To see the watcher’s last check, decisions, and next scheduled check, set `ROLIBRARY_WATCH_REPORT` to a dedicated JSON path before starting `watch` or running `rotate`. Select that file under **Import local watcher activity**. Select the updated file again after later checks. The activity report contains thumbnail IDs and status messages.

See [dashboard deployment](cloud/README.md#private-thumbnail-analytics-dashboard) for the website owner’s one-time Cloudflare setup.

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
