"""仅测采集器的拒绝边界；这些合成 socket 不计为原生 Luvus 验收。"""

import os
from datetime import datetime, timezone
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

from collect_native import Capture


class EndpointBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".p0-endpoint-unit-", dir="/workspace")
        self.root = Path(self.temp.name)
        (self.root / "state").mkdir(mode=0o700)
        self.path = self.root / "state" / "synthetic.sock"
        self.bound = []
        self.bind()
        self.capture = object.__new__(Capture)
        self.capture.root = self.root
        self.capture.endpoint = {"transport": "unix_socket", "address": str(self.path)}
        self.capture.endpoint_identity = None
        self.capture.records, self.capture.checks = [], []

    def bind(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(str(self.path))
        self.path.chmod(0o600)
        self.bound.append(sock)

    def tearDown(self):
        for sock in self.bound:
            sock.close()
        self.temp.cleanup()

    def test_private_owned_socket_and_replacement(self):
        self.assertEqual(self.capture.validate_endpoint(), str(self.path))
        self.path.unlink()
        self.bind()
        with self.assertRaisesRegex(AssertionError, "unchanged"):
            self.capture.validate_endpoint()

    def test_symlink_refused(self):
        link = self.path.with_name("link.sock")
        link.symlink_to(self.path)
        self.capture.endpoint["address"] = str(link)
        with self.assertRaisesRegex(AssertionError, "symlink"):
            self.capture.validate_endpoint()

    def test_writable_parent_refused(self):
        self.path.parent.chmod(0o770)
        with self.assertRaisesRegex(AssertionError, "writable"):
            self.capture.validate_endpoint()

    def test_public_socket_mode_refused(self):
        self.path.chmod(0o666)
        with self.assertRaisesRegex(AssertionError, "mode"):
            self.capture.validate_endpoint()

    def test_arbitrary_remote_or_outside_endpoint_refused(self):
        for address in ("relative.sock", "/tmp/other-owner.sock", "\\\\host\\pipe\\unsafe"):
            self.capture.endpoint["address"] = address
            with self.assertRaisesRegex(AssertionError, "absolute"):
                self.capture.validate_endpoint()


class CleanupFailure(unittest.TestCase):
    """注入采集器错误只用于失败清理回归，不计入原生 Luvus 通过数。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".p0-cleanup-unit-", dir="/workspace")
        parent = Path(self.temp.name)
        capture = self.capture = object.__new__(Capture)
        capture.root, capture.output = parent / "state-root", parent / "evidence"
        capture.root.mkdir(mode=0o700)
        capture.output.mkdir(mode=0o700)
        capture.binary = parent / "synthetic-binary"
        capture.binary.write_bytes(b"synthetic metadata only, never executed")
        capture.records, capture.checks, capture.streams = [], [], []
        capture.server = None
        capture.environment, capture.session = {}, "synthetic-cleanup-unit"
        capture.started_at = datetime.now(timezone.utc).isoformat()
        capture.completed, capture.collection_failure = True, None

    def tearDown(self):
        self.temp.cleanup()

    def test_discovery_failure_still_saves_failure_and_removes_root(self):
        capture = self.capture
        capture.server_out = open(capture.root / "server.stdout", "wb")
        capture.server_err = open(capture.root / "server.stderr", "wb")
        # 此子进程立即退出，不启动任何服务。
        capture.server = subprocess.Popen([sys.executable, "-c", "pass"], stdout=capture.server_out, stderr=capture.server_err)
        capture.server.wait(timeout=3)

        def fail_discovery(_label):
            raise RuntimeError("synthetic discovery failure")

        capture.discover = fail_discovery
        with self.assertRaisesRegex(RuntimeError, "cleanup_discovery"):
            capture.finish()
        self.assertFalse(capture.root.exists())
        report = json.loads((capture.output / "environment.json").read_text())
        self.assertFalse(report["native_collection_completed"])
        self.assertTrue(report["cleanup"]["temporary_root_removed"])
        self.assertEqual(report["cleanup"]["errors"][0]["stage"], "cleanup_discovery")
        self.assertTrue((capture.output / "manifest.json").is_file())

    def test_evidence_write_failure_does_not_preserve_temporary_root(self):
        capture = self.capture

        def fail_save(_name, _value):
            raise OSError("synthetic output failure")

        capture.save = fail_save
        with self.assertRaisesRegex(OSError, "synthetic output failure"):
            capture.finish()
        self.assertFalse(capture.root.exists())


if __name__ == "__main__":
    unittest.main()
