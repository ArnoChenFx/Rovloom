"""验证原生采集器的本地拒绝/清理边界；这些合成测试不算 Herdr 原生实证。"""

import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from contract import Rejected, ROOT
import verify_native as native


class NativeCaptureBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rh-unit-')
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.binary = self.root/'synthetic-binary'
        self.binary.write_bytes(b'synthetic input, never executed')
        self.binary.chmod(0o700)
        self.pin = {'binary_sha256': hashlib.sha256(self.binary.read_bytes()).hexdigest()}

    def tearDown(self):
        self.temp.cleanup()

    def make_run(self):
        with patch('verify_native.validate_binary', return_value=self.binary):
            return native.Run(self.binary, self.root/'capture')

    def test_binary_pin_is_checked_before_any_execution_or_output(self):
        output = self.root/'not-created'
        with patch('subprocess.Popen') as process, self.assertRaisesRegex(Rejected, 'official pin'):
            native.Run(self.binary, output)
        process.assert_not_called()
        self.assertFalse(output.exists())
        self.assertEqual(native.validate_binary(self.binary, self.pin), self.binary)

    def test_binary_link_mode_and_hash_changes_are_rejected(self):
        link = self.root/'link'
        link.symlink_to(self.binary)
        with self.assertRaisesRegex(Rejected, 'canonical'):
            native.validate_binary(link, self.pin)
        self.binary.chmod(0o777)
        with self.assertRaisesRegex(Rejected, 'unsafe binary'):
            native.validate_binary(self.binary, self.pin)
        self.binary.chmod(0o700)
        self.binary.write_bytes(b'changed')
        with self.assertRaisesRegex(Rejected, 'official pin'):
            native.validate_binary(self.binary, self.pin)

    def test_output_must_be_fresh_and_outside_checkout(self):
        for output in (self.root, ROOT/'native-must-not-be-created'):
            with patch('verify_native.validate_binary', return_value=self.binary), self.assertRaises(Rejected):
                native.Run(self.binary, output)

    def test_environment_does_not_copy_fake_credentials(self):
        with patch.dict(os.environ, {'SSH_AUTH_SOCK': '/synthetic/agent.sock', 'OPENAI_API_KEY': 'synthetic-canary'}):
            run = self.make_run()
        try:
            self.assertNotIn('SSH_AUTH_SOCK', run.env)
            self.assertNotIn('OPENAI_API_KEY', run.env)
            self.assertNotIn('synthetic-canary', json.dumps(run.env))
            self.assertEqual(Path(run.env['HOME']).parent, run.root)
        finally:
            run.finish()
        self.assertTrue(run.report['cleanup']['temporary_root_removed'])

    def test_native_event_tags_and_payloads_are_not_normalized(self):
        event = {'event': 'workspace_renamed', 'data': {'type': 'workspace_renamed',
                 'workspace_id': 'w1', 'label': '合成', 'extra': {'preserve': [True, None]}}}
        self.assertEqual(native.lifecycle_event(native.encoded(event), 'w1'), event)
        for change in ({'event': 'workspace.renamed'}, {'data': {**event['data'], 'workspace_id': 'w2'}},
                       {'data': {**event['data'], 'type': 'workspace.renamed'}}):
            with self.subTest(change=change), self.assertRaises(Rejected):
                native.lifecycle_event(native.encoded({**event, **change}), 'w1')

    def test_kernel_peer_must_match_directly_supervised_pid_before_send(self):
        run = self.make_run()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            run.endpoint = run.root/'test.sock'
            listener.bind(str(run.endpoint)); run.endpoint.chmod(0o600); listener.listen()
            run.process = SimpleNamespace(pid=os.getpid()+100000, poll=lambda: 0)
            with self.assertRaisesRegex(AssertionError, 'peer PID differs'):
                run.connect()
            peer, _ = listener.accept()
            peer.settimeout(1)
            self.assertEqual(peer.recv(1), b'')
            peer.close()
            self.assertEqual(run.sockets, [])
        finally:
            listener.close()
            run.process = None
            run.finish()

    def test_arbitrary_endpoint_and_public_mode_are_rejected(self):
        run = self.make_run()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            run.endpoint = self.root/'outside.sock'
            with self.assertRaises(AssertionError):
                run.connect()
            run.endpoint = run.root/'test.sock'
            listener.bind(str(run.endpoint)); run.endpoint.chmod(0o666)
            with self.assertRaises(AssertionError):
                run.connect()
        finally:
            listener.close()
            run.finish()

    def test_cleanup_waits_for_own_started_process(self):
        run = self.make_run()
        run.process = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(30)'],
                                       env={'PATH': '/usr/bin:/bin'}, cwd=run.root, start_new_session=True)
        run.server_pid = run.process.pid
        run.finish()
        self.assertIsNotNone(run.process.returncode)
        self.assertEqual(run.report['cleanup'], {'temporary_root_removed': True, 'supervisor_exited': True,
                                                'remaining_tracked_children': []})

    def test_failed_native_step_remains_failed(self):
        run = self.make_run()
        try:
            run.check('synthetic-failure', lambda: (_ for _ in ()).throw(Rejected('synthetic failure')))
            self.assertEqual(run.report['checks'][0]['status'], 'failed')
        finally:
            run.finish()

    def test_evidence_copy_failure_still_removes_state_and_reports_failure(self):
        run = self.make_run()
        (run.root/'synthetic.log').write_text('synthetic only')
        with patch('verify_native.shutil.copyfile', side_effect=OSError('synthetic output failure')):
            with self.assertRaisesRegex(OSError, 'after cleanup'):
                run.finish()
        self.assertFalse(run.root.exists())
        report = json.loads((run.out/'native-results.json').read_text())
        self.assertEqual(report['evidence_copy_error'], 'OSError')
        self.assertTrue(report['cleanup']['temporary_root_removed'])


if __name__ == '__main__':
    unittest.main()
