#!/usr/bin/env python3
"""
Tiny mock of the cobalt API, for local UI testing only.

    python3 tests/mock-api.py 4320
    # then set the instance in Settings to http://127.0.0.1:4320

Implements just enough of the v11 contract:
  GET  /         instance info
  POST /         tunnel / picker / error responses, chosen by keywords in the url
  GET  /tunnel   a small generated file with Content-Length + CORS
"""
import base64
import json
import sys
import time
from urllib.parse import parse_qs, quote, urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

START = int(time.time() * 1000)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4320
PAYLOAD = b"mget mock payload\n" * 4096


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Estimated-Content-Length, RateLimit-Remaining")

    def _thumb(self):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(self.PNG)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(self.PNG)

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    PNG = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )

    def do_GET(self):
        if self.path.startswith("/thumb.png"):
            self._thumb()
            return
        if self.path.startswith("/tunnel"):
            query = parse_qs(urlparse(self.path).query)
            name = (query.get("name") or ["mock.bin"])[0]
            ctype = (query.get("type") or ["application/octet-stream"])[0]
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % name)
            self.send_header("Content-Length", str(len(PAYLOAD)))
            self.send_header("RateLimit-Remaining", "17")
            self._cors()
            self.end_headers()
            if "slow" in name:
                step = max(1, len(PAYLOAD) // 10)
                for offset in range(0, len(PAYLOAD), step):
                    self.wfile.write(PAYLOAD[offset:offset + step])
                    self.wfile.flush()
                    time.sleep(0.18)
            else:
                self.wfile.write(PAYLOAD)
            return
        self._json({
            "cobalt": {
                "version": "11.7-mock",
                "url": "http://127.0.0.1:%d" % PORT,
                "startTime": str(START),
                "services": ["youtube", "twitter", "instagram", "tiktok", "reddit",
                             "soundcloud", "bilibili", "vimeo", "twitch", "bandcamp"],
            },
            "git": {"commit": "0123456789abcdef", "branch": "main", "remote": "mock"},
        })

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json({"status": "error", "error": {"code": "api.url.invalid"}}, 400)
            return

        url = body.get("url", "")
        host = "http://127.0.0.1:%d" % PORT
        self._host = host

        if "picker" in url:
            # "link" entries are pages the client re-posts; the rest are files
            self._json({
                "status": "picker",
                "title": "a mock playlist",
                "picker": [
                    {"type": "link", "url": "https://youtu.be/one", "thumb": host + "/thumb.png", "name": "first item"},
                    {"type": "link", "url": "https://youtu.be/two", "thumb": host + "/thumb.png", "name": "second item"},
                    {"type": "link", "url": "https://youtu.be/three", "thumb": "", "name": "third item"},
                ],
            })
            return

        if "local" in url:
            self._json({
                "status": "local-processing",
                "type": "merge",
                "service": "youtube",
                "tunnel": [host + "/tunnel?v=1", host + "/tunnel?a=1"],
                "output": {"type": "video/mp4", "filename": "merged-output.mp4", "metadata": {"title": "Mock"}},
                "audio": {"copy": True, "format": "mp3", "bitrate": "128"},
            })
            return

        if "too-long" in url:
            self._json({"status": "error", "error": {"code": "api.content.video.too_long", "context": {"limit": 1500}}})
            return

        # the three rate-limit reasons the UI words differently
        for needle, reason in (("dailycap", "daily_cap"),
                               ("burst", "too_many_downloads"),
                               ("queuefull", "queue_full")):
            if needle in url:
                self._json({"status": "error", "error": {"code": "api.rate_limit",
                                                         "context": {"reason": reason}}}, 429)
                return

        if "error" in url:
            self._json({"status": "error", "error": {"code": "api.content.video.private", "context": {"service": "youtube"}}})
            return

        mode = body.get("downloadMode") or "auto"
        if mode == "audio":
            fmt = body.get("audioFormat") or "mp3"
            ext = "m4a" if fmt == "best" else fmt
            payload = ("mock-audio-%s.%s" % (fmt, ext), "audio/%s" % ("mp4" if ext == "m4a" else ext))
        else:
            payload = ("mock-%s.mp4" % mode, "video/mp4")
        if "slow" in url:
            payload = (payload[0].replace("mock-", "mock-slow-"), payload[1])
        self._json({
            "status": "tunnel",
            "url": host + "/tunnel?url=" + quote(url) + "&name=" + quote(payload[0]) + "&type=" + quote(payload[1]),
            "filename": payload[0],
        })

    def log_message(self, fmt, *args):
        sys.stderr.write("mock-api: " + (fmt % args) + "\n")


if __name__ == "__main__":
    print("mock cobalt api on http://127.0.0.1:%d" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
