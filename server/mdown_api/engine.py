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

import base64
import hashlib
import json
import os
import shlex
import re
import signal
import subprocess
import tempfile
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


def run_bytes(cmd: list, timeout: int, limit: int = 2 * 1024 * 1024) -> Tuple[int, bytes, str]:
    """Like run(), but for output that is an image rather than text."""
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        env=_base_env(),
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
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        return 1, b"", "timed out"
    return proc.returncode, out[:limit], err.decode("utf-8", "replace")


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

    formats = []
    for fmt in (info.get("formats") or []):
        if not isinstance(fmt, dict):
            continue
        if not fmt.get("height") and not fmt.get("acodec"):
            continue
        formats.append({
            key: fmt.get(key)
            for key in ("format_id", "ext", "height", "width", "vcodec", "acodec",
                        "filesize", "filesize_approx", "tbr", "abr", "vbr", "fps")
        })
        if len(formats) >= 80:
            break

    thumb = info.get("thumbnail")
    if not thumb and isinstance(info.get("thumbnails"), list) and info["thumbnails"]:
        thumb = info["thumbnails"][-1].get("url")

    slim = {
        "id": info.get("id"),
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel") or "",
        "thumbnail": thumb or "",
        "formats": formats,
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


def _number(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number > 0 else 0.0


def _has(value: Any) -> bool:
    return bool(value) and str(value) != "none"


def _size_of(fmt: Dict[str, Any], duration: float) -> float:
    """Bytes for one format: exact, approximate, then bitrate × time."""
    size = _number(fmt.get("filesize")) or _number(fmt.get("filesize_approx"))
    if size:
        return size
    rate = _number(fmt.get("tbr")) or (_number(fmt.get("vbr")) + _number(fmt.get("abr")))
    if rate and duration:
        return rate * 1000 / 8 * duration
    return 0.0


def _sharper(fmt: Dict[str, Any]) -> tuple:
    return (_number(fmt.get("height")), _number(fmt.get("tbr")), _number(fmt.get("filesize")))


def estimate(info: Dict[str, Any], *, mode: str, height: int,
             audio_format: str, audio_bitrate: int) -> Dict[str, Any]:
    """Roughly how big the result will be, before a single byte is fetched.

    This is an estimate, and it is labelled as one in the UI: exact sizes only
    exist on formats the source publishes a filesize for. Bitrate × duration
    is used when it does not, and a re-encode is computed from the target
    bitrate instead — which is the one case where the guess is very good.
    """
    duration = _number(info.get("duration"))
    formats = [f for f in (info.get("formats") or []) if isinstance(f, dict)]
    if not duration or not formats:
        return {"bytes": 0, "height": None, "exact": False}

    if mode == "audio":
        if audio_format == "wav":
            return {"bytes": int(176400 * duration), "height": None, "exact": True}
        if audio_format in ("mp3", "ogg", "opus"):
            return {"bytes": int(audio_bitrate * 125 * duration), "height": None, "exact": True}
        audios = [f for f in formats if _has(f.get("acodec")) and not _has(f.get("vcodec"))]
        if not audios:
            audios = [f for f in formats if _has(f.get("acodec"))]
        if not audios:
            return {"bytes": 0, "height": None, "exact": False}
        pick = max(audios, key=_sharper)
        return {"bytes": int(_size_of(pick, duration)), "height": None,
                "exact": bool(_number(pick.get("filesize")))}

    videos = [f for f in formats if _has(f.get("vcodec"))]
    capped = [f for f in videos if 0 < _number(f.get("height")) <= height]
    pool = capped or videos
    if not pool:
        return {"bytes": 0, "height": None, "exact": False}

    top = max(_number(f.get("height")) for f in pool)
    same = [f for f in pool if _number(f.get("height")) == top]

    if mode == "mute":
        pick = max(same, key=lambda f: _size_of(f, duration))
        return {"bytes": int(_size_of(pick, duration)),
                "height": int(top) if top else None,
                "exact": bool(_number(pick.get("filesize")))}

    progressive = [f for f in same if _has(f.get("acodec"))]
    if progressive:
        pick = max(progressive, key=lambda f: _size_of(f, duration))
        return {"bytes": int(_size_of(pick, duration)),
                "height": int(top) if top else None,
                "exact": bool(_number(pick.get("filesize")))}

    video_size = max(_size_of(f, duration) for f in same)
    audios = [f for f in formats if _has(f.get("acodec")) and not _has(f.get("vcodec"))]
    audio_size = max((_size_of(f, duration) for f in audios), default=0.0)
    return {
        "bytes": int(video_size + audio_size),
        "height": int(top) if top else None,
        "exact": bool(video_size and audio_size),
    }


def thumb_data_url(url: str, *, cache_dir: Optional[str] = None,
                   timeout: int = 10, width: int = 160) -> str:
    """Fetch a thumbnail and return it inline, so the page never talks to the
    source's CDN. A failure is not an error: the preview just has no picture."""
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        return ""

    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]
    folder = os.path.join(cache_dir or tempfile.gettempdir(), "thumbs")
    try:
        os.makedirs(folder, mode=0o700, exist_ok=True)
    except OSError:
        folder = tempfile.gettempdir()
    path = os.path.join(folder, digest + ".jpg")

    try:
        with open(path, "rb") as handle:
            cached = handle.read()
        if cached[:2] == b"\xff\xd8":
            return "data:image/jpeg;base64," + base64.b64encode(cached).decode("ascii")
    except OSError:
        pass

    cmd = [
        FFMPEG, "-nostdin", "-loglevel", "error", "-y",
        "-rw_timeout", "8000000",
        "-i", url,
        "-frames:v", "1",
        "-vf", "scale=%d:-2:flags=lanczos" % width,
        "-f", "mjpeg", "-q:v", "6", "pipe:1",
    ]
    code, data, _ = run_bytes(cmd, timeout)
    if code != 0 or len(data) < 400 or len(data) > 400000 or data[:2] != b"\xff\xd8":
        return ""
    try:
        with open(path, "wb") as handle:
            handle.write(data)
    except OSError:
        pass
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


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
    audio_covers: bool = False,
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
        # cover art needs a container that can carry it; the untouched source
        # stream is deliberately left alone
        if audio_covers and fmt in ("mp3", "ogg", "opus"):
            cmd += ["--embed-thumbnail", "--convert-thumbnails", "jpg"]
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


SUBTITLE_EXTS = (".srt", ".vtt", ".ass", ".ssa", ".lrc")


def _single_file(directory: str, extensions=None) -> str:
    """The media file, never a subtitle sidecar.

    With --embed-subs yt-dlp leaves the .srt next to the video. Picking by size
    happens to work, but a tiny clip with a long transcript would serve the
    transcript. Filter them out by name and extension instead of by luck.
    """
    candidates = []
    for name in sorted(os.listdir(directory)):
        if not name.startswith("media."):
            continue
        if name.endswith((".part", ".ytdl", ".tmp")):
            continue
        lowered = name.lower()
        # media.en.srt, media.en.vtt, ... are sidecars, not the download
        if any(lowered.endswith(ext) for ext in SUBTITLE_EXTS):
            continue
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
