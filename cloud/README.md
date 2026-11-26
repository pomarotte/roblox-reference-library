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

1. In Cloudflare Zero Trust, enable the [One-time PIN identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/). Cloudflare sends a sign-in code to the viewer’s authorized email address.
2. Create a self-hosted Access application covering `analytics.rolibrary.win`, select One-time PIN as its login method, and add an Allow policy for the exact creator emails that should have access. Record the application’s Audience (AUD) tag. [Cloudflare Access setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
3. Create the private bucket under [Thumbnail Autopilot](#thumbnail-autopilot). From the repository root, apply the migrations, then deploy using the audience tag. The Worker requires the matching authenticated Cloudflare Access context on the dashboard. The separate `watch.rolibrary.win` hostname accepts watcher events with game-scoped tokens. The database stores token hashes and recent rotation events.

   ```sh
   npx wrangler d1 migrations apply WATCH_ACTIVITY --remote --config cloud/wrangler.dashboard.toml
   npx wrangler deploy --config cloud/wrangler.dashboard.toml --var ACCESS_AUDIENCE:YOUR_ACCESS_AUD
   ```

4. Open `https://analytics.rolibrary.win/` and verify that an allowed email can sign in. Connect a Roblox Universe ID with a game-scoped Open Cloud key granting `universe.thumbnail:read` and `universe.analytics:read`. Keep the separate write-scoped rotation key in the watcher environment. [Roblox Open Cloud key setup](https://create.roblox.com/docs/cloud/auth/api-keys)
5. Set the repository Actions variable `ROLIBRARY_ANALYTICS_ENABLED` to `true` to link the protected dashboard from the generator. Once Autopilot is ready, set `ROLIBRARY_AUTOPILOT_ENABLED` to `true` and rebuild Pages to route thumbnail campaigns from the generator and gallery to Analytics.

Run `node cloud/test-dashboard.mjs` from the repository root for the mocked Access and Roblox integration checks. Run `node cloud/test-dashboard-activity.mjs` with Node.js 24 for the database and watcher authorization checks.

### Thumbnail Autopilot

The dashboard Worker runs due campaigns every two minutes. D1 stores campaign state and AES-GCM-encrypted
Roblox keys. The R2 bucket stores private assets and review images. The Cloudflare Images binding prepares
the final JPEG before review so the approved file matches the one submitted to Roblox.

Create the private bucket before deploying the updated Worker. Keep public access disabled.

```sh
npx wrangler r2 bucket create rolibrary-autopilot-private --config cloud/wrangler.dashboard.toml
npx wrangler d1 migrations apply WATCH_ACTIVITY --remote --config cloud/wrangler.dashboard.toml
```

Set the Worker secrets with `npx wrangler secret put NAME --config cloud/wrangler.dashboard.toml`.

- `AUTOPILOT_ENCRYPTION_KEY` is a stable base64-encoded 32-byte random key. Generate one with
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and store it securely.
  Replacing it makes previously saved Roblox keys unreadable.
- `AUTOPILOT_GEMINI_KEY` authorizes the existing Nano Banana 2.1 image model. Uploaded art and selected
  references are sent to Gemini as image inputs when drafts are generated.
- `AUTOPILOT_RESEND_KEY` and `AUTOPILOT_MAIL_FROM` authorize review notifications. Use a sender on a
  domain verified with Resend. Notifications go to the authenticated Cloudflare Access email.

Deploy with the Access audience command above. Verify that a connected game can save an asset and
generate a private draft before enabling the Pages link. For a live campaign, scope the Roblox key to
the game and grant `universe.thumbnail:read`, `universe.thumbnail:write`, and `universe.analytics:read`.
Use one rotation controller per game. External active-set changes pause Autopilot until the creator
reviews and syncs the new live set in Analytics. To resolve an upload with no Roblox receipt, inspect
Creator Dashboard before skipping it in Analytics. Autopilot avoids automatically retrying an upload
that Roblox might already have received.

Run `node cloud/test-autopilot.mjs` with Node.js 24 for the mocked end-to-end campaign check.
