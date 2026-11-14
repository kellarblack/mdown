"""Runtime configuration, entirely from environment variables.

Every value has a conservative default sized for a 2-OCPU / 12 GB ARM VM.
Nothing here is a performance promise; the numbers are ceilings that keep a
small box from being exhausted by one job.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List

GB = 1024 * 1024 * 1024
MB = 1024 * 1024


class ConfigError(RuntimeError):
    pass


def _int(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer, got {raw!r}")
    if not low <= value <= high:
        raise ConfigError(f"{name} must be between {low} and {high}, got {value}")
    return value


def _list(name: str) -> List[str]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return []
    return [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Config:
    # ---- identity -------------------------------------------------------
    version: str = "mdown-1.0"
    api_url: str = "http://127.0.0.1:9000/"

    # ---- listener -------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 9000
    trust_proxy: bool = False
    require_origin: bool = True
    cors_origins: List[str] = field(default_factory=list)

    # ---- auth (optional; off by default for a friends-scale instance) ----
    api_key: str = ""
    # turnstile: sitekey is public and shipped to the browser, the secret never
    # leaves the box. Empty either one disables the check entirely.
    turnstile_sitekey: str = ""
    turnstile_secret: str = ""

    # ---- media limits ---------------------------------------------------
    max_height: int = 4320
    max_duration: int = 1800          # 30 minutes
    max_output_bytes: int = 2048 * MB   # a 30-minute 4K file is ~1 GB

    # ---- capacity -------------------------------------------------------
    max_concurrent: int = 2
    # parallel range requests per download. Measured on the live box: 8 is ~40%
    # faster than 4 on a 900 MB 4K file, and 16 is slower than 8 because one
    # vCPU cannot keep more sockets fed.
    fragments: int = 8
    max_queue: int = 6
    job_timeout: int = 300            # seconds, whole download
    probe_timeout: int = 45           # seconds, metadata only
    job_ttl: int = 900                # seconds a finished file is kept
    max_daily_jobs: int = 500         # 0 = no ceiling
    min_free_bytes: int = 3 * GB
    work_dir: str = "/var/lib/mdown/jobs"

    # ---- request frequency ----------------------------------------------
    rate_limit_max: int = 30
    rate_limit_window: int = 60
    rate_limit_tunnel_max: int = 120
    # downloads (not requests) per IP per window. Generous for a person
    # batching a few links, tight enough to stop a scraper.
    job_rate_max: int = 60
    job_rate_window: int = 300
    # metadata lookups run yt-dlp without downloading, so they are cheaper than
    # a job but still touch the source: their own window keeps a typing user
    # from spending the download budget by accident
    probe_rate_max: int = 60
    probe_rate_window: int = 300

    # ---- source-side workarounds ----------------------------------------
    # a Netscape cookies.txt for age-gated / login-walled sources; empty = none
    ytdlp_cookies: str = ""
    # extra argv appended to every yt-dlp call, e.g.
    #   --extractor-args "youtube:player_client=tv,web_safari"
    ytdlp_extra_args: str = ""

    def cors_origin_allowed(self, origin: str) -> bool:
        if not origin:
            return False
        return origin.rstrip("/") in self.cors_origins

    @classmethod
    def from_env(cls) -> "Config":
        origins = _list("MDOWN_CORS_ORIGINS")
        if not origins:
            origins = ["https://mdown.cc"]
        return cls(
            version=os.environ.get("MDOWN_VERSION", "mdown-1.0").strip() or "mdown-1.0",
            api_url=os.environ.get("MDOWN_API_URL", "http://127.0.0.1:9000/").strip(),
            host=os.environ.get("MDOWN_HOST", "127.0.0.1").strip(),
            port=_int("MDOWN_PORT", 9000, 1024, 65535),
            trust_proxy=os.environ.get("MDOWN_TRUST_PROXY", "").strip() in ("1", "true", "yes"),
            require_origin=os.environ.get("MDOWN_REQUIRE_ORIGIN", "1").strip() not in ("0", "false", "no"),
            cors_origins=origins,
            api_key=os.environ.get("MDOWN_API_KEY", "").strip(),
            turnstile_sitekey=os.environ.get("MDOWN_TURNSTILE_SITEKEY", "").strip(),
            turnstile_secret=os.environ.get("MDOWN_TURNSTILE_SECRET", "").strip(),
            max_height=_int("MDOWN_MAX_HEIGHT", 4320, 144, 4320),
            max_duration=_int("MDOWN_MAX_DURATION", 1800, 30, 86400),
            max_output_bytes=_int("MDOWN_MAX_OUTPUT_MB", 2048, 16, 8192) * MB,
            max_concurrent=_int("MDOWN_MAX_CONCURRENT", 2, 1, 16),
            fragments=_int("MDOWN_FRAGMENTS", 8, 1, 16),
            max_queue=_int("MDOWN_MAX_QUEUE", 6, 0, 100),
            job_timeout=_int("MDOWN_JOB_TIMEOUT", 300, 30, 3600),
            probe_timeout=_int("MDOWN_PROBE_TIMEOUT", 45, 5, 600),
            job_ttl=_int("MDOWN_JOB_TTL", 900, 60, 86400),
            max_daily_jobs=_int("MDOWN_DAILY_JOBS", 500, 0, 1000000),
            min_free_bytes=_int("MDOWN_MIN_FREE_MB", 3072, 128, 1024 * 1024) * MB,
            work_dir=os.environ.get("MDOWN_WORK_DIR", "/var/lib/mdown/jobs").strip(),
            rate_limit_max=_int("MDOWN_RATE_MAX", 30, 1, 10000),
            rate_limit_window=_int("MDOWN_RATE_WINDOW", 60, 1, 3600),
            rate_limit_tunnel_max=_int("MDOWN_TUNNEL_RATE_MAX", 120, 1, 100000),
            job_rate_max=_int("MDOWN_JOB_RATE_MAX", 60, 1, 10000),
            job_rate_window=_int("MDOWN_JOB_RATE_WINDOW", 300, 10, 86400),
            probe_rate_max=_int("MDOWN_PROBE_RATE_MAX", 60, 1, 10000),
            probe_rate_window=_int("MDOWN_PROBE_RATE_WINDOW", 300, 10, 86400),
            ytdlp_cookies=os.environ.get("MDOWN_YTDLP_COOKIES", "").strip(),
            ytdlp_extra_args=os.environ.get("MDOWN_YTDLP_EXTRA_ARGS", "").strip(),
        )
