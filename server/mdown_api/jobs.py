"""Job lifecycle, capacity control and cleanup.

A job is a directory under `work_dir` named after an unguessable token. The
token in the tunnel URL *is* the capability: the front-end fetches that URL
without any headers, so it has to be unguessable rather than authenticated.

Bounds enforced here:
  * at most `max_concurrent` downloads running, `max_queue` waiting, then 429
  * free disk is checked before a job starts, not after it fails
  * finished files are deleted after `job_ttl`, and orphans are swept
  * output is re-probed and rejected if it breaks the resolution or duration cap
"""

from __future__ import annotations

import datetime
import os
import re
import secrets
import shutil
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from . import engine
from .config import Config
from .errors import ApiError
from .security import safe_filename

#: tunnel capability token
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


class PickerNeeded(Exception):
    """The URL is a multi-item post: the client should choose what to fetch."""

    def __init__(self, entries, title=""):
        super().__init__("picker")
        self.entries = entries
        self.title = title


@dataclass
class Job:
    token: str
    url: str
    mode: str
    created: float = field(default_factory=time.time)
    ready_at: Optional[float] = None
    served_at: Optional[float] = None
    path: Optional[str] = None
    filename: str = "download.bin"
    size: int = 0
    media: Dict[str, Any] = field(default_factory=dict)

    @property
    def directory(self) -> str:
        return os.path.dirname(self.path) if self.path else ""


class RateLimiter:
    """Sliding window per client key. In-memory, so it resets on restart."""

    def __init__(self, maximum: int, window: int) -> None:
        self.maximum = maximum
        self.window = window
        self._hits: Dict[str, list] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> Dict[str, Any]:
        now = time.time()
        with self._lock:
            hits = [stamp for stamp in self._hits.get(key, []) if now - stamp < self.window]
            if len(hits) >= self.maximum:
                self._hits[key] = hits
                retry = int(self.window - (now - hits[0])) + 1
                return {"allowed": False, "remaining": 0, "retry": max(1, retry)}
            hits.append(now)
            self._hits[key] = hits
            return {
                "allowed": True,
                "remaining": self.maximum - len(hits),
                "retry": int(self.window - (now - hits[0])) + 1,
            }

    def prune(self) -> None:
        now = time.time()
        with self._lock:
            for key in list(self._hits):
                kept = [stamp for stamp in self._hits[key] if now - stamp < self.window]
                if kept:
                    self._hits[key] = kept
                else:
                    self._hits.pop(key, None)


class JobManager:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(config.max_concurrent)
        self._queued = 0
        self._active = 0
        self._count_lock = threading.Lock()
        self._stop = threading.Event()
        self._day = datetime.date.today()
        self._day_count = 0
        self._sweeper: Optional[threading.Thread] = None
        self.started_at = time.time()
        os.makedirs(config.work_dir, mode=0o700, exist_ok=True)

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        if self._sweeper is not None:
            return
        self._sweeper = threading.Thread(target=self._sweep_loop, name="sweeper", daemon=True)
        self._sweeper.start()

    def stop(self) -> None:
        self._stop.set()

    def _sweep_loop(self) -> None:
        while not self._stop.wait(30):
            try:
                self.sweep()
            except Exception:
                pass

    # -- capacity ----------------------------------------------------------
    def _enter_queue(self) -> None:
        with self._count_lock:
            self._queued += 1
            over = self._queued > self.config.max_queue
        if over:
            with self._count_lock:
                self._queued -= 1
            raise ApiError.busy()

    def _leave_queue(self) -> None:
        with self._count_lock:
            self._queued = max(0, self._queued - 1)

    def _free_bytes(self) -> int:
        try:
            return shutil.disk_usage(self.config.work_dir).free
        except OSError:
            return 0

    @property
    def active(self) -> int:
        with self._count_lock:
            return self._active

    @property
    def queued(self) -> int:
        with self._count_lock:
            return self._queued

    # -- the actual work ---------------------------------------------------
    def create(
        self,
        url: str,
        *,
        mode: str,
        height: int,
        audio_format: str,
        audio_bitrate: int,
        subtitle_lang: str = "",
    ) -> Job:
        if mode not in ("auto", "audio", "mute"):
            mode = "auto"

        self._enter_queue()
        try:
            self._slots.acquire()
        except BaseException:
            self._leave_queue()
            raise
        self._leave_queue()
        with self._count_lock:
            self._active += 1
        try:
            return self._run(url, mode=mode, height=height,
                             audio_format=audio_format, audio_bitrate=audio_bitrate,
                             subtitle_lang=subtitle_lang)
        finally:
            with self._count_lock:
                self._active = max(0, self._active - 1)
            self._slots.release()

    def _claim_daily_slot(self) -> None:
        """A hard ceiling on jobs per day. Bounds the damage from a scraper,
        a viral spike, or a bug that loops — the box cannot be drained."""
        limit = self.config.max_daily_jobs
        if not limit:
            return
        today = datetime.date.today()
        with self._count_lock:
            if today != self._day:
                self._day = today
                self._day_count = 0
            if self._day_count >= limit:
                raise ApiError("api.rate_limit", 429, {"reason": "daily_cap"}, detail="daily job cap reached")
            self._day_count += 1

    def _run(self, url: str, *, mode: str, height: int,
             audio_format: str, audio_bitrate: int, subtitle_lang: str = "") -> Job:
        config = self.config
        self._claim_daily_slot()

        free = self._free_bytes()
        if free < config.min_free_bytes:
            raise ApiError.busy()

        token = ""
        for _ in range(3):
            candidate = secrets.token_urlsafe(24)
            if TOKEN_RE.fullmatch(candidate):
                token = candidate
                break
        if not token:
            raise ApiError.internal("could not generate a token")

        # --- metadata first: no bytes are fetched to learn the duration ----
        info = engine.probe(url, config.probe_timeout, os.path.join(config.work_dir, ".cache"))

        if info.get("is_live"):
            raise ApiError.live()

        # multi-item posts (playlists, galleries, channels) become a picker.
        # Each entry is a normal page URL, so the client re-posts the ones
        # that were chosen — no media is fetched before the choice.
        if info.get("entry_count", 0) > 1:
            raise PickerNeeded(info.get("entries") or [], info.get("title") or "")

        duration = info.get("duration")
        if not isinstance(duration, (int, float)) or duration <= 0:
            # unknown duration cannot be proven to be inside the limit
            raise ApiError("api.content.video.unavailable", 422,
                           detail="duration unknown, refusing to guess")

        if duration > config.max_duration:
            raise ApiError.too_long(config.max_duration)

        destination = os.path.join(config.work_dir, token)
        os.makedirs(destination, mode=0o700, exist_ok=True)

        try:
            produced = engine.download(
                url,
                mode=mode,
                height=min(int(height), config.max_height),
                audio_format=audio_format,
                audio_bitrate=min(int(audio_bitrate), 128),
                dest_dir=destination,
                timeout=config.job_timeout,
                max_bytes=config.max_output_bytes,
                fragments=max(1, min(4, config.max_concurrent * 2)),
                cache_dir=os.path.join(config.work_dir, ".cache"),
                cookies=config.ytdlp_cookies,
                extra_args=config.ytdlp_extra_args,
                subtitle_lang=subtitle_lang,
            )

            size = os.path.getsize(produced)
            if size <= 0:
                raise ApiError.unavailable(detail="empty output")
            if size > config.max_output_bytes:
                raise ApiError("api.content.too_large", 413,
                               detail="output exceeds the size cap")

            media = engine.probe_file(produced)
            if media.get("has_video") and media.get("height", 0) > config.max_height:
                # the selector asked for <= cap; anything above it means the
                # source ignored us, so the file is discarded rather than served
                raise ApiError.unavailable(detail="resolution above the cap")
            if media.get("duration", 0) > config.max_duration + 5:
                raise ApiError.too_long(config.max_duration)
            if mode == "audio" and media.get("has_video"):
                raise ApiError.unavailable(detail="audio mode returned a video")

            extension = os.path.splitext(produced)[1].lstrip(".")
            job = Job(
                token=token,
                url=url,
                mode=mode,
                path=produced,
                size=size,
                filename=safe_filename(info.get("title"), extension),
                media=media,
            )
            job.ready_at = time.time()
        except BaseException:
            shutil.rmtree(destination, ignore_errors=True)
            raise

        with self._lock:
            self._jobs[token] = job
        return job

    # -- lookup / cleanup --------------------------------------------------
    def get(self, token: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(token)

    def mark_served(self, token: str) -> None:
        with self._lock:
            job = self._jobs.get(token)
            if job is not None:
                job.served_at = time.time()

    def sweep(self) -> None:
        now = time.time()
        config = self.config
        expired = []
        with self._lock:
            for token, job in list(self._jobs.items()):
                if job.ready_at is None:
                    continue
                if job.served_at and now - job.served_at > 60:
                    expired.append(token)
                elif now - job.ready_at > config.job_ttl:
                    expired.append(token)
        for token in expired:
            self.drop(token)

        # orphaned directories (crash, SIGKILL) are removed once stale
        try:
            entries = os.listdir(config.work_dir)
        except OSError:
            return
        for entry in entries:
            if entry == ".cache":
                continue
            path = os.path.join(config.work_dir, entry)
            if not os.path.isdir(path):
                continue
            with self._lock:
                if entry in self._jobs:
                    continue
            try:
                if now - os.path.getmtime(path) > config.job_ttl * 2:
                    shutil.rmtree(path, ignore_errors=True)
            except OSError:
                pass

    def drop(self, token: str) -> None:
        with self._lock:
            job = self._jobs.pop(token, None)
        if job is None:
            return
        if job.path:
            shutil.rmtree(os.path.dirname(job.path), ignore_errors=True)

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            count = len(self._jobs)
        return {
            "active": self.active,
            "queued": self.queued,
            "ready_jobs": count,
            "today": self._day_count,
            "disk_free_mb": int(self._free_bytes() / (1024 * 1024)),
            "uptime_s": int(time.time() - self.started_at),
        }
