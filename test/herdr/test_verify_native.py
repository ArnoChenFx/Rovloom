# 用合成文件、socket 和故障注入检查原生验证器的 pin、来源、超时与清理边界，不计作原生实证。
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
from unittest.mock import Mock, patch

# 从当前仓库显式载入被测维护工具，隔离不同测试文件的导入状态。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/herdr'))

from contract import Rejected, ROOT
import verify_native as native


class NativeCaptureBoundary(unittest.TestCase):
    # 建立私有临时目录和从不执行的合成二进制，计算仅供本地边界测试使用的摘要。
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rh-unit-')
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.binary = self.root/'synthetic-binary'
        self.binary.write_bytes(b'synthetic input, never executed')
        self.binary.chmod(0o700)
        self.pin = {'binary_sha256': hashlib.sha256(self.binary.read_bytes()).hexdigest()}

    # 删除本测试的合成二进制、输出记录及临时目录。
    def tearDown(self):
        self.temp.cleanup()

    # 用固定返回值替代整个二进制校验来构造合成运行对象，保留输出与私有环境初始化路径。
    def make_run(self):
        with patch('verify_native.validate_binary', return_value=self.binary):
            return native.Run(self.binary, self.root/'capture')

    # 验证官方 pin 不匹配时既不启动进程也不创建输出，同时确认匹配合成摘要可过本地校验。
    def test_binary_pin_is_checked_before_any_execution_or_output(self):
        output = self.root/'not-created'
        with patch('subprocess.Popen') as process, self.assertRaisesRegex(Rejected, 'official pin'):
            native.Run(self.binary, output)
        process.assert_not_called()
        self.assertFalse(output.exists())
        self.assertEqual(native.validate_binary(self.binary, self.pin), self.binary)

    # 分别验证符号链接、不安全文件权限和二进制字节改变均被拒绝。
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

    # 验证已有目录或检出目录内的输出在创建运行环境前被拒绝。
    def test_output_must_be_fresh_and_outside_checkout(self):
        for output in (self.root, ROOT/'native-must-not-be-created'):
            with patch('verify_native.validate_binary', return_value=self.binary), self.assertRaises(Rejected):
                native.Run(self.binary, output)

    # 验证新环境不继承 SSH 或模型凭据，且 HOME 位于本次私有根并在收尾删除。
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

    # 验证原生事件未知字段保留，错误事件标签、数据类型标签和 workspace 身份被拒绝。
    def test_native_event_tags_and_payloads_are_not_normalized(self):
        event = {'event': 'workspace_renamed', 'data': {'type': 'workspace_renamed',
                 'workspace_id': 'w1', 'label': '合成', 'extra': {'preserve': [True, None]}}}
        self.assertEqual(native.lifecycle_event(native.encoded(event), 'w1'), event)
        for change in ({'event': 'workspace.renamed'}, {'data': {**event['data'], 'workspace_id': 'w2'}},
                       {'data': {**event['data'], 'type': 'workspace.renamed'}}):
            with self.subTest(change=change), self.assertRaises(Rejected):
                native.lifecycle_event(native.encoded({**event, **change}), 'w1')

    # 用合成 socket 验证内核对端 PID 不符时连接被关闭，且未发送任何协议字节。
    def test_kernel_peer_must_match_directly_supervised_pid_before_send(self):
        run = self.make_run()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            run.endpoint = run.root/'test.sock'
            listener.bind(str(run.endpoint)); run.endpoint.chmod(0o600); listener.listen()
            run.process = SimpleNamespace(pid=os.getpid()+100000, poll=lambda: 0)  # 模拟已退出的被监管进程，仅用于验证连接时对端 PID 不匹配的拒绝路径。
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

    # 验证私有根外的任意端点以及公开读写的 socket 都无法连接。
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

    # 启动仅休眠的自建进程，验证收尾会等待其退出并删除临时状态。
    def test_cleanup_waits_for_own_started_process(self):
        run = self.make_run()
        run.process = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(30)'],
                                       env={'PATH': '/usr/bin:/bin'}, cwd=run.root, start_new_session=True)
        run.server_pid = run.process.pid
        run.finish()
        self.assertIsNotNone(run.process.returncode)
        self.assertEqual(run.report['cleanup'], {'temporary_root_removed': True, 'supervisor_exited': True,
                                                'remaining_tracked_children': []})

    # 验证单项回调抛错会保留失败记录，不能因收尾完成而被当作通过。
    def test_failed_native_step_remains_failed(self):
        run = self.make_run()
        try:
            run.check('synthetic-failure', lambda: (_ for _ in ()).throw(Rejected('synthetic failure')))  # 回调固定抛出拒绝异常，验证单项检查会保存失败状态。
            self.assertEqual(run.report['checks'][0]['status'], 'failed')
        finally:
            run.finish()

    # 构造可切换超时、EOF、重置或原生错误的帧探针，返回真实检查逻辑产生的结果。
    def framing_probe(self, outcome):
        with patch('verify_native.validate_binary', return_value=self.binary):
            run = native.Run(self.binary, self.root/('capture-' + outcome))
        channels = []

        class Channel:
            # 仅在超限请求场景按参数注入发送超时，其余请求模拟发送成功。
            def sendall(self, _data):
                if len(channels) == 6 and outcome == 'send_timeout':
                    raise socket.timeout('synthetic send timeout without rejection evidence')

            # 用超时模拟缺失最终 LF 时等待后续输入，不伪造原生拒绝响应。
            def recv(self, _size):
                raise socket.timeout('synthetic partial-line wait')

            # 接纳探针对接收时限的调整；合成通道的超时行为由固定注入控制。
            def settimeout(self, _timeout):
                pass

            # 作为无真实句柄的合成通道关闭入口，使测试走完整的连接清理路径。
            def close(self):
                pass

        # 创建并登记合成通道，使请求序号和收尾连接清单与真实路径一致。
        def connect():
            channel = Channel()
            channels.append(channel)
            run.sockets.append(channel)
            return channel

        error = native.encoded({'id': 'invalid', 'error': {'code': 'invalid_request', 'message': 'synthetic'}})
        pong = native.encoded({'id': 'size', 'result': {'type': 'pong'}})
        sixth = {'receive_timeout': socket.timeout('synthetic receive timeout without rejection evidence'),
                 'eof': b'', 'reset': ConnectionResetError('synthetic reset'),
                 'error': native.encoded({'id': 'size', 'error': {'code': 'request_too_large', 'message': 'synthetic'}})}.get(outcome)
        responses = [error, error, pong, pong, pong]
        if outcome != 'send_timeout':
            responses.append(sixth)
        run.connect = connect
        run.read_line = Mock(side_effect=[*responses, pong])
        run.request = Mock(return_value={'result': {'type': 'pong'}})
        try:
            run.check('framing', run.framing)
            return run.report['checks'][0]
        finally:
            run.finish()

    # 验证超限帧的接收超时会保留失败，不能充当服务端已拒绝的证据。
    def test_oversize_receive_timeout_is_not_rejection(self):
        result = self.framing_probe('receive_timeout')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('synthetic receive timeout', result['error'])

    # 验证超限帧的发送超时会保留失败，不能充当原生拒绝证据。
    def test_oversize_send_timeout_is_not_rejection(self):
        result = self.framing_probe('send_timeout')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('synthetic send timeout', result['error'])

    # 验证超限帧收到 EOF、连接重置或原生错误时，探针仍认可明确拒绝结果。
    def test_explicit_native_refusal_evidence_is_still_accepted(self):
        for outcome in ('eof', 'reset', 'error'):
            with self.subTest(outcome=outcome):
                result = self.framing_probe(outcome)
                self.assertEqual(result['status'], 'passed')

    # 验证复制运行日志失败后仍删除临时根，并落盘清理摘要且向外报告复制错误。
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
