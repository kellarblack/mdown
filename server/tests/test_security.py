"""URL validation and SSRF guards. No network: the resolver is patched."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mdown_api import security
from mdown_api.errors import ApiError

PUBLIC = ["93.184.216.34"]


class ValidateUrlTest(unittest.TestCase):
    def setUp(self):
        self._original = security.resolve
        security.resolve = lambda host, port: list(PUBLIC)

    def tearDown(self):
        security.resolve = self._original

    def assertRejected(self, url, code="api.url.invalid"):
        with self.assertRaises(ApiError) as caught:
            security.validate_url(url)
        self.assertEqual(caught.exception.code, code)

    def test_accepts_ordinary_links(self):
        for url in (
            "https://www.youtube.com/watch?v=abc123",
            "https://soundcloud.com/artist/track",
            "http://example.com/a.mp4",
        ):
            self.assertTrue(security.validate_url(url).startswith("http"))

    def test_normalises(self):
        self.assertEqual(
            security.validate_url("HTTPS://Example.COM/Path?x=1#frag"),
            "https://example.com/Path?x=1",
        )
        self.assertEqual(security.validate_url("https://example.com:443/a"), "https://example.com/a")
        self.assertEqual(security.validate_url("http://example.com:80/a"), "http://example.com/a")

    def test_rejects_non_standard_ports(self):
        # media sources are on 443; anything else is an SSRF foothold
        for url in ("https://example.com:8443/", "http://example.com:8080/"):
            self.assertRejected(url)

    def test_rejects_other_schemes(self):
        for url in ("javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://x.com/a"):
            self.assertRejected(url)

    def test_rejects_loopback_and_private_literals(self):
        for url in (
            "http://127.0.0.1/",
            "http://127.1/",
            "http://0.0.0.0/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://172.16.4.2/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://[fd00::1]/",
        ):
            self.assertRejected(url)

    def test_rejects_disguised_addresses(self):
        # decimal and octal spellings of 127.0.0.1 must not slip through
        for url in ("http://2130706433/", "http://017700000001/", "http://0x7f000001/"):
            self.assertRejected(url)

    def test_rejects_internal_hostnames(self):
        for url in (
            "http://localhost/",
            "http://metadata.google.internal/",
            "http://printer.local/",
            "http://intranet/",
        ):
            self.assertRejected(url)

    def test_rejects_credentials_and_bad_ports(self):
        self.assertRejected("https://user:pass@example.com/")
        self.assertRejected("http://example.com:22/")
        self.assertRejected("http://example.com:6379/")

    def test_rejects_when_dns_points_inside(self):
        security.resolve = lambda host, port: ["10.1.2.3"]
        self.assertRejected("https://evil.example.org/")
        security.resolve = lambda host, port: ["93.184.216.34", "192.168.0.9"]
        self.assertRejected("https://mixed.example.org/")

    def test_rejects_unresolvable(self):
        security.resolve = lambda host, port: []
        self.assertRejected("https://does-not-resolve.example.org/")

    def test_missing_input(self):
        for value in ("", "   ", None):
            with self.assertRaises(ApiError) as caught:
                security.validate_url(value)
            self.assertEqual(caught.exception.code, "api.url.missing")

    def test_control_characters(self):
        self.assertRejected("https://example.com/a\x00b")
        self.assertRejected("https://example.com/a\nHost: evil")

    def test_long_url(self):
        self.assertRejected("https://example.com/" + "a" * 3000)


class FilenameTest(unittest.TestCase):
    def test_strips_path_parts(self):
        self.assertEqual(security.safe_filename("../../etc/passwd", "mp4"), "etc-passwd.mp4")
        self.assertEqual(security.safe_filename("C:\\Windows\\system.ini", "mp4"), "C--Windows-system.ini.mp4")

    def test_removes_control_characters(self):
        self.assertEqual(security.safe_filename("bad\x00name\x1f", "mp3"), "badname.mp3")

    def test_falls_back_when_empty(self):
        self.assertEqual(security.safe_filename("", "mp3"), "download.mp3")
        self.assertEqual(security.safe_filename("   ", "mp3"), "download.mp3")
        self.assertEqual(security.safe_filename(None, "mp3"), "download.mp3")

    def test_bounds_length(self):
        name = security.safe_filename("x" * 400, "mp4")
        self.assertLessEqual(len(name), 115)
        self.assertTrue(name.endswith(".mp4"))

    def test_hostile_extension(self):
        self.assertEqual(security.safe_filename("a", "../../etc/passwd"), "a.bin")

    def test_header_safe(self):
        self.assertEqual(security.header_safe("a\r\nSet-Cookie: x=1"), "aSet-Cookie: x=1")


if __name__ == "__main__":
    unittest.main()
