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

### How it syncs

Prep talks to the existing **Year Abroad Scorecard** Google Apps Script web app — the
same deployment that powers the scorecards, itinerary, notes, and travel tracker. That
script already exposes full Prep_Tasks CRUD (`load_tasks`, `save_task`, `update_task`,
`delete_task`), so Prep does not need its own backend and does not change the sheet
schema.

The web app URL is hardcoded in `prep.html` (`DEFAULT_ENDPOINT`), just like the other
pages hardcode their API URLs — so there is no per-device setup. If that web app is ever
re-deployed to a new URL, update `DEFAULT_ENDPOINT`, or use the gear (Settings) on the
Prep page to override it and **Reset to default** to clear the override.

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
