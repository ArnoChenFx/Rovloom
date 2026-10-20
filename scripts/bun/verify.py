#!/usr/bin/env python3
# 在临时项目中直接执行固定 Bun 质量命令，记录真实退出码、测试覆盖和构建结果。
"""在临时项目中直接运行 Bun 验证并记录实际结果。

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
import time
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET


# 超时诊断只保留有界尾部，不作为测试通过或完整执行的证明。
TIMEOUT_LOG_BYTES = 131_072
FAILURE_CONSOLE_BYTES = 12_000


# 失败控制台只保留可核对的仓库位置、固定阶段和数字总计，不转发断言值、源码或错误正文。
def foundation_failure_summary(project, log, source_files):
    root = project.resolve()
    phases = {'connect', 'start', 'both_running', 'client_cancel', 'server_cancel', 'client_close',
              'bob_reply', 'ping', 'listener_auth', 'fixture_import', 'fixture_open', 'ready',
              'http_connect', 'call', 'duplicate', 'result_page', 'changed_cursor', 'cancel',
              'revoked_read', 'complete'}
    cleanups = {'not_started', 'clients', 'listener', 'http', 'service', 'runtime', 'complete'}
    failures, totals, block, current, ordinal, delimiters = [], [], [], None, 0, None

    # 绝对临时路径和已脱敏路径均只映射到确实存在的仓库源文件，不输出外部文件或任意错误片段。
    def source_path(value):
        if value.startswith('/isolated/project/'):
            value = value[len('/isolated/project/'):]
        path = Path(value)
        if not path.is_absolute():
            path = root / path
        try:
            relative = str(path.resolve().relative_to(root))
        except (ValueError, OSError):
            return None
        if (len(relative) > 256 or relative not in source_files
                or not re.fullmatch(r'(?:src|test|scripts)/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s|[jt]sx|py)', relative)
                or not path.is_file()):
            return None
        return relative

    # 用文件及该文件内用例序号定位首个失败；测试名、动态参数及异常 message 都可能包含秘密。
    def record(kind):
        if len(failures) >= 3:
            return
        entry = {'kind': kind, 'file': current, 'caseOrdinal': ordinal if kind == 'test' else None,
                 'error': 'test_failure', 'stack': [], 'progress': []}
        for line in block:
            error = re.match(r'^(AssertionError|TypeError|RangeError|SyntaxError|McpError|StreamableHTTPError):', line)
            if error:
                entry['error'] = error[1]
            timeout = re.search(r'test timed out after ([0-9]{1,9})ms', line)
            if timeout:
                entry['error'] = 'test_timeout'
                entry['timeoutMs'] = int(timeout[1])
            compiler = re.search(r'"reason":"(compiler_(?:timeout|unavailable|busy|failed|closed|cancelled))"', line)
            if compiler:
                entry['compiler'] = compiler[1]
            progress = re.fullmatch(r'\[mcp-http-failure\] case=(runtime-sdk|http-sessions) '
                                    r'phase=([a-z_]+) cleanup=([a-z_]+)', line)
            if progress and progress[2] in phases and progress[3] in cleanups and len(entry['progress']) < 3:
                entry['progress'].append({'case': progress[1], 'phase': progress[2], 'cleanup': progress[3]})
            if line.lstrip().startswith('at ') and len(entry['stack']) < 8:
                location = line.strip()[3:].rsplit('(', 1)[-1].rstrip(')')
                parts = location.rsplit(':', 2)
                if len(parts) == 3 and all(re.fullmatch(r'[0-9]{1,9}', number) for number in parts[1:]):
                    source = source_path(parts[0])
                    if source:
                        frame = f'{source}:{parts[1]}:{parts[2]}'
                        if frame not in entry['stack']:
                            entry['stack'].append(frame)
        failures.append(entry)

    for line in log.splitlines():
        # Bun在GitHub Actions中用工作流分组包装文件标题，仍只接受冻结清单内的真实源码。
        header = re.fullmatch(r'(.+[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)):(?: \(run #\d+\))?',
                              line.removeprefix('::group::'))
        source = source_path(header[1]) if header else None
        if source:
            current, ordinal, block, delimiters = source, 0, [], None
            continue
        if re.fullmatch(r'\d+ tests? failed:', line):
            break  # Bun随后重复失败名称；不能把重复汇总误算成首次断言。
        block.append(line)
        if line == '# Unhandled error between tests':
            delimiters = 0
        elif delimiters is not None and re.fullmatch(r'-{5,}', line):
            delimiters += 1
            if delimiters == 2:
                record('between_tests')
                block, delimiters = [], None
        elif re.match(r'^\((?:pass|fail|skip|todo)\) ', line):
            ordinal += 1
            if line.startswith('(fail) '):
                record('test')
            block = []
    for line in log.splitlines():
        value = line.strip()
        if (re.fullmatch(r'[0-9]{1,9} (?:pass|fail|errors?|skip|todo)', value)
                or re.fullmatch(r'Ran [0-9]{1,9} tests? across [0-9]{1,9} files?\. '
                                r'\[[0-9]{1,9}(?:\.[0-9]{1,6})?m?s\]', value)):
            totals.append(value)
    summary = {'status': 'failed', 'firstFailures': failures, 'totals': totals[-8:],
               'details': 'assertion values, messages, source text and test names omitted'}
    encoded = json.dumps(summary, ensure_ascii=True, indent=2)
    while len(encoded.encode()) > FAILURE_CONSOLE_BYTES:
        summary['truncated'] = True
        if failures and failures[-1]['stack']:
            failures[-1]['stack'].pop()
        elif failures:
            failures.pop()
        else:
            summary['totals'] = []
        encoded = json.dumps(summary, ensure_ascii=True, indent=2)
    return encoded


# 脱敏并保存超时阶段的有界日志与已观察用例，始终标记验收不完整。
def save_timeout_diagnostics(output, label, stdout, stderr, seconds, elapsed, replacements, exit_code=None):
    combined = stdout + stderr
    for source, replacement in replacements:
        combined = combined.replace(source, replacement)
    files, cases, current = [], [], None
    for line in combined.splitlines():
        if re.search(r'[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx):\s*$', line):
            current = line.strip()[:-1]
        elif re.match(r'^\((?:pass|fail|skip|todo)\) ', line):
            cases.append(line.encode()[-1024:].decode('utf-8', errors='ignore'))
            if current and current not in files:
                files.append(current.encode()[-512:].decode('utf-8', errors='ignore'))
    header = f'{label}: timed out after {seconds}s; incomplete verification\n'.encode()
    raw = combined.encode()
    tail = raw[-(TIMEOUT_LOG_BYTES - len(header)):].decode('utf-8', errors='ignore').encode()
    (output / f'{label}.log').write_bytes(header + tail)
    summary = {'label': label, 'status': 'timed_out', 'complete': False,
               'timeoutSeconds': seconds, 'elapsedSeconds': round(elapsed, 3), 'exit': exit_code,
               'capturedLogBytes': len(raw), 'logTailTruncated': len(raw) > len(tail),
               'observedTestFilesTail': files[-32:], 'observedTestCasesTail': cases[-32:]}
    (output / f'{label}.timeout.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    return (header + tail[-12000:]).decode('utf-8', errors='ignore')


# 读取文件原始字节并返回 SHA-256 摘要，供证据和元数据比对。
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# 直接执行质量命令，保留真实退出码；超时或中断时终止并回收本次进程组。
def run_command(project, output, label, arguments, env, expected=0, seconds=180,
                source_files=(), replacements=()):
    started = time.monotonic()
    process = subprocess.Popen(arguments, cwd=project, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=seconds)
    except BaseException as error:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, stderr = process.communicate()
        if isinstance(error, subprocess.TimeoutExpired):
            diagnostic = save_timeout_diagnostics(
                output, label, stdout, stderr, seconds, time.monotonic() - started,
                replacements, exit_code=process.returncode)
            print(diagnostic, file=sys.stderr)
        raise
    for source, replacement in replacements:
        stdout, stderr = stdout.replace(source, replacement), stderr.replace(source, replacement)
    combined = stdout + stderr
    log = output / (label + '.log')
    log.write_text(combined)
    if process.returncode != expected:
        if label == 'foundation':
            print(foundation_failure_summary(project, combined, source_files), file=sys.stderr)
        print(f'{label}: command={json.dumps(arguments)}; exit={process.returncode}, expected={expected}',
              file=sys.stderr)
        for stream, content in (('stdout', stdout), ('stderr', stderr)):
            print(f'{label}: {stream}\n{content}', file=sys.stderr)
        raise RuntimeError(f'{label}: exit {process.returncode}, expected {expected}; see {output}')
    record = {'label': label, 'command': arguments, 'exit': process.returncode, 'expectedExit': expected,
              'timeoutSeconds': seconds, 'elapsedSeconds': round(time.monotonic() - started, 3),
              'logSha256': sha(log)}
    print(f'{label}: pass; exit={record["exit"]}; elapsed={record["elapsedSeconds"]}s; watchdog={seconds}s',
          flush=True)
    return combined, record


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


# 核对日志通过数与当前 JUnit 用例一致，并拒绝跳过或待办标记。
def validate_tests(project, label, log, count=None):
    if label == 'foundation':
        count = validate_foundation(project, project / 'foundation.junit.xml')
    if not re.search(rf'^\s*{count} pass\s*$', log, re.MULTILINE) or not re.search(r'^\s*0 fail\s*$', log, re.MULTILINE):
        raise RuntimeError(f'{label}: test count differs')
    if re.search(r'\b[1-9]\d* (?:skip|todo)\b|\bskipped=', log):
        raise RuntimeError(f'{label}: skipped or todo tests')
    return count


# 复制项目到隔离环境，执行工具链和构建测试并将脱敏证据写入新目录。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bun', default=shutil.which('bun'))
    parser.add_argument('--output', required=True, help='new evidence directory outside the checkout')
    args = parser.parse_args()
    if not args.bun:
        raise SystemExit('Bun 1.4.3 must be available')
    bun = Path(args.bun).resolve(strict=True)
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
        for folder in ('src', 'test', 'scripts'):
            for source in (repo / folder).rglob('*'):
                if source.is_file() and '__pycache__' not in source.parts and not source.name.startswith('.env'):
                    destination = project / source.relative_to(repo)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
        for name in ('package.json', 'bun.lock', 'bunfig.toml', '.bun-version', 'tsconfig.json',
                     '.gitignore', '.oxlintrc.json', '.oxfmtrc.json'):
            shutil.copyfile(repo / name, project / name)
        # WebUI 只复制明确的应用标与横版全名图，保留原背景和字节，不引入其它文档或日志。
        for name in ('rovloom-mark-orange.png', 'rovloom-logo.png'):
            brand = Path('docs/assets/brand') / name
            (project / brand).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(repo / brand, project / brand)
        # 在执行任何测试前冻结源码位置清单；测试临时创建的秘密命名文件不得进入控制台栈。
        source_files = frozenset(str(path.relative_to(project)) for folder in ('src', 'test', 'scripts')
                                 for path in (project / folder).rglob('*') if path.is_file())
        tools = root / 'bin'
        tools.mkdir()
        (tools / 'bun').symlink_to(bun)
        home = root / 'home'
        home.mkdir(mode=0o700)
        env = {'PATH': str(tools) + os.pathsep + os.environ.get('PATH', os.defpath),
               'HOME': str(home), 'SHELL': '/bin/sh',
               'LANG': 'C.UTF-8', 'NO_COLOR': '1', 'CI': '1',
               'BUN_INSTALL_CACHE_DIR': str(root / 'empty-cache'),
               'LUVUS_TEST_ROOT': str(repo.parent)}
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
        # 固定 Bun 在普通 PATH 前，其余工具正常解析；每步只按实际退出码接纳结果。
        def run(label, arguments, expected=0):
            combined, record = run_command(
                project, output, label, arguments, env, expected=expected,
                seconds=600 if label == 'foundation' else 180, source_files=source_files,
                replacements=[(str(root), '/isolated'), (str(bun), '/verified/bun')])
            records.append(record)
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
        harness = run('verify-harness', ['python3', 'test/toolchain/test_verify.py'])
        harness_summary = re.search(r'Ran (\d+) tests?[^\n]*\n\s*OK\s*$', harness)
        if not harness_summary or int(harness_summary[1]) == 0 or 'skipped=' in harness:
            raise RuntimeError('test discovery regression harness did not pass all tests')
        log = run('foundation', ['bun', '--no-env-file', 'run', 'test',
                                 '--reporter=junit', '--reporter-outfile=foundation.junit.xml'])
        count = validate_tests(project, 'foundation', log)
        print(f'foundation: {count} passed cases; ' +
              next(line for line in log.splitlines() if line.startswith('Ran ')), flush=True)
        junit = (project / 'foundation.junit.xml').read_text().replace(str(root), '/isolated')
        (output / 'foundation.junit.xml').write_text(junit)
        run('luvus-audit', ['bun', '--no-env-file', 'run', 'audit:luvus'])
        # 单文件回归可能已生成发行探针；仍放入 stale 标记，核对正式构建清除所有旧输出。
        (project / 'dist').mkdir(exist_ok=True)
        (project / 'dist' / 'stale.js').write_text('throw new Error("stale")')
        run('build', ['bun', '--no-env-file', 'run', 'build'])
        if (project / 'dist' / 'stale.js').exists():
            raise RuntimeError('build retained stale output')
        run('artifact-smoke', ['bun', '--no-env-file', 'run', 'smoke'])
        if before != {name: sha(project / name) for name in before}:
            raise RuntimeError('verification mutated package metadata')
        report = {'runtime': 'Bun 1.4.3', 'platform': 'Linux', 'bunBinarySha256': sha(bun),
                  'emptyInstallCache': True, 'frozenInstallChangedMetadata': False,
                  'platformNetworkSettingNames': network_keys,
                  'strictFlags': ['strict', 'noUncheckedIndexedAccess'],
                  'checkedFiles': expected_files, 'lifecycleScriptsFoundButNotExecuted': lifecycle,
                  'tests': {'foundation': count, 'verifyHarness': int(harness_summary[1])},
                  'records': records, 'temporaryProjectRemoved': True}
    (output / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'All checks passed; evidence: {output}')


if __name__ == '__main__':
    main()
