"""yt-dlp / ffmpeg adapters.

Two rules this file exists to enforce:

* no shell, ever — every command is an argv list, so a URL containing `;` or
  `$(...)` is just a URL argument;
* no transcode unless the user asked for an audio re-encode — video is always
  stream-copied, and merged by ffmpeg's muxer.

Everything blocking runs in a child process with its own process group, so a
timeout kills yt-dlp *and* the ffmpeg it spawned, not just the parent.
"""

from __future__ import annotations

import json
import os
import shlex
import re
import signal
import subprocess
import threading
import time
from typing import Any, Dict, Optional, Tuple

from .errors import ApiError

YTDLP = os.environ.get("MDOWN_YTDLP", "yt-dlp")
FFMPEG = os.environ.get("MDOWN_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("MDOWN_FFPROBE", "ffprobe")

#: source-side failures, in the order they are matched
ERROR_PATTERNS: Tuple[Tuple[str, str, str], ...] = (
    (r"Unsupported URL|no suitable InfoExtractor", "api.url.unsupported", "unsupported url"),
    (r"This (video|content) is (private|only available)", "api.content.video.private", "private"),
    (r"Private (video|content)", "api.content.video.private", "private"),
    (r"Sign in to confirm your age|age[- ]restricted|inappropriate for some users",
     "api.content.video.age", "age restricted"),
    (r"members[- ]only|Join this channel|paid|premium", "api.content.video.payment", "paywalled"),
    (r"not available in your country|geo[- ]restrict", "api.content.video.region", "region locked"),
    (r"is live|live event will begin|premieres in|stream is offline", "api.content.video.live", "live"),
    (r"Requested format is not available", "api.content.video.unavailable", "format not available"),
    (r"larger than max-filesize|File is larger", "api.content.too_large", "output exceeds the size cap"),
    (r"HTTP Error 429|Too Many Requests", "api.content.video.unavailable", "source rate limited"),
    (r"Video unavailable|video is unavailable|has been removed|does not exist|404",
     "api.content.video.unavailable", "unavailable"),
)


class EngineError(RuntimeError):
    def __init__(self, message: str, stderr: str = "") -> None:
        super().__init__(message)
        self.stderr = stderr


def _base_env() -> Dict[str, str]:
    env = dict(os.environ)
    env.setdefault("LC_ALL", "C.UTF-8")
    env.setdefault("PYTHONUNBUFFERED", "1")
    return env


def run(cmd: list, timeout: int, cache_dir: Optional[str] = None) -> Tuple[int, str, str]:
    """Run a command in its own process group; kill the whole group on timeout."""
    env = _base_env()
    if cache_dir:
        env["XDG_CACHE_HOME"] = cache_dir
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        env=env,
        start_new_session=True,
    )
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
        try:
            proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        raise EngineError("timed out after %ds" % timeout)
    return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def classify(stderr: str) -> Optional[ApiError]:
    text = stderr or ""
    for pattern, code, detail in ERROR_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            status = 422
            if code in ("api.url.unsupported",):
                status = 422
            return ApiError(code, status, detail=detail)
    return None


# --------------------------------------------------------------------------
# metadata
# --------------------------------------------------------------------------

class InfoCache:
    """Short-lived cache of extraction results.

    Repeat submissions of the same link (retry after a network hiccup, a
    second tab) cost zero extraction requests against the source. 120 s is
    short enough that a freshly published video is not served stale data.
    """

    def __init__(self, ttl: int = 120, size: int = 128) -> None:
        self.ttl = ttl
        self.size = size
        self._data: Dict[str, Tuple[float, Dict[str, Any]]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        now = time.time()
        with self._lock:
            hit = self._data.get(key)
            if not hit:
                return None
            stamp, value = hit
            if now - stamp > self.ttl:
                self._data.pop(key, None)
                return None
            return value

    def put(self, key: str, value: Dict[str, Any]) -> None:
        with self._lock:
            if len(self._data) >= self.size:
                oldest = min(self._data, key=lambda k: self._data[k][0])
                self._data.pop(oldest, None)
            self._data[key] = (time.time(), value)


INFO_CACHE = InfoCache()


def probe(url: str, timeout: int, cache_dir: Optional[str] = None) -> Dict[str, Any]:
    """Metadata only. Never downloads media — `--skip-download` is explicit."""
    cached = INFO_CACHE.get(url)
    if cached is not None:
        return cached

    cmd = [
        YTDLP,
        "--dump-single-json",
        "--skip-download",
        # flat-playlist: a single video still returns full info, but a playlist,
        # channel or gallery now enumerates instead of erroring
        "--flat-playlist",
        "--no-warnings",
        "--socket-timeout", "20",
        "--retries", "2",
        "--no-call-home",
        url,
    ]
    if cache_dir:
        cmd[1:1] = ["--cache-dir", cache_dir]

    code, out, err = run(cmd, timeout, cache_dir)
    if code != 0 or not out.strip():
        failure = classify(err)
        if failure is not None:
            raise failure
        raise EngineError("metadata extraction failed", err)

    try:
        info = json.loads(out)
    except json.JSONDecodeError:
        raise EngineError("metadata was not valid json", err)

    if not isinstance(info, dict):
        raise EngineError("metadata was not an object")

    if info.get("_type") == "playlist" and not info.get("entries"):
        raise EngineError("playlist came back empty")

    entries = []
    raw_entries = info.get("entries") if isinstance(info.get("entries"), list) else []
    for entry in raw_entries[:20]:
        if not isinstance(entry, dict):
            continue
        link = entry.get("webpage_url") or entry.get("url") or ""
        if not link:
            continue
        thumb = entry.get("thumbnail")
        if not thumb and isinstance(entry.get("thumbnails"), list) and entry["thumbnails"]:
            thumb = entry["thumbnails"][-1].get("url")
        entries.append({
            "url": link,
            "title": entry.get("title") or "",
            "thumb": thumb or "",
        })

    slim = {
        "id": info.get("id"),
        "title": info.get("title"),
        "entries": entries,
        "entry_count": len(entries),
        "duration": info.get("duration"),
        "height": info.get("height"),
        "width": info.get("width"),
        "is_live": bool(info.get("is_live") or info.get("was_live")),
        "ext": info.get("ext"),
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "webpage_url": info.get("webpage_url") or url,
    }
    INFO_CACHE.put(url, slim)
    return slim


# --------------------------------------------------------------------------
# download
# --------------------------------------------------------------------------

def _common(
    url: str,
    cache_dir: Optional[str],
    max_bytes: int,
    fragments: int,
    cookies: str = "",
    extra_args: str = "",
) -> list:
    cmd = [
        YTDLP,
        "--no-playlist",
        "--no-warnings",
        "--no-call-home",
        "--no-mtime",
        "--socket-timeout", "20",
        "--retries", "3",
        "--fragment-retries", "3",
        "--concurrent-fragments", str(fragments),
        "--max-filesize", "%dM" % max(1, max_bytes // (1024 * 1024)),
    ]
    if cache_dir:
        cmd += ["--cache-dir", cache_dir]
    # a cookies file is the only reliable answer to age gates and bot checks;
    # it is optional and never shipped with the code
    if cookies and os.path.isfile(cookies):
        cmd += ["--cookies", cookies]
    # operator escape hatch, e.g. --extractor-args "youtube:player_client=tv"
    if extra_args:
        cmd += shlex.split(extra_args)
    return cmd


def download(
    url: str,
    *,
    mode: str,
    height: int,
    audio_format: str,
    audio_bitrate: int,
    dest_dir: str,
    timeout: int,
    max_bytes: int,
    fragments: int = 4,
    cache_dir: Optional[str] = None,
    cookies: str = "",
    extra_args: str = "",
    subtitle_lang: str = "",
) -> str:
    """Fetch the media into `dest_dir` and return the produced path.

    `mode` is one of auto / audio / mute, matching the front-end.
    """
    template = os.path.join(dest_dir, "media.%(ext)s")
    base = _common(url, cache_dir, max_bytes, fragments, cookies, extra_args)

    if mode == "audio":
        fmt = audio_format if audio_format in ("best", "mp3", "ogg", "opus", "wav") else "mp3"

        # "best" is the untouched source stream: no ffmpeg, no re-encode,
        # whatever container the service served (m4a, webm/opus, mp3).
        if fmt == "best":
            cmd = base + ["-f", "bestaudio/best", "-o", template, url]
            code, out, err = run(cmd, timeout, cache_dir)
            if code != 0:
                raise _download_error(err)
            return _single_file(dest_dir)

        cmd = base + [
            "-f", "bestaudio/best",
            "-x",
            "--audio-format", fmt,
            "-o", template,
        ]
        if fmt != "wav":
            cmd += ["--audio-quality", "%dK" % audio_bitrate]
        cmd.append(url)
        code, out, err = run(cmd, timeout, cache_dir)
        if code != 0:
            raise _download_error(err)
        return _single_file(dest_dir, ["." + fmt]) or _single_file(dest_dir)

    subs = []
    if subtitle_lang and mode != "audio":
        subs = ["--write-subs", "--sub-langs", subtitle_lang, "--embed-subs", "--convert-subs", "srt"]

    def build(container: str) -> list:
        if mode == "mute":
            selector = "bv*[height<=%d]/b[height<=%d]/b" % (height, height)
        else:
            # prefer an h264 + aac pair: ffmpeg can copy those into mp4
            # without touching a single frame
            selector = (
                "bv*[height<=%d][vcodec^=avc1]+ba[acodec^=mp4a]"
                "/bv*[height<=%d]+ba"
                "/b[height<=%d]"
                "/b"
            ) % (height, height, height)
        return base + subs + [
            "-f", selector,
            "--merge-output-format", container,
            "-o", template,
            url,
        ]

    code, out, err = run(build("mp4"), timeout, cache_dir)
    if code != 0:
        # codecs that mp4 cannot hold: retry as matroska, still a stream copy
        code, out, err = run(build("mkv"), timeout, cache_dir)
        if code != 0 and subs:
            # a subtitle track that will not mux is not worth failing the job for
            subs.clear()
            code, out, err = run(build("mkv"), timeout, cache_dir)
        if code != 0:
            raise _download_error(err)

    return _single_file(dest_dir)


def _download_error(stderr: str) -> ApiError:
    failure = classify(stderr)
    if failure is not None:
        return failure
    return ApiError.unavailable(detail=(stderr or "")[-400:])


def _single_file(directory: str, extensions=None) -> str:
    candidates = []
    for name in sorted(os.listdir(directory)):
        if name.startswith("media.") and not name.endswith((".part", ".ytdl", ".tmp")):
            if extensions and os.path.splitext(name)[1].lower() not in extensions:
                continue
            candidates.append(os.path.join(directory, name))
    if not candidates:
        raise EngineError("downloader finished without producing a file")
    # largest wins if a leftover from an earlier attempt is present
    return max(candidates, key=os.path.getsize)


# --------------------------------------------------------------------------
# verification
# --------------------------------------------------------------------------

def probe_file(path: str, timeout: int = 30) -> Dict[str, Any]:
    """ffprobe the finished file. Used to verify, not to trust."""
    cmd = [
        FFPROBE,
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        path,
    ]
    code, out, err = run(cmd, timeout)
    if code != 0 or not out.strip():
        raise EngineError("ffprobe rejected the output", err)
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        raise EngineError("ffprobe output was not json", err)

    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    fmt = data.get("format", {}) or {}
    try:
        duration = float(fmt.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    return {
        "height": int(video.get("height") or 0) if video else 0,
        "width": int(video.get("width") or 0) if video else 0,
        "duration": duration,
        "video_codec": (video or {}).get("codec_name"),
        "audio_codec": (audio or {}).get("codec_name"),
        "format_name": fmt.get("format_name"),
        "size": int(fmt.get("size") or 0),
        "has_video": video is not None,
        "has_audio": audio is not None,
    }


def tools_available() -> Dict[str, bool]:
    """Probe each binary with the flag it actually supports.
    yt-dlp takes --version; ffmpeg and ffprobe take -version."""
    found = {}
    for name, binary, flag in (
        ("yt-dlp", YTDLP, "--version"),
        ("ffmpeg", FFMPEG, "-version"),
        ("ffprobe", FFPROBE, "-version"),
    ):
        try:
            code, out, _ = run([binary, flag], 15)
            found[name] = code == 0 and bool(out.strip())
        except (OSError, EngineError):
            found[name] = False
    return found
