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
from verify_readonly import retained_boundary


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


if __name__ == '__main__':
    unittest.main()
