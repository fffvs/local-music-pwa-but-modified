# Snae Player

**[snaeplayer.com](https://snaeplayer.com)** - Local music player in the browser.

Play audio files stored on your device. Includes playlists, queue, favorites, equalizer, playback speed, and artwork-based theming.

<p align="center">
  <img src="https://raw.githubusercontent.com/minht11/local-music-pwa/main/src/routes/(marketing)/assets/hero.avif" height="400" alt="Snae Player showing the music library and playback controls" />
</p>

## Browser support

The build targets Chromium 130 and Safari 18 or newer. When the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) is available, currently Chromium-based browsers, the app reads files directly from your chosen folder. In other browsers, files are copied into IndexedDB, which doubles the storage used.

## Large libraries and removable drives

- Use a Chromium-based browser with direct folder access for a large USB library. The fallback picker must first materialize the browser's full file list, then copies music into browser storage and can run out of space; file transfers to the scanner are bounded.
- Scanning is incremental and pauses during playback. Settings provides pause, resume (including while listening), and cancel controls. A pending file read may need to finish before a pause or cancellation takes effect.
- Rescans keep missing or unreadable tracks so a disconnected drive does not erase playlists or listening history. Remove unwanted tracks manually only when you are sure: removal also removes their playlist and history entries, but not the original music files.
- Incremental scans compare file size and modification time. An edit that preserves both attributes may not be detected. Browser storage can still be cleared or evicted, so keep a separate backup of the browser profile/library data.
- Close older app tabs if a database upgrade is blocked, and reconnect the drive or renew folder permissions if scanning or playback cannot read it.

Production builds leave the optional console performance and clipping diagnostics off to reduce background work. To enable them for troubleshooting, run `localStorage.setItem('snae-debug-diagnostics', '1')` in the browser console and reload. Studio's playback metrics remain available without this option.

## Privacy

Your music files and library data stay on your device. The app does not collect or transmit them.

Page views are counted using [GoatCounter](https://goatcounter.com/), a minimal privacy-preserving analytics tool.

## Translations

Translations are machine-generated and won't always sound natural. Fixes and suggestions are welcome — each language is a file in [`messages/`](messages/), with [`en.json`](messages/en.json) as the reference. To add a language, also register its code in [`vite.config.ts`](vite.config.ts) and the settings language picker, then run `pnpm run i18n-check`.

## Tech stack

SvelteKit/Svelte 5 · TypeScript · Tailwind CSS 4

## Running locally

Clone the repo, then copy `.env.example` to `.env`:

```
cp .env.example .env
pnpm install
pnpm run build
```

Or run the development server:

```
pnpm run dev
```

On first run, `pnpm run dev` or `pnpm run build` generates types for SvelteKit, auto-imports, and i18n, so run one of them before type checking.
