# 在全新受控 Herdr 实例核对固定二进制与契约，采集原生边界和清理证据，不授予产品执行许可。
"""在获授权的全新临时实例验证固定 Herdr；写入只用于本次合成 pane/事件。

不接入已有会话，不读取用户 HOME，不下载/升级 binary，不签发产品执行许可。
原始协议、schema、退出与清理记录仅写到指定的 checkout 外私有输出目录。
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import traceback

from contract import ROOT as REPO, Rejected, frame, require, schema_closure, sha, StateRebuild


PIN = json.loads((REPO/'test/fixtures/herdr/0.9.5/provenance.json').read_text())
LIMIT = 1024 * 1024


# 把请求或记录编码为以换行结束的紧凑 JSON 原文字节。
def encoded(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


# 校验原生重命名事件的标签、数据类型和自建 workspace 身份，返回未改写的事件。
def lifecycle_event(raw, workspace_id):
    event = frame(raw)
    data = event.get('data')
    require(event.get('event') == 'workspace_renamed' and type(data) is dict and
            data.get('type') == 'workspace_renamed' and data.get('workspace_id') == workspace_id and
            isinstance(data.get('label'), str), 'native lifecycle event context mismatch')
    return event


# 核对 Linux 本地可执行文件的规范路径、所有权、写权限及大小，再匹配已评审官方摘要。
def validate_binary(binary, pin):
    require(sys.platform == 'linux', 'native verification currently requires Linux')
    path = Path(binary)
    require(path.is_absolute() and path == path.resolve() and not path.is_symlink(), 'canonical absolute binary required')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        status = os.fstat(stream.fileno())
        require(stat.S_ISREG(status.st_mode) and status.st_nlink == 1 and status.st_uid == os.getuid() and
                status.st_mode & 0o022 == 0 and status.st_mode & 0o100 and status.st_size <= 64*LIMIT,
                'unsafe binary file')
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    require(digest == pin['binary_sha256'], 'binary differs from reviewed official pin')
    return path


class Run:
    # 拒绝关闭断言的运行，校验二进制 pin 和全新外部输出，建立私有 HOME/XDG 根及最小环境。
    def __init__(self, binary, output):
        if sys.flags.optimize:
            raise Rejected('native verification requires enabled assertions')
        self.binary = validate_binary(binary, PIN)
        self.out = Path(output)
        require(self.out.is_absolute() and self.out == self.out.resolve() and not self.out.exists(), 'fresh canonical absolute output required')
        require(not self.out.is_relative_to(REPO), 'native output must be outside checkout')
        self.out.mkdir(mode=0o700)
        self.root = Path(tempfile.mkdtemp(prefix='rh-'))
        self.root.chmod(0o700)
        for name in ('h', 'c', 's', 'k', 't', 'w'):
            (self.root / name).mkdir(mode=0o700)
        self.env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.root/'h'), 'XDG_CONFIG_HOME': str(self.root/'c'),
                    'XDG_STATE_HOME': str(self.root/'s'), 'XDG_CACHE_HOME': str(self.root/'k'),
                    'TMPDIR': str(self.root/'t'), 'TERM': 'xterm-256color', 'SHELL': '/bin/sh', 'LANG': 'C.UTF-8'}
        self.session = 'p0h-native'
        self.endpoint = self.root / 'c/herdr/sessions' / self.session / 'herdr.sock'
        self.process = None
        self.server_pid = None
        self.sockets = []
        self.binary_sha256 = PIN['binary_sha256']
        self.counter = 0
        self.owned = set()
        self.flood_trace = None
        self.children_cleaned = False
        self.report = {'native_run': True, 'production_allowlist': [], 'checks': [], 'source': PIN,
                       'root': str(self.root), 'verifier_sha256': sha(Path(__file__).read_bytes())}

    # 保存原始字节或 JSON 记录，并把输出文件权限收窄为仅当前用户可读写。
    def save(self, name, data):
        path = self.out / name
        path.write_bytes(data if isinstance(data, bytes) else (json.dumps(data, indent=2) + '\n').encode())
        path.chmod(0o600)

    # 运行固定二进制的版本和 schema 导出，保存原文并核对 pin 与离线引用闭包，不授予许可。
    def installed_contract(self):
        records = []
        for label, args in [('version', ['--version']), ('schema', ['api', 'schema', '--json'])]:
            process = subprocess.run([str(self.binary), *args], env=self.env, cwd=self.root/'w',
                                     capture_output=True, timeout=15, umask=0o077)
            self.save(label + '.stdout', process.stdout)
            self.save(label + '.stderr', process.stderr)
            records.append({'argv': ['herdr', *args], 'exit_code': process.returncode,
                            'stdout_sha256': sha(process.stdout), 'stdout_bytes': len(process.stdout),
                            'stderr_bytes': len(process.stderr)})
            assert process.returncode == 0, 'installed CLI command failed'
        self.report['commands'] = records
        assert (self.out/'version.stdout').read_text().strip() == 'herdr ' + PIN['version']
        raw = (self.out/'schema.stdout').read_bytes()
        assert sha(raw) == PIN['schema_sha256'], 'installed schema differs from reviewed pin'
        schema = json.loads(raw)
        assert schema['protocol'] == PIN['protocol'] and schema['schema_version'] == PIN['schema_version']
        closure = schema_closure({'schema.json': raw}, 'schema.json')
        return {'binary_sha256': self.binary_sha256, 'schema_sha256': sha(raw), 'closure': closure,
                'schema_documents': sorted(schema['schemas']), 'production_permission': False}

    # 调用单项验证回调，保留失败状态及异常回溯，持续写出报告供后续总体验收判定。
    def check(self, name, function):
        started = time.monotonic()
        try:
            value = function()
            self.report['checks'].append({'name': name, 'status': 'passed', 'value': value,
                                          'seconds': round(time.monotonic() - started, 4)})
        except Exception as error:
            self.report['checks'].append({'name': name, 'status': 'failed', 'error': type(error).__name__ + ': ' + str(error),
                                          'seconds': round(time.monotonic() - started, 4)})
            self.save('failure-' + name + '.txt', traceback.format_exc().encode())
        self.save('native-results.json', self.report)
        print(name + ': ' + self.report['checks'][-1]['status'], flush=True)

    # 配置仅计数输入的合成终端并关闭更新和 agent 恢复，设置子进程回收后监管启动新会话。
    def start(self):
        config = self.root / 'c/herdr/config.toml'
        config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        helper = self.root / 'synthetic-shell'
        helper.write_text('#!/usr/bin/python3 -I\nimport os,signal,tty\n'
                          'signal.signal(signal.SIGHUP,signal.SIG_DFL)\n'
                          'tty.setraw(0)\n'
                          'open(' + repr(str(self.root/'shell.pid')) + ',"w").write(str(os.getpid()))\n'
                          'p=' + repr(str(self.root/'shell.input.bytes')) + '\nn=0\nopen(p,"w").write("0")\n'
                          'os.write(1,b"synthetic p0h terminal ready\\r\\n")\n'
                          'while True:\n b=os.read(0,1024)\n if not b: break\n n+=len(b)\n open(p,"w").write(str(n))\n')
        helper.chmod(0o700)
        config.write_text('onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n'
                          f'[terminal]\ndefault_shell = "{helper}"\nshell_mode = "non_login"\nnew_cwd = "current"\n'
                          '[session]\nresume_agents_on_restore = false\n[server]\nheadless_cols = 80\nheadless_rows = 24\n')
        config.chmod(0o600)
        self.save('test-config.toml', config.read_bytes())
        self.env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CEILING_DIRECTORIES': str(self.root)})
        assert sha(self.binary.read_bytes()) == self.binary_sha256
        # 仅当前测试进程接管自己的孤儿子进程，不创建系统服务或持久权限。
        require(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0, 'local child reaper unavailable')
        stdout = open(self.out / 'server.stdout', 'wb')
        stderr = open(self.out / 'server.stderr', 'wb')
        try:
            os.fchmod(stdout.fileno(), 0o600)
            os.fchmod(stderr.fileno(), 0o600)
            self.process = subprocess.Popen([str(self.binary), '--session', self.session, 'server'], env=self.env, cwd=self.root/'w',
                                            stdout=stdout, stderr=stderr, start_new_session=True, umask=0o077)
            self.server_pid = self.process.pid
        finally:
            stdout.close()
            stderr.close()
        deadline = time.monotonic() + 10
        while not self.endpoint.exists():
            assert self.process.poll() is None, 'native server exited during startup'
            assert time.monotonic() < deadline, 'native socket startup timeout'
            time.sleep(0.02)
        self.report['argv'] = ['herdr', '--session', self.session, 'server']
        self.report['native_pid'] = self.process.pid
        return {'socket_created': True, 'environment_keys': sorted(self.env), 'inherited_credentials': False}

    # 核对私有 socket 路径与权限，并验证内核对端 UID/GID 和直属原生进程 PID 后登记连接。
    def connect(self):
        assert self.endpoint.is_absolute() and str(self.endpoint).startswith(str(self.root) + '/')
        for parent in [self.endpoint, *self.endpoint.parents]:
            if parent == self.root.parent:
                break
            status = parent.lstat()
            assert not stat.S_ISLNK(status.st_mode) and status.st_uid == os.getuid()
            assert not status.st_mode & 0o022
        status = self.endpoint.stat()
        assert stat.S_ISSOCK(status.st_mode) and stat.S_IMODE(status.st_mode) == 0o600
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        channel.settimeout(6)
        try:
            channel.connect(str(self.endpoint))
            pid, uid, gid = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            assert uid == os.getuid() and gid == os.getgid()
            assert pid == self.process.pid, 'peer PID differs from directly supervised native process'
            if self.server_pid is not None:
                assert self.server_pid == pid
        except BaseException:
            channel.close()
            raise
        self.server_pid = pid
        self.report['endpoint'] = {'transport': 'unix_socket', 'path': str(self.endpoint), 'uid': status.st_uid,
                                   'mode': oct(stat.S_IMODE(status.st_mode)), 'dev': status.st_dev, 'ino': status.st_ino,
                                   'peer_pid': pid, 'peer_uid': uid, 'peer_gid': gid,
                                   'launched_binary_sha256': self.binary_sha256}
        self.sockets.append(channel)
        return channel

    # 逐字节读取至 LF 或 EOF，在给定大小上限内返回原始字节；超时继续向外传播。
    def read_line(self, channel, ceiling=2*LIMIT):
        data = bytearray()
        while not data.endswith(b'\n'):
            chunk = channel.recv(1)
            if not chunk:
                break
            data.extend(chunk)
            assert len(data) <= ceiling, 'native response exceeded capture bound'
        return bytes(data)

    # 仅向本次实例发送限定候选请求或自建 workspace 操作，核对响应关联并确保连接关闭。
    def request(self, method, params, label=None):
        # create/rename 仅生成本次新建 workspace 的合成事件，不是产品允许集。
        assert method in ('ping', 'session.snapshot', 'workspace.create', 'workspace.rename')
        if method == 'workspace.create':
            assert params == {'cwd': str(self.root/'w'), 'label': 'synthetic-p0h', 'focus': False}
        elif method == 'workspace.rename':
            assert params['workspace_id'] in self.owned and set(params) == {'workspace_id', 'label'}
        else:
            assert params == {}
        self.counter += 1
        request = {'id': f'p0h-{self.counter}', 'method': method, 'params': params}
        raw = encoded(request)
        channel = self.connect()
        try:
            channel.sendall(raw)
            response_raw = self.read_line(channel)
            if self.flood_trace is not None:
                self.flood_trace.write(raw + response_raw)
            response = json.loads(response_raw)
            assert response['id'] == request['id']
            assert ('result' in response) != ('error' in response)
            if label:
                self.save(label + '.request.jsonl', raw); self.save(label + '.response.jsonl', response_raw)
            return response
        finally:
            channel.close(); self.sockets.remove(channel)

    # 核对实例版本和协议与 pin 一致，确认全新会话无既有工作且重复空快照一致。
    def baseline(self):
        ping = self.request('ping', {}, 'ping')
        assert ping['result']['version'] == PIN['version'] and ping['result']['protocol'] == PIN['protocol']
        snapshot = self.request('session.snapshot', {}, 'snapshot-initial')['result']['snapshot']
        assert snapshot['version'] == PIN['version'] and snapshot['protocol'] == PIN['protocol']
        assert snapshot['workspaces'] == [], 'new headless session unexpectedly has existing work'
        again = self.request('session.snapshot', {}, 'snapshot-repeat')['result']['snapshot']
        assert snapshot == again
        return {'version': ping['result']['version'], 'protocol': ping['result']['protocol'],
                'empty_instance': True, 'repeat_snapshot_equal': True, 'capabilities': ping['result'].get('capabilities')}

    # 探测畸形、重复键及长度边界和缺 LF 输入；超时记失败，超限仅接受错误或断连证据。
    def framing(self):
        results = []
        for label, raw, expect in [
            ('invalid-request', b'{"id":"invalid","method":"session.snapshot","params":7}\n', 'error'),
            ('duplicate-id', b'{"id":"a","id":"b","method":"ping","params":{}}\n', 'error'),
            *[('limit-' + str(n), b'{"id":"size","method":"ping","params":{}}' +
               b' '*(n-len(b'{"id":"size","method":"ping","params":{}}')-1) + b'\n',
               'pong' if n <= LIMIT+1 else 'rejected') for n in (LIMIT-1, LIMIT, LIMIT+1, LIMIT+2)],
        ]:
            channel = self.connect(); data = b''; failure = None
            # 超时没有原生拒绝证据，向外传播并由 check 记为失败。
            try:
                channel.sendall(raw)
                data = self.read_line(channel)
            except (BrokenPipeError, ConnectionResetError) as error:
                failure = type(error).__name__
            finally:
                channel.close(); self.sockets.remove(channel)
            self.save(label + '.request.raw', raw); self.save(label + '.response.raw', data)
            value = json.loads(data) if data else None
            if expect == 'error':
                assert value and 'error' in value
            elif expect == 'pong':
                assert value and value.get('result', {}).get('type') == 'pong'
            elif expect == 'rejected':
                assert value is None or 'error' in value, 'oversized frame was accepted'
            results.append({'label': label, 'request_bytes': len(raw), 'response': value, 'transport_error': failure})
        channel = self.connect()
        raw = b'{"id":"partial","method":"ping","params":{}}\n'
        try:
            channel.sendall(raw[:-1]); channel.settimeout(0.15)
            try:
                unexpected = channel.recv(1)
                assert False, 'partial line unexpectedly completed: ' + repr(unexpected)
            except socket.timeout:
                pass
            channel.settimeout(6); channel.sendall(b'\n')
            answer = self.read_line(channel)
            assert json.loads(answer)['result']['type'] == 'pong'
            self.save('partial.response.jsonl', answer)
        finally:
            channel.close(); self.sockets.remove(channel)
        self.request('ping', {}, 'ping-after-framing')
        return {'cases': results, 'native_limit_excludes_trailing_lf': True,
                'partial_line_waited_for_newline': True, 'server_survived': True}

    # 创建合成 workspace 与 pane，比较被动请求前后快照及 PTY 输入计数，范围限于可观察状态。
    def seed(self):
        response = self.request('workspace.create', {'cwd': str(self.root/'w'), 'label': 'synthetic-p0h', 'focus': False}, 'seed-workspace')
        assert 'result' in response, response
        workspace = response['result']['workspace']
        wid = workspace['workspace_id']; self.owned.add(wid)
        self.workspace_id = wid
        deadline = time.monotonic() + 3
        while not (self.root/'shell.input.bytes').exists():
            assert time.monotonic() < deadline, 'synthetic shell did not initialize'
            time.sleep(0.02)
        snapshot = self.request('session.snapshot', {}, 'snapshot-seeded')['result']['snapshot']
        assert len(snapshot['workspaces']) == 1 and len(snapshot['panes']) == 1
        self.pane_id = snapshot['panes'][0]['pane_id']
        input_before = int((self.root/'shell.input.bytes').read_text())
        before = self.request('session.snapshot', {}, 'snapshot-passive-before')['result']['snapshot']
        time.sleep(0.2)
        self.request('ping', {}, 'ping-passive')
        after = self.request('session.snapshot', {}, 'snapshot-passive-after')['result']['snapshot']
        assert before == after, 'passive candidate changed observable seeded snapshot'
        input_after = int((self.root/'shell.input.bytes').read_text())
        assert input_before == input_after == 0, 'passive candidate wrote synthetic PTY input'
        return {'workspace_id': wid, 'pane_id': self.pane_id, 'no_input_or_agent_calls': True,
                'before_after_snapshot_equal': True, 'synthetic_pty_input_bytes': input_after}

    # 订阅 workspace 重命名事件，保存请求和原生确认并返回已登记的长连接。
    def subscribe(self, label):
        channel = self.connect()
        request = {'id': label, 'method': 'events.subscribe', 'params': {'subscriptions': [{'type': 'workspace.renamed'}]}}
        channel.sendall(encoded(request))
        raw = self.read_line(channel); response = json.loads(raw)
        self.save(label + '.request.jsonl', encoded(request)); self.save(label + '.ack.jsonl', raw)
        assert response == {'id': label, 'result': {'type': 'subscription_started'}}
        return channel

    # 验证订阅确认后收到自建资源事件、另一连接可读快照，以及客户端断开后可重新订阅。
    def lifecycle(self):
        channel = self.subscribe('subscription-lifecycle')
        self.request('workspace.rename', {'workspace_id': self.workspace_id, 'label': 'synthetic-after-subscribe'}, 'rename-one')
        raw = self.read_line(channel)
        lifecycle_event(raw, self.workspace_id)
        self.save('lifecycle.event.jsonl', raw)
        snapshot = self.request('session.snapshot', {}, 'snapshot-other-connection')['result']['snapshot']
        channel.close(); self.sockets.remove(channel)
        replacement = self.subscribe('subscription-after-eof')
        replacement.close(); self.sockets.remove(replacement)
        self.request('ping', {}, 'ping-after-subscription-eof')
        return {'ack_verified': True, 'event_verified': True, 'snapshot_other_connection': True,
                'snapshot_workspace_count': len(snapshot['workspaces']), 'client_eof_and_resubscribe': True}

    # 积压自建重命名事件，要求真实 events_lost 与 EOF，再验证新订阅和整份快照的串行重建。
    def overflow(self):
        channel = self.subscribe('subscription-overflow')
        started = time.monotonic()
        generated = 0
        with (self.out/'overflow-generator.jsonl').open('wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            self.flood_trace = stream
            for index in range(1200):
                if time.monotonic() - started > 3.5:
                    break
                params = {'workspace_id': self.workspace_id, 'label': f'p0h-{index:04d}-' + 'x'*1024}
                response = self.request('workspace.rename', params)
                assert 'result' in response
                generated += 1
        self.flood_trace = None
        elapsed = time.monotonic() - started
        received, lost, eof, total = 0, None, False, 0
        with (self.out/'overflow.stream.jsonl').open('wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            while received < 1600:
                try:
                    raw = self.read_line(channel)
                except socket.timeout:
                    break
                if not raw:
                    eof = True; break
                stream.write(raw); total += len(raw)
                assert total <= 4*LIMIT
                value = json.loads(raw)
                received += 1
                if 'error' in value:
                    lost = value
                    trailing = channel.recv(1)
                    eof = trailing == b''
                    break
        channel.close(); self.sockets.remove(channel)
        record = {'generated': generated, 'generation_seconds': elapsed, 'received_lines': received,
                  'received_bytes': total, 'native_error': lost, 'eof': eof}
        self.save('overflow-observation.json', record)
        assert generated > 512, 'did not exceed source retained-event window'
        assert lost and lost['id'] == 'subscription-overflow' and lost['error']['code'] == 'events_lost', record
        assert eof, 'events_lost was not followed by EOF'
        replacement = self.subscribe('subscription-after-loss')
        model = StateRebuild()
        model.subscribe('old'); model.acknowledge('old'); model.gap('old')
        model.subscribe('replacement'); model.acknowledge('replacement')
        ticket = model.begin_snapshot('separate-snapshot-connection')
        snapshot = self.request('session.snapshot', {}, 'snapshot-after-loss')['result']['snapshot']
        expected = f'p0h-{generated-1:04d}-' + 'x'*1024
        assert snapshot['workspaces'][0]['label'] == expected, 'rebuild did not contain final native state'
        self.request('workspace.rename', {'workspace_id': self.workspace_id, 'label': 'p0h-dirty-refresh'}, 'rename-during-refresh')
        event_raw = self.read_line(replacement)
        lifecycle_event(event_raw, self.workspace_id)
        self.save('rebuild-invalidation.event.jsonl', event_raw)
        model.invalidate('replacement')
        assert model.finish_snapshot(ticket, snapshot)['refresh_again']
        ticket = model.begin_snapshot('second-snapshot-connection')
        current = self.request('session.snapshot', {}, 'snapshot-dirty-refresh')['result']['snapshot']
        assert current['workspaces'][0]['label'] == 'p0h-dirty-refresh'
        state = model.finish_snapshot(ticket, current)
        assert not state['refresh_again'] and state['gap_seen'] and model.cache == current
        replacement.close(); self.sockets.remove(replacement)
        return {**record, 'resubscribe_and_other_connection_snapshot': True, 'guarantee': 'state_rebuild_only',
                'dirty_refresh_verified': True, 'whole_snapshot_replacement_verified': True}

    # 记录合成子进程后杀死本次监管的原生进程，核对订阅仅返回 EOF 并回收子进程。
    def process_eof(self):
        channel = self.subscribe('subscription-process-exit')
        tracked = self.fixture_children()
        self.report['owned_children_before_fault'] = tracked
        self.process.kill()
        raw = self.read_line(channel)
        channel.close(); self.sockets.remove(channel)
        assert raw == b'', 'process loss fabricated a response'
        self.process.wait(timeout=5)
        self.report['native_forced_exit_code'] = self.process.returncode
        self.cleanup_children(tracked)
        return {'actual_eof': True, 'no_native_result': True, 'forced_own_process_only': True}

    # 只从本次合成终端写入的 PID 文件提取待回收子进程，不扫描其它进程来源。
    def fixture_children(self):
        path = self.root / 'shell.pid'
        return {int(path.read_text()): 'trusted_synthetic_fixture'} if path.exists() else {}

    # 等待或终止已登记合成子进程，再回收本进程可等待的子进程并记录尚未确认退出的状态。
    def cleanup_children(self, tracked):
        outcomes = []
        for pid in tracked:
            try:
                result, status = os.waitpid(pid, os.WNOHANG)
                if result == 0:
                    os.kill(pid, signal.SIGTERM)
                    deadline = time.monotonic() + 2
                    while result == 0 and time.monotonic() < deadline:
                        time.sleep(0.02)
                        result, status = os.waitpid(pid, os.WNOHANG)
                    if result == 0:
                        os.kill(pid, signal.SIGKILL)
                        result, status = os.waitpid(pid, 0)
                outcomes.append({'pid':pid,'reaped':result==pid})
            except ChildProcessError:
                outcomes.append({'pid':pid,'not_waitable':True})
        remaining = False
        for _ in range(50):
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    remaining = True
                    time.sleep(0.02)
                else:
                    remaining = False
            except ChildProcessError:
                remaining = False
                break
        self.report['synthetic_children_cleanup'] = outcomes
        self.report['tracked_children_remaining'] = ['waitable_child_unconfirmed'] if remaining else []
        self.children_cleaned = True

    # 关闭连接并停止监管进程、回收子进程，复制日志后删除临时根并保存清理摘要；复制失败仍报错。
    def finish(self):
        self.flood_trace = None
        for channel in self.sockets:
            channel.close()
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if self.server_pid:
                    try: os.kill(self.server_pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                self.process.kill(); self.process.wait(timeout=5)
        if not self.children_cleaned:
            self.cleanup_children(self.fixture_children())
        copy_error = None
        try:
            for path in self.root.rglob('*.log'):
                if path.is_file():
                    destination = self.out / ('runtime-' + path.name)
                    shutil.copyfile(path, destination); destination.chmod(0o600)
        except OSError as error:
            copy_error = type(error).__name__
        finally:
            shutil.rmtree(self.root)
            self.report['cleanup'] = {'temporary_root_removed': not self.root.exists(),
                                      'supervisor_exited': not self.process or self.process.poll() is not None,
                                      'remaining_tracked_children': self.report.get('tracked_children_remaining', [])}
        if copy_error:
            self.report['evidence_copy_error'] = copy_error
        self.report['files_sha256'] = {path.name: sha(path.read_bytes()) for path in sorted(self.out.iterdir())
                                       if path.is_file() and path.name != 'native-results.json'}
        self.save('native-results.json', self.report)
        if copy_error:
            raise OSError('runtime evidence copy failed after cleanup')


# 按依赖顺序执行八项原生验证，关键前置失败时停止后续阶段，收尾后仅在全部检查与清理通过时成功。
def execute(binary, output):
    run = Run(binary, output)
    try:
        for name, action in [('installed-contract', run.installed_contract), ('startup', run.start),
                             ('native-baseline', run.baseline), ('framing', run.framing),
                             ('synthetic-pane-and-passive-snapshot', run.seed), ('subscription-lifecycle', run.lifecycle),
                             ('events-lost', run.overflow), ('native-process-eof', run.process_eof)]:
            run.check(name, action)
            if name in ('installed-contract', 'startup', 'native-baseline', 'synthetic-pane-and-passive-snapshot') and run.report['checks'][-1]['status'] != 'passed':
                break
    finally:
        run.finish()
    passed = len(run.report['checks']) == 8 and all(item['status'] == 'passed' for item in run.report['checks'])
    passed = passed and run.report['cleanup']['temporary_root_removed'] and run.report['cleanup']['supervisor_exited']
    passed = passed and not run.report['cleanup']['remaining_tracked_children']
    return 0 if passed else 1


# 读取固定本地二进制与外部输出参数，执行验证并用异常类型报告预期的入口拒绝。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        return execute(args.binary, args.output)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({'native_verification': 'rejected', 'error_type': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
