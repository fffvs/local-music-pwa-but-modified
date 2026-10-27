#!/usr/bin/env python3
"""Serve the production build at http://127.0.0.1:8080 with SPA fallback.

No dependencies — Python 3 standard library only. A school web filter never sees
localhost traffic, and localhost is a secure context, so the file picker,
IndexedDB, service worker and PWA install all work normally.

    python3 scripts/serve.py            # macOS, Linux, ChromeOS Linux, Termux
    py -3 scripts\\serve.py             # Windows with Python installed
    python3 scripts/serve.py 9000       # use a different port

Put the folder next to `build/` on a USB stick and run it from anywhere.
"""

from __future__ import annotations

import mimetypes
import os
import sys
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BUILD_DIR = Path(__file__).resolve().parent.parent / "build"
# 200.html is the SPA shell. index.html is the prerendered landing page and
# would hydrate the wrong route when used as a catch-all.
FALLBACK_PAGE = "/200.html"

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/avif", ".avif")


class SpaHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.isdir(path) and not os.path.isfile(path):
            # A missing JS/CSS chunk must not be answered with HTML — the
            # browser would report a confusing MIME-type error instead of a 404.
            if self.path.split("?", 1)[0].startswith("/_app/"):
                self.send_error(404, "Asset not found")
                return None
            self.path = FALLBACK_PAGE
        return super().send_head()


def main() -> None:
    if not (BUILD_DIR / FALLBACK_PAGE.lstrip("/")).is_file():
        sys.exit(f"Missing {BUILD_DIR / '200.html'} — run 'pnpm run build' first.")

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = partial(SpaHandler, directory=str(BUILD_DIR))

    with ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        # 127.0.0.1 avoids the IPv6 ::1 resolution that some browsers try for
        # "localhost" and can't reach when the server is IPv4-only.
        url = f"http://127.0.0.1:{port}/"
        print(f"Snae Player is running at {url}\nPress Ctrl+C to stop.", flush=True)
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
