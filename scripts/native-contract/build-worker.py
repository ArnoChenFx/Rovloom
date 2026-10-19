"""从固定官方源码离线构建 Linux x64 编译进程，不执行安装脚本或下载输入。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile

SOURCE_HASH = 'a4e2341eee0cb98e40942fbaad9668de0bad96d6bd07c642aedd03681f669423'
SOURCE_COMMIT = '84e723f1ace5e3823cef8149dd0f890fe74b77ce'


def digest(path):
    """计算本地构建输入/产物的完整摘要，不记录用户环境。"""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract(archive, target):
    """在固定摘要之外检查普通文件、路径和展开总量，再写入私有临时目录。"""
    if digest(archive) != SOURCE_HASH:
        raise RuntimeError('QuickJS source checksum mismatch')
    with tarfile.open(archive, 'r:gz') as source:
        entries = source.getmembers()
        if len(entries) > 3000 or sum(item.size for item in entries) > 50 * 1024**2:
            raise RuntimeError('QuickJS archive limit')
        for item in entries:
            parts = Path(item.name).parts
            if not parts or parts[0] != 'quickjs-' + SOURCE_COMMIT or '..' in parts or item.name.startswith('/'):
                raise RuntimeError('QuickJS archive path')
            if not (item.isdir() or item.isfile()) or item.size > 8 * 1024**2:
                raise RuntimeError('QuickJS archive type')
        source.extractall(target, filter='data')
    return target / ('quickjs-' + SOURCE_COMMIT)


def build(root, service, output):
    """固定源码、标志与无时间戳输入；相同编译器下两次构建应逐字节一致。"""
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or platform.libc_ver()[0] != 'glibc':
        raise RuntimeError('schema worker build supports Linux x64 glibc only')
    compiler = shutil.which('gcc')
    if not compiler:
        raise RuntimeError('GCC is required for the Linux schema worker')
    archive = root / 'fixtures/toolchain/quickjs/source.tar.gz'
    driver = root / 'scripts/native-contract/compiler-worker.c'
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='rovloom-schema-build-') as temporary:
        workspace = Path(temporary)
        source = extract(archive, workspace)
        if (source / 'VERSION').read_text().strip() != '2026-06-04':
            raise RuntimeError('QuickJS version mismatch')
        payload = service.read_bytes()
        (workspace / 'compiler-service.h').write_text('static const unsigned char compiler_service[] = {' +
                                                    ','.join(map(str, payload)) + ',0};\n')
        flags = ['-O2', '-g0', '-fwrapv', '-fno-ident', '-fPIE', '-fstack-protector-strong',
                 '-D_GNU_SOURCE', '-DCONFIG_VERSION="2026-06-04"', '-I' + str(source), '-I' + str(workspace),
                 '-ffile-prefix-map=' + str(workspace) + '=/schema-source',
                 '-ffile-prefix-map=' + str(root) + '=/rovloom-source']
        inputs = [source / (name + '.c') for name in ('quickjs', 'dtoa', 'libregexp', 'libunicode', 'cutils')]
        inputs.append(driver)
        objects = []
        for index, path in enumerate(inputs):
            obj = workspace / f'{index}.o'
            subprocess.run([compiler, *flags, '-c', str(path), '-o', str(obj)], check=True, timeout=120)
            objects.append(obj)
        binary = output / 'schema-worker'
        subprocess.run([compiler, *map(str, objects), '-pie', '-Wl,--build-id=none', '-Wl,-z,relro,-z,now',
                        '-lm', '-lpthread', '-ldl', '-o', str(binary)], check=True, timeout=120)
        binary.chmod(0o500)
        manifest = {'compiler_protocol': 1, 'platform': 'linux', 'arch': 'x64', 'heap_bytes': 64 * 1024**2,
                    'deadline_ms': 2000, 'quickjs_commit': SOURCE_COMMIT, 'quickjs_source_sha256': SOURCE_HASH,
                    'service_sha256': digest(service), 'driver_sha256': digest(driver),
                    'binary_sha256': digest(binary),
                    'compiler': subprocess.check_output([compiler, '-dumpfullversion'], text=True).strip()}
        (output / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        shutil.copyfile(source / 'LICENSE', output / 'QUICKJS-LICENSE')


def main():
    """仅接收明确的项目、服务代码及产物目录，不读取 HOME 或全局配置。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--service', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.root.resolve(), args.service.resolve(), args.output.resolve())


if __name__ == '__main__':
    main()
