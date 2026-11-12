"""The HTTP contract, exercised over a real socket on a real port.

The media engine is faked (no network, no ffmpeg), but the routing, CORS,
auth, rate limiting, streaming and JSON shapes are the production code.
"""

import dataclasses
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mdown_api import engine, server as server_module, security
from mdown_api.config import Config

URL = "https://www.youtube.com/watch?v=test"
PUBLIC = ["93.184.216.34"]


class FakeEngine:
    def __init__(self):
        self.info = {"title": "A Test Clip", "duration": 60, "is_live": False}
        self.media = {"height": 720, "duration": 60, "has_video": True, "has_audio": True,
                      "format_name": "mp4", "video_codec": "h264", "audio_codec": "aac",
                      "size": 2048}
        self.payload = b"x" * 2048

    def probe(self, url, timeout, cache_dir=None):
        return dict(self.info)

    downloaded = 0

    def download(self, url, **kwargs):
        FakeEngine.downloaded += 1
        path = os.path.join(kwargs["dest_dir"], "media.mp4")
        with open(path, "wb") as handle:
            handle.write(self.payload)
        return path

    def probe_file(self, path, timeout=30):
        return dict(self.media)


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        logging.disable(logging.CRITICAL)

    @classmethod
    def tearDownClass(cls):
        logging.disable(logging.NOTSET)

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.fake = FakeEngine()
        FakeEngine.downloaded = 0

        self._saved = (engine.probe, engine.download, engine.probe_file,
                       engine.tools_available, security.resolve)
        engine.probe = self.fake.probe
        engine.download = self.fake.download
        engine.probe_file = self.fake.probe_file
        engine.tools_available = lambda: {"yt-dlp": True, "ffmpeg": True, "ffprobe": True}
        security.resolve = lambda host, port: list(PUBLIC)
        engine.INFO_CACHE._data.clear()

        self.config = Config(
            port=0,          # let the OS pick, so the suite never collides with a tunnel
            work_dir=self.tmp,
            min_free_bytes=0,
            max_concurrent=2,
            max_queue=4,
            rate_limit_max=50,
            cors_origins=["https://mdown.cc"],
        )
        self.server = server_module.ApiServer(self.config)
        self.port = self.server.server_address[1]
        self.base = "http://127.0.0.1:%d" % self.port
        # the tunnel URL must be absolute; point it at the test port
        self.server.RequestHandlerClass.config = dataclasses.replace(
            self.config, api_url=self.base + "/")
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        (engine.probe, engine.download, engine.probe_file,
         engine.tools_available, security.resolve) = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers -----------------------------------------------------------
    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Accept", "application/json")
        request.add_header("Origin", "https://mdown.cc")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def post(self, body, headers=None):
        status, hdrs, raw = self.call("POST", "/", body, headers)
        return status, hdrs, json.loads(raw or b"{}")

    # -- instance info -----------------------------------------------------
    def test_instance_info(self):
        status, headers, raw = self.call("GET", "/")
        self.assertEqual(status, 200)
        data = json.loads(raw)
        self.assertEqual(data["cobalt"]["version"], self.config.version)
        self.assertIn("youtube", data["cobalt"]["services"])
        self.assertIn("soundcloud", data["cobalt"]["services"])
        self.assertFalse(data["cobalt"]["apiKeyRequired"])
        self.assertEqual(data["limits"]["maxDuration"], 1800)
        self.assertEqual(data["limits"]["maxHeight"], 4320)
        self.assertEqual(headers.get("Content-Type"), "application/json; charset=utf-8")

    def test_health(self):
        status, _, raw = self.call("GET", "/health")
        self.assertEqual(status, 200)
        data = json.loads(raw)
        self.assertEqual(data["status"], "ok")
        self.assertTrue(data["checks"]["downloader"])
        self.assertNotIn("path", json.dumps(data).lower())

    def test_unknown_route(self):
        status, _, raw = self.call("GET", "/nope")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(raw)["error"]["code"], "api.content.video.unavailable")

    # -- cors --------------------------------------------------------------
    def test_preflight_allowed_origin(self):
        status, headers, _ = self.call("OPTIONS", "/", headers={
            "Origin": "https://mdown.cc",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "https://mdown.cc")
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods"))
        self.assertIn("Authorization", headers.get("Access-Control-Allow-Headers"))

    def test_preflight_foreign_origin_is_not_allowed(self):
        status, headers, _ = self.call("OPTIONS", "/", headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        })
        self.assertEqual(status, 204)
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))

    def test_post_carries_cors_header(self):
        _, headers, _ = self.post({"url": URL}, {"Origin": "https://mdown.cc"})
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "https://mdown.cc")

    # -- the download flow -------------------------------------------------
    def test_post_returns_tunnel_then_streams(self):
        self.fake.payload = b"y" * 5000
        status, headers, data = self.post({"url": URL, "downloadMode": "auto"})
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "tunnel")
        self.assertTrue(data["url"].startswith(self.base + "/tunnel/"))
        self.assertEqual(data["filename"], "A Test Clip.mp4")
        self.assertEqual(data["size"], 5000)
        self.assertIn("RateLimit-Remaining", headers)

        status, headers, body = self.call("GET", data["url"][len(self.base):])
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Length"), "5000")
        self.assertEqual(headers.get("Content-Type"), "video/mp4")
        self.assertIn("attachment", headers.get("Content-Disposition"))
        self.assertIn("Test%20Clip", headers.get("Content-Disposition"))
        self.assertEqual(len(body), 5000)

    def test_audio_mode_returns_audio_content_type(self):
        self.fake.media = {"height": 0, "duration": 60, "has_video": False,
                           "has_audio": True, "format_name": "mp3"}
        self.fake.payload = b"a" * 100

        def download(url, **kwargs):
            path = os.path.join(kwargs["dest_dir"], "media.mp3")
            with open(path, "wb") as handle:
                handle.write(b"a" * 100)
            return path

        engine.download = download
        status, _, data = self.post({"url": URL, "downloadMode": "audio", "audioFormat": "mp3"})
        self.assertEqual(status, 200)
        self.assertTrue(data["filename"].endswith(".mp3"))
        status, headers, body = self.call("GET", data["url"][len(self.base):])
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "audio/mpeg")

    def test_tunnel_token_is_unguessable_length(self):
        _, _, data = self.post({"url": URL})
        token = data["url"].rsplit("/", 1)[-1]
        self.assertGreaterEqual(len(token), 16)

    def test_tunnel_unknown_token(self):
        status, _, raw = self.call("GET", "/tunnel/" + "a" * 32)
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(raw)["status"], "error")

    def test_tunnel_query_form(self):
        _, _, data = self.post({"url": URL})
        token = data["url"].rsplit("/", 1)[-1]
        status, _, _ = self.call("GET", "/tunnel?id=" + token)
        self.assertEqual(status, 200)

    # -- range requests ----------------------------------------------------
    # A dropped connection on a 900 MB file used to mean starting again from
    # zero. These pin the resume contract.
    def _tunnel(self, payload=b"0123456789" * 500):
        self.fake.payload = payload
        _, _, data = self.post({"url": URL})
        return data["url"][len(self.base):], payload

    def test_full_download_advertises_ranges(self):
        path, payload = self._tunnel()
        status, headers, body = self.call("GET", path)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Accept-Ranges"), "bytes")
        self.assertIsNone(headers.get("Content-Range"))
        self.assertEqual(body, payload)

    def test_range_returns_206_with_content_range(self):
        path, payload = self._tunnel()
        status, headers, body = self.call("GET", path, headers={"Range": "bytes=0-99"})
        self.assertEqual(status, 206)
        self.assertEqual(headers.get("Content-Length"), "100")
        self.assertEqual(headers.get("Content-Range"), "bytes 0-99/%d" % len(payload))
        self.assertEqual(body, payload[:100])

    def test_range_from_offset_to_end(self):
        path, payload = self._tunnel()
        start = len(payload) - 40
        status, headers, body = self.call("GET", path, headers={"Range": "bytes=%d-" % start})
        self.assertEqual(status, 206)
        self.assertEqual(headers.get("Content-Range"),
                         "bytes %d-%d/%d" % (start, len(payload) - 1, len(payload)))
        self.assertEqual(body, payload[start:])

    def test_range_suffix_serves_the_tail(self):
        path, payload = self._tunnel()
        status, _, body = self.call("GET", path, headers={"Range": "bytes=-25"})
        self.assertEqual(status, 206)
        self.assertEqual(body, payload[-25:])

    def test_range_past_the_end_is_416(self):
        path, payload = self._tunnel()
        status, headers, _ = self.call("GET", path, headers={"Range": "bytes=%d-" % (len(payload) + 10)})
        self.assertEqual(status, 416)
        self.assertEqual(headers.get("Content-Range"), "bytes */%d" % len(payload))

    def test_head_reports_size_without_a_body(self):
        path, payload = self._tunnel()
        status, headers, body = self.call("HEAD", path)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Length"), str(len(payload)))
        self.assertEqual(headers.get("Accept-Ranges"), "bytes")
        self.assertEqual(body, b"")

    # -- rejections --------------------------------------------------------
    def test_duration_limit_is_serverside(self):
        self.fake.info["duration"] = 1801
        status, _, data = self.post({"url": URL})
        self.assertEqual(status, 422)
        self.assertEqual(data["error"]["code"], "api.content.video.too_long")
        self.assertEqual(data["error"]["context"]["limit"], 1800)

    def test_resolution_is_serverside(self):
        self.fake.media["height"] = 8640
        status, _, data = self.post({"url": URL})
        self.assertEqual(status, 422)
        self.assertEqual(data["status"], "error")

    def test_invalid_scheme(self):
        status, _, data = self.post({"url": "javascript:alert(1)"})
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], "api.url.invalid")

    def test_private_address(self):
        status, _, data = self.post({"url": "http://127.0.0.1:9000/"})
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], "api.url.invalid")

    def test_missing_url(self):
        status, _, data = self.post({})
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], "api.url.missing")

    def test_body_not_json(self):
        request = urllib.request.Request(self.base + "/", data=b"not json", method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Origin", "https://mdown.cc")
        try:
            urllib.request.urlopen(request, timeout=10)
            self.fail("expected an error")
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 400)

    def test_post_from_a_foreign_origin_is_refused(self):
        status, _, data = self.post({"url": URL}, {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertEqual(data["error"]["code"], "api.auth.origin")

    def test_post_without_an_origin_is_refused(self):
        # curl and friends send no Origin: they must say who they are or use a key
        data = json.dumps({"url": URL}).encode()
        request = urllib.request.Request(self.base + "/", data=data, method="POST")
        request.add_header("Content-Type", "application/json")
        try:
            urllib.request.urlopen(request, timeout=10)
            self.fail("expected a refusal")
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 403)

    def test_reads_stay_open(self):
        status, _, _ = self.call("GET", "/")
        self.assertEqual(status, 200)

    def test_download_burst_is_limited(self):
        # config in this class allows 50 requests/min; the job bucket is separate
        self.server.RequestHandlerClass.job_limiter = server_module.RateLimiter(2, 60)
        codes = []
        for _ in range(3):
            status, _, data = self.post({"url": URL, "downloadMode": "auto"})
            codes.append((status, (data.get("error") or {}).get("context", {}).get("reason")))
        self.assertEqual(codes[0][0], 200)
        self.assertEqual(codes[1][0], 200)
        self.assertEqual(codes[2][0], 429)
        self.assertEqual(codes[2][1], "too_many_downloads")

    def test_burst_limit_does_not_block_reading(self):
        self.server.RequestHandlerClass.job_limiter = server_module.RateLimiter(1, 60)
        self.post({"url": URL})
        status, _, _ = self.post({"url": URL})
        self.assertEqual(status, 429)
        # health and instance info stay open
        self.assertEqual(self.call("GET", "/health")[0], 200)
        self.assertEqual(self.call("GET", "/")[0], 200)

    def test_multi_item_post_returns_a_picker(self):
        self.fake.info = {
            "title": "a playlist",
            "duration": None,
            "is_live": False,
            "entry_count": 3,
            "entries": [
                {"url": "https://www.youtube.com/watch?v=a", "title": "one", "thumb": "https://i/1.jpg"},
                {"url": "https://www.youtube.com/watch?v=b", "title": "two", "thumb": ""},
                {"url": "https://www.youtube.com/watch?v=c", "title": "three", "thumb": ""},
            ],
        }
        before = FakeEngine.downloaded
        status, _, data = self.post({"url": URL, "downloadMode": "auto"})
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "picker")
        self.assertEqual(len(data["picker"]), 3)
        self.assertEqual(data["picker"][0]["type"], "link")
        self.assertEqual(data["picker"][0]["url"], "https://www.youtube.com/watch?v=a")
        self.assertEqual(data["picker"][0]["name"], "one")
        # nothing was downloaded: a picker costs one metadata call, not media
        self.assertEqual(FakeEngine.downloaded, before)

    def test_single_entry_playlist_is_a_normal_download(self):
        self.fake.info = {
            "title": "just one",
            "duration": 60,
            "is_live": False,
            "entry_count": 1,
            "entries": [{"url": "https://x/1", "title": "one", "thumb": ""}],
        }
        status, _, data = self.post({"url": URL, "downloadMode": "auto"})
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "tunnel")

    def test_live_rejected(self):
        self.fake.info["is_live"] = True
        status, _, data = self.post({"url": URL})
        self.assertEqual(status, 422)
        self.assertEqual(data["error"]["code"], "api.content.video.live")


class AuthTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.fake = FakeEngine()
        self._saved = (engine.probe, engine.download, engine.probe_file,
                       engine.tools_available, security.resolve)
        engine.probe = self.fake.probe
        engine.download = self.fake.download
        engine.probe_file = self.fake.probe_file
        engine.tools_available = lambda: {"yt-dlp": True, "ffmpeg": True, "ffprobe": True}
        security.resolve = lambda host, port: list(PUBLIC)
        engine.INFO_CACHE._data.clear()

        self.config = Config(port=0, work_dir=self.tmp, min_free_bytes=0, api_key="secret-key",
                             cors_origins=["https://mdown.cc"])
        self.server = server_module.ApiServer(self.config)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        (engine.probe, engine.download, engine.probe_file,
         engine.tools_available, security.resolve) = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_get_requires_key(self):
        status, raw = self.call("GET", "/")
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(raw)["error"]["code"], "api.auth.apikey.missing")

    def test_wrong_key(self):
        status, raw = self.call("GET", "/", headers={"Authorization": "Api-Key nope"})
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(raw)["error"]["code"], "api.auth.apikey.invalid")

    def test_correct_key(self):
        status, raw = self.call("GET", "/", headers={"Authorization": "Api-Key secret-key"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw)["cobalt"]["apiKeyRequired"])

    def test_post_requires_key(self):
        status, _ = self.call("POST", "/", {"url": URL})
        self.assertEqual(status, 401)

    def test_health_is_open(self):
        status, _ = self.call("GET", "/health")
        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main()
