"""Job lifecycle, capacity limits, cleanup. The media engine is faked."""

import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mdown_api import engine, jobs as jobs_module
from mdown_api.config import Config
from mdown_api.errors import ApiError

URL = "https://www.youtube.com/watch?v=test"


class FakeEngine:
    """Writes a small file and reports whatever metadata a test asks for."""

    def __init__(self):
        self.info = {"id": "test", "title": "A Test Clip", "duration": 60, "is_live": False}
        self.media = {"height": 720, "width": 1280, "duration": 60, "has_video": True,
                      "has_audio": True, "format_name": "mp4", "video_codec": "h264",
                      "audio_codec": "aac", "size": 1024}
        self.bytes = 1024
        self.calls = []

    def probe(self, url, timeout, cache_dir=None):
        return dict(self.info)

    def download(self, url, **kwargs):
        self.calls.append(kwargs)
        path = os.path.join(kwargs["dest_dir"], "media.mp4")
        with open(path, "wb") as handle:
            handle.write(b"\0" * self.bytes)
        return path

    def probe_file(self, path, timeout=30):
        return dict(self.media)


class JobManagerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.fake = FakeEngine()
        self._saved = (engine.probe, engine.download, engine.probe_file)
        engine.probe = self.fake.probe
        engine.download = self.fake.download
        engine.probe_file = self.fake.probe_file
        engine.INFO_CACHE._data.clear()
        self.manager = jobs_module.JobManager(Config(
            work_dir=self.tmp,
            min_free_bytes=0,
            max_concurrent=1,
            max_queue=2,
            job_ttl=60,
        ))

    def tearDown(self):
        engine.probe, engine.download, engine.probe_file = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make(self, **overrides):
        options = dict(mode="auto", height=1080, audio_format="mp3", audio_bitrate=128,
                       subtitle_lang="")
        options.update(overrides)
        return self.manager.create(URL, **options)

    def leftovers(self):
        return [name for name in os.listdir(self.tmp) if name != ".cache"]

    # -- happy path --------------------------------------------------------
    def test_creates_job_and_file(self):
        job = self.make()
        self.assertRegex(job.token, r"^[A-Za-z0-9_-]{16,64}$")
        self.assertTrue(os.path.isfile(job.path))
        self.assertEqual(job.filename, "A Test Clip.mp4")
        self.assertEqual(job.size, 1024)
        self.assertIsNotNone(job.ready_at)

    def test_tokens_are_unique(self):
        tokens = {self.make().token for _ in range(5)}
        self.assertEqual(len(tokens), 5)

    def test_get_and_mark_served(self):
        job = self.make()
        self.assertIs(self.manager.get(job.token), job)
        self.assertIsNone(self.manager.get("nope"))
        self.manager.mark_served(job.token)
        self.assertIsNotNone(job.served_at)

    # -- limits ------------------------------------------------------------
    def test_rejects_over_duration(self):
        self.fake.info["duration"] = 1801
        with self.assertRaises(ApiError) as caught:
            self.make()
        self.assertEqual(caught.exception.code, "api.content.video.too_long")
        self.assertEqual(caught.exception.context["limit"], 1800)
        self.assertEqual(self.leftovers(), [])

    def test_accepts_duration_at_the_cap(self):
        self.fake.info["duration"] = 1800
        job = self.make()
        self.assertTrue(os.path.isfile(job.path))

    def test_rejects_unknown_duration(self):
        self.fake.info["duration"] = None
        with self.assertRaises(ApiError):
            self.make()
        self.assertEqual(self.leftovers(), [])

    def test_rejects_live(self):
        self.fake.info["is_live"] = True
        with self.assertRaises(ApiError) as caught:
            self.make()
        self.assertEqual(caught.exception.code, "api.content.video.live")

    def test_rejects_resolution_above_cap(self):
        self.fake.media["height"] = 8640
        with self.assertRaises(ApiError):
            self.make()
        self.assertEqual(self.leftovers(), [])

    def test_clamps_requested_height(self):
        self.make(height=4320)
        self.assertEqual(self.fake.calls[-1]["height"], 4320)

    def test_clamps_bitrate(self):
        self.fake.media["has_video"] = False
        self.make(mode="audio", audio_bitrate=320)
        self.assertEqual(self.fake.calls[-1]["audio_bitrate"], 128)

    def test_rejects_oversized_output(self):
        self.fake.bytes = 4096
        self.manager = jobs_module.JobManager(Config(
            work_dir=self.tmp, min_free_bytes=0, max_output_bytes=2048, max_concurrent=1, max_queue=2))
        with self.assertRaises(ApiError) as caught:
            self.make()
        self.assertEqual(caught.exception.status, 413)
        self.assertEqual(self.leftovers(), [])

    def test_refuses_to_start_without_disk_headroom(self):
        # a 4K job is a gigabyte; starting one on a full disk corrupts it
        self.manager = jobs_module.JobManager(Config(
            work_dir=self.tmp, min_free_bytes=1 << 62, max_output_bytes=2048,
            max_concurrent=1, max_queue=2))
        with self.assertRaises(ApiError) as caught:
            self.make()
        self.assertEqual(caught.exception.status, 503,
                         "got %s %s" % (caught.exception.status, caught.exception.code))
        self.assertEqual(caught.exception.code, "api.instance.not_ready")
        self.assertEqual(self.leftovers(), [])

    def test_audio_mode_must_not_return_video(self):
        self.fake.media["has_video"] = True
        with self.assertRaises(ApiError):
            self.make(mode="audio")

    def test_download_failure_cleans_up(self):
        def boom(url, **kwargs):
            os.makedirs(kwargs["dest_dir"], exist_ok=True)
            open(os.path.join(kwargs["dest_dir"], "media.mp4"), "wb").close()
            raise ApiError.unavailable()

        engine.download = boom
        with self.assertRaises(ApiError):
            self.make()
        self.assertEqual(self.leftovers(), [])

    # -- daily ceiling -----------------------------------------------------
    def test_daily_cap_blocks_after_limit(self):
        manager = jobs_module.JobManager(Config(
            work_dir=self.tmp, min_free_bytes=0, max_concurrent=1, max_queue=5, max_daily_jobs=2))
        manager.create(URL, mode="auto", height=1080, audio_format="mp3", audio_bitrate=128)
        manager.create(URL, mode="auto", height=1080, audio_format="mp3", audio_bitrate=128)
        with self.assertRaises(ApiError) as caught:
            manager.create(URL, mode="auto", height=1080, audio_format="mp3", audio_bitrate=128)
        self.assertEqual(caught.exception.status, 429)
        self.assertEqual(caught.exception.context.get("reason"), "daily_cap")

    def test_daily_cap_zero_means_off(self):
        manager = jobs_module.JobManager(Config(
            work_dir=self.tmp, min_free_bytes=0, max_concurrent=1, max_queue=5, max_daily_jobs=0))
        for _ in range(4):
            manager.create(URL, mode="auto", height=1080, audio_format="mp3", audio_bitrate=128)
        self.assertEqual(manager.stats()["today"], 0)

    def test_subtitle_language_is_passed_to_the_engine(self):
        self.make(subtitle_lang="en")
        self.assertEqual(self.fake.calls[-1]["subtitle_lang"], "en")

    # -- capacity ----------------------------------------------------------
    def test_queue_limit(self):
        manager = self.manager
        manager._slots  # noqa: B018 - documentation of the attribute under test
        # pre-fill the waiter count to simulate a full queue
        manager._queued = 3
        with self.assertRaises(ApiError) as caught:
            self.make()
        self.assertEqual(caught.exception.status, 429)
        self.assertEqual(manager._queued, 3)

    def test_stats_shape(self):
        stats = self.manager.stats()
        for key in ("active", "queued", "ready_jobs", "disk_free_mb", "uptime_s"):
            self.assertIn(key, stats)

    # -- cleanup -----------------------------------------------------------
    def test_sweep_removes_expired_jobs(self):
        job = self.make()
        job.ready_at = time.time() - 120
        self.manager.sweep()
        self.assertIsNone(self.manager.get(job.token))
        self.assertFalse(os.path.exists(job.path))

    def test_sweep_removes_served_jobs_quickly(self):
        job = self.make()
        job.served_at = time.time() - 120
        self.manager.sweep()
        self.assertIsNone(self.manager.get(job.token))

    def test_sweep_keeps_fresh_jobs(self):
        job = self.make()
        self.manager.sweep()
        self.assertIsNotNone(self.manager.get(job.token))

    def test_sweep_removes_orphan_directories(self):
        orphan = os.path.join(self.tmp, "orphan")
        os.makedirs(orphan)
        old = time.time() - 60 * 60 * 24
        os.utime(orphan, (old, old))
        self.manager.sweep()
        self.assertFalse(os.path.exists(orphan))

    def test_drop_is_idempotent(self):
        job = self.make()
        self.manager.drop(job.token)
        self.manager.drop(job.token)
        self.assertIsNone(self.manager.get(job.token))


class RateLimiterTest(unittest.TestCase):
    def test_allows_up_to_max(self):
        limiter = jobs_module.RateLimiter(3, 60)
        for _ in range(3):
            self.assertTrue(limiter.check("1.2.3.4")["allowed"])
        verdict = limiter.check("1.2.3.4")
        self.assertFalse(verdict["allowed"])
        self.assertEqual(verdict["remaining"], 0)
        self.assertGreater(verdict["retry"], 0)

    def test_keys_are_independent(self):
        limiter = jobs_module.RateLimiter(1, 60)
        self.assertTrue(limiter.check("a")["allowed"])
        self.assertTrue(limiter.check("b")["allowed"])
        self.assertFalse(limiter.check("a")["allowed"])

    def test_window_expiry(self):
        limiter = jobs_module.RateLimiter(1, 1)
        self.assertTrue(limiter.check("a")["allowed"])
        self.assertFalse(limiter.check("a")["allowed"])
        time.sleep(1.05)
        self.assertTrue(limiter.check("a")["allowed"])

    def test_prune(self):
        limiter = jobs_module.RateLimiter(1, 1)
        limiter.check("a")
        time.sleep(1.05)
        limiter.prune()
        self.assertEqual(limiter._hits, {})


if __name__ == "__main__":
    unittest.main()
