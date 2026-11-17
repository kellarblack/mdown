"""The request board: short public asks, newest first, nothing attached.

One JSONL file, no database, no accounts. What is kept is the line somebody
typed, the second they typed it, and whether it has been let through. No
address, no cookie, no user agent, no name: the rate limiter holds an address
in memory for an hour and never writes it down.

A new ask waits. `list()` only ever returns what the owner approved, so a
stranger cannot put words on the front page by typing them.

    board = RequestBoard("/var/lib/mdown/board.jsonl")
    board.add("a tool that strips chapters")   # pending
    board.pending()                            # what waits
    board.approve("abc123")                    # now it shows
    board.delete("abc123")                     # or it never does
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from typing import Any, Dict, List

MAX_TEXT = 240
MIN_TEXT = 3
KEEP = 500          # entries on the board; the oldest fall off the end
TITLE = 40          # characters of a single line, for the log and the tests


class RequestBoard:
    def __init__(self, path: str, keep: int = KEEP) -> None:
        self.path = path
        self.keep = keep
        self._lock = threading.Lock()
        self._items: List[Dict[str, Any]] = []
        self._loaded = False

    # -- storage -----------------------------------------------------------
    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(entry, dict) and entry.get("text") and entry.get("id"):
                        self._items.append({
                            "id": str(entry["id"]),
                            "t": int(entry.get("t") or 0),
                            "text": str(entry["text"]),
                            # entries written before approval existed were public
                            "ok": bool(entry.get("ok", True)),
                        })
        except OSError:
            self._items = []
        self._items = self._items[-self.keep:]

    def _save(self) -> None:
        folder = os.path.dirname(self.path)
        if folder:
            os.makedirs(folder, mode=0o700, exist_ok=True)
        temporary = self.path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            for entry in self._items:
                handle.write(json.dumps(entry, separators=(",", ":"), ensure_ascii=False) + "\n")
        os.replace(temporary, self.path)

    # -- words -------------------------------------------------------------
    @staticmethod
    def normalize(raw: Any) -> str:
        """One line, no control characters, no runs of space."""
        # a control character is a break between words, not a deletion
        text = "".join(ch if (ch.isprintable() or ch == " ") else " " for ch in str(raw or ""))
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) < MIN_TEXT:
            raise ValueError("a few words, please")
        if len(text) > MAX_TEXT:
            text = text[:MAX_TEXT].rstrip()
        return text

    # -- api ---------------------------------------------------------------
    def add(self, raw: Any) -> Dict[str, Any]:
        text = self.normalize(raw)
        with self._lock:
            self._load()
            entry = {
                "id": secrets.token_urlsafe(6),
                "t": int(time.time()),
                "text": text,
                "ok": False,
            }
            self._items.append(entry)
            if len(self._items) > self.keep:
                self._items = self._items[-self.keep:]
            self._save()
            return dict(entry)

    def list(self, limit: int = 30) -> List[Dict[str, Any]]:
        """Only what the owner let through, newest first."""
        with self._lock:
            self._load()
            approved = [entry for entry in self._items if entry.get("ok")]
            newest = list(reversed(approved))
            return [dict(entry) for entry in newest[:max(0, limit)]]

    def pending(self, limit: int = 50) -> List[Dict[str, Any]]:
        """What is waiting for a yes. Oldest first: deal with the queue in order."""
        with self._lock:
            self._load()
            waiting = [entry for entry in self._items if not entry.get("ok")]
            return [dict(entry) for entry in waiting[:max(0, limit)]]

    def approve(self, ident: str) -> bool:
        with self._lock:
            self._load()
            for entry in self._items:
                if entry["id"] == ident:
                    entry["ok"] = True
                    self._save()
                    return True
            return False

    def delete(self, ident: str) -> bool:
        with self._lock:
            self._load()
            kept = [entry for entry in self._items if entry["id"] != ident]
            if len(kept) == len(self._items):
                return False
            self._items = kept
            self._save()
            return True

    def count(self) -> int:
        with self._lock:
            self._load()
            return sum(1 for entry in self._items if entry.get("ok"))
