"""A tiny self-measured uptime log.

The status page used to draw its bars from one visitor's localStorage, which
made a browser tab look like an outage. This keeps one sample a minute on the
server, in daily buckets, and serves them as JSON. It is deliberately boring:
a file, a lock, a prune, no database.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Dict, List


class UptimeLog:
    def __init__(self, path: str, keep_days: int = 35) -> None:
        self.path = path
        self.keep_days = keep_days
        self._lock = threading.Lock()
        self._data: Dict[str, List[int]] = {}
        self._last_save = 0.0
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
            if isinstance(raw, dict):
                for day, pair in raw.items():
                    if isinstance(pair, list) and len(pair) == 2:
                        self._data[day] = [int(pair[0]), int(pair[1])]
        except (OSError, ValueError):
            self._data = {}

    def _save(self) -> None:
        tmp = self.path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(self._data, handle, separators=(",", ":"))
            os.replace(tmp, self.path)
            self._last_save = time.time()
        except OSError:
            pass

    def record(self, ok: bool) -> None:
        day = time.strftime("%Y-%m-%d", time.gmtime())
        with self._lock:
            pair = self._data.setdefault(day, [0, 0])
            pair[1] += 1
            if ok:
                pair[0] += 1
            cutoff = time.strftime(
                "%Y-%m-%d", time.gmtime(time.time() - self.keep_days * 86400))
            for key in [k for k in self._data if k < cutoff]:
                self._data.pop(key, None)
            due = time.time() - self._last_save > 300
        if due:
            with self._lock:
                self._save()

    def summary(self, days: int = 30) -> Dict[str, Any]:
        with self._lock:
            data = dict(self._data)
        out: List[Dict[str, Any]] = []
        total_up = total_all = 0
        now = time.time()
        for offset in range(days - 1, -1, -1):
            day = time.strftime("%Y-%m-%d", time.gmtime(now - offset * 86400))
            pair = data.get(day)
            if pair:
                out.append({"date": day, "up": pair[0], "total": pair[1]})
                total_up += pair[0]
                total_all += pair[1]
            else:
                out.append({"date": day, "up": None, "total": None})
        pct = round(total_up / total_all * 100, 2) if total_all else None
        return {
            "days": out,
            "checks": total_all,
            "up": total_up,
            "uptime": pct,
            "since": out[0]["date"] if out else None,
        }
