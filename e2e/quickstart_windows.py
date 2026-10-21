#!/usr/bin/env python3
"""Windows 上按 Quick Start 在真实控制台（ConPTY）里从零完成 Gateway + Connector 首次配对，并附着官方 Herdr。

依赖 pywinpty（pip install pywinpty）。两个角色各用独立的用户目录（USERPROFILE/APPDATA/LOCALAPPDATA）和真实 ConPTY，
Herdr 通过 PATH 被自动发现。就绪后把 MCP 连接信息写入 <work>\\mcp.json，并可选执行 --then 命令
（环境变量 MCP_CONFIG 指向该文件），结束时停止两个角色并清理本次部署用到的 Herdr 进程。

用法：python e2e\\quickstart_windows.py --binary C:\\path\\rovloom.exe --herdr-dir C:\\path\\herdr-dir [--then "cmd ..."]
"""
import argparse, json, os, queue, re, shlex, shutil, subprocess, sys, tempfile, threading, time

from winpty import PtyProcess

# 提示是中英双语；Windows 的默认控制台编码打印不了中文。
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r')
CODE = re.compile(r'm_[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+')


class Term:
    """子进程独占一个 ConPTY（等价于用户开的一个真实本地控制台）；后台线程持续收集输出。"""

    def __init__(self, name, cmd, env, cwd):
        self.name, self.buf, self.log = name, '', ''
        self.lock = threading.Lock()
        self.proc = PtyProcess.spawn(cmd, cwd=cwd, env=env, dimensions=(50, 220))
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            try:
                data = self.proc.read(4096)
            except EOFError:
                return
            except Exception:
                return
            if data:
                with self.lock:
                    self.buf += data
                    self.log += data

    def pump(self, timeout=0.2):
        time.sleep(timeout)

    def text(self):
        with self.lock:
            return ANSI.sub('', self.buf)

    def clean_log(self):
        with self.lock:
            return ANSI.sub('', self.log)

    def reset(self):
        with self.lock:
            self.buf = ''

    def alive(self):
        return self.proc.isalive()

    def expect(self, marker, timeout=60):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            clean = self.text()
            if marker in clean:
                self.reset()
                return clean
            if not self.alive():
                raise RuntimeError(f'{self.name} exited before {marker!r}: {self.clean_log()[-2500:]}')
            time.sleep(0.2)
        raise RuntimeError(f'{self.name} timeout waiting {marker!r}; tail: {self.clean_log()[-2500:]}')

    def send(self, text):
        self.proc.write(text.replace('\n', '\r'))

    def stop(self):
        if self.alive():
            try:
                self.proc.terminate(force=True)
            except Exception:
                pass


def redact(text):
    text = CODE.sub('<CODE>', text)
    return re.sub(r'(Bearer \(private\): )\S+', r'\1<SECRET>', text).strip()[-1000:]


def user_env(home, extra_path):
    system = os.environ.get('SystemRoot', r'C:\Windows')
    return {
        'ROVLOOM_DEBUG_ERRORS': '1',
        'USERPROFILE': home, 'HOME': home,
        'APPDATA': os.path.join(home, 'AppData', 'Roaming'),
        'LOCALAPPDATA': os.path.join(home, 'AppData', 'Local'),
        'TEMP': os.path.join(home, 'AppData', 'Local', 'Temp'), 'TMP': os.path.join(home, 'AppData', 'Local', 'Temp'),
        'SystemRoot': system, 'windir': system, 'ComSpec': os.path.join(system, 'System32', 'cmd.exe'),
        'PATHEXT': '.COM;.EXE;.BAT;.CMD', 'LANG': 'C.UTF-8', 'TERM': 'xterm',
        'PATH': ';'.join([*extra_path, os.path.join(system, 'System32'), system]),
    }


def herdr_servers(herdr_dir):
    """本次部署使用的 herdr server 进程（按可执行文件路径区分），返回 [(pid, 创建时间)]。"""
    script = (
        "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and "
        f"$_.ExecutablePath -ieq '{os.path.join(herdr_dir, 'herdr.exe')}' -and $_.CommandLine -match 'server' }} | "
        "ForEach-Object { \"$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())\" }"
    )
    out = subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', script],
                         capture_output=True, text=True, timeout=60).stdout
    return sorted((int(a), b) for a, b in (line.split() for line in out.splitlines() if line.strip()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--binary', required=True)
    ap.add_argument('--herdr-dir', required=True, help='含 herdr.exe 与 conpty 目录的官方 Herdr 目录')
    ap.add_argument('--work', help='工作目录（默认系统临时目录下新建）')
    ap.add_argument('--then', help='就绪后执行的命令，环境变量 MCP_CONFIG 指向连接信息')
    args = ap.parse_args()
    work = os.path.abspath(args.work or tempfile.mkdtemp(prefix='rq-'))
    os.makedirs(work, exist_ok=True)
    home_g, home_c, tools = (os.path.join(work, n) for n in ('g', 'c', 'bin'))
    for home in (home_g, home_c):
        for sub in ('AppData\\Roaming', 'AppData\\Local\\Temp'):
            os.makedirs(os.path.join(home, sub), exist_ok=True)
    os.makedirs(tools, exist_ok=True)
    rov = os.path.join(tools, 'rovloom.exe')
    shutil.copy(args.binary, rov)
    # 路径信任要求每一级祖先不被宽主体写入：runner 的 D:\\a 对所有人可写，故像真实安装在用户目录那样复制一份。
    herdr_dir = os.path.join(work, 'hb')
    shutil.copytree(os.path.abspath(args.herdr_dir), herdr_dir)
    env_g = user_env(home_g, [])
    # Connector 的 PATH 里有 herdr 所在目录：不写 runtime_bin_dirs，验证默认从 PATH 发现程序。
    env_c = user_env(home_c, [herdr_dir])
    terms = []
    try:
        first = Term('connector0', [rov, 'connector'], env_c, home_c)
        first.expect('Gateway address'); first.stop()
        path = os.path.join(home_c, '.config', 'rovloom', 'connector.json')
        cfg = json.load(open(path, encoding='utf-8'))
        cfg['native'] = {'provider': 'herdr'}
        open(path, 'w', encoding='utf-8').write(json.dumps(cfg, indent=2) + '\n')

        gateway = Term('gateway', [rov, 'gateway'], env_g, home_g); terms.append(gateway)
        gateway.expect('Pair one Connector'); gateway.send('y\n')
        code = CODE.search(gateway.expect('Gateway address and code')).group(0)
        connector = Term('connector', [rov, 'connector'], env_c, home_c); terms.append(connector)
        connector.expect('Gateway address'); connector.send('ws://127.0.0.1:9443\n')
        connector.expect('配对码'); connector.send(code + '\n')
        deadline, ready = time.time() + 240, False
        while time.time() < deadline and not ready:
            time.sleep(1.0)
            for term in (connector, gateway):
                text = term.text()
                if text.strip().endswith('[y/N]'):
                    print(f'[{term.name}]', redact(text), '\n  -> y', flush=True)
                    term.reset(); term.send('y\n')
            if 'connector_ready' in gateway.clean_log() and 'provider_ready=true' in connector.clean_log():
                ready = True
            for term in (connector, gateway):
                if not term.alive():
                    raise RuntimeError(f'{term.name} exited: {redact(term.text())}')
        if not ready:
            raise RuntimeError('timeout waiting for connector_ready; connector tail: ' + redact(connector.clean_log()))
        log = gateway.clean_log()
        info = {'url': re.search(r'MCP URL: (\S+)', log).group(1),
                'token': re.search(r'Bearer \(private\): (\S+)', log).group(1),
                'targets': json.loads(re.search(r'Targets: (\[.*\])', log).group(1))}
        out = os.path.join(work, 'mcp.json')
        open(out, 'w').write(json.dumps(info))
        print('READY', json.dumps({'mcp_url': info['url'], 'targets': info['targets'], 'config': out}), flush=True)
        print('HERDR_SERVERS', herdr_servers(herdr_dir), flush=True)
        status = 0
        if args.then:
            done = subprocess.run(shlex.split(args.then, posix=False), env={**os.environ, 'MCP_CONFIG': out},
                                  capture_output=True, encoding='utf-8', errors='replace')
            status = done.returncode
            print(done.stdout, done.stderr, sep='\n', flush=True)
            if status != 0:
                print('--- gateway tail ---\n' + redact(gateway.clean_log()[-3000:]), flush=True)
                print('--- connector tail ---\n' + redact(connector.clean_log()), flush=True)
        sys.exit(status)
    finally:
        for term in reversed(terms):
            term.stop()
        # 自建的 Herdr 是用户的持久会话，Connector 退出后仍在运行；测试结束时清理本次部署的进程。
        subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command',
                        f"Get-Process herdr -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -ieq '{os.path.join(herdr_dir, 'herdr.exe')}' }} | Stop-Process -Force"],
                       capture_output=True, timeout=60)


if __name__ == '__main__':
    main()
