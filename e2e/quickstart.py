#!/usr/bin/env python3
"""按 Quick Start 在真实终端（pty）里从零完成 Gateway + Connector 首次配对和 Herdr 原生初始化。

只依赖 Python 3 标准库。两个角色各用独立 HOME、真实 TTY、真实产物；Herdr 通过 PATH 被自动发现。
就绪后把 MCP 连接信息写入 <work>/mcp.json，并可选执行 --then 命令（环境变量 MCP_CONFIG 指向该文件），
结束时优雅停止两个角色。

用法：python3 e2e/quickstart.py --binary /path/rovloom --herdr /path/herdr-0.9.5 [--work DIR] [--then 'cmd ...']
"""
import argparse, fcntl, json, os, pty, re, select, shlex, shutil, signal, subprocess, sys, tempfile, termios, time

ANSI = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\r')
CODE = re.compile(r'm_[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+')


class Term:
    """子进程独占一个 pty 并成为其控制终端，等价于用户开的一个真实本地终端。"""

    def __init__(self, name, cmd, env, cwd):
        self.name, self.buf, self.log = name, b'', b''
        self.master, slave = pty.openpty()
        self.child = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=cwd,
                                      start_new_session=True,
                                      preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
        os.close(slave)

    def pump(self, timeout=0.2):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if select.select([self.master], [], [], 0.05)[0]:
                try:
                    data = os.read(self.master, 4096)
                except OSError:
                    return
                if not data:
                    return
                self.buf += data
                self.log += data

    def text(self):
        return ANSI.sub(b'', self.buf).decode('utf8', 'replace')

    def expect(self, marker, timeout=30):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump(0.2)
            clean = self.text()
            if marker in clean:
                self.buf = b''
                return clean
            if self.child.poll() is not None:
                raise RuntimeError(f'{self.name} exited {self.child.returncode} before {marker!r}: {clean[-600:]}')
        raise RuntimeError(f'{self.name} timeout waiting {marker!r}; tail: {self.text()[-600:]}')

    def send(self, text):
        os.write(self.master, text.encode())

    def stop(self):
        if self.child.poll() is None:
            self.child.send_signal(signal.SIGTERM)
            try:
                self.child.wait(10)
            except subprocess.TimeoutExpired:
                self.child.kill()


def redact(text):
    text = CODE.sub('<CODE>', text)
    return re.sub(r'(Bearer \(private\): )\S+', r'\1<SECRET>', text).strip()[-1000:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--binary', required=True)
    ap.add_argument('--herdr', help='官方 herdr 0.9.5 可执行文件')
    ap.add_argument('--luvus', help='官方 luvus 0.14.3 可执行文件（与 --herdr 二选一；走默认的 Luvus 引导）')
    ap.add_argument('--work', help='工作目录（需位于祖先不可被其它用户写入的位置；默认 ~/.rq-*）')
    ap.add_argument('--then', help='就绪后执行的命令，环境变量 MCP_CONFIG 指向连接信息')
    args = ap.parse_args()
    if bool(args.herdr) == bool(args.luvus):
        ap.error('exactly one of --herdr / --luvus is required')
    work = os.path.abspath(args.work or tempfile.mkdtemp(prefix='.rq-', dir=os.path.expanduser('~')))
    os.makedirs(work, mode=0o700, exist_ok=True)
    home_g, home_c, tools, herdr_dir = (os.path.join(work, n) for n in ('g', 'c', 'bin', 'hb'))
    for d in (home_g, home_c, tools, herdr_dir):
        os.makedirs(d, mode=0o700, exist_ok=True)
    rov = os.path.join(tools, 'rovloom')
    shutil.copy(args.binary, rov); os.chmod(rov, 0o755)
    source, name = (args.herdr, 'herdr') if args.herdr else (args.luvus, 'luvus')
    shutil.copy(source, os.path.join(herdr_dir, name)); os.chmod(os.path.join(herdr_dir, name), 0o700)
    base = {'LANG': 'C.UTF-8', 'TERM': 'xterm'}
    env_g = {**base, 'HOME': home_g, 'PATH': '/usr/bin:/bin'}
    # Connector 的 PATH 里有 herdr 所在目录：不写 runtime_bin_dirs，验证默认从 PATH 发现程序。
    env_c = {**base, 'HOME': home_c, 'PATH': f'{herdr_dir}:/usr/bin:/bin'}
    terms = []
    try:
        # 首次启动让 Connector 自动创建用户文件；再按文档在原生批准前选择 Herdr。
        first = Term('connector0', [rov, 'connector'], env_c, home_c); first.expect('Gateway address'); first.stop()
        path = os.path.join(home_c, '.config', 'rovloom', 'connector.json')
        cfg = json.load(open(path))
        if args.herdr:
            cfg['native'] = {'provider': 'herdr'}
        else:
            # Luvus 的状态路径上限 52 字节（Unix socket 限制），默认数据目录太长，按文档改用短路径。
            cfg['data'] = {'directory': os.path.join(work, 'd')}
        open(path, 'w').write(json.dumps(cfg, indent=2) + '\n'); os.chmod(path, 0o600)

        gateway = Term('gateway', [rov, 'gateway'], env_g, home_g); terms.append(gateway)
        gateway.expect('Pair one Connector'); gateway.send('y\n')
        code = CODE.search(gateway.expect('Gateway address and code')).group(0)
        connector = Term('connector', [rov, 'connector'], env_c, home_c); terms.append(connector)
        connector.expect('Gateway address'); connector.send('ws://127.0.0.1:9443\n')
        connector.expect('配对码'); connector.send(code + '\n')
        deadline, ready = time.time() + 180, False
        while time.time() < deadline and not ready:
            connector.pump(1.0); gateway.pump(0.3)
            for term in (connector, gateway):
                text = term.text()
                if text.strip().endswith('[y/N]'):
                    print(f'[{term.name}]', redact(text), '\n  -> y', flush=True)
                    term.buf = b''; term.send('y\n')
            if 'connector_ready' in ANSI.sub(b'', gateway.log).decode('utf8', 'replace') and \
               'provider_ready=true' in ANSI.sub(b'', connector.log).decode('utf8', 'replace'):
                ready = True
            for term in (connector, gateway):
                if term.child.poll() is not None:
                    raise RuntimeError(f'{term.name} exited {term.child.returncode}: {redact(term.text())}')
        if not ready:
            raise RuntimeError('timeout waiting for connector_ready')
        log = ANSI.sub(b'', gateway.log).decode('utf8', 'replace')
        info = {'url': re.search(r'MCP URL: (\S+)', log).group(1),
                'token': re.search(r'Bearer \(private\): (\S+)', log).group(1),
                'targets': json.loads(re.search(r'Targets: (\[.*\])', log).group(1))}
        out = os.path.join(work, 'mcp.json')
        open(out, 'w').write(json.dumps(info)); os.chmod(out, 0o600)
        print('READY', json.dumps({'mcp_url': info['url'], 'targets': info['targets'], 'config': out}), flush=True)
        status = 0
        if args.then:
            status = subprocess.call(shlex.split(args.then), env={**os.environ, 'MCP_CONFIG': out})
            if status != 0:
                connector.pump(1.0); gateway.pump(0.3)
                print('--- gateway tail ---\n' + ANSI.sub(b'', gateway.log).decode('utf8', 'replace')[-1800:], flush=True)
                print('--- connector tail ---\n' + ANSI.sub(b'', connector.log).decode('utf8', 'replace')[-2500:], flush=True)
        sys.exit(status)
    finally:
        for term in reversed(terms):
            term.stop()


if __name__ == '__main__':
    main()
