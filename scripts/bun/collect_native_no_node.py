#!/usr/bin/env python3
# 在阻断 Node 工具链的环境中采集独立 Luvus 实例，并保存执行追踪证据。
"""仅采集全新 Luvus 实例；阻断 Node/npm/npx 并保存真实采集执行链。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile


# 校验 Bun 并构造隔离工具链，采集或调度采集与重放，保存脱敏验证报告。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--bun', required=True)
    parser.add_argument('--output', required=True, help='尚不存在的证据目录')
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--tools', help=argparse.SUPPRESS)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    if args.worker:
        sys.path.insert(0, str(repo / 'scripts/p0'))
        from collect_native import Capture
        capture = Capture(args.binary, args.output)
        try:
            # 使用原采集器；仅将其 child PATH 收窄到已验证的阻断目录。
            tools = capture.root / 'blocked-bin'
            tools.mkdir(mode=0o700)
            for source in Path(args.tools).iterdir():
                (tools / source.name).symlink_to(source)
            capture.environment['PATH'] = str(tools)
            capture.collect()
            capture.completed = True
        except BaseException as error:
            capture.collection_failure = {'error': type(error).__name__, 'message': str(error)}
            raise
        finally:
            capture.finish()
        return

    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    bun = Path(args.bun).resolve(strict=True)
    if hashlib.sha256(bun.read_bytes()).hexdigest() != '7ce7d6b654eddeec20afddf2396317fba6dc19ab52788a27e894e1806bf8f24b':
        raise SystemExit('需要已审定的官方 Bun 1.4.3 Linux x64 二进制')
    trace_tool = shutil.which('strace')
    if not trace_tool:
        raise SystemExit('需要 Linux strace')
    with tempfile.TemporaryDirectory(prefix='luvus-native-no-node-') as temporary:
        root = Path(temporary)
        tools = root / 'bin'
        tools.mkdir()
        (tools / 'python3').symlink_to(sys.executable)
        (tools / 'bun').symlink_to(bun)
        (tools / 'sh').symlink_to('/bin/sh')
        for name in ('node', 'npm', 'npx'):
            shim = tools / name
            shim.write_text('#!/bin/sh\nexit 99\n')
            shim.chmod(0o700)
        (root / 'home').mkdir(mode=0o700)
        env = {'PATH': str(tools), 'HOME': str(root / 'home'), 'SHELL': '/bin/sh', 'LANG': 'C.UTF-8'}
        probes = {name: subprocess.run([name, '--version'], env=env, capture_output=True).returncode
                  for name in ('node', 'npm', 'npx')}
        if set(probes.values()) != {99}:
            raise RuntimeError('阻断探针失败')

        # 追踪命令执行，超时清理进程组，脱敏日志并拒绝未核算或被禁用的程序。
        def trace(label, command):
            log = output / (label + '.execve.log')
            process = subprocess.Popen([trace_tool, '-f', '-qq', '-s', '256', '-e', 'trace=execve,execveat',
                                        '-o', str(log), *command], cwd=repo, env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
            try:
                stdout, stderr = process.communicate(timeout=120)
            except BaseException:
                os.killpg(process.pid, signal.SIGINT)
                try:
                    process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.communicate()
                raise
            text = log.read_text().replace(str(root), '/blocked').replace(str(repo), '/project')
            text = re.sub(r'/workspace/\.luvus-p0-[^/"\\ ]+', '/fixture/issue3', text)
            text = text.replace(str(bun), '/verified/bun').replace(str(Path(args.binary).resolve()), '/verified/luvus')
            log.write_text(text)
            (output / (label + '.log')).write_text(stdout + stderr)
            executables = sorted(set(re.findall(r'execve\("([^"\n]+)"', text)))
            if 'execveat(' in text or any(Path(p).name in ('node', 'nodejs', 'npm', 'npx') for p in executables):
                raise RuntimeError('发现未核算的进程或 Node/npm/npx 调用')
            if process.returncode:
                raise RuntimeError(f'{label}: exit {process.returncode}')
            return {'command': command, 'exit': 0, 'executables': executables,
                    'traceSha256': hashlib.sha256(log.read_bytes()).hexdigest()}, stdout

        capture, _ = trace('native-collection', [sys.executable, str(Path(__file__).resolve()), '--worker',
                           '--binary', str(Path(args.binary).resolve()), '--bun', str(bun),
                           '--output', str(output / 'native'), '--tools', str(tools)])
        code = 'import {inspectFixtures} from "./scripts/p0/audit-fixtures.mjs"; console.log(JSON.stringify(inspectFixtures(process.argv[1])))'
        replay, stdout = trace('native-replay', [str(bun), '--no-env-file', '-e', code, str(output / 'native')])
        environment = json.loads((output / 'native/environment.json').read_text())
        assertions = json.loads((output / 'native/assertions.json').read_text())
        report = {'blockingProbeExits': probes, 'workflowNodeNpmNpxInvocations': 0,
                  'nativeCollection': capture, 'bunReplay': replay, 'wireValidation': json.loads(stdout),
                  'nativeAssertions': len(assertions), 'allPassed': all(row['passed'] for row in assertions),
                  'cleanup': environment['cleanup'], 'childPath': environment['child_environment']['PATH']}
        # 命令参数中也只保留脱敏后的临时工具路径。
        report = json.loads(json.dumps(report).replace(str(root), '/blocked').replace(str(repo), '/project')
                            .replace(str(bun), '/verified/bun').replace(str(Path(args.binary).resolve()), '/verified/luvus'))
    (output / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
