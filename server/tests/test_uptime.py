"""The uptime log: samples, day buckets, and the holes where it was dead.

A self-measured graph that only counts the minutes it was alive always reads
100%. These tests pin down the correction: a gap between samples is downtime,
and it lands in the right day.
"""

import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mdown_api.uptime import UptimeLog


def day(offset=0):
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + offset * 86400))


class UptimeLogTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "uptime.json")

    def test_a_sample_is_one_check(self):
        log = UptimeLog(self.path)
        log.record(True)
        log.record(False)
        summary = log.summary(1)
        self.assertEqual(summary["checks"], 2)
        self.assertEqual(summary["up"], 1)
        self.assertEqual(summary["uptime"], 50.0)

    def test_consecutive_samples_are_not_downtime(self):
        log = UptimeLog(self.path)
        log.record(True)
        log.record(True)
        self.assertEqual(log.summary(1)["checks"], 2)

    def test_a_gap_is_counted_as_down(self):
        log = UptimeLog(self.path)
        log.record(True)
        # pretend the last sample was ten minutes ago, then come back
        log._last_at = time.time() - 600
        before = log.summary(1)["checks"]
        log.record(True)
        after = log.summary(1)
        self.assertGreater(after["checks"], before + 1)
        # nine minutes were missed: one of them is the sample we just took
        self.assertGreaterEqual(after["checks"] - before, 10)
        self.assertEqual(after["up"], 2)
        self.assertLess(after["uptime"], 30.0)

    def test_a_short_delay_is_not_downtime(self):
        log = UptimeLog(self.path)
        log.record(True)
        log._last_at = time.time() - 100  # under the two-interval line
        log.record(True)
        self.assertEqual(log.summary(1)["checks"], 2)

    def test_the_timestamp_survives_a_restart(self):
        log = UptimeLog(self.path)
        log.record(True)
        log._save()
        again = UptimeLog(self.path)
        self.assertGreater(again._last_at, 0)
        again._last_at = time.time() - 300
        again.record(True)
        self.assertGreater(again.summary(1)["checks"], 2)

    def test_days_with_no_traffic_are_null_not_zero(self):
        log = UptimeLog(self.path)
        log.record(True)
        days = log.summary(3)["days"]
        self.assertEqual(len(days), 3)
        self.assertTrue(days[-1]["total"])
        self.assertIsNone(days[0]["up"])
        self.assertIsNone(days[0]["total"])

    def test_old_days_are_pruned(self):
        log = UptimeLog(self.path)
        log._data["2000-01-01"] = [1, 1]
        log.record(True)
        self.assertNotIn("2000-01-01", log._data)

    def test_flush_writes_without_waiting_for_the_interval(self):
        log = UptimeLog(self.path)
        log.record(True)
        log._last_save = 0          # pretend the interval has not elapsed
        log.flush()
        again = UptimeLog(self.path)
        self.assertEqual(again._data[day()], [1, 1])
        self.assertGreater(again._last_at, 0)

    def test_a_clean_restart_is_not_an_outage(self):
        log = UptimeLog(self.path)
        log.record(True)
        log.flush()
        again = UptimeLog(self.path)
        # ten seconds later, a new process samples again: no missed minutes
        again._last_at = time.time() - 10
        again.record(True)
        self.assertEqual(again.summary(1)["checks"], 2)

    def test_the_summary_says_when_it_last_sampled(self):
        log = UptimeLog(self.path)
        log.record(True)
        summary = log.summary(1)
        self.assertIsInstance(summary["lastSampleAt"], int)
        self.assertLessEqual(summary["lastSampleAt"], int(time.time()) + 1)

    def test_the_stamp_is_not_a_day(self):
        log = UptimeLog(self.path)
        log.record(True)
        log._save()
        again = UptimeLog(self.path)
        for entry in again.summary(30)["days"]:
            self.assertRegex(entry["date"], r"^\d{4}-\d{2}-\d{2}$")
        again.record(True)
        again.record(True)
        self.assertNotIn("_at", [d["date"] for d in again.summary(5)["days"]])


if __name__ == "__main__":
    unittest.main()
