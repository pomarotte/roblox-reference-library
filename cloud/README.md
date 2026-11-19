# Cloud gallery and daily indexing

This separate preview builds the existing historical catalogue and scene index and loads
image previews from `https://rolibrary.win/{icons|thumbs}/{filename}`. It does not change
the original gallery, the image dataset, or the public website.

Run `python build_cloud.py` to build `dist/`, and `node test-cloud.cjs` for the host checks.
The build currently depends on the adjacent `roblox-gallery` folder and its saved database
and visual index.

The Pages workflow serves this gallery at `/cloud/`. It runs daily at 13:47 UTC and can also run
from the Actions tab. For unattended uploads, set the repository's `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` Actions secrets to credentials scoped to `roblox-thumbnails`.
The job runs on GitHub. The historical gallery is available before credentials are configured.

The job checks named public Roblox charts, uploads new image bytes under content-addressed
`daily/` keys, and embeds each new file once with the historical CLIP model. It preserves
historical image IDs and stores daily game-image associations separately, including shared images.
The View menu shows new images for existing games, games added for the first time, or the full archive.
The daily views use the latest successful scan. Byte-for-byte duplicates of historical images are
excluded from the new images view. Scheduled and manual runs collect new captures, while code
pushes rebuild the site using the saved scan when a checkpoint is available.
The SQLite checkpoint contains public Roblox metadata and feature vectors, and the workflow stores
it as a GitHub Actions artifact for up to 90 days. Regular successful runs refresh it.

For an optional local run, execute `python run_daily.py`. It uses the configured rclone remote and
the same model as the historical collection. Pass `--limit 8` for a small test run.
Collection ZIP downloads require the R2 bucket to allow GET from `https://pomarotte.github.io`
in its CORS policy. Ordinary image display does not depend on that policy.
