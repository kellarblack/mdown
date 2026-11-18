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
import datetime
import json
import sys
import time
from urllib.parse import parse_qs, quote, urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

START = int(time.time() * 1000)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4320
PAYLOAD = b"mget mock payload\n" * 4096

#: private "this service is broken" notes, owner-only
INBOX = []

#: the request board, in memory for the length of the run
BOARD = [
    {"id": "seed-1", "t": int(time.time()) - 3 * 86400, "text": "a tool that strips chapters", "ok": True},
    {"id": "seed-2", "t": int(time.time()) - 2 * 3600, "text": "bandcamp album downloads", "ok": True},
]


def _owner(headers):
    """The moderator is whoever holds the instance key; the mock only checks
    that a key-shaped header is there."""
    return str(headers.get("Authorization") or "").startswith("Api-Key ")


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

    def _keyed(self):
        """An instance locked with an API key, reachable at /keyed/."""
        return self.path.startswith("/keyed")

    def _key_ok(self):
        return self.headers.get("Authorization") == "Api-Key test-key"

    def _require_key(self):
        if not self._keyed():
            return True
        if self._key_ok():
            return True
        if self.headers.get("Authorization"):
            self._json({"status": "error", "error": {"code": "api.auth.apikey.invalid"}}, 403)
        else:
            self._json({"status": "error", "error": {"code": "api.auth.apikey.missing"}}, 401)
        return False

    def do_GET(self):
        if self._keyed() and not self._require_key():
            return
        if self.path.startswith("/thumb.png"):
            self._thumb()
            return
        # an instance that also keeps a 30-day log, so the status page's server
        # graph can be exercised without the real box
        if self.path.startswith("/uptime-on"):
            if "/uptime" in self.path:
                days = []
                today = datetime.date.today()
                for i in range(30):
                    day = today - datetime.timedelta(days=29 - i)
                    if i == 29:
                        up, total = 47, 48
                    elif i in (12, 20):
                        up, total = 0, 48
                    elif i == 25:
                        up, total = 46, 48
                    else:
                        up, total = 48, 48
                    days.append({"date": day.isoformat(), "up": up, "total": total})
                self._json({"days": days, "checks": sum(d["total"] for d in days),
                            "uptime": 98.4})
                return
            if "/health" in self.path:
                self._json({"status": "ok", "uptimeSeconds": 3600})
                return

        if self.path.startswith("/reports"):
            if not _owner(self.headers):
                self._json({"status": "error", "error": {"code": "api.request.locked"}}, 403)
                return
            waiting = [entry for entry in INBOX if not entry.get("ok")]
            self._json({"items": waiting, "handled": []})
            return

        # an instance that advertises the board and then fails it, so the
        # "not answering" line can be seen without unplugging anything
        if "/boardbroken" in self.path and self.path.endswith("/requests"):
            self._json({"status": "error", "error": {"code": "api.internal"}}, 500)
            return

        if self.path.startswith("/requests/pending"):
            if not _owner(self.headers):
                self._json({"status": "error", "error": {"code": "api.request.locked"}}, 403)
                return
            waiting = [entry for entry in BOARD if not entry.get("ok")]
            self._json({"items": waiting})
            return
        if self.path.startswith("/requests"):
            shown = [entry for entry in BOARD if entry.get("ok")]
            self._json({"items": list(reversed(shown[-30:])), "count": len(shown)})
            return

        if self.path.startswith("/health"):
            # deliberately bare: no checks, no uptime. The status suite asserts
            # that a server reporting nothing is still read as up.
            self._json({"status": "ok"})
            return
        if self.path.startswith("/tunnel"):
            query = parse_qs(urlparse(self.path).query)
            name = (query.get("name") or ["mock.bin"])[0]
            ctype = (query.get("type") or ["application/octet-stream"])[0]
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % name)
            # "large" claims a 300 MB file and sends no body: enough for the
            # client to decide to hand the URL to the browser instead of
            # buffering it in the JS heap
            if "large" in name:
                self.send_header("Content-Length", str(300 * 1024 * 1024))
                self._cors()
                self.end_headers()
                return
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
                # opt-in capability: without it the client shows no preview
                "probe": True,
                "board": True,
                "inbox": True,
                "turnstileSitekey": None,
            },
            "limits": {"maxHeight": 4320, "maxDuration": 1800,
                       "modes": ["auto", "audio", "mute"]},
            "git": {"commit": "0123456789abcdef", "branch": "main", "remote": "mock"},
        })

    def do_POST(self):
        # read the body before any rejection: leaving it in the socket makes the
        # next request on this keep-alive connection parse as garbage (501, no
        # CORS) and the browser reports "Failed to fetch" instead of the 401
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        if self._keyed() and not self._require_key():
            return
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._json({"status": "error", "error": {"code": "api.url.invalid"}}, 400)
            return

        url = body.get("url", "")
        host = "http://127.0.0.1:%d" % PORT
        self._host = host

        if self.path.startswith("/reports/handled") or self.path.startswith("/reports/delete"):
            if not _owner(self.headers):
                self._json({"status": "error", "error": {"code": "api.request.locked"}}, 403)
                return
            handled = self.path.startswith("/reports/handled")
            for index, entry in enumerate(INBOX):
                if entry["id"] == body.get("id"):
                    if handled:
                        entry["ok"] = True
                    else:
                        INBOX.pop(index)
                    self._json({"status": "ok"})
                    return
            self._json({"status": "error", "error": {"code": "api.request.missing"}}, 404)
            return

        if self.path.startswith("/reports"):
            service = str(body.get("service") or "unknown").strip().lower()[:24]
            note = str(body.get("note") or "").strip()[:600]
            item = {"id": "p%d" % (len(INBOX) + 1), "t": int(time.time()),
                    "text": service + ((" \u00b7 " + note) if note else " \u00b7 reported broken"),
                    "ok": False}
            INBOX.append(item)
            self._json({"status": "queued", "item": dict(item, text="")}, 202)
            return

        if self.path.startswith("/requests/approve"):
            if not _owner(self.headers):
                self._json({"status": "error", "error": {"code": "api.request.locked"}}, 403)
                return
            for entry in BOARD:
                if entry["id"] == body.get("id"):
                    entry["ok"] = True
                    self._json({"status": "ok"})
                    return
            self._json({"status": "error", "error": {"code": "api.request.missing"}}, 404)
            return

        if self.path.startswith("/requests/delete"):
            if not _owner(self.headers):
                self._json({"status": "error", "error": {"code": "api.request.locked"}}, 403)
                return
            for index, entry in enumerate(BOARD):
                if entry["id"] == body.get("id"):
                    BOARD.pop(index)
                    self._json({"status": "ok"})
                    return
            self._json({"status": "error", "error": {"code": "api.request.missing"}}, 404)
            return

        if self.path.startswith("/requests"):
            text = str(body.get("text") or "").strip()
            if len(text) < 3:
                self._json({"status": "error",
                            "error": {"code": "api.request.invalid",
                                      "context": {"reason": "a few words, please"}}}, 400)
                return
            item = {"id": "r%d" % (len(BOARD) + 1), "t": int(time.time()),
                    "text": text, "ok": False}
            BOARD.append(item)
            self._json({"status": "pending", "item": item}, 202)
            return

        if self.path.startswith("/probe"):
            # a probe slow enough to double-click inside
            if "slowprobe" in url:
                time.sleep(3)
            if "error" in url:
                self._json({"status": "error",
                            "error": {"code": "api.content.video.private"}}, 422)
                return
            big = "xl" in url
            self._json({
                "status": "ok",
                "title": "a mock clip",
                "uploader": "mock",
                "duration": 125,
                "thumbnail": host + "/thumb.png",
                "estimate": {"bytes": (800 if big else 24) * 1024 * 1024, "height": 1080, "exact": False},
                "isLive": False,
                "isPlaylist": False,
                "tooLong": "too-long" in url,
                "service": "youtube",
            })
            return

        # a hostile instance: a link that would run script in our origin, and a
        # thumbnail that tries to close the CSS string it lands in
        if "jsurl" in url:
            self._json({"status": "tunnel", "url": "javascript:alert(1)", "filename": "hostile.mp4"})
            return
        if "badthumb" in url:
            self._json({
                "status": "tunnel",
                "url": host + "/tunnel?name=badthumb.mp4",
                "filename": "../../evil\u0000.mp4",
                "thumbnail": 'https://evil.example/a.png");background:url(https://evil.example/b.png',
            })
            return

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

        if self.path.startswith("/report"):
            # the browser suites POST their results here so a headless run can be
            # read back without a devtools session
            # do_POST already consumed the body — never read it twice or the
            # handler blocks waiting for bytes that will never arrive
            try:
                with open("/tmp/mdown-report.json", "w") as fh:
                    json.dump(body, fh)
            except OSError:
                pass
            self._json({"ok": True})
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

        # an encrypted track, the way SoundCloud's major-label releases answer
        if "drm" in url:
            self._json({"status": "error", "error": {"code": "api.content.drm", "ref": "mockdrm1"}}, 422)
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
        if "bigfile" in url:
            payload = ("mock-large-video.mp4", payload[1])
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
