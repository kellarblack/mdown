#!/usr/bin/env python3
"""
Static server that behaves like GitHub Pages: unknown paths get 404.html.

    python3 tests/spa-server.py 4332

Used to test the pretty deep link form:

    http://127.0.0.1:4332/https://youtube.com/watch?v=x
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path):
            self.path = "/404.html"
            return super().send_head()
        return super().send_head()

    def log_message(self, fmt, *args):
        sys.stderr.write("spa: " + (fmt % args) + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4332
    print("spa server on http://127.0.0.1:%d" % port)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
