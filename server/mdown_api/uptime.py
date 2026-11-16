"""A tiny self-measured uptime log.

The status page used to draw its bars from one visitor's localStorage, which
made a browser tab look like an outage. This keeps one sample a minute on the
server, in daily buckets, and serves them as JSON. It is deliberately boring:
a file, a lock, a prune, no database.

A process cannot sample itself while it is dead, so a naive log would always
read 100%: it only counts the minutes it was alive. The timestamps are kept, and
a gap longer than two intervals is filled with the minutes that were missed,
counted as down. If the box reboots, that is downtime and the graph shows it.
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
        self._last_at = 0.0
        self._last_save = 0.0
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
            if isinstance(raw, dict):
                for day, pair in raw.items():
                    if day == "_at" and isinstance(pair, (int, float)):
                        self._last_at = float(pair)
                    elif isinstance(pair, list) and len(pair) == 2:
                        self._data[day] = [int(pair[0]), int(pair[1])]
        except (OSError, ValueError):
            self._data = {}

    def _save(self) -> None:
        tmp = self.path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
            payload = dict(self._data)
            payload["_at"] = round(self._last_at, 3)
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, separators=(",", ":"))
            os.replace(tmp, self.path)
            self._last_save = time.time()
        except OSError:
            pass

    #: a gap this long between samples means the process was not sampling
    GAP_SECONDS = 150

    def _fill_gap(self, now: float) -> int:
        """Count the minutes nobody was here to count.

        Must be called with the lock held. Returns how many misses were added so
        a caller (and a test) can see the correction rather than infer it.
        """
        last = self._last_at
        if not last or now - last <= self.GAP_SECONDS:
            return 0
        if now - last > self.keep_days * 86400:
            # older than the window: not worth walking, and not worth claiming
            return 0
        missed = 0
        at = last + 60
        while at < now - 30:
            day = time.strftime("%Y-%m-%d", time.gmtime(at))
            pair = self._data.setdefault(day, [0, 0])
            pair[1] += 1
            missed += 1
            at += 60
        return missed

    def flush(self) -> None:
        """Write now, whatever the interval says. Called on the way down so a
        restart leaves a timestamp behind and the gap check can tell a three
        second restart from a three hour outage."""
        with self._lock:
            self._save()

    def record(self, ok: bool) -> None:
        now = time.time()
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        with self._lock:
            self._fill_gap(now)
            pair = self._data.setdefault(day, [0, 0])
            pair[1] += 1
            if ok:
                pair[0] += 1
            self._last_at = now
            cutoff = time.strftime(
                "%Y-%m-%d", time.gmtime(time.time() - self.keep_days * 86400))
            for key in [k for k in self._data if k[:1].isdigit() and k < cutoff]:
                self._data.pop(key, None)
            due = time.time() - self._last_save > 120
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
            # when the last sample was taken: without it a dead box looks like a
            # graph that simply stopped growing, which reads as healthy
            "lastSampleAt": int(self._last_at) if self._last_at else None,
        }
