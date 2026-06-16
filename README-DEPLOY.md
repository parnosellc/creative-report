# Creative Performance Report — Deploy to Railway

A small Node server that holds your Facebook token, runs the report, and hosts
shareable snapshots. The browser never sees the token. Zero dependencies.

```
creative-report-railway/
├── server.js          ← the server (token-side pull, caching, snapshots)
├── public/index.html  ← the report UI (no token; calls the server)
├── package.json
├── .gitignore
└── .env.example       ← the env vars you'll set in Railway
```

---

## Step 1 — Put the code on GitHub

1. Create a new **private** GitHub repo (e.g. `creative-report`).
2. Upload these four files + the `public/` folder. Easiest no-terminal way:
   on the repo page, **Add file → Upload files**, drag everything in, **Commit**.
   (Make sure `public/index.html` keeps its folder — upload the `public` folder too.)

## Step 2 — Create the Railway project

1. Go to **railway.app → New Project → Deploy from GitHub repo** → pick your repo.
   This sets up **auto-deploy on every push**. (Don't use the Railway CLI for this —
   mixing CLI + dashboard creates duplicate projects.)
2. Railway auto-detects Node and runs `npm start`. No build command needed.

## Step 3 — Add a Volume (for durable snapshots)

Railway wipes the disk on every redeploy, so saved snapshots need a Volume.

1. In your service → **Settings → Volumes → New Volume**.
2. Mount path: **`/data`**.

## Step 4 — Set the environment variables

Service → **Variables → Raw Editor**, paste this, and fill in the token:

```
CPR_FB_TOKEN=<your read-only system-user token>
CPR_FB_AD_ACCOUNTS=445988994369431,2149427105556889
CPR_FB_API_VERSION=v21.0
CPR_SECRET=<a long random string — see below>
CPR_DATA_DIR=/data
```

- **CPR_SECRET** is your secret URL. Make it long and random (e.g. mash 30+
  characters). Your private report will live at:
  `https://<your-app>.up.railway.app/<CPR_SECRET>/`
- **Do NOT add a `PORT` variable** — Railway injects it; setting it yourself causes 502s.

Save. Railway redeploys automatically. (If it shows "Apply N changes" and doesn't
restart, click Apply or hit **Redeploy**.)

## Step 5 — Open it

1. Service → **Settings → Networking → Generate Domain** (gives you the
   `*.up.railway.app` URL).
2. Visit `https://<your-app>.up.railway.app/<CPR_SECRET>/` — that's your live report.
3. Quick health check: `https://<your-app>.up.railway.app/healthz` should show
   `{"ok":true,"accounts":2,"tokenSet":true}`.

---

## How it works

- **Live report** (`/<secret>/`) — pulls fresh data through the server. Results are
  **cached 45 minutes** per date range, so re-opening or sharing the live link won't
  hammer your system user.
- **Snapshots** — click *Create shareable snapshot*. The server bakes in the data and
  **base64-embedded thumbnails**, saves it, and gives you a public link like
  `https://<your-app>.up.railway.app/s/ab12cd34`. That link uses **no token and makes
  zero Facebook calls**, so colleagues can't touch your system user. Snapshots
  **auto-delete after 90 days.**

## Updating later

Edit a file on GitHub (or push a change) → Railway redeploys automatically.
To bump the Graph API version, just change `CPR_FB_API_VERSION` in Variables — no code change.

## Gotchas (from experience)

- Never set `PORT` yourself → 502 "application not found".
- Snapshots live on the **/data Volume**; without it they vanish on redeploy.
- If a new env var doesn't take effect, hit **Redeploy**.
- Pick one deploy method (dashboard) — don't also use the CLI, or you'll get
  duplicate projects.
