#!/usr/bin/env python3
"""Refuse to publish a site that identifies its owner.

Checks every file the Pages workflow ships, not the repo: README, LICENSE and
the git history are fine to be public, the *site* is not allowed to carry a
name, an email, or a third-party request.

    python3 tests/privacy_check.py            # exits 1 on a finding
    python3 tests/privacy_check.py --verbose  # list every scanned file
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# exactly what .github/workflows/pages.yml copies into _site
SITE = [
    "index.html", "404.html", "terms.html", "status.html", "updates.html",
    "robots.txt", "sitemap.xml", "llms.txt", "manifest.webmanifest", "_headers",
]

# a name, an address, or a handle that would dox the operator
IDENTITY = [
    (re.compile(r"kellar", re.I), "the owner's handle"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[a-z]{2,}", re.I), "an email address"),
    (re.compile(r'<meta[^>]+name=["\']author["\']', re.I), "an author meta tag"),
    (re.compile(r"©|&copy;", re.I), "a copyright notice"),
]

# hosts that would mean the page phones somewhere
TRACKERS = re.compile(
    r"(google-analytics|googletagmanager|gtag\(|doubleclick|facebook\.net|"
    r"connect\.facebook|hotjar|plausible\.io|posthog|segment\.(io|com)|"
    r"amplitude|mixpanel|sentry\.io|clarity\.ms|matomo|piwik)",
    re.I,
)

# a request to a third party from the page itself
EXTERNAL_LOAD = re.compile(
    r"""<(?:script|img|iframe|video|audio|source)\b[^>]*\b(?:src|href)\s*=\s*["']https?://"""
    r"""|<link\b(?![^>]*\brel=["'](?:canonical|alternate)["'])[^>]*\bhref\s*=\s*["']https?://""",
    re.I,
)


def assets():
    base = os.path.join(ROOT, "assets")
    for folder, _dirs, files in os.walk(base):
        if "vendor" in folder.split(os.sep):
            continue
        for name in files:
            if name.endswith((".js", ".css", ".html", ".webmanifest", ".svg")):
                yield os.path.relpath(os.path.join(folder, name), ROOT)


def main():
    verbose = "--verbose" in sys.argv
    targets = [f for f in SITE if os.path.exists(os.path.join(ROOT, f))] + list(assets())
    findings = []

    for rel in targets:
        path = os.path.join(ROOT, rel)
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError as error:
            findings.append((rel, "cannot read: %s" % error))
            continue
        if verbose:
            print("scan %-32s %6d bytes" % (rel, len(text)))

        for pattern, label in IDENTITY:
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                findings.append((rel, "%s on line %d: %r" % (label, line, match.group(0)[:40])))

        # the cobalt API docs link in a comment is a citation, not a home page,
        # so only flag tracker hosts and real requests
        if TRACKERS.search(text):
            findings.append((rel, "analytics/tracking reference"))

        if rel.endswith(".html"):
            for match in EXTERNAL_LOAD.finditer(text):
                snippet = match.group(0).replace("\n", " ")[:70]
                if "schema.org" in snippet or "mdown.cc" in snippet or "127.0.0.1" in snippet:
                    continue
                findings.append((rel, "third-party load: %s" % snippet))

    if findings:
        print("privacy check: %d finding(s)" % len(findings))
        for rel, message in findings:
            print("  %-34s %s" % (rel, message))
        return 1

    print("privacy check: %d files clean (no identity, no trackers, no third-party loads)" % len(targets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
