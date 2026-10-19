#!/usr/bin/env python3
# 在临时项目中验证固定 Bun 工具链、测试和构建，并记录阻断 Node 后的执行证据。
"""在临时项目中完成 Linux 验证并阻断 Node/npm/npx。

仅复制项目代码、fixture 和指定工具链文件，不复制用户 env、npm 配置、
凭据、已有数据库或 home。
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET


# 读取文件原始字节并返回 SHA-256 摘要，供证据和元数据比对。
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# 校验 JUnit 用例成功且完整覆盖当前测试文件，返回实际用例数。
def validate_foundation(project, report):
    # 使用运行器报告，支持嵌套、参数化和不同引号的新增测试，不从源码猜测试标题。
    root = ET.parse(report).getroot()
    cases = list(root.iter('testcase'))
    if not cases or int(root.attrib['tests']) != len(cases):
        raise RuntimeError('foundation: empty or inconsistent JUnit report')
    for node in root.iter():
        if node.tag in ('failure', 'error', 'skipped') or any(
                int(node.attrib.get(key, '0')) for key in ('failures', 'errors', 'skipped', 'disabled')):
            raise RuntimeError('foundation: failed, skipped or disabled tests')
    files = {str(path.relative_to(project)) for path in (project / 'test').rglob('*')
             if path.is_file() and re.search(r'[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$', path.name)}
    discovered = set()
    for case in cases:
        path = Path(case.attrib['file'])
        if not path.is_absolute():
            path = project / path
        discovered.add(str(path.resolve().relative_to(project.resolve())))
    if files != discovered:
        raise RuntimeError('foundation: discovered test files differ from source')
    return len(cases)


# 核对日志通过数及跳过标记，并为 P0 检查 Python 测试摘要。
def validate_tests(project, label, log, count=None):
    if label == 'foundation':
        count = validate_foundation(project, project / 'foundation.junit.xml')
    if not re.search(rf'^\s*{count} pass\s*$', log, re.MULTILINE) or not re.search(r'^\s*0 fail\s*$', log, re.MULTILINE):
        raise RuntimeError(f'{label}: test count differs')
    if re.search(r'\b[1-9]\d* (?:skip|todo)\b|\bskipped=', log):
        raise RuntimeError(f'{label}: skipped or todo tests')
    if label == 'p0' and not re.search(r'Ran 7 tests[\s\S]*OK', log):
        raise RuntimeError('Python P0 harness did not pass 7 tests')
    return count


# 复制项目到隔离环境，执行工具链和构建测试并将脱敏证据写入新目录。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bun', default=shutil.which('bun'))
    parser.add_argument('--output', required=True, help='new evidence directory outside the checkout')
    args = parser.parse_args()
    if not args.bun or not shutil.which('strace'):
        raise SystemExit('Bun 1.4.3 and Linux strace must be available')
    bun = Path(args.bun).resolve(strict=True)
    trace_tool = str(Path(shutil.which('strace')).resolve())
    repo = Path(__file__).resolve().parents[2]
    output = Path(args.output).resolve()
    if output.is_relative_to(repo):
        raise SystemExit('evidence output must be outside the checkout')
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    records = []
    with tempfile.TemporaryDirectory(prefix='luvus-bun-verify-') as temporary:
        root = Path(temporary)
        project = root / 'project'
        project.mkdir()
        for folder in ('src', 'test', 'scripts', 'fixtures'):
            for source in (repo / folder).rglob('*'):
                if source.is_file() and '__pycache__' not in source.parts and not source.name.startswith('.env'):
                    destination = project / source.relative_to(repo)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
        for name in ('package.json', 'bun.lock', 'bunfig.toml', '.bun-version', 'tsconfig.json',
                     '.gitignore', '.oxlintrc.json', '.oxfmtrc.json'):
            shutil.copyfile(repo / name, project / name)
        tools = root / 'bin'
        tools.mkdir()
        (tools / 'bun').symlink_to(bun)
        (tools / 'python3').symlink_to(Path(shutil.which('python3')).resolve())
        (tools / 'sh').symlink_to('/bin/sh')
        for name in ('node', 'npm', 'npx'):
            shim = tools / name
            shim.write_text(f'#!/bin/sh\nprintf "{name}\\n" >> "$BLOCKED_EXEC_LOG"\nexit 99\n')
            shim.chmod(0o700)
        home = root / 'home'
        home.mkdir(mode=0o700)
        env = {'PATH': str(tools), 'HOME': str(home), 'SHELL': '/bin/sh',
               'LANG': 'C.UTF-8', 'NO_COLOR': '1', 'CI': '1',
               'BUN_INSTALL_CACHE_DIR': str(root / 'empty-cache'),
               'LUVUS_P0_TEST_ROOT': str(repo.parent),
               'BLOCKED_EXEC_LOG': str(root / 'blocked.log')}
        # 云环境出口可能依赖平台代理/CA；仅继承这些设置。
        # 拒绝含凭据的代理 URL，不记录任何配置值。
        network_keys = []
        for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'):
            value = os.environ.get(name)
            if value:
                if name.endswith('_PROXY') and name != 'NO_PROXY' and (urlsplit(value).username or urlsplit(value).password):
                    raise RuntimeError('credential-bearing proxy settings are not copied')
                env[name] = value
                network_keys.append(name)
        for name in ('node', 'npm', 'npx'):
            result = subprocess.run([name, '--version'], env=env, capture_output=True)
            if result.returncode != 99:
                raise RuntimeError(f'{name} was not blocked')
        if (root / 'blocked.log').read_text().splitlines() != ['node', 'npm', 'npx']:
            raise RuntimeError('blocking probe did not run all shims')
        (root / 'blocked.log').unlink()

        # 在隔离项目追踪单条命令，保存日志并核对禁用程序调用与预期退出码。
        def run(label, arguments, expected=0):
            trace = output / (label + '.execve.log')
            process = subprocess.Popen([trace_tool, '-f', '-qq', '-s', '256', '-e', 'trace=execve,execveat',
                                        '-o', str(trace), *arguments], cwd=project, env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
            try:
                stdout, stderr = process.communicate(timeout=180)
            except BaseException:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                raise
            combined = stdout + stderr
            # 只追踪本次自建进程，将临时绝对路径脱敏。
            combined = combined.replace(str(root), '/isolated').replace(str(bun), '/verified/bun')
            (output / (label + '.log')).write_text(combined)
            traced = trace.read_text().replace(str(root), '/isolated').replace(str(bun), '/verified/bun')
            trace.write_text(traced)
            executables = sorted(set(re.findall(r'execve\("([^"\n]+)"', traced)))
            if 'execveat(' in traced:
                raise RuntimeError(f'{label}: unaccounted execveat execution; inspect trace')
            if any(Path(path).name in ('node', 'nodejs', 'npm', 'npx') for path in executables):
                raise RuntimeError(f'{label}: Node/npm/npx execution attempted')
            if (root / 'blocked.log').exists():
                raise RuntimeError(f'{label}: blocked executable invoked')
            if process.returncode != expected:
                print(combined[-12000:], file=sys.stderr)
                raise RuntimeError(f'{label}: exit {process.returncode}, expected {expected}; see {output}')
            records.append({'label': label, 'command': arguments, 'exit': process.returncode,
                            'executables': executables, 'logSha256': sha(output / (label + '.log')),
                            'execveSha256': sha(trace)})
            print(f'{label}: pass', flush=True)
            return combined

        before = {name: sha(project / name) for name in ('package.json', 'bun.lock')}
        if run('version', ['bun', '--version']).strip() != '1.4.3':
            raise RuntimeError('wrong Bun version')
        run('frozen-install', ['bun', '--no-env-file', 'install', '--frozen-lockfile', '--ignore-scripts'])
        run('installed-dependencies', ['bun', '--no-env-file', 'scripts/bun/audit_installed.mjs'])
        run('toolchain', ['bun', '--no-env-file', 'run', 'toolchain'])
        if before != {name: sha(project / name) for name in before}:
            raise RuntimeError('frozen install changed package.json or bun.lock')
        lifecycle = []
        for manifest in (project / 'node_modules').rglob('package.json'):
            package = json.loads(manifest.read_text())
            scripts = sorted(set(package.get('scripts', {})) & {'preinstall', 'install', 'postinstall', 'prepare'})
            if scripts:
                lifecycle.append({'package': package['name'], 'version': package['version'], 'scripts': scripts})
        run('typecheck', ['bun', '--no-env-file', 'run', 'typecheck'])
        config = run('typecheck-config', ['bun', '--no-env-file', 'node_modules/typescript/bin/tsc', '--showConfig'])
        config = json.loads(config)
        if not all(config['compilerOptions'].get(key) for key in ('strict', 'noUncheckedIndexedAccess')):
            raise RuntimeError('strict compiler flags disabled')
        expected_files = sorted('./' + str(p.relative_to(project)) for folder in ('src', 'test')
                                for p in (project / folder).rglob('*.ts'))
        if sorted(config['files']) != expected_files:
            raise RuntimeError('typecheck omitted source or test files')
        negative = project / 'test' / 'bun-negative.ts'
        negative.write_text('const wrong: string = 42;\nconst values: string[] = [];\nvalues[0].toUpperCase();\nexport {};\n')
        diagnostics = run('typecheck-negative', ['bun', '--no-env-file', 'run', 'typecheck'], expected=1)
        if not all(code in diagnostics for code in ('TS2322', 'TS2532')):
            raise RuntimeError('independent typechecker did not reject expected strict errors')
        negative.unlink()
        harness = run('verify-harness', ['python3', 'scripts/bun/test_verify.py'])
        harness_summary = re.search(r'Ran (\d+) tests?[^\n]*\n\s*OK\s*$', harness)
        if not harness_summary or int(harness_summary[1]) == 0 or 'skipped=' in harness:
            raise RuntimeError('test discovery regression harness did not pass all tests')
        counts = {}
        for label, script, count in [('foundation', 'test', None), ('p0', 'test:p0', 7), ('bun-compatibility', 'test:bun', 5)]:
            command = ['bun', '--no-env-file', 'run', script]
            if label == 'foundation':
                command += ['--reporter=junit', '--reporter-outfile=foundation.junit.xml']
            log = run(label, command)
            counts[label] = validate_tests(project, label, log, count)
        junit = (project / 'foundation.junit.xml').read_text().replace(str(root), '/isolated')
        (output / 'foundation.junit.xml').write_text(junit)
        run('p0-audit', ['bun', '--no-env-file', 'run', 'p0:audit'])
        run('new-native-audit', ['bun', '--no-env-file', 'run', 'p0:bun-native'])
        (project / 'dist').mkdir()
        (project / 'dist' / 'stale.js').write_text('throw new Error("stale")')
        run('build', ['bun', '--no-env-file', 'run', 'build'])
        if (project / 'dist' / 'stale.js').exists():
            raise RuntimeError('build retained stale output')
        run('artifact-smoke', ['bun', '--no-env-file', 'run', 'smoke'])
        if before != {name: sha(project / name) for name in before}:
            raise RuntimeError('verification mutated package metadata')
        report = {'runtime': 'Bun 1.4.3', 'platform': 'Linux', 'bunBinarySha256': sha(bun),
                  'nodeNpmNpxBlockingProbeExit': 99, 'workflowNodeNpmNpxInvocations': 0,
                  'emptyInstallCache': True, 'frozenInstallChangedMetadata': False,
                  'platformNetworkSettingNames': network_keys,
                  'strictFlags': ['strict', 'noUncheckedIndexedAccess'],
                  'checkedFiles': expected_files, 'lifecycleScriptsFoundButNotExecuted': lifecycle,
                  'tests': {'foundation': counts['foundation'],
                            'verifyHarness': int(harness_summary[1]),
                            'p0JavaScript': counts['p0'], 'p0Python': 7,
                            'bunCompatibility': counts['bun-compatibility']},
                  'records': records, 'temporaryProjectRemoved': True}
    (output / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'All checks passed; evidence: {output}')


if __name__ == '__main__':
    main()
