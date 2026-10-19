# 安装固定版本的官方原生 Bun，核对归档摘要与完整成员后只写入 runner 临时目录。
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import zipfile


# 从维护矩阵选择唯一目标，不从环境变量或任意 URL 加载工具链。
def install(target, directory):
    root = Path(__file__).resolve().parents[2]
    if (root / '.bun-version').read_text().strip() != '1.4.3':
        raise ValueError('Bun pin mismatch')
    platforms = json.loads((root / 'scripts/release/platforms.json').read_text())
    platform = next(item for item in platforms if item['target'] == target)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    archive = directory / 'bun.zip'
    url = f"https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/{platform['archive']}.zip"
    with urllib.request.urlopen(url, timeout=120) as response:
        archive.write_bytes(response.read())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != platform['sha256']:
        raise ValueError('Bun archive checksum mismatch')
    executable = 'bun.exe' if platform['os'] == 'windows' else 'bun'
    member = f"{platform['archive']}/{executable}"
    with zipfile.ZipFile(archive) as package:
        if set(package.namelist()) != {platform['archive'] + '/', member}:
            raise ValueError('Unexpected Bun archive members')
        package.extractall(directory)
    (directory / member).chmod(0o755)
    with open(os.environ['GITHUB_PATH'], 'a', encoding='utf-8') as output:
        output.write(str((directory / platform['archive']).resolve()) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True)
    parser.add_argument('--directory', required=True)
    args = parser.parse_args()
    install(args.target, args.directory)
