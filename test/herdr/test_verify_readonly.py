"""只检验新增采集边界的失败关闭；合成 socket 不算真实原生结果。"""

from pathlib import Path
import sys
import io
import json
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

# 从当前仓库显式载入被测维护工具，隔离不同测试文件的导入状态。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/herdr'))

from verify_native import Run, encoded
from verify_readonly import passive_ping, retained_boundary


class BoundaryFailures(unittest.TestCase):
    """超时或未建立背压不能冒充精确的原生保留窗证据。"""

    def setUp(self):
        """为每个反例建立自己的临时输出及显式合成 socket。"""
        self.temp = tempfile.TemporaryDirectory(prefix='rovloom-readonly-unit-')
        self.addCleanup(self.temp.cleanup)
        self.channel = Mock()
        self.channel.getsockopt.return_value = 212992
        self.channel.recv.side_effect = [b'{"event":', socket.timeout('synthetic no refusal evidence')]
        self.run = SimpleNamespace(out=Path(self.temp.name), workspace_id='synthetic-workspace',
                                   request=Mock(return_value={'result': {}}),
                                   subscribe=Mock(return_value=self.channel), sockets=[self.channel],
                                   flood_trace=None, save=Mock())

    def test_receive_timeout_does_not_prove_513_loss(self):
        """只有超时的流必须失败，不能归为 events_lost 或 EOF。"""
        with self.assertRaisesRegex(socket.timeout, 'synthetic no refusal evidence'):
            retained_boundary(self.run, 513)
        self.channel.close.assert_called_once()

    def test_receive_timeout_does_not_prove_512_retention(self):
        """未收到 512 条完整事件时，保留边界同样不能通过。"""
        with self.assertRaises(socket.timeout):
            retained_boundary(self.run, 512)
        self.channel.close.assert_called_once()

    def test_initial_complete_event_does_not_fix_a_blocked_cursor(self):
        """已完整写出的首事件不保证服务端仍停在同一批，故拒绝继续推论。"""
        self.channel.recv.side_effect = [b'{}\n']
        with self.assertRaisesRegex(AssertionError, 'still incomplete'):
            retained_boundary(self.run, 513)
        self.assertEqual(self.run.request.call_count, 1)

    def test_only_exact_reviewed_counts_are_accepted(self):
        """其它数量不进入本实验，也不建立网络或合成写入。"""
        with self.assertRaises(AssertionError):
            retained_boundary(self.run, 514)
        self.run.subscribe.assert_not_called()

    def retained_stream(self, marker=False, malformed=False):
        """提供完整原生形状的合成字节流，末尾明确 EOF，不代替真实边界实验。"""
        self.run.sockets = [self.channel]
        def event(label, kind='workspace_renamed'):
            """只生成该测试 workspace 的明确事件值。"""
            return encoded({'event': kind, 'data': {'type': 'workspace_renamed',
                            'workspace_id': self.run.workspace_id, 'label': label}})
        raw = event('hold-' + 'H'*750000)
        raw += b''.join(event(f'boundary-{index:04d}', 'wrong_event' if malformed and index == 0 else 'workspace_renamed')
                        for index in range(512))
        stream = io.BytesIO(raw)
        self.channel.recv.side_effect = stream.read
        # 使用真实采集器的完整单行读取逻辑，仅将底层 socket 替换成当前合成流。
        self.run.read_line = lambda channel: Run.read_line(self.run, channel)

        def request(_method, params, *_label):
            """marker 只能在测试器实际发出后到达，避免预填流污染反例。"""
            if marker and params.get('label') == 'boundary-after-retained':
                if marker == 'timeout':
                    self.channel.recv.side_effect = socket.timeout('synthetic marker timeout')
                    return {'result': {}}
                extra = event('boundary-after-retained')
                if marker == 'duplicate':
                    extra = extra.replace(b'{"event":', b'{"event":"duplicate","event":', 1)
                elif marker == 'workspace':
                    value = json.loads(extra)
                    value['data']['workspace_id'] = 'wrong-workspace'
                    extra = encoded(value)
                elif marker == 'lost':
                    extra = encoded({'id': 'boundary-512', 'error': {'code': 'events_lost', 'message': 'synthetic'}})
                position = stream.tell()
                stream.seek(0, 2)
                stream.write(extra)
                stream.seek(position)
            return {'result': {}}
        self.run.request.side_effect = request

    def test_complete_512_then_eof_is_not_a_live_subscription(self):
        """读满后立即 EOF 必须失败，不能只靠 eof 初始值断言订阅存活。"""
        self.retained_stream()
        with self.assertRaisesRegex(AssertionError, 'closed before marker'):
            retained_boundary(self.run, 512)

    def test_final_request_cannot_overrun_generation_budget(self):
        """最后一次请求返回超预算，即使事件完整也不能通过。"""
        self.retained_stream(marker=True)
        ticks = iter([0.0]*513 + [3.1])
        # 只在最终请求返回后推进时钟，区分请求开始与生成完成的预算门禁。
        with patch('verify_readonly.time.monotonic', side_effect=lambda: next(ticks, 3.1)):
            with self.assertRaisesRegex(AssertionError, 'generation exceeded'):
                retained_boundary(self.run, 512)

    def test_ordered_labels_under_wrong_event_tag_are_not_native_evidence(self):
        """label 相同仍须核对原生事件标签、类型和 workspace 归属。"""
        self.retained_stream(marker=True, malformed=True)
        with self.assertRaisesRegex(AssertionError, 'native rename event'):
            retained_boundary(self.run, 512)

    def test_marker_failures_never_confirm_continuation(self):
        """marker 超时、重复键、错 workspace 和原生 gap 都不能冒充继续消费。"""
        for mode, error, message in [('timeout', socket.timeout, 'synthetic marker timeout'),
                                     ('duplicate', ValueError, 'duplicate JSON key'),
                                     ('workspace', AssertionError, 'native rename event context mismatch'),
                                     ('lost', AssertionError, 'native rename event envelope mismatch')]:
            with self.subTest(mode=mode):
                self.channel.close.reset_mock()
                self.retained_stream(marker=mode)
                with self.assertRaisesRegex(error, message):
                    retained_boundary(self.run, 512)
                self.channel.close.assert_called_once()


class PassivePingFailures(unittest.TestCase):
    """静态 ping 观察不能从坏确认、状态变化、输入或 EOF 中得出通过。"""

    def setUp(self):
        """只使用本轮合成状态和 mock socket，不创建原生进程。"""
        self.temp = tempfile.TemporaryDirectory(prefix='rovloom-ping-unit-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'shell.input.bytes').write_text('0')
        self.channel = Mock()
        self.snapshot = {'version': '0.9.5', 'protocol': 22, 'panes': [], 'agents': []}
        self.snapshots = [self.snapshot, dict(self.snapshot)]
        self.run = SimpleNamespace(root=self.root, sockets=[self.channel], connect=Mock(return_value=self.channel),
                                   request=Mock(side_effect=self.request), save=Mock(),
                                   read_line=Mock(return_value=encoded({'id': 'ping-observer', 'result': {'type': 'subscription_started'}})))

    def request(self, method, _params, _label):
        """按实际顺序返回两份对照和精确 pong，不用候选报告补造原生许可。"""
        if method == 'session.snapshot':
            return {'result': {'snapshot': self.snapshots.pop(0)}}
        return {'id': 'synthetic', 'result': {'type': 'pong', 'version': '0.9.5', 'protocol': 22}}

    def test_exact_ack_is_required(self):
        """错 ID 或错类型的确认必须失败并关闭当前通道。"""
        self.run.read_line.return_value = encoded({'id': 'other', 'result': {'type': 'subscription_started'}})
        with self.assertRaises(AssertionError):
            passive_ping(self.run)
        self.channel.close.assert_called_once()

    def test_state_or_input_change_cannot_pass(self):
        """任何可见状态变化或合成输入都使比较失败，不以 ping 名称推断被动。"""
        for change in ('state', 'input'):
            with self.subTest(change=change):
                self.snapshots = [self.snapshot, {**self.snapshot, **({'agents': ['changed']} if change == 'state' else {})}]
                (self.root/'shell.input.bytes').write_text('1' if change == 'input' else '0')
                self.run.sockets = [self.channel]
                with self.assertRaises(AssertionError):
                    passive_ping(self.run)

    def test_readable_event_or_eof_is_not_a_quiet_window(self):
        """通道可读时 EOF 同样拒绝，不能把订阅死亡报告为无事件。"""
        self.run.read_line.side_effect = [encoded({'id': 'ping-observer', 'result': {'type': 'subscription_started'}}), b'']
        with patch('verify_readonly.select.select', return_value=([self.channel], [], [])):
            with self.assertRaisesRegex(AssertionError, 'event or observer EOF'):
                passive_ping(self.run)
        self.channel.close.assert_called_once()

    def test_quiet_window_reports_scope_without_production_permission(self):
        """成功也只能报告有限窗口，明确缺 UI/agent 覆盖和产品派发许可。"""
        with patch('verify_readonly.select.select', return_value=([], [], [])):
            result = passive_ping(self.run)
        self.assertEqual(result['calls'], 32)
        self.assertFalse(result['production_permission'])
        self.assertIn('active_ui', result['not_covered'])
        self.assertEqual(self.run.sockets, [])


if __name__ == '__main__':
    unittest.main()
