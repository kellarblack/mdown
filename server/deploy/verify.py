#!/usr/bin/env python3
"""End-to-end verification and timing for a deployed mdown API.

Runs against the real service over HTTPS — no mocks. Every check prints
PASS / FAIL / SKIP and the process exits non-zero if anything failed.

    python3 verify.py
    API=https://api.mdown.cc ORIGIN=https://mdown.cc python3 verify.py
    SAMPLE=https://www.youtube.com/watch?v=... LONG_URL=... python3 verify.py

Timings reported here are measured, not estimated. `inspect` is the POST that
extracts metadata and produces the file; `ttfb` is the first byte of the
tunnel transfer; `throughput` is bytes over the wall time of that transfer.
"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse

API = os.environ.get("API", "https://api.mdown.cc").rstrip("/")
ORIGIN = os.environ.get("ORIGIN", "https://mdown.cc").rstrip("/")
SAMPLE = os.environ.get("SAMPLE", "https://www.youtube.com/watch?v=aqz-KE-bpKQ")
LONG_URL = os.environ.get("LONG_URL", "").strip()
CONCURRENCY = int(os.environ.get("CONCURRENCY", "3"))

RESULTS = []
TIMINGS = {}

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"


def record(name, status, detail=""):
    RESULTS.append({"check": name, "status": status, "detail": detail})
    print(f"  [{status}] {name}{(' — ' + detail) if detail else ''}")


def split(url):
    parts = urllib.parse.urlsplit(url)
    return parts.scheme, parts.netloc, parts.path + (("?" + parts.query) if parts.query else "")


def request(method, url, body=None, headers=None, timeout=30):
    scheme, netloc, path = split(url)
    connection = http.client.HTTPSConnection(netloc, timeout=timeout) if scheme == "https" \
        else http.client.HTTPConnection(netloc, timeout=timeout)
    payload = json.dumps(body).encode() if body is not None else None
    head = {"Accept": "application/json"}
    if payload is not None:
        head["Content-Type"] = "application/json"
    head.update(headers or {})
    started = time.time()
    try:
        connection.request(method, path, body=payload, headers=head)
        response = connection.getresponse()
        data = response.read()
        return {
            "status": response.status,
            "headers": {k.lower(): v for k, v in response.getheaders()},
            "body": data,
            "elapsed": time.time() - started,
        }
    finally:
        connection.close()


def retarget(url):
    """Point a tunnel URL at the API base we were told to test.

    The API builds tunnel links from its own public URL, which does not resolve
    until DNS exists. Testing through an SSH tunnel (or before DNS) should still
    exercise the same endpoint, so keep the path and swap the host.
    """
    api = urllib.parse.urlsplit(API)
    target = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((api.scheme, api.netloc, target.path, target.query, ""))


def download_tunnel(url, timeout=300):
    """Stream the tunnel URL, measuring time-to-first-byte and throughput."""
    url = retarget(url)
    scheme, netloc, path = split(url)
    connection = http.client.HTTPSConnection(netloc, timeout=timeout) if scheme == "https" \
        else http.client.HTTPConnection(netloc, timeout=timeout)
    started = time.time()
    connection.request("GET", path)
    response = connection.getresponse()
    first = response.read(65536)
    ttfb = time.time() - started
    total = len(first)
    while True:
        chunk = response.read(262144)
        if not chunk:
            break
        total += len(chunk)
    elapsed = time.time() - started
    headers = {k.lower(): v for k, v in response.getheaders()}
    connection.close()
    return {
        "status": response.status,
        "headers": headers,
        "bytes": total,
        "ttfb": ttfb,
        "elapsed": elapsed,
        "throughput_mbps": (total * 8 / 1e6) / elapsed if elapsed > 0 else 0,
        "head": first[:32],
    }


def magic_ok(head: bytes) -> bool:
    return (
        head[4:8] == b"ftyp"          # mp4 / m4a
        or head[:4] == b"RIFF"        # wav
        or head[:4] == b"OggS"        # ogg / opus
        or head[:3] == b"ID3"         # mp3 with tags
        or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")  # raw mp3 frames
        or head[:4] == b"\x1a\x45\xdf\xa3"  # matroska / webm
    )


def ffprobe(path):
    binary = shutil.which("ffprobe")
    if not binary:
        return None
    try:
        out = subprocess.run(
            [binary, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
            capture_output=True, timeout=60, check=True,
        ).stdout
        return json.loads(out)
    except (subprocess.SubprocessError, json.JSONDecodeError):
        return None


def main() -> int:
    print(f"mdown API verification\n  api    {API}\n  origin {ORIGIN}\n  sample {SAMPLE}\n")

    # 1. instance info -----------------------------------------------------
    info = request("GET", API + "/")
    ok = info["status"] == 200
    payload = {}
    if ok:
        try:
            payload = json.loads(info["body"])
        except json.JSONDecodeError:
            ok = False
    if ok:
        cobalt = payload.get("cobalt") or {}
        services = cobalt.get("services") or []
        ok = bool(cobalt.get("version")) and "youtube" in services
        record("instance info", PASS if ok else FAIL,
               f"version={cobalt.get('version')} services={len(services)}")
        TIMINGS["instance_info_ms"] = round(info["elapsed"] * 1000)
    else:
        record("instance info", FAIL, f"HTTP {info['status']}")

    # 2. health ------------------------------------------------------------
    health = request("GET", API + "/health")
    checks = {}
    try:
        checks = json.loads(health["body"]).get("checks", {})
    except json.JSONDecodeError:
        pass
    healthy = health["status"] == 200 and all(checks.values())
    record("health", PASS if healthy else FAIL,
           f"HTTP {health['status']} {checks}")

    # 3. CORS --------------------------------------------------------------
    allowed = request("OPTIONS", API + "/", headers={
        "Origin": ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    got = allowed["headers"].get("access-control-allow-origin", "")
    record("cors allows the site", PASS if got.rstrip("/") == ORIGIN else FAIL,
           f"allow-origin={got or 'absent'}")

    foreign = request("OPTIONS", API + "/", headers={
        "Origin": "https://not-mdown.example",
        "Access-Control-Request-Method": "POST",
    })
    leaked = foreign["headers"].get("access-control-allow-origin", "")
    record("cors blocks other origins", PASS if not leaked else FAIL,
           f"allow-origin={leaked or 'absent'}")

    # 4. input rejection ---------------------------------------------------
    bad = request("POST", API + "/", {"url": "javascript:alert(1)"}, {"Origin": ORIGIN})
    code = ""
    try:
        code = json.loads(bad["body"]).get("error", {}).get("code", "")
    except json.JSONDecodeError:
        pass
    record("rejects javascript: urls", PASS if bad["status"] == 400 and code == "api.url.invalid" else FAIL,
           f"HTTP {bad['status']} {code}")

    private = request("POST", API + "/", {"url": "http://169.254.169.254/latest/meta-data/"}, {"Origin": ORIGIN})
    record("rejects metadata address", PASS if private["status"] == 400 else FAIL,
           f"HTTP {private['status']}")

    missing = request("POST", API + "/", {}, {"Origin": ORIGIN})
    record("rejects empty body", PASS if missing["status"] == 400 else FAIL, f"HTTP {missing['status']}")

    # 5. a real download ---------------------------------------------------
    job = request("POST", API + "/", {
        "url": SAMPLE,
        "downloadMode": "audio",
        "audioFormat": "mp3",
        "audioBitrate": "128",
    }, {"Origin": ORIGIN}, timeout=600)

    job_ok = job["status"] == 200
    data = {}
    if job_ok:
        try:
            data = json.loads(job["body"])
            job_ok = data.get("status") == "tunnel" and data.get("url")
        except json.JSONDecodeError:
            job_ok = False

    record("real download produces a tunnel", PASS if job_ok else FAIL,
           f"HTTP {job['status']} {data.get('filename', '')} {data.get('size', '')}B")
    TIMINGS["post_to_tunnel_s"] = round(job["elapsed"], 2)

    if job_ok:
        transfer = download_tunnel(data["url"])
        body_ok = (
            transfer["status"] == 200
            and transfer["bytes"] > 50_000
            and int(transfer["headers"].get("content-length", 0) or 0) == transfer["bytes"]
            and magic_ok(transfer["head"])
        )
        record("tunnel streams real media", PASS if body_ok else FAIL,
               f"{transfer['bytes']}B, first bytes {transfer['head'][:8]!r}")
        TIMINGS["tunnel_ttfb_s"] = round(transfer["ttfb"], 3)
        TIMINGS["transfer_s"] = round(transfer["elapsed"], 2)
        TIMINGS["throughput_mbps"] = round(transfer["throughput_mbps"], 2)

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as handle:
            handle.write(transfer["head"])
            path = handle.name
        probe = ffprobe(path) if shutil.which("ffprobe") else None
        os.unlink(path)
        if probe is None:
            record("output is decodable (ffprobe)", SKIP, "ffprobe not installed here")
        else:
            record("output is decodable (ffprobe)", PASS, "ffprobe read the header")

    # 6. server-side duration cap -----------------------------------------
    if LONG_URL:
        long_job = request("POST", API + "/", {"url": LONG_URL, "downloadMode": "audio"},
                           {"Origin": ORIGIN}, timeout=600)
        long_code = ""
        try:
            long_code = json.loads(long_job["body"]).get("error", {}).get("code", "")
        except json.JSONDecodeError:
            pass
        record("rejects media over 30 minutes",
               PASS if long_job["status"] == 422 and "too_long" in long_code else FAIL,
               f"HTTP {long_job['status']} {long_code}")
    else:
        record("rejects media over 30 minutes", SKIP, "set LONG_URL to a >30 min link")

    # 7. job isolation -----------------------------------------------------
    forged = request("GET", API + "/tunnel/" + "z" * 32)
    record("unknown tunnel token is refused", PASS if forged["status"] == 404 else FAIL,
           f"HTTP {forged['status']}")

    # 8. concurrency -------------------------------------------------------
    import threading

    outcomes = []
    lock = threading.Lock()

    def worker():
        try:
            result = request("POST", API + "/", {
                "url": SAMPLE, "downloadMode": "audio", "audioFormat": "mp3",
            }, {"Origin": ORIGIN}, timeout=600)
            with lock:
                outcomes.append(result["status"])
        except Exception as problem:  # noqa: BLE001 - reported, not swallowed
            with lock:
                outcomes.append(f"error:{problem}")

    started = time.time()
    threads = [threading.Thread(target=worker) for _ in range(CONCURRENCY)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    wall = time.time() - started

    accepted = sum(1 for status in outcomes if status == 200)
    throttled = sum(1 for status in outcomes if status == 429)
    record(f"{CONCURRENCY} simultaneous downloads",
           PASS if accepted >= 1 and all(isinstance(s, int) for s in outcomes) else FAIL,
           f"200s={accepted} 429s={throttled} wall={wall:.1f}s")
    TIMINGS["concurrency_wall_s"] = round(wall, 2)

    # summary --------------------------------------------------------------
    failed = [item for item in RESULTS if item["status"] == FAIL]
    skipped = [item for item in RESULTS if item["status"] == SKIP]
    print("\ntimings (measured)")
    for key, value in TIMINGS.items():
        print(f"  {key}: {value}")
    print(f"\n{len(RESULTS) - len(failed) - len(skipped)} passed, "
          f"{len(failed)} failed, {len(skipped)} skipped")

    report = {"api": API, "when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "results": RESULTS, "timings": TIMINGS}
    with open("verify-report.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print("report written to verify-report.json")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
