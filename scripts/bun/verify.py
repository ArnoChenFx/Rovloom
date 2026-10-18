#!/usr/bin/env python3
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
import tempfile
from urllib.parse import urlsplit


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_tests(project, label, log, count):
    if not re.search(rf'\b{count} pass\b', log) or not re.search(r'\b0 fail\b', log):
        raise RuntimeError(f'{label}: test count differs')
    if re.search(r'\b[1-9]\d* (?:skip|todo)\b|\bskipped=', log):
        raise RuntimeError(f'{label}: skipped or todo tests')
    if label == 'foundation':
        titles = [title for path in (project / 'test').glob('*.test.ts')
                  for title in re.findall(r"^test\('([^']+)'", path.read_text(), re.MULTILINE)]
        discovered = re.findall(r'^\(pass\) (.*?) \[', log, re.MULTILINE)
        if len(titles) != count or sorted(titles) != sorted(discovered):
            raise RuntimeError('foundation: discovered test names differ from source')
    if label == 'p0' and not re.search(r'Ran 7 tests[\s\S]*OK', log):
        raise RuntimeError('Python P0 harness did not pass 7 tests')


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
        for name in ('package.json', 'bun.lock', 'bunfig.toml', '.bun-version', 'tsconfig.json'):
            shutil.copyfile(repo / name, project / name)
        (project / 'docs' / 'p0').mkdir(parents=True)
        shutil.copyfile(repo / 'docs/p0/coverage.json', project / 'docs/p0/coverage.json')
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
        for label, script, count in [('foundation', 'test', 20), ('p0', 'test:p0', 7), ('bun-compatibility', 'test:bun', 5)]:
            log = run(label, ['bun', '--no-env-file', 'run', script])
            validate_tests(project, label, log, count)
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
                  'tests': {'foundation': 20, 'p0JavaScript': 7, 'p0Python': 7, 'bunCompatibility': 5},
                  'records': records, 'temporaryProjectRemoved': True}
    (output / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'All checks passed; evidence: {output}')


if __name__ == '__main__':
    main()
