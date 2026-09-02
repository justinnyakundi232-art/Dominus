# Dev-only static server for previewing the extension pages.
#
# python -m http.server sends Last-Modified and the browser then serves edited
# CSS and JS from its own cache, which during a UI pass means screenshotting a
# version of the page that no longer exists on disk. This is the same server
# with caching switched off.

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8124
    print(f"serving on http://localhost:{port} (no-store)")
    sys.stdout.flush()
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
