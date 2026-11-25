# Cloud gallery and daily indexing

This separate preview builds the existing historical catalogue and scene index and loads
image previews from `https://rolibrary.win/{icons|thumbs}/{filename}`. It does not change
the original gallery, the image dataset, or the public website.

Run `python build_cloud.py` to build `dist/`, and `node test-cloud.cjs` for the host checks.
The build currently depends on the adjacent `roblox-gallery` folder and its saved database
and visual index.

The Pages workflow serves this gallery at `/cloud/`. It runs at 05:47, 13:47, and 21:47 UTC and can also run
from the Actions tab. For unattended uploads, set the repository's `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` Actions secrets to credentials scoped to `roblox-thumbnails`.
The job runs on GitHub. The historical gallery is available before credentials are configured.

The job checks the public charts returned by Roblox, uploads new image bytes under content-addressed
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

The Pages build publishes **Top 100 charts** using games from Roblox’s public Charts API. It ranks each genre and subgenre by concurrent players at the time of the scan. Categories with fewer than 100 ranked games show the available results. The snapshot refreshes during each Pages publish, including the scheduled runs, and works without R2 credentials.

The generator’s game-link import uses a read-only Cloudflare Worker because Roblox’s lookup APIs do not allow cross-origin browser requests. Deploy it with `npx wrangler deploy --config cloud/wrangler.reference.toml` from the repository root, using a Cloudflare account authorized for the `rolibrary.win` zone. The Worker returns Roblox CDN URLs and has no storage bindings. Run `node cloud/test-reference-worker.mjs` to check it locally.

## Private thumbnail analytics dashboard

1. In Cloudflare Zero Trust, [add Google as an identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/). Use a Google Cloud OAuth client and configure the redirect URI from the guide.
2. Create a self-hosted Access application covering `analytics.rolibrary.win`, select Google as its login method, and add an Allow policy for the creator emails that should have access. Record the application’s Audience (AUD) tag. [Cloudflare Access setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
3. From the repository root, deploy using the audience tag. The Worker requires the matching authenticated Cloudflare Access context even if the URL is reached directly.

   ```sh
   npx wrangler deploy --config cloud/wrangler.dashboard.toml --var ACCESS_AUDIENCE:YOUR_ACCESS_AUD
   ```

4. Open `https://analytics.rolibrary.win/` and verify that an allowed Google account can sign in. Connect a Roblox Universe ID with a game-scoped Open Cloud key granting `universe.thumbnail:read` and `universe.analytics:read`. Keep the separate write-scoped rotation key in the watcher environment. [Roblox Open Cloud key setup](https://create.roblox.com/docs/cloud/auth/api-keys)
5. After verifying the protected dashboard, set the repository Actions variable `ROLIBRARY_ANALYTICS_ENABLED` to `true` and rebuild Pages to link it from **Roblox Home thumbnail test**.

Run `node cloud/test-dashboard.mjs` from the repository root for the mocked Access and Roblox integration checks.
