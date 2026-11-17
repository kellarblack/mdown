"""The request board: one public line, nothing attached, a broom for the owner.

Two layers are tested: the file behind it, and the HTTP route over a real
socket, so the rate limit, the origin check and the moderation key are the
production code and not a mock.
"""

import dataclasses
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mdown_api import server as server_module
from mdown_api.board import RequestBoard
from mdown_api.config import Config


class BoardFileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "board.jsonl")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_one_line_no_control_characters(self):
        board = RequestBoard(self.path)
        item = board.add("  a tool\n\nthat\tstrips   chapters  ")
        self.assertEqual(item["text"], "a tool that strips chapters")
        self.assertTrue(item["id"])

    def test_too_short_is_refused(self):
        board = RequestBoard(self.path)
        for bad in ("", " ", "\n\n", "a", "ab"):
            with self.assertRaises(ValueError):
                board.add(bad)

    def test_long_text_is_cut_not_refused(self):
        board = RequestBoard(self.path)
        item = board.add("x" * 400)
        self.assertEqual(len(item["text"]), 240)

    def test_a_new_ask_waits_for_a_yes(self):
        board = RequestBoard(self.path)
        item = board.add("a tool that strips chapters")
        self.assertEqual(board.list(10), [])
        self.assertEqual([entry["id"] for entry in board.pending()], [item["id"]])
        self.assertTrue(board.approve(item["id"]))
        self.assertEqual([entry["text"] for entry in board.list(10)],
                         ["a tool that strips chapters"])
        self.assertEqual(board.pending(), [])
        self.assertFalse(board.approve("nothing-with-that-id"))

    def test_newest_first(self):
        board = RequestBoard(self.path)
        first = board.add("first ask")
        second = board.add("second ask")
        board.approve(first["id"])
        board.approve(second["id"])
        listed = board.list(10)
        self.assertEqual([entry["id"] for entry in listed], [second["id"], first["id"]])

    def test_the_oldest_fall_off(self):
        board = RequestBoard(self.path, keep=3)
        for index in range(5):
            board.approve(board.add("ask %d" % index)["id"])
        texts = [entry["text"] for entry in board.list(10)]
        self.assertEqual(texts, ["ask 4", "ask 3", "ask 2"])

    def test_it_survives_a_restart(self):
        board = RequestBoard(self.path)
        board.approve(board.add("kept across a restart")["id"])
        again = RequestBoard(self.path)
        self.assertEqual(again.list(5)[0]["text"], "kept across a restart")

    def test_delete_removes_one_and_says_so(self):
        board = RequestBoard(self.path)
        item = board.add("to be removed")
        board.approve(board.add("stays")["id"])
        self.assertTrue(board.delete(item["id"]))
        self.assertFalse(board.delete(item["id"]))
        self.assertEqual([entry["text"] for entry in board.list(5)], ["stays"])

    def test_no_address_is_written_down(self):
        RequestBoard(self.path).add("nothing attached")
        with open(self.path, encoding="utf-8") as handle:
            raw = handle.read()
        self.assertNotIn("127.0.0.1", raw)
        self.assertNotIn("User-Agent", raw)
        entry = json.loads(raw.strip())
        self.assertEqual(sorted(entry), ["id", "ok", "t", "text"])
        self.assertFalse(entry["ok"])


class BoardHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        logging.disable(logging.CRITICAL)

    @classmethod
    def tearDownClass(cls):
        logging.disable(logging.NOTSET)

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.config = Config(
            port=0,
            work_dir=self.tmp,
            min_free_bytes=0,
            board_rate_max=2,
            board_rate_window=3600,
            cors_origins=["https://mdown.cc"],
        )
        self.server = server_module.ApiServer(self.config)
        self.port = self.server.server_address[1]
        self.base = "http://127.0.0.1:%d" % self.port
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.handler = self.server.RequestHandlerClass

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Accept", "application/json")
        request.add_header("Origin", "https://mdown.cc")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, dict(response.headers), json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), json.loads(error.read() or b"{}")

    def post(self, text, headers=None):
        return self.call("POST", "/requests", {"text": text}, headers)

    def rekey(self, key):
        self.handler.config = dataclasses.replace(self.config, api_key=key)

    def test_the_board_is_only_advertised_where_it_can_be_moderated(self):
        status, _, data = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertFalse(data["cobalt"]["board"])
        self.rekey("instance-key")
        try:
            # a keyed instance asks for the key on the info route too
            status, _, data = self.call("GET", "/",
                                       headers={"Authorization": "Api-Key instance-key"})
            self.assertEqual(status, 200)
            self.assertTrue(data["cobalt"]["board"])
        finally:
            self.rekey("")

    def test_an_empty_board_says_so(self):
        status, _, data = self.call("GET", "/requests")
        self.assertEqual(status, 200)
        self.assertEqual(data["items"], [])
        self.assertEqual(data["count"], 0)

    def test_posting_queues_it_until_it_is_approved(self):
        status, headers, data = self.post("a tool that renames files")
        self.assertEqual(status, 202)
        self.assertEqual(data["status"], "pending")
        self.assertEqual(data["item"]["text"], "a tool that renames files")
        self.assertFalse(data["item"]["ok"])
        self.assertIn("RateLimit-Remaining", headers)

        status, _, listed = self.call("GET", "/requests")
        self.assertEqual(status, 200)
        self.assertEqual(listed["items"], [])

        status, _, data = self.call("GET", "/requests/pending")
        self.assertEqual(status, 403)   # no key on this instance

        self.rekey("instance-key")
        try:
            status, _, queue = self.call("GET", "/requests/pending",
                                         headers={"Authorization": "Api-Key instance-key"})
            self.assertEqual(status, 200)
            self.assertEqual(len(queue["items"]), 1)
            ident = queue["items"][0]["id"]

            status, _, _ = self.call("POST", "/requests/approve", {"id": ident},
                                     {"Authorization": "Api-Key instance-key"})
            self.assertEqual(status, 200)

            status, _, listed = self.call("GET", "/requests")
            self.assertEqual([entry["text"] for entry in listed["items"]],
                             ["a tool that renames files"])
            status, _, queue = self.call("GET", "/requests/pending",
                                         headers={"Authorization": "Api-Key instance-key"})
            self.assertEqual(queue["items"], [])
        finally:
            self.rekey("")

    def test_a_short_ask_is_refused_with_a_reason(self):
        status, _, data = self.post("  ")
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], "api.request.invalid")
        self.assertIn("reason", data["error"]["context"])

    def test_the_board_is_rate_limited(self):
        self.assertEqual(self.post("one ask")[0], 202)
        self.assertEqual(self.post("two asks")[0], 202)
        status, headers, data = self.post("three asks")
        self.assertEqual(status, 429)
        self.assertEqual(data["error"]["context"]["reason"], "board_slow_down")
        self.assertIn("Retry-After", headers)

    def test_another_origin_cannot_post(self):
        request = urllib.request.Request(self.base + "/requests", data=b'{"text":"spam"}',
                                         method="POST")
        request.add_header("Origin", "https://elsewhere.example")
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
        self.assertEqual(status, 403)

    def test_deleting_needs_the_instance_key(self):
        status, _, data = self.post("delete me")
        ident = data["item"]["id"]
        status, _, data = self.call("POST", "/requests/delete", {"id": ident})
        self.assertEqual(status, 403)
        self.assertEqual(data["error"]["code"], "api.request.locked")

        self.rekey("instance-key")
        try:
            status, _, _ = self.call("POST", "/requests/delete", {"id": ident},
                                     {"Authorization": "Api-Key instance-key"})
            self.assertEqual(status, 200)
            status, _, listed = self.call("GET", "/requests")
            self.assertEqual(listed["items"], [])
            status, _, data = self.call("POST", "/requests/delete", {"id": ident},
                                        {"Authorization": "Api-Key instance-key"})
            self.assertEqual(status, 404)
            self.assertEqual(data["error"]["code"], "api.request.missing")
        finally:
            self.handler.config = self.config

    def test_a_deleted_entry_is_gone_from_the_file(self):
        self.post("gone in a moment")
        path = os.path.join(self.tmp, "board.jsonl")
        with open(path, encoding="utf-8") as handle:
            self.assertIn("gone in a moment", handle.read())


if __name__ == "__main__":
    unittest.main()
