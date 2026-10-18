"""仅测采集器的拒绝边界；这些合成 socket 不计为原生 Luvus 验收。"""

import os
from pathlib import Path
import socket
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


if __name__ == "__main__":
    unittest.main()
