"""Configuration parsing. Pure logic, no environment leakage between tests."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mdown_api.config import Config, ConfigError

KEYS = (
    "MDOWN_API_URL", "MDOWN_HOST", "MDOWN_PORT", "MDOWN_CORS_ORIGINS",
    "MDOWN_API_KEY", "MDOWN_MAX_HEIGHT", "MDOWN_MAX_DURATION",
    "MDOWN_MAX_OUTPUT_MB", "MDOWN_MAX_CONCURRENT", "MDOWN_MAX_QUEUE",
    "MDOWN_JOB_TIMEOUT", "MDOWN_PROBE_TIMEOUT", "MDOWN_JOB_TTL",
    "MDOWN_MIN_FREE_MB", "MDOWN_WORK_DIR", "MDOWN_RATE_MAX",
    "MDOWN_RATE_WINDOW", "MDOWN_TRUST_PROXY", "MDOWN_VERSION",
)


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.saved = {key: os.environ.get(key) for key in KEYS}
        for key in KEYS:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_defaults_are_conservative(self):
        config = Config.from_env()
        self.assertEqual(config.max_height, 4320)
        self.assertEqual(config.max_duration, 1800)
        self.assertEqual(config.max_concurrent, 2)
        self.assertEqual(config.api_key, "")
        self.assertEqual(config.cors_origins, ["https://mdown.cc"])
        self.assertTrue(config.host.startswith("127.0.0.1"))

    def test_env_overrides(self):
        os.environ["MDOWN_MAX_DURATION"] = "600"
        os.environ["MDOWN_PORT"] = "9100"
        os.environ["MDOWN_API_KEY"] = "abc"
        os.environ["MDOWN_CORS_ORIGINS"] = "https://mdown.cc, https://staging.mdown.cc/"
        config = Config.from_env()
        self.assertEqual(config.max_duration, 600)
        self.assertEqual(config.port, 9100)
        self.assertEqual(config.api_key, "abc")
        self.assertEqual(config.cors_origins,
                         ["https://mdown.cc", "https://staging.mdown.cc"])

    def test_rejects_non_numeric(self):
        os.environ["MDOWN_MAX_DURATION"] = "twenty"
        with self.assertRaises(ConfigError):
            Config.from_env()

    def test_rejects_out_of_range(self):
        os.environ["MDOWN_MAX_CONCURRENT"] = "999"
        with self.assertRaises(ConfigError):
            Config.from_env()

    def test_origin_matching_is_exact(self):
        config = Config(cors_origins=["https://mdown.cc"])
        self.assertTrue(config.cors_origin_allowed("https://mdown.cc"))
        self.assertTrue(config.cors_origin_allowed("https://mdown.cc/"))
        self.assertFalse(config.cors_origin_allowed("https://www.mdown.cc"))
        self.assertFalse(config.cors_origin_allowed("http://mdown.cc"))
        self.assertFalse(config.cors_origin_allowed(""))
        self.assertFalse(config.cors_origin_allowed("https://mdown.cc.evil.com"))


if __name__ == "__main__":
    unittest.main()
