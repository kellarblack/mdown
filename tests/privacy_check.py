#!/usr/bin/env python3
"""Refuse to publish a site that identifies its owner.

Checks every file the Pages workflow ships, not the repo: README, LICENSE and
the git history are fine to be public, the *site* is not allowed to carry a
name, an email, or a third-party request.

    python3 tests/privacy_check.py                 # exits 1 on a finding
    python3 tests/privacy_check.py --verbose       # list every scanned file
    python3 tests/privacy_check.py _site           # check an assembled site

The optional directory is what CI uses, so the deploy gate reads the exact
folder that is about to be published rather than the source tree.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# an explicit directory wins: `_site` in CI, the repo everywhere else
for argument in sys.argv[1:]:
    if not argument.startswith("-"):
        ROOT = os.path.abspath(argument)
        break

# exactly what .github/workflows/pages.yml copies into _site
SITE = [
    "index.html", "404.html", "terms.html", "status.html", "updates.html", "donate.html",
    "api.html", "sources.html",
    "robots.txt", "sitemap.xml", "llms.txt", "manifest.webmanifest", "_headers",
]

# The handle this build must never carry is read from a local file that is not
# published and not committed: the guard used to spell it out in its own source,
# which is a strange way to keep a secret. Absent file, one less rule.
OWNER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "owner-handle.txt")
OWNER = ""
try:
    with open(OWNER_FILE, "r", encoding="utf-8") as handle:
        OWNER = handle.read().strip()
except OSError:
    OWNER = ""

IDENTITY = [
    (re.compile(r"[\w.+-]+@[\w-]+\.[a-z]{2,}", re.I), "an email address"),
    (re.compile(r'<meta[^>]+name=["\']author["\']', re.I), "an author meta tag"),
    (re.compile(r"©|&copy;", re.I), "a copyright notice"),
]
if OWNER:
    IDENTITY.insert(0, (re.compile(re.escape(OWNER), re.I), "the owner's handle"))

# hosts that would mean the page phones somewhere
TRACKERS = re.compile(
    r"(google-analytics|googletagmanager|gtag\(|doubleclick|facebook\.net|"
    r"connect\.facebook|hotjar|plausible\.io|posthog|segment\.(io|com)|"
    r"amplitude|mixpanel|sentry\.io|clarity\.ms|matomo|piwik)",
    re.I,
)

# no advertisements, ever. The site is funded by donations or not at all.
ADS = re.compile(
    r"adsbygoogle|googlesyndication|/pagead/|data-ad-slot"
    r"|class=[\"'][^\"']*\bslot\b|id=[\"']slot[\"']",
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

        if ADS.search(text):
            findings.append((rel, "advertising markup — donations only"))

        if rel.endswith(".html"):
            for match in EXTERNAL_LOAD.finditer(text):
                # read past the scheme: the host is what decides "third party",
                # and a preconnect to the site's own API is the site talking to
                # itself, not a phone call to somebody else
                snippet = text[match.start():match.start() + 120].replace("\n", " ")
                host = re.search(r"https?://([^/\"'\s>]+)", snippet)
                host = host.group(1).lower() if host else ""
                own = host == "mdown.cc" or host.endswith(".mdown.cc")
                if "schema.org" in snippet or own or host in ("127.0.0.1", "localhost"):
                    continue
                findings.append((rel, "third-party load: %s" % snippet[:70]))

    # the phone's donation tab is this site framing donate.html, so the framing
    # policy must allow 'self'. 'none' looks stricter and blanks the tab.
    headers_file = os.path.join(ROOT, "_headers")
    if os.path.exists(headers_file):
        policy = open(headers_file, encoding="utf-8").read()
        if "frame-ancestors 'none'" in policy or re.search(r"X-Frame-Options:\s*DENY", policy):
            findings.append(("_headers", "frame policy refuses the site's own donation tab"))

    if findings:
        print("privacy check: %d finding(s)" % len(findings))
        for rel, message in findings:
            print("  %-34s %s" % (rel, message))
        return 1

    print("privacy check: %d files clean (no identity, no trackers, no third-party loads)" % len(targets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
