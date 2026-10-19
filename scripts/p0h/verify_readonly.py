"""在获授权的独立实例复核保留窗边界与并发 snapshot；不开放产品权限。

大事件只用于固定测试订阅游标，不放宽桥接的 64 KiB 帧限额。所有写入均限于
本次创建的 workspace 或合成 PTY 的私有控制文件；不读取其它进程的 /proc。
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import select
import socket
import threading
import time

from contract import StateRebuild, decode, sha
from verify_native import Run, encoded


def close_channel(run, channel):
    """关闭且解除本次测试跟踪的连接，不触碰其它实例。"""
    channel.close()
    run.sockets.remove(channel)


def checked_rename(value, workspace_id, label):
    """完整核对本实验重命名事件的标签、类型、归属与有序 label。"""
    assert type(value) is dict and set(value) == {'event', 'data'}, 'native rename event envelope mismatch'
    data = value.get('data')
    assert value['event'] == 'workspace_renamed' and type(data) is dict, 'native rename event type mismatch'
    assert data == {'type': 'workspace_renamed', 'workspace_id': workspace_id, 'label': label}, 'native rename event context mismatch'


def blocked_event(run, label):
    """只发送自己的大 label，保留部分原文和当前 Unix socket 的发送缓冲量。"""
    channel = run.subscribe(label)
    channel.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
    send_buffer = channel.getsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF)
    value = 'hold-' + 'H'*750000
    assert len(value) > 3*send_buffer, 'kernel socket buffer is outside the reviewed backpressure setup'
    response = run.request('workspace.rename', {'workspace_id': run.workspace_id, 'label': value}, 'hold-write')
    assert 'result' in response
    first = channel.recv(4096)
    assert first and b'\n' not in first, 'first event must be observed while still incomplete'
    run.save('backpressure-setup.json', {'client_send_buffer': send_buffer, 'label_bytes': len(value),
                                      'initial_partial_bytes': len(first), 'peer_buffer_not_directly_observable': True})
    return channel, value, first


def blocked_write_control(run):
    """独立对照等待原生写超时，必须实际收到截断帧和 EOF 才证明该设置产生背压。"""
    channel, label, first = blocked_event(run, 'blocked-write-control')
    try:
        # 不读取排队数据，等待原生真正关闭；write_all 的多次系统调用可能重置发送超时。
        poller = select.poll()
        poller.register(channel, select.POLLRDHUP | select.POLLHUP | select.POLLERR)
        started = time.monotonic()
        closed = poller.poll(12000)
        assert closed and closed[0][1] & (select.POLLRDHUP | select.POLLHUP), 'native writer closure was not observed'
        closure_seconds = time.monotonic() - started
        chunks = [first]
        total = len(first)
        while True:
            chunk = channel.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            assert total <= 2*1024*1024
        raw = b''.join(chunks)
        run.save('blocked-write-truncated.raw', raw)
        expected = (json.dumps({'event': 'workspace_renamed', 'data': {'type': 'workspace_renamed',
                                'workspace_id': run.workspace_id, 'label': label}},
                               sort_keys=True, separators=(',', ':')) + '\n').encode()
        assert 0 < len(raw) < len(expected) and expected.startswith(raw), 'native writer did not truncate its expected first event'
        run.request('ping', {}, 'ping-after-write-timeout')
        return {'native_truncated_event_and_eof': True, 'received_bytes': total,
                'native_server_survived': True, 'client_timeout_is_not_evidence': True,
                'hangup_observed_without_draining': True, 'closure_seconds': closure_seconds}
    finally:
        close_channel(run, channel)


def retained_boundary(run, count):
    """用未写完的首事件固定游标，分别验证恰好 512/513 条后续事件。"""
    assert count in (512, 513)
    channel, label, first = blocked_event(run, 'boundary-' + str(count))
    started = time.monotonic()
    with (run.out/'boundary-generator.jsonl').open('wb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        run.flood_trace = stream
        try:
            for index in range(count):
                assert time.monotonic() - started < 3, 'generation must finish before native write timeout'
                response = run.request('workspace.rename', {'workspace_id': run.workspace_id,
                                                           'label': f'boundary-{index:04d}'})
                assert 'result' in response
        finally:
            run.flood_trace = None
    elapsed = time.monotonic() - started
    assert elapsed < 3, 'generation exceeded its final deadline'
    buffer, lines, eof = bytearray(first), [], False
    channel.settimeout(2)
    deadline = time.monotonic() + 4
    try:
        with (run.out/'boundary.stream.jsonl').open('wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            while time.monotonic() < deadline:
                while b'\n' in buffer:
                    raw, _, remaining = buffer.partition(b'\n')
                    buffer = bytearray(remaining)
                    stream.write(raw + b'\n')
                    lines.append(decode(raw))
                if len(lines) >= count + 1 or any('error' in value for value in lines):
                    if any('error' in value for value in lines):
                        eof = channel.recv(1) == b''
                    break
                chunk = channel.recv(65536)
                if not chunk:
                    eof = True
                    break
                buffer.extend(chunk)
                assert len(buffer) <= 2*1024*1024, 'native capture bound exceeded'
        assert lines, 'missing initial blocked event'
        checked_rename(lines[0], run.workspace_id, label)
        tail = lines[1:]
        record = {'generated_after_blocked_event': count, 'generation_seconds': elapsed,
                  'initial_partial_bytes': len(first), 'initial_event_complete': True,
                  'received_after_initial': len(tail), 'native_errors': [v for v in tail if 'error' in v],
                  'eof': eof, 'unparsed_bytes': len(buffer), 'source_cursor_inference': True}
        assert not buffer, 'incomplete trailing native frame'
        if count == 512:
            assert len(tail) == count and not eof
            for index, value in enumerate(tail):
                checked_rename(value, run.workspace_id, f'boundary-{index:04d}')
            # 另发 marker 证明读满后仍可继续消费；这条事件不计入初始 512 保留窗。
            response = run.request('workspace.rename', {'workspace_id': run.workspace_id,
                                                       'label': 'boundary-after-retained'}, 'retained-marker')
            assert 'result' in response
            marker = run.read_line(channel)
            run.save('retained-marker.event.jsonl', marker)
            assert marker, 'retained subscription closed before marker'
            checked_rename(decode(marker), run.workspace_id, 'boundary-after-retained')
            record['subscription_continued_after_512'] = True
            record['marker_is_after_retained_window'] = True
        else:
            assert len(tail) == 1 and tail[0]['id'] == 'boundary-513'
            assert set(tail[0]) == {'id', 'error'} and type(tail[0]['error']) is dict
            assert tail[0]['error']['code'] == 'events_lost' and isinstance(tail[0]['error'].get('message'), str) and eof
        run.save('boundary-observation.json', record)
        return {**record, 'cursor_is_not_public_native_sequence': True}
    finally:
        close_channel(run, channel)


def concurrent_snapshot(run):
    """重叠只读刷新和自己 workspace 的重命名，核对脏刷新与可见被动状态。"""
    channel = run.subscribe('snapshot-concurrent-events')
    baseline = run.request('session.snapshot', {}, 'concurrent-before')['result']['snapshot']
    model = StateRebuild()
    model.subscribe('native-events')
    model.acknowledge('native-events')
    ticket = model.begin_snapshot('native-snapshot-connection')
    barrier = threading.Barrier(2)
    intervals = {'snapshot': [], 'rename': []}

    def snapshots():
        """使用独立连接重复 snapshot，保留真实开始/结束区间与原文。"""
        barrier.wait(timeout=3)
        values = []
        for index in range(32):
            started = time.monotonic()
            value = run.request('session.snapshot', {}, f'concurrent-snapshot-{index}')['result']['snapshot']
            intervals['snapshot'].append([started, time.monotonic()])
            values.append(value)
        return values

    def renames():
        """仅改变本次创建的 workspace label，作为外部事件失效刺激。"""
        barrier.wait(timeout=3)
        for index in range(16):
            started = time.monotonic()
            response = run.request('workspace.rename', {'workspace_id': run.workspace_id,
                                                       'label': f'concurrent-{index:02d}'}, f'concurrent-rename-{index}')
            assert 'result' in response
            intervals['rename'].append([started, time.monotonic()])

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(snapshots)
            mutation = pool.submit(renames)
            values = pending.result(timeout=10)
            mutation.result(timeout=10)
        overlap = sum(a < d and c < b for a, b in intervals['snapshot'] for c, d in intervals['rename'])
        assert overlap > 0, 'requests did not actually overlap'
        events = []
        for index in range(16):
            raw = run.read_line(channel)
            event = decode(raw)
            checked_rename(event, run.workspace_id, f'concurrent-{index:02d}')
            events.append(raw)
            model.invalidate('native-events')
        run.save('concurrent-events.jsonl', b''.join(events))
        assert model.finish_snapshot(ticket, values[0])['refresh_again']
        ticket = model.begin_snapshot('native-final-snapshot-connection')
        current = run.request('session.snapshot', {}, 'concurrent-final')['result']['snapshot']
        assert current['workspaces'][0]['label'] == 'concurrent-15'
        assert not model.finish_snapshot(ticket, current)['refresh_again'] and model.cache == current
        for value in [*values, current]:
            for key in ('focused_workspace_id', 'focused_tab_id', 'focused_pane_id', 'tabs', 'panes', 'layouts', 'agents'):
                assert value[key] == baseline[key], f'unexpected passive change: {key}'
        assert int((run.root/'shell.input.bytes').read_text()) == 0
        record = {'snapshot_calls': len(values) + 2, 'rename_calls': 16,
                  'overlapping_client_request_intervals': overlap, 'intervals': intervals,
                  'focus_viewport_pane_agent_unchanged': True, 'synthetic_pty_input_bytes': 0,
                  'dirty_refresh_verified': True, 'whole_snapshot_replacement_verified': True,
                  'guarantee': 'state_rebuild_only', 'native_common_sequence': False,
                  'not_covered': ['active_ui', 'real_agent', 'notifications', 'pending_terminal_title_sync']}
        run.save('concurrent-observation.json', record)
        return record
    finally:
        close_channel(run, channel)


def start_title_fixture(run):
    """在创建任何 pane 前替换自己的合成 shell，仅由私有文件触发已知输出。"""
    result = run.start()
    helper = run.root/'synthetic-shell'
    helper.write_text('#!/usr/bin/python3 -I\nimport os,select,signal,tty\n'
                      'signal.signal(signal.SIGHUP,signal.SIG_DFL)\ntty.setraw(0)\n'
                      'open(' + repr(str(run.root/'shell.pid')) + ',"w").write(str(os.getpid()))\n'
                      'p=' + repr(str(run.root/'shell.input.bytes')) + '\nn=0\nopen(p,"w").write("0")\n'
                      'trigger=' + repr(str(run.root/'title-trigger')) + '\nemitted=False\n'
                      'os.write(1,b"synthetic p0h terminal ready\\r\\n")\n'
                      'while True:\n'
                      ' if not emitted and os.path.exists(trigger):\n'
                      '  os.write(1,b"\\x1b]2;synthetic-title-changed\\x07"+b"synthetic output line\\r\\n"*200)\n'
                      '  emitted=True\n'
                      ' ready,_,_=select.select([0],[],[],0.01)\n'
                      ' if ready:\n'
                      '  b=os.read(0,1024)\n'
                      '  if not b: break\n'
                      '  n+=len(b)\n  open(p,"w").write(str(n))\n')
    helper.chmod(0o700)
    return result


def title_snapshot(run):
    """在合成 OSC 标题和输出变动期间刷新，分别记录允许元数据变化与输入/焦点。"""
    before = run.request('session.snapshot', {}, 'title-before')['result']['snapshot']
    channel = run.connect()
    request = {'id': 'title-events', 'method': 'events.subscribe',
               'params': {'subscriptions': [{'type': 'pane.updated'}]}}
    channel.sendall(encoded(request))
    ack = run.read_line(channel)
    run.save('title-events.request.jsonl', encoded(request))
    run.save('title-events.ack.jsonl', ack)
    assert json.loads(ack) == {'id': 'title-events', 'result': {'type': 'subscription_started'}}
    (run.root/'title-trigger').write_text('synthetic output only')
    snapshots = []
    try:
        for index in range(64):
            value = run.request('session.snapshot', {}, f'title-snapshot-{index}')['result']['snapshot']
            snapshots.append(value)
            if value['panes'][0].get('terminal_title') == 'synthetic-title-changed':
                break
            time.sleep(0.01)
        after = snapshots[-1]
        assert after['panes'][0].get('terminal_title') == 'synthetic-title-changed'
        event = run.read_line(channel)
        run.save('title-update.event.jsonl', event)
        assert json.loads(event)['event'] == 'pane_updated'
        for value in snapshots:
            for key in ('focused_workspace_id', 'focused_tab_id', 'focused_pane_id', 'tabs', 'layouts', 'agents'):
                assert value[key] == before[key], f'unexpected output/refresh change: {key}'
            pane, original = value['panes'][0], before['panes'][0]
            for key in ('pane_id', 'terminal_id', 'workspace_id', 'tab_id', 'focused', 'agent', 'agent_status'):
                assert (key in pane, pane.get(key)) == (key in original, original.get(key)), f'unexpected pane change: {key}'
            assert pane['scroll']['offset_from_bottom'] == original['scroll']['offset_from_bottom'] == 0
            assert pane['scroll']['viewport_rows'] == original['scroll']['viewport_rows']
        assert int((run.root/'shell.input.bytes').read_text()) == 0
        record = {'snapshot_calls': len(snapshots) + 1, 'synthetic_osc_title_observed': True,
                  'native_pane_updated_observed': True, 'focus_and_agent_unchanged': True,
                  'viewport_offset_unchanged': True, 'synthetic_pty_input_bytes': 0,
                  'metadata_changes_are_expected': ['terminal_title', 'title', 'revision', 'scroll.max_offset_from_bottom'],
                  'request_caused_title_sync_not_distinguishable_from_native_loop': True,
                  'not_covered': ['active_ui', 'real_agent', 'notifications']}
        run.save('title-observation.json', record)
        return record
    finally:
        close_channel(run, channel)


def execute(binary, output):
    """每个边界独立启动全新实例；失败原样归档且返回非零。"""
    output = Path(output)
    assert output.is_absolute() and not output.exists() and not output.is_relative_to(Path(__file__).resolve().parents[2])
    output.mkdir(mode=0o700)
    success, control_passed, cases = True, False, []
    for label, action in [('blocked-write-control', blocked_write_control),
                          # 将本次独立实例限定为精确 512 条保留窗实验。
                          ('retained-512', lambda run: retained_boundary(run, 512)),
                          # 将本次独立实例限定为精确 513 条溢出实验。
                          ('lost-513', lambda run: retained_boundary(run, 513)),
                          ('concurrent-snapshot', concurrent_snapshot), ('title-snapshot', title_snapshot)]:
        run = Run(binary, output/label)
        run.report['readonly_verifier_sha256'] = sha(Path(__file__).read_bytes())
        run.report['backpressure_control_passed'] = control_passed

        def scenario():
            """边界推论依赖同设置的真实背压对照，其失败时不得宣称精确边界。"""
            if label in ('retained-512', 'lost-513'):
                assert control_passed, 'native backpressure control was not established'
            return action(run)

        try:
            # 标题场景先安装自己的合成 shell，其它场景沿用普通隔离实例启动。
            startup = (lambda: start_title_fixture(run)) if label == 'title-snapshot' else run.start
            for name, function in [('installed-contract', run.installed_contract), ('startup', startup),
                                   ('baseline', run.baseline), ('synthetic-fixture', run.seed),
                                   (label, scenario)]:
                run.check(name, function)
                if run.report['checks'][-1]['status'] != 'passed':
                    break
        finally:
            run.finish()
        passed = len(run.report['checks']) == 5 and all(c['status'] == 'passed' for c in run.report['checks'])
        passed = passed and run.report['cleanup']['temporary_root_removed'] and run.report['cleanup']['supervisor_exited']
        passed = passed and not run.report['cleanup']['remaining_tracked_children']
        if label == 'blocked-write-control':
            control_passed = passed
        cases.append({'name': label, 'passed': passed})
        success = success and passed
    summary = output/'readonly-results.json'
    summary.write_text(json.dumps({'native_run': True, 'production_allowlist': [], 'passed': success,
                                   'cases': cases, 'verifier_sha256': sha(Path(__file__).read_bytes())}, indent=2) + '\n')
    summary.chmod(0o600)
    return 0 if success else 1


def main():
    """仅接受显式 binary 与 checkout 外的新证据目录。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    return execute(args.binary, args.output)


if __name__ == '__main__':
    raise SystemExit(main())
