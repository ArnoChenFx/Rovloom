# 把预先导出的本地证据复制为私有归档，并离线复核原始字节和来源一致性。
"""归档预先导出的本地只读证据；不运行 binary、联网、发现或连接 socket。"""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys

from contract import audit, read_file, require, ROOT


# 审核私有输入后复制到检出目录外的新归档，复核失败时删除输出并保留输入。
def collect(source, output):
    source, output = Path(source), Path(output)
    require(source.is_absolute() and not source.is_symlink(), 'absolute ordinary input directory required')
    require(output.is_absolute() and not output.exists() and not output.is_symlink(), 'fresh absolute output required')
    resolved = output.resolve()
    require(not resolved.is_relative_to(ROOT) and not resolved.is_relative_to(source.resolve()),
            'output must be outside checkout and input')
    require(source.stat().st_uid == os.getuid() and source.stat().st_mode & 0o077 == 0,
            'private owned input directory required')
    result = audit(source)
    manifest = json.loads(read_file(source, 'capture.json'))
    output.mkdir(mode=0o700)
    try:
        for name in ['capture.json', *manifest['files']]:
            data = read_file(source, name)
            destination = output / name
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with destination.open('xb') as stream:
                destination.chmod(0o600)
                stream.write(data)
        # 重新核对落盘原文字节，源变化不能留下被误认为通过的归档。
        require(audit(output) == result, 'source changed during collection')
    except BaseException:
        shutil.rmtree(output)
        raise
    return result


# 解析输入输出路径并执行离线归档，仅用错误类型报告拒绝原因。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = collect(args.input, args.output)
    except (ValueError, KeyError, TypeError, OSError, RecursionError) as error:
        print(json.dumps({'collection': 'rejected', 'error_type': type(error).__name__}), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
