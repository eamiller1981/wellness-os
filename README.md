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
