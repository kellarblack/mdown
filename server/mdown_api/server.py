"""HTTP layer: the cobalt v11 contract, stdlib only.

Routes
  GET  /                 instance info      -> data.cobalt.{version,services}
  GET  /health           liveness + dependency checks
  POST /                 create a job       -> {status:"tunnel", url, filename}
  GET  /tunnel/<token>   stream the file

The tunnel URL is fetched by the browser with no headers at all, so it cannot
carry an API key: the unguessable token is the capability, it is single-job,
and the file behind it is deleted shortly after it is served.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import socketserver
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

from . import engine
from .config import Config
from .errors import ApiError
from .jobs import JobManager, PickerNeeded, RateLimiter
from .security import header_safe, validate_url

log = logging.getLogger("mdown.api")

MAX_BODY = 16 * 1024
CHUNK = 64 * 1024

#: services this instance can actually fetch, for the front-end's
#: "is this service available here" hint
SERVICES = [
    "youtube", "twitter", "instagram", "tiktok", "reddit", "soundcloud",
    "bandcamp", "mixcloud", "audiomack", "hearthis", "bilibili", "vimeo",
    "dailymotion", "twitch", "kick", "rumble", "odysee", "streamable",
    "coub", "facebook", "threads", "snapchat", "rutube", "ok", "vk",
    "loom", "tumblr", "bluesky", "newgrounds", "xiaohongshu", "imgur", "9gag",
]

CONTENT_TYPES = {
    "mp4": "video/mp4",
    "m4v": "video/mp4",
    "mkv": "video/x-matroska",
    "webm": "video/webm",
    "mov": "video/quicktime",
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "wav": "audio/wav",
    "flac": "audio/flac",
}


class ToolState:
    """Cached dependency probe — no subprocess per health request."""

    def __init__(self, ttl: int = 120) -> None:
        self.ttl = ttl
        self._at = 0.0
        self._value: Dict[str, bool] = {}
        self._lock = threading.Lock()

    def read(self) -> Dict[str, bool]:
        with self._lock:
            if time.time() - self._at > self.ttl:
                self._value = engine.tools_available()
                self._at = time.time()
            return dict(self._value)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mdown"
    sys_version = ""
    timeout = 120

    # injected by the server factory
    config: Config
    jobs: JobManager
    limiter: RateLimiter
    job_limiter: RateLimiter
    tools: ToolState
    started_at: float

    # -- plumbing ----------------------------------------------------------
    def version_string(self) -> str:  # no trailing space from sys_version
        return self.server_version

    def log_message(self, fmt: str, *args: Any) -> None:  # keep noise down
        log.info("%s %s", self.address_string(), fmt % args)

    def _client_ip(self) -> str:
        if self.config.trust_proxy:
            forwarded = self.headers.get("X-Forwarded-For", "")
            if forwarded:
                return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def _cors_headers(self) -> Dict[str, str]:
        origin = self.headers.get("Origin", "")
        if self.config.cors_origin_allowed(origin):
            return {
                "Access-Control-Allow-Origin": origin.rstrip("/"),
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
                "Access-Control-Expose-Headers": "RateLimit-Remaining, RateLimit-Reset, Content-Length",
                "Access-Control-Max-Age": "600",
                "Vary": "Origin",
            }
        return {"Vary": "Origin"}

    def _send(self, status: int, body: bytes, content_type: str,
              extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (extra or {}).items():
            self.send_header(key, header_safe(value))
        for key, value in self._cors_headers().items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: Dict[str, Any],
              extra: Optional[Dict[str, str]] = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra)

    def _error(self, error: ApiError) -> None:
        headers = {}
        if error.code == "api.rate_limit":
            headers["Retry-After"] = str(error.context.get("retry") or 30)
        self._json(error.status, error.payload(), headers)

    # -- auth --------------------------------------------------------------
    def _check_auth(self) -> None:
        if not self.config.api_key:
            return
        header = self.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if not token.strip() and header:
            token = header
        token = token.strip()
        if not token:
            raise ApiError.auth_missing()
        if not hmac.compare_digest(token, self.config.api_key):
            raise ApiError.auth_invalid()

    # -- routing -----------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        for key, value in self._cors_headers().items():
            self.send_header(key, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._route_get()
        except ApiError as error:
            self._error(error)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.error("unhandled GET error\n%s", traceback.format_exc())
            self._error(ApiError.internal())

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._route_post()
        except ApiError as error:
            self._error(error)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.error("unhandled POST error\n%s", traceback.format_exc())
            self._error(ApiError.internal())

    def _route_get(self) -> None:
        path, query = self._split()
        if path in ("/", ""):
            self._instance_info()
        elif path == "/health":
            self._health()
        elif path == "/tunnel" or path.startswith("/tunnel/"):
            token = path[len("/tunnel/"):] if path.startswith("/tunnel/") else ""
            if not token:
                token = (parse_qs(query).get("id") or [""])[0]
            self._serve_tunnel(unquote(token))
        else:
            raise ApiError.not_found()

    def _split(self) -> Tuple[str, str]:
        parts = urlsplit(self.path)
        path = parts.path or "/"
        if len(path) > 1:
            path = path.rstrip("/")
        return path, parts.query

    # -- handlers ----------------------------------------------------------
    def _instance_info(self) -> None:
        self._check_auth()
        payload = {
            "cobalt": {
                "version": self.config.version,
                "url": self.config.api_url,
                "startTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.started_at)),
                "turnstileSitekey": None,
                "apiKeyRequired": bool(self.config.api_key),
                "services": SERVICES,
            },
            "git": {"branch": "", "commit": ""},
            "limits": {
                "maxHeight": self.config.max_height,
                "maxDuration": self.config.max_duration,
                "modes": ["auto", "audio", "mute"],
                "audioFormats": ["mp3", "ogg", "opus", "wav"],
                "maxAudioBitrate": 128,
            },
        }
        self._json(200, payload)

    def _health(self) -> None:
        tools = self.tools.read()
        stats = self.jobs.stats()
        disk_ok = stats["disk_free_mb"] * 1024 * 1024 >= self.config.min_free_bytes
        healthy = all(tools.values()) and disk_ok
        payload = {
            "status": "ok" if healthy else "degraded",
            "checks": {
                "downloader": bool(tools.get("yt-dlp")),
                "ffmpeg": bool(tools.get("ffmpeg")),
                "ffprobe": bool(tools.get("ffprobe")),
                "storage": disk_ok,
            },
            "jobs": {"active": stats["active"], "queued": stats["queued"]},
            "uptimeSeconds": stats["uptime_s"],
        }
        self._json(200 if healthy else 503, payload)

    def _serve_tunnel(self, token: str) -> None:
        if not token:
            raise ApiError.not_found()
        job = self.jobs.get(token)
        if job is None or not job.path or not os.path.isfile(job.path):
            raise ApiError.not_found()

        size = os.path.getsize(job.path)
        extension = os.path.splitext(job.path)[1].lstrip(".").lower()
        content_type = CONTENT_TYPES.get(extension, "application/octet-stream")
        disposition = "attachment; filename*=UTF-8''%s" % _quote(job.filename)

        try:
            handle = open(job.path, "rb")
        except OSError:
            raise ApiError.not_found()

        with handle:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", disposition)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for key, value in self._cors_headers().items():
                self.send_header(key, value)
            self.end_headers()
            if self.command == "HEAD":
                return

            remaining = size
            while remaining > 0:
                chunk = handle.read(min(CHUNK, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

        self.jobs.mark_served(token)

    def _route_post(self) -> None:
        path, _ = self._split()
        if path not in ("/", ""):
            raise ApiError.not_found()

        self._check_auth()

        verdict = self.limiter.check(self._client_ip())
        headers = {
            "RateLimit-Limit": str(self.config.rate_limit_max),
            "RateLimit-Remaining": str(verdict["remaining"]),
            "RateLimit-Reset": str(verdict["retry"]),
        }
        if not verdict["allowed"]:
            error = ApiError.rate_limit(0)
            error.context["retry"] = verdict["retry"]
            headers["Retry-After"] = str(verdict["retry"])
            self._json(429, error.payload(), headers)
            return

        burst = self.job_limiter.check(self._client_ip())
        if not burst["allowed"]:
            error = ApiError.rate_limit(0)
            error.context["retry"] = burst["retry"]
            error.context["reason"] = "too_many_downloads"
            headers["Retry-After"] = str(burst["retry"])
            self._json(429, error.payload(), headers)
            return

        body = self._read_json()
        url = body.get("url")
        if not isinstance(url, str) or not url.strip():
            raise ApiError.url_missing()

        safe_url = validate_url(url)

        mode = str(body.get("downloadMode") or "auto").strip().lower()
        if mode not in ("auto", "audio", "mute"):
            mode = "auto"

        height = _as_int(body.get("videoQuality"), self.config.max_height)
        audio_format = str(body.get("audioFormat") or "mp3").strip().lower()
        if audio_format not in ("mp3", "ogg", "opus", "wav"):
            audio_format = "mp3"
        bitrate = min(_as_int(body.get("audioBitrate"), 128), 128)

        subtitle_lang = str(body.get("subtitleLang") or "").strip().lower()
        if subtitle_lang and not re.fullmatch(r"[a-z]{2,3}(-[a-z0-9]{2,8})?", subtitle_lang):
            subtitle_lang = ""

        try:
            job = self.jobs.create(
                safe_url,
                mode=mode,
                height=height,
                audio_format=audio_format,
                audio_bitrate=bitrate,
                subtitle_lang=subtitle_lang,
            )
        except PickerNeeded as picker:
            self._json(200, {
                "status": "picker",
                "title": picker.title,
                "picker": [
                    {
                        "type": "link",
                        "url": entry.get("url", ""),
                        "thumb": entry.get("thumb", ""),
                        "name": entry.get("title", ""),
                    }
                    for entry in picker.entries
                ],
            }, headers)
            return
        except engine.EngineError as failure:
            log.warning("engine failure: %s", failure)
            if "timed out" in str(failure):
                self._json(504, {
                    "status": "error",
                    "error": {"code": "api.instance.timed_out"},
                }, headers)
                return
            raise ApiError.internal(str(failure))

        tunnel = self.config.api_url.rstrip("/") + "/tunnel/" + job.token
        self._json(200, {
            "status": "tunnel",
            "url": tunnel,
            "filename": job.filename,
            "size": job.size,
        }, headers)

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError.url_invalid("bad content-length")
        if length <= 0:
            raise ApiError.url_missing()
        if length > MAX_BODY:
            raise ApiError.url_invalid("body too large")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            raise ApiError.url_invalid("body was not json")
        if not isinstance(data, dict):
            raise ApiError.url_invalid("body was not an object")
        return data


def _as_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


class ApiServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: Config) -> None:
        handler = type("BoundHandler", (Handler,), {
            "config": config,
            "jobs": JobManager(config),
            "limiter": RateLimiter(config.rate_limit_max, config.rate_limit_window),
            "job_limiter": RateLimiter(config.job_rate_max, config.job_rate_window),
            "tools": ToolState(),
            "started_at": time.time(),
        })
        super().__init__((config.host, config.port), handler)
        self.config = config

    def server_bind(self) -> None:
        # skip HTTPServer's getfqdn() call, which blocks for seconds on a host
        # without working reverse DNS
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port
