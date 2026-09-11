# Wellness OS

A mobile-first personal home screen for wellness planning, rituals, tracking, and daily review.

## Local Preview

Open `index.html` directly in a browser, or run a small static server from the project folder:

```bash
python -m http.server 4173
```

Then visit `http://localhost:4173`.

## Vercel

This project can deploy to Vercel as a static site with no build step.

- Framework preset: Other
- Build command: leave empty
- Output directory: leave empty
- Install command: leave empty

Future pages can be added as static HTML files or the project can be moved into a Vite/Next.js app once the individual spaces need real state, auth, or data.

## Prep (Today checklist)

`prep.html` is a calm, mobile-first checklist view of the **`Prep_Tasks`** tab in the
"Destination Scorecard" Google Sheet. It is only a view — it does not add columns or
introduce a new data source. It reads and writes the existing columns (`task_name`,
`status`, `owner`, `due_date`, …) so it stays fully in sync with the sheet.

Features: Today tab (default) plus the next six days and a "Later" bucket, a Liz / Matt /
Both filter with a per-task owner toggle, one-tap complete (with a ding), drag-to-reorder
(saved on the device — no schema change), an inline "Add a task" button, and Today /
Tomorrow / date-picker day navigation.

### Connect the sheet (one time)

1. Open the Destination Scorecard sheet → `Extensions → Apps Script`.
2. Paste in `docs/prep-tasks-apps-script.gs` and save.
3. (Recommended) Project Settings → Script Properties → add `PREP_TOKEN` with a long
   random value.
4. `Deploy → New deployment → Web app` — *Execute as: Me*, *Who has access: Anyone with
   the link*. Copy the `/exec` URL.
5. In the Prep page, tap the gear (Settings), paste the `/exec` URL and the same token
   (if you set one), and Save.

Re-deploy a new version of the Apps Script whenever you change it.

## Personal App Auth

The app includes a lightweight personal auth layer for phone use. Sessions last 30 days.

- Frontend: `app-auth.js` shows the unlock screen, stores the signed token on the device, registers the PWA service worker, and adds `Authorization: Bearer ...` to Wellness OS API calls.
- Auth Worker: `cloudflare/wellness-auth-worker.js` issues 30-day signed tokens.
- Protected Workers: `cloudflare/notion-budget-manager-worker.js` and `cloudflare/skincare-worker.js` verify the same token before proxying Notion-backed data.

Before deploying the protected Workers, set the same signing secret everywhere and set the app password on the auth Worker:

```bash
cd cloudflare
wrangler secret put PERSONAL_AUTH_SECRET --config wrangler.wellness-auth.jsonc
wrangler secret put PERSONAL_APP_PASSWORD --config wrangler.wellness-auth.jsonc
wrangler secret put PERSONAL_AUTH_SECRET --config wrangler.skincare.jsonc
wrangler secret put PERSONAL_AUTH_SECRET --config wrangler.notion-budget-manager.jsonc
```

Keep the existing `NOTION_TOKEN` secret on the `notion-budget-manager` Worker.

## EPUB → Audio (TTS pipeline)

`audio-render.html` turns an EPUB/TXT into MP3 entries in the Audio Library. Rendering
is orchestrated **in the browser**, not inside one long Worker request:

1. The page extracts chapters and splits each one into ≤2,800-character chunks.
2. Each chunk is a separate `POST /api/tts/synthesize` call (one Edge TTS socket per
   request, a few seconds each), with its own timeout and retries.
3. The browser concatenates the MP3 frames and uploads the finished file once via
   `POST /api/tts/library/upload`, which stores it in R2 and writes the Notion row.

The earlier design asked the Worker to synthesize a whole chapter in a single request,
opening two Edge TTS sockets at a time. When a socket hung, the request never returned:
the page sat on "Rendering…" indefinitely and the Notion row stayed `pending` with an
empty `Error`. Every stage now has a deadline, so a failure is visible instead of silent.

### Background renders (no tab, no wake lock)

"Render in background" hands the whole selection to the Worker instead of rendering it in
the page. A Cron Trigger fires every minute and works the queue, so the render continues
with the browser closed and the phone asleep.

Job state lives in R2 alongside the audio — no extra binding to provision:

| Key | Holds |
| --- | --- |
| `jobs/active/<id>.json` | manifest + cursor (chapter, chunk) |
| `jobs/done/<id>.json` | finished manifest |
| `jobs/cancel/<id>` | tombstone requesting cancellation |
| `jobs/text/<id>/<n>.txt` | chapter source text |
| `jobs/audio/<id>/<n>/<k>.mp3` | rendered chunk, concatenated on completion |

Each tick claims the oldest un-leased job, renders chunks until its time or subrequest
budget runs out, and persists the cursor after every chunk — so a tick that dies loses at
most one chunk. Chapters retry up to three times across ticks before being marked `error`,
and finishing or cancelling a job clears its scratch keys and closes out its Notion row.
The per-tick budgets are deliberately conservative (50s, 40 subrequests) to stay inside
the Workers Free limits; on Workers Paid they could be raised for faster throughput.

Endpoints: `POST /api/tts/jobs` (queue), `GET /api/tts/jobs` (list), `GET /api/tts/jobs/<id>`
(progress), `POST /api/tts/jobs/<id>/cancel`.

Run the job-runner tests — no network, no Cloudflare account needed:

```bash
node cloudflare/tts-jobs.test.mjs
```

**The render page requires the current Worker build.** After pulling these changes:

```bash
cd cloudflare
wrangler deploy --config wrangler.tts.jsonc
```

Or let CI do it: `.github/workflows/deploy-tts-worker.yml` deploys the Worker whenever
`cloudflare/tts-worker.js`, `personal-auth.js` or `wrangler.tts.jsonc` changes on `main`,
runs the job-runner tests first, and then polls `/api/tts/health` to confirm the build
that is actually live. It needs one repository secret, `CLOUDFLARE_API_TOKEN`, with
**Workers Scripts: Edit** and **Account Settings: Read** (add `CLOUDFLARE_ACCOUNT_ID` too
if you prefer a token without account-read). Redeploying never clears Worker secrets, so
`PERSONAL_AUTH_SECRET` is untouched.

Verify the build that is live (no auth required):

```bash
curl -s https://tts.eamiller1981.workers.dev/api/tts/health
# {"ok":true,"version":"2026-09-11-jobs-1","features":[...,"libraryUpload","backgroundJobs"]}
```

If `libraryUpload` or `backgroundJobs` is missing from `features`, the render page shows a
banner and the Worker still needs deploying. Deploying also registers the Cron Trigger that
drives background renders; confirm it under Workers → tts → Settings → Triggers.

Operational notes:

- "Render here (watch it)" runs the loop in the page: closing the tab or letting the phone
  sleep stops it, so the page holds a screen wake lock while rendering and warns before
  unload. "Render in background" has neither constraint.
- Chapters left mid-render are marked `pending` in Notion and can simply be re-rendered.
