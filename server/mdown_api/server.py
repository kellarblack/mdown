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
import ipaddress
import json
import logging
import os
import re
import socket
import shutil
import socketserver
import threading
import time
import traceback
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

from . import engine
from .board import RequestBoard
from .config import Config
from .errors import ApiError
from .jobs import JobManager, PickerNeeded, RateLimiter
from .security import header_safe, redact_log, validate_url
from .uptime import UptimeLog

log = logging.getLogger("mdown.api")

MAX_BODY = 16 * 1024
CHUNK = 256 * 1024

_RANGE_INVALID = object()


def _parse_range(header: str, size: int):
    """Return (start, end) for a single byte range, None to serve the whole file.

    Multi-range requests are answered with the full body, which is legal and
    keeps the hot path to one seek. An unsatisfiable range returns the sentinel
    so the caller can answer 416 instead of pretending the file is empty.
    """
    if not header or size <= 0:
        return None
    value = header.strip()
    if not value.lower().startswith("bytes="):
        return None
    spec = value[6:].strip()
    if "," in spec:
        return None
    first, _, last = spec.partition("-")
    first, last = first.strip(), last.strip()
    try:
        if not first:                      # "bytes=-500": the final 500 bytes
            suffix = int(last)
            if suffix <= 0:
                return _RANGE_INVALID
            return max(0, size - suffix), size - 1
        start = int(first)
        end = int(last) if last else size - 1
    except ValueError:
        return None
    if start < 0 or end < start or start >= size:
        return _RANGE_INVALID
    return start, min(end, size - 1)

#: services this instance can actually fetch, for the front-end's
#: "is this service available here" hint
SERVICES = [
    "9gag", "audiomack", "bandcamp", "bilibili", "bluesky", "coub", "dailymotion",
    "douyin", "facebook", "hearthis", "imgur", "instagram", "kick", "loom",
    "mixcloud", "newgrounds", "odysee", "ok", "reddit", "rumble", "rutube",
    "snapchat", "soundcloud", "streamable", "threads", "tiktok", "tumblr",
    "twitch", "twitter", "vimeo", "vk", "xiaohongshu", "youtube",
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
    # A client that sends headers and then nothing must not own a thread for two
    # minutes: 250 of those wedged every worker. Twenty seconds is longer than
    # any real body takes (16 KB cap) and short enough to be harmless.
    timeout = 20

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
        # No address, no query string, no tunnel token: a log line should say
        # that a request happened, not what it was for. redact_log also removes
        # any URL that a toolchain slipped into the message.
        log.info("%s", redact_log(fmt % args))

    def _client_ip(self) -> str:
        # A proxy *appends* the address it saw to any header the client sent.
        # Taking the first entry would let one header spoof a fresh identity on
        # every request and walk straight through the rate limiter.
        if self.config.trust_proxy:
            forwarded = self.headers.get("X-Forwarded-For", "")
            if forwarded:
                candidate = forwarded.split(",")[-1].strip()
                try:
                    ipaddress.ip_address(candidate)
                    return candidate
                except ValueError:
                    pass
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
        if self.command == "POST" and not self._body_consumed:
            # the request body is still unread; a keep-alive connection would
            # parse it as the next request line and answer 501 with no CORS
            self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        # the API is for the page, not for search results
        self.send_header("X-Robots-Tag", "noindex")
        for key, value in (extra or {}).items():
            self.send_header(key, header_safe(value))
        for key, value in self._cors_headers().items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    #: set once a POST body has been read off the socket
    _body_consumed = True
    _raw_body = b""

    def _json(self, status: int, payload: Dict[str, Any],
              extra: Optional[Dict[str, str]] = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra)

    def _error(self, error: ApiError) -> None:
        headers = {}
        if error.code == "api.rate_limit":
            headers["Retry-After"] = str(error.context.get("retry") or 30)
        if error.detail and not error.expose:
            log.warning("%s %s: %s", error.status, error.code, redact_log(error.detail))
        self._json(error.status, error.payload(), headers)

    # -- auth --------------------------------------------------------------
    def _check_turnstile(self, token: str) -> None:
        """Verify the widget token with Cloudflare. No secret, no check."""
        secret = self.config.turnstile_secret
        if not secret:
            return
        if not token:
            raise ApiError("api.auth.turnstile.missing", 403)
        body = urllib.parse.urlencode({
            "secret": secret,
            "response": token,
            "remoteip": self._client_ip(),
        }).encode()
        request = urllib.request.Request(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data=body, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                payload = json.loads(response.read() or b"{}")
        except Exception:
            # Cloudflare unreachable: refuse rather than silently let bots in
            raise ApiError("api.auth.turnstile.invalid", 403)
        if not payload.get("success"):
            raise ApiError("api.auth.turnstile.invalid", 403)

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

    def _check_origin(self) -> None:
        """CORS only stops a browser reading the response; the request still
        runs and still costs bandwidth. This rejects it outright, so another
        site cannot quietly use this instance as its backend."""
        if not self.config.require_origin:
            return
        origin = (self.headers.get("Origin") or "").strip()
        if self.config.cors_origin_allowed(origin):
            return
        raise ApiError("api.auth.origin", 403, {"origin": origin or "none"},
                       detail="origin not allowed")

    # -- routing -----------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        for key, value in self._cors_headers().items():
            self.send_header(key, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def _method_not_allowed(self) -> None:
        """JSON, with Allow, because the default is an HTML 501 that names the
        Python version and says nothing a client can act on."""
        error = ApiError.bad_method()
        self._json(error.status, error.payload(),
                   {"Allow": "GET, HEAD, POST, OPTIONS"})

    do_PUT = _method_not_allowed      # noqa: N815
    do_DELETE = _method_not_allowed   # noqa: N815
    do_PATCH = _method_not_allowed    # noqa: N815
    do_TRACE = _method_not_allowed    # noqa: N815

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._route_get()
        except ApiError as error:
            self._error(error)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.error("unhandled GET error\n%s", redact_log(traceback.format_exc()))
            self._error(ApiError.internal())

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._route_post()
        except ApiError as error:
            self._error(error)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.error("unhandled POST error\n%s", redact_log(traceback.format_exc()))
            self._error(ApiError.internal())

    def _limit_get(self) -> None:
        """Reads are cheap, but they are not free: a scraper asking for the
        instance info in a loop gets the same window as a downloader."""
        verdict = self.read_limiter.check(self._client_ip())
        if verdict["allowed"]:
            return
        error = ApiError.rate_limit(0)
        error.context["retry"] = verdict["retry"]
        self._json(429, error.payload(), {
            "RateLimit-Limit": str(self.config.read_rate_max),
            "RateLimit-Remaining": "0",
            "RateLimit-Reset": str(verdict["retry"]),
            "Retry-After": str(verdict["retry"]),
        })

    def _route_get(self) -> None:
        path, query = self._split()
        if path in ("/", ""):
            self._limit_get()
            self._instance_info()
        elif path == "/health":
            self._limit_get()
            self._health()
        elif path == "/uptime":
            self._limit_get()
            self._uptime()
        elif path == "/requests":
            self._limit_get()
            self._board_list()
        elif path == "/requests/pending":
            self._board_pending()
        elif path == "/reports":
            self._inbox_list()
        elif path == "/tunnel" or path.startswith("/tunnel/"):
            token = path[len("/tunnel/"):] if path.startswith("/tunnel/") else ""
            if not token:
                token = (parse_qs(query).get("id") or [""])[0]
            self._serve_tunnel(unquote(token))
        else:
            raise ApiError.no_route()

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
                # only advertise the widget when the check is actually on, or the
                # front-end would load Cloudflare's script and wait for a token
                # that nothing is going to require
                "turnstileSitekey": (self.config.turnstile_sitekey
                                     if self.config.turnstile_secret else None),
                "apiKeyRequired": bool(self.config.api_key),
                "services": SERVICES,
                # a capability, not a promise: the front-end only shows a size
                # estimate and a thumbnail when the instance can produce them
                "probe": True,
                # the board exists only where somebody can moderate it: with
                # no instance key, asks would pile up with no way to say yes,
                # so the page is not offered a box that leads nowhere
                "board": bool(self.config.api_key),
                # the private inbox rides with the board: both need a key
                "inbox": bool(self.config.api_key),
            },
            "git": {"branch": "", "commit": ""},
            "limits": {
                "maxHeight": self.config.max_height,
                "maxDuration": self.config.max_duration,
                "modes": ["auto", "audio", "mute"],
                "audioFormats": ["best", "mp3", "ogg", "opus", "wav"],
                "maxAudioBitrate": 128,
            },
        }
        self._json(200, payload)

    def _uptime(self) -> None:
        self._json(200, self.uptime.summary(30), {"Cache-Control": "no-store"})

    # -- the request board -------------------------------------------------
    def _board_list(self) -> None:
        items = self.board.list(30)
        self._json(200, {"items": items, "count": self.board.count()},
                   {"Cache-Control": "no-store"})

    def _board_pending(self) -> None:
        """The queue, for the owner only. No key, no queue."""
        if not self.config.api_key:
            raise ApiError.request_locked()
        self._check_auth()
        self._json(200, {"items": self.board.pending()},
                   {"Cache-Control": "no-store"})

    # -- the private inbox: "this service is broken" -----------------------
    def _inbox_list(self) -> None:
        if not self.config.api_key:
            raise ApiError.request_locked()
        self._check_auth()
        waiting = self.board_reports.pending(200)
        handled = [entry for entry in self.board_reports.list(200)]
        self._json(200, {"items": waiting, "handled": handled},
                   {"Cache-Control": "no-store"})

    def _inbox_post(self) -> None:
        """A visitor's note about a service, private to the owner. The link
        they pasted is never sent: it is not needed to fix a service and it is
        theirs."""
        self._check_origin()
        verdict = self.inbox_limiter.check(self._client_ip())
        headers = {
            "RateLimit-Limit": str(self.config.inbox_rate_max),
            "RateLimit-Remaining": str(verdict["remaining"]),
            "RateLimit-Reset": str(verdict["retry"]),
        }
        if not verdict["allowed"]:
            error = ApiError.rate_limit(0)
            error.context["retry"] = verdict["retry"]
            error.context["reason"] = "inbox_slow_down"
            headers["Retry-After"] = str(verdict["retry"])
            self._json(429, error.payload(), headers)
            return

        body = self._read_json()
        service = str(body.get("service") or "unknown").strip().lower()
        service = re.sub(r"[^a-z0-9._-]", "", service)[:24] or "unknown"
        note = str(body.get("note") or "").strip()
        text = service + ((" · " + note) if note else " · reported broken")
        try:
            item = self.board_reports.add(text)
        except ValueError as bad:
            raise ApiError.request_invalid(str(bad))
        log.info("inbox: %s", service)     # the service name, never the note
        self._json(202, {"status": "queued", "item": dict(item, text="")}, headers)

    def _inbox_handled(self) -> None:
        if not self.config.api_key:
            raise ApiError.request_locked()
        self._check_auth()
        self._check_origin()
        ident = str(self._read_json().get("id") or "").strip()
        if not ident or not self.board_reports.approve(ident):
            raise ApiError.request_missing()
        self._json(200, {"status": "ok"})

    def _inbox_delete(self) -> None:
        if not self.config.api_key:
            raise ApiError.request_locked()
        self._check_auth()
        self._check_origin()
        ident = str(self._read_json().get("id") or "").strip()
        if not ident or not self.board_reports.delete(ident):
            raise ApiError.request_missing()
        self._json(200, {"status": "ok"})

    def _board_approve(self) -> None:
        if not self.config.api_key:
            raise ApiError.request_locked()
        self._check_auth()
        self._check_origin()
        body = self._read_json()
        ident = str(body.get("id") or "").strip()
        if not ident or not self.board.approve(ident):
            raise ApiError.request_missing()
        self._json(200, {"status": "ok"})

    def _board_post(self) -> None:
        """An ask joins the queue. It shows on the board when the owner says so."""
        self._check_origin()
        verdict = self.board_limiter.check(self._client_ip())
        headers = {
            "RateLimit-Limit": str(self.config.board_rate_max),
            "RateLimit-Remaining": str(verdict["remaining"]),
            "RateLimit-Reset": str(verdict["retry"]),
        }
        if not verdict["allowed"]:
            error = ApiError.rate_limit(0)
            error.context["retry"] = verdict["retry"]
            error.context["reason"] = "board_slow_down"
            headers["Retry-After"] = str(verdict["retry"])
            self._json(429, error.payload(), headers)
            return

        body = self._read_json()
        try:
            item = self.board.add(body.get("text"))
        except ValueError as bad:
            raise ApiError.request_invalid(str(bad))
        self._json(202, {"status": "pending", "item": item}, headers)

    def _board_delete(self) -> None:
        """The owner's broom. Needs the instance key; a public board with an
        open delete is a board that empties itself on the first bored visitor."""
        if not self.config.api_key:
            raise ApiError.request_locked()
        self._check_auth()
        self._check_origin()
        body = self._read_json()
        ident = str(body.get("id") or "").strip()
        if not ident or not self.board.delete(ident):
            raise ApiError.request_missing()
        self._json(200, {"status": "ok"})

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

        # Range support matters here more than anywhere else on the site: a 4K
        # file is hundreds of megabytes, and without ranges a dropped
        # connection means starting over from zero.
        span = _parse_range(self.headers.get("Range") or "", size)
        if span is _RANGE_INVALID:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            for key, value in self._cors_headers().items():
                self.send_header(key, value)
            self.end_headers()
            return

        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

        start, end = span if span is not None else (0, size - 1)
        length = end - start + 1
        partial = span is not None

        with handle:
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if partial:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Content-Disposition", disposition)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for key, value in self._cors_headers().items():
                self.send_header(key, value)
            self.end_headers()
            if self.command == "HEAD":
                return

            # the socket is loopback into Caddy: small writes there are pure
            # overhead, and sendfile moves the file without a Python copy
            self.wfile.flush()
            sent = 0
            try:
                sent = os.sendfile(self.connection.fileno(), handle.fileno(), start, length)
            except (OSError, AttributeError):
                sent = 0
            remaining = length - sent
            if remaining > 0:
                handle.seek(start + sent)
                while remaining > 0:
                    chunk = handle.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

        self.jobs.mark_served(token)

    def _route_post(self) -> None:
        # Read the body before any check can reject the request. A rejection
        # that leaves bytes in the socket poisons the next request on the same
        # keep-alive connection: the client gets a 501 with no CORS headers,
        # which a browser reports as "Failed to fetch" instead of the real
        # error. Bodies above MAX_BODY are deliberately not drained; those
        # close the connection instead.
        self._raw_body = b""
        self._body_consumed = False
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._body_consumed = True
        elif length <= MAX_BODY:
            self._raw_body = self.rfile.read(length)
            self._body_consumed = True

        path, _ = self._split()
        if path not in ("/", "", "/probe", "/report", "/requests",
                        "/requests/delete", "/requests/approve",
                        "/reports", "/reports/handled", "/reports/delete"):
            raise ApiError.no_route()

        # the board is public on purpose: an anonymous ask cannot carry a key
        if path == "/requests":
            self._board_post()
            return
        if path == "/requests/delete":
            self._board_delete()
            return
        if path == "/requests/approve":
            self._board_approve()
            return
        if path == "/reports":
            self._inbox_post()
            return
        if path == "/reports/handled":
            self._inbox_handled()
            return
        if path == "/reports/delete":
            self._inbox_delete()
            return

        self._check_auth()
        self._check_origin()

        if path == "/report":
            self._report()
            return

        if path == "/probe":
            self._probe()
            return

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
            # say which window actually said no, or a client obeying
            # RateLimit-Reset retries instantly and loops
            burst_headers = {
                "RateLimit-Limit": str(self.job_limiter.maximum),
                "RateLimit-Remaining": str(burst["remaining"]),
                "RateLimit-Reset": str(burst["retry"]),
                "RateLimit-Policy": "%d;w=%d" % (self.job_limiter.maximum, self.job_limiter.window),
                "Retry-After": str(burst["retry"]),
            }
            self._json(429, error.payload(), burst_headers)
            return

        body = self._read_json()
        self._check_turnstile(str(body.get("turnstileToken") or ""))
        url = body.get("url")
        if not isinstance(url, str) or not url.strip():
            raise ApiError.url_missing()

        safe_url = validate_url(url)

        mode = str(body.get("downloadMode") or "auto").strip().lower()
        if mode not in ("auto", "audio", "mute"):
            mode = "auto"

        height = _as_int(body.get("videoQuality"), self.config.max_height)
        audio_format = str(body.get("audioFormat") or "mp3").strip().lower()
        if audio_format not in ("best", "mp3", "ogg", "opus", "wav"):
            audio_format = "mp3"
        bitrate = min(_as_int(body.get("audioBitrate"), 128), 128)

        audio_covers = bool(body.get("audioCovers"))
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
                audio_covers=audio_covers,
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
            log.warning("engine failure: %s", redact_log(str(failure)))
            if "timed out" in str(failure):
                self._json(504, {
                    "status": "error",
                    "error": {"code": "api.instance.timed_out"},
                }, headers)
                return
            if "metadata extraction failed" in str(failure):
                raise ApiError("api.content.video.unavailable", 503,
                               detail="the source refused, try again")
            raise ApiError.internal(str(failure))

        tunnel = self.config.api_url.rstrip("/") + "/tunnel/" + job.token
        self._json(200, {
            "status": "tunnel",
            "url": tunnel,
            "filename": job.filename,
            "size": job.size,
        }, headers)

    def _report(self) -> None:
        """A problem report that actually arrives, without a third party.

        The note is the only free text. Everything else is what the page already
        knows: the page, the state and a user agent. No IP, no cookie, no email.
        """
        verdict = self.report_limiter.check(self._client_ip())
        if not verdict["allowed"]:
            error = ApiError.rate_limit(0)
            error.context["retry"] = verdict["retry"]
            self._json(429, error.payload(), {"Retry-After": str(verdict["retry"])})
            return

        body = self._read_json()
        note = str(body.get("note") or "").strip()[:2000]
        page = str(body.get("page") or "").strip()[:120]
        state = str(body.get("state") or "").strip()[:40]
        if not note and not state:
            raise ApiError.url_invalid("empty report")

        folder = os.path.join(self.config.work_dir, "reports")
        try:
            os.makedirs(folder, mode=0o700, exist_ok=True)
            name = time.strftime("%Y-%m-%d.jsonl", time.gmtime())
            entry = {
                "t": int(time.time()),
                "page": page,
                "state": state,
                "note": note,
                "ua": str(self.headers.get("User-Agent") or "")[:180],
            }
            with open(os.path.join(folder, name), "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, separators=(",", ":")) + "\n")
        except OSError:
            raise ApiError.internal("could not store the report")

        self._json(200, {"status": "ok"})

    def _probe(self) -> None:
        """Metadata only: title, duration, thumbnail, estimated size.

        Deliberately not part of the v11 contract — a client that does not see
        `probe: true` in the instance info never calls it, so mdown stays a
        normal cobalt client anywhere else.
        """
        verdict = self.probe_limiter.check(self._client_ip())
        headers = {
            "RateLimit-Limit": str(self.config.probe_rate_max),
            "RateLimit-Remaining": str(verdict["remaining"]),
            "RateLimit-Reset": str(verdict["retry"]),
        }
        if not verdict["allowed"]:
            error = ApiError.rate_limit(0)
            error.context["retry"] = verdict["retry"]
            headers["Retry-After"] = str(verdict["retry"])
            self._json(429, error.payload(), headers)
            return

        body = self._read_json()
        self._check_turnstile(str(body.get("turnstileToken") or ""))
        url = body.get("url")
        if not isinstance(url, str) or not url.strip():
            raise ApiError.url_missing()
        safe_url = validate_url(url)

        mode = str(body.get("downloadMode") or "auto").strip().lower()
        if mode not in ("auto", "audio", "mute"):
            mode = "auto"
        height = _as_int(body.get("videoQuality"), self.config.max_height)
        audio_format = str(body.get("audioFormat") or "mp3").strip().lower()
        if audio_format not in ("best", "mp3", "ogg", "opus", "wav"):
            audio_format = "mp3"
        bitrate = min(_as_int(body.get("audioBitrate"), 128), 128)

        cache = os.path.join(self.config.work_dir, ".cache")
        info = engine.probe(safe_url, self.config.probe_timeout, cache)
        duration = info.get("duration")
        duration = float(duration) if isinstance(duration, (int, float)) and duration > 0 else 0.0

        thumbnail = ""
        thumb_url = info.get("thumbnail") or ""
        if thumb_url:
            # the extractor hands us a URL; it is not trusted just because the
            # metadata came from a known service
            try:
                validate_url(thumb_url)
            except ApiError:
                thumb_url = ""
        if thumb_url and body.get("thumbnail", True) is not False:
            try:
                thumbnail = engine.thumb_data_url(thumb_url, cache_dir=cache, timeout=8)
            except Exception:  # a missing picture is never a failed request
                log.debug("thumbnail failed", exc_info=True)

        self._json(200, {
            "status": "ok",
            "title": info.get("title") or "",
            "uploader": info.get("uploader") or "",
            "duration": duration,
            "thumbnail": thumbnail,
            "estimate": engine.estimate(info, mode=mode, height=height,
                                        audio_format=audio_format, audio_bitrate=bitrate),
            "isLive": bool(info.get("is_live")),
            "isPlaylist": (info.get("entry_count") or 0) > 1,
            "tooLong": bool(duration and duration > self.config.max_duration),
            "service": info.get("extractor") or "",
        }, headers)

    def _read_json(self) -> Dict[str, Any]:
        if not self._body_consumed:
            raise ApiError.too_large()
        raw = self._raw_body
        if not raw:
            raise ApiError.url_missing()
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
    # 64 concurrent sockets is more than a one-vCPU box can serve anyway; beyond
    # that the kernel queue is the right place to wait, not a thread per socket
    request_queue_size = 64
    max_connections = 120
    _live = None

    def __init__(self, config: Config) -> None:
        handler = type("BoundHandler", (Handler,), {
            "config": config,
            "jobs": JobManager(config),
            "limiter": RateLimiter(config.rate_limit_max, config.rate_limit_window),
            "job_limiter": RateLimiter(config.job_rate_max, config.job_rate_window),
            "probe_limiter": RateLimiter(config.probe_rate_max, config.probe_rate_window),
            "read_limiter": RateLimiter(config.read_rate_max, config.read_rate_window),
            "report_limiter": RateLimiter(config.report_rate_max, config.report_rate_window),
            "board_limiter": RateLimiter(config.board_rate_max, config.board_rate_window),
            "inbox_limiter": RateLimiter(config.inbox_rate_max, config.inbox_rate_window),
            "board": RequestBoard(os.path.join(config.work_dir, "board.jsonl")),
            # six hundred characters: a report is a sentence about a service,
            # and a wall of text is either spam or a bug report that belongs
            # in an issue tracker
            "board_reports": RequestBoard(os.path.join(config.work_dir, "reports.jsonl"),
                                          keep=300, max_text=600),
            "uptime": UptimeLog(os.path.join(config.work_dir, "uptime.json")),
            "tools": ToolState(),
            "started_at": time.time(),
        })
        super().__init__((config.host, config.port), handler)
        self.config = config
        # a scanner with a million addresses would otherwise leave a million
        # entries behind; expired windows are swept even when nobody asks
        threading.Thread(target=self._prune_loop, name="limiter-prune", daemon=True).start()
        threading.Thread(target=self._uptime_loop, name="uptime", daemon=True).start()

    def _uptime_loop(self) -> None:
        while True:
            try:
                handler = self.RequestHandlerClass
                tools = handler.tools.read()
                free = shutil.disk_usage(self.config.work_dir).free
                ok = all(tools.values()) and free >= self.config.min_free_bytes
                handler.uptime.record(ok)
            except Exception:
                pass
            time.sleep(60)

    def _prune_loop(self) -> None:
        limiter = self.RequestHandlerClass.limiter
        jobs = self.RequestHandlerClass.job_limiter
        probes = self.RequestHandlerClass.probe_limiter
        reads = self.RequestHandlerClass.read_limiter
        reports = self.RequestHandlerClass.report_limiter
        boards = self.RequestHandlerClass.board_limiter
        inboxes = self.RequestHandlerClass.inbox_limiter
        while True:
            time.sleep(120)
            for item in (limiter, jobs, probes, reads, reports, boards, inboxes):
                item.prune()

    def process_request(self, request, client_address) -> None:  # noqa: D401
        # Refuse politely rather than spawn thread 121; the kernel accept queue
        # still holds the rest, so nothing is silently dropped.
        if self._live is None:
            import threading
            self._live = threading.Semaphore(self.max_connections)
        if not self._live.acquire(blocking=False):
            try:
                request.close()
            except OSError:
                pass
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._live.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._live.release()

    def server_bind(self) -> None:
        # skip HTTPServer's getfqdn() call, which blocks for seconds on a host
        # without working reverse DNS
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port
