# Hosting Snae Player without GitHub Pages or Codespaces

## Short version

This app is a **static single-page app**. `pnpm run build` produces a plain `build/`
folder of HTML, JS, CSS, fonts and icons. There is no server, no database and no
API to run — your music library lives in your own browser (IndexedDB / File System
Access API), not on the host.

That means **any free static host works**, and you do not need Codespaces, a VPS,
or even a computer with Node installed: the host connects to your GitHub repo and
builds it for you. Each host gives you a free HTTPS URL on a domain that is
*not* `github.io`.

> **Do this first:** open a few of these domains from the school network/device
> *before* setting anything up — `https://example.netlify.app`,
> `https://example.pages.dev`, `https://example.vercel.app`,
> `https://example.onrender.com`. School filters often block whole categories
> ("developer tools", "personal sites", "unclassified / newly registered
> domains"), so a host that works at home may be blocked at school. A short mail
> to your school's IT asking them to allowlist your one domain usually works.

## Build settings (same on every host)

| Setting | Value |
| --- | --- |
| Build command | `pnpm run build` (see host notes below) |
| Publish / output directory | `build` |
| Node.js | 24 or newer (`.node-version` is included; `engines.node >= 24`) |
| Package manager | pnpm 11 (`packageManager` in `package.json`) |
| Env vars | none needed — `.env.production` is committed with the public `PUBLIC_FALLBACK_PAGE=/200.html` |
| Secrets | none. Never put music files in the repo. |

`.env.production` is safe to commit: it contains a public build setting, not a
secret. It exists so hosts build correctly without you having to configure env
vars in a dashboard. You can still override it with a host-level variable.

The build emits two HTML files: `index.html` (the prerendered landing page) and
`200.html` (the empty SPA shell). **Deep links into the app must fall back to
`200.html`**, not `index.html` — otherwise the marketing page hydrates instead of
the route you asked for. This is why the configs below mention that file.

---

## Option A — Netlify (easiest, config already in the repo)

Site URL: `https://<your-name>.netlify.app`

1. Make a free account at [netlify.com](https://www.netlify.com/) and choose
   **Add new site → Import an existing project → GitHub**.
2. Pick this repository, then **deploy**. [`netlify.toml`](netlify.toml) already
   sets the build command, publish directory, Node version, SPA rewrites and the
   security headers, so you can leave every field blank.
3. In **Site configuration → Site details**, rename the site to something
   neutral, or add a custom domain (see "If the free domains are blocked").

Free plan: no credit card, custom domains and HTTPS included. New accounts get
300 credits/month (a production deploy costs 15, bandwidth 20/GB), which is
plenty for a personal music player — see [Netlify pricing](https://www.netlify.com/pricing/).

## Option B — Cloudflare Pages (best if a lot of people use it)

Site URL: `https://<your-project>.pages.dev`

Cloudflare's free tier has **unlimited bandwidth and static requests**, 500
builds/month and no credit card — see [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).

1. Free account at [dash.cloudflare.com](https://dash.cloudflare.com/) →
   **Workers & Pages → Create → Pages → Import an existing Git repository**.
2. Select this repo and use:

   | Field | Value |
   | --- | --- |
   | Framework preset | None |
   | Build command | `pnpm run build && cp build/200.html build/404.html` |
   | Build output directory | `build` |

3. Under **Settings → Environment variables → Build**, add:

   | Name | Value |
   | --- | --- |
   | `NODE_VERSION` | `24` |
   | `PNPM_VERSION` | `11.6.0` |

4. Save and deploy. **Do not add a `_redirects` catch-all rewrite.** Cloudflare
   Pages serves `404.html` automatically for paths that are not static assets;
   copying the SPA shell there gives deep links exactly the right page. A
   catch-all `/* /200.html 200` rule would also intercept the JS/CSS files on
   Pages and break the app. See [Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/).

## Option C — Vercel

Site URL: `https://<your-project>.vercel.app`

[`vercel.json`](vercel.json) is included: import the repo at
[vercel.com/new](https://vercel.com/new), set **Framework Preset** to `Other`
and deploy — no other fields to fill. The config sets `build` as the output
directory and rewrites unknown paths to `/200.html` (Vercel checks static files
before rewrites, so assets are unaffected). Vercel Hobby is free for personal,
non-commercial projects and includes 100 GB transfer/month — see
[Vercel Hobby plan](https://vercel.com/docs/plans/hobby).

## Option D — Build in GitHub Actions, then drag & drop (no local tools at all)

If you cannot connect a host to GitHub, or just want a folder you can upload
anywhere, the [`Build static site`](.github/workflows/build-static.yml) workflow
does the build in the cloud on every push (and can be run manually from the
Actions tab):

1. Push these changes, open **Actions → Build static site**, and click the
   latest run.
2. Download the `snae-player-static` artifact and unzip it. It contains the
   prerendered `index.html` for `/`, plus `200.html` and a `404.html` copy of the
   SPA shell, so it works on hosts that use either entry point.
3. Drag the folder onto [Netlify Drop](https://app.netlify.com/drop), or use
   **Cloudflare Pages → Create → Direct upload**, [tiiny.host](https://tiiny.host/),
   [Surge](https://surge.sh/) (`npm i -g surge && surge ./build`), etc.

> A `workflow_dispatch` workflow only appears in the Actions UI once it exists
> on your repository's **default branch** (`main`), so merge this first or run
> `gh workflow run build-static.yml --ref <your-branch>`.

[GitHub Actions](https://docs.github.com/en/billing/reference/actions-billing-per-minute-rates)
is free for public repos and includes 2,000 minutes/month on private ones —
building this app takes about a minute.

## Option E — No hosting at all

If you only need it on one computer you own, you don't need a host:

```bash
cp .env.example .env      # Node >= 24 and pnpm 11 required
pnpm install
pnpm run dev              # http://localhost:5173
```

`localhost` counts as a secure context, so the file picker, service worker and
PWA install all work, and the school filter never sees it. `pnpm run build &&
pnpm run preview` does the same with the production build. The catch: it only
works on that machine and only while the server is running. On a school-managed
Chromebook you usually cannot install Node — use one of the hosted options
instead, or enable Linux (Crostini) if your school allows it.

---

## If the free domains are blocked too

Try hosts with different domains until one loads on the school network:

| Host | Free URL | Notes |
| --- | --- | --- |
| Netlify | `*.netlify.app` | config included |
| Cloudflare Pages | `*.pages.dev` | unlimited bandwidth |
| Vercel | `*.vercel.app` | personal/non-commercial only |
| Render | `*.onrender.com` | free static sites, no credit card |
| Firebase Hosting | `*.web.app` | free tier, needs a Google account |
| Surge | `*.surge.sh` | CLI upload, custom domains free |
| Sevalla / Neocities / Tiiny.host | various | simple drag-and-drop uploads |

For any of them: build command `pnpm run build`, output `build`, Node 24+,
pnpm 11, and make sure unknown paths fall back to `200.html` (or a `404.html`
copy of it) rather than a generic 404 page.

**A custom domain is the most reliable fix.** A domain costs a few dollars a
year (some registrars have cheap `.xyz`/`.top`/`.me` names, and students often
get one free through GitHub Student Developer Pack). Add it under the host's
**Custom domains** settings — free HTTPS certificates are automatic — then use
that one URL everywhere. Filters are much less likely to block a single
ordinary-looking domain than a shared wildcard developer domain.

If the block is *only* on the `github.io` hostname, another option is to keep
using GitHub Pages but add a custom domain to it — visitors (and the filter) see
your own domain, never `github.io`. It still needs the same `/200.html` fallback
trick, though, so one of the hosts above is less work.

## Things that will bite you

- **Stay on one URL.** Your library, playlists, settings and folder permissions
  are stored per *origin* in the browser. Moving from
  `something.netlify.app` to `something.pages.dev` — even renaming the
  subdomain — gives you an empty library. A custom domain protects you from
  ever having to move again.
- **HTTPS is mandatory.** The service worker, PWA install and the File System
  Access API only work in a secure context. All the hosts above provide HTTPS.
  Serving the folder from a home PC over plain `http://192.168.x.x` will load
  the page but fail on file access and offline support.
- **Serve it from the domain root.** Asset URLs are absolute (`/_app/...`,
  `/icons/...`), so the app must live at `https://your-domain/`, not
  `https://your-domain/some-folder/`. A custom domain or a host subdomain is
  fine; a subdirectory is not.
- **Your music is not uploaded.** Hosting the site does **not** sync your songs.
  The audio files must be on the device you use at school (USB drive, Downloads
  folder, etc.). The app has no server-side storage at all.
- **Managed school devices.** Chrome policies can disable the File System
  Access API, and guest/Chromebook profiles can wipe IndexedDB on logout.
  Firefox/Safari use the app's IndexedDB fallback, which copies files into the
  browser (about double the storage). Don't rely on a school computer for your
  only copy of your library.
- **Troubleshooting a blank page:** open DevTools → Network. If a `.js` file
  comes back as HTML, your host's catch-all rewrite is shadowing static assets —
  remove `force = true` / remove the `/* /200.html 200` rule and let the host
  serve existing files first. If you see "Encountered dynamic routes" in the
  build log, `PUBLIC_FALLBACK_PAGE` was not picked up — set it to `/200.html`
  in the host's build environment variables.
