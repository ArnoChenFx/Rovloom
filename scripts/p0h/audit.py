"""离线检查 Herdr P0-H 归档；通过只表示回放完整，不表示原生实测通过。"""

import argparse
import json
from pathlib import Path
import sys

from contract import audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    try:
        result = audit(args.input)
    except (ValueError, KeyError, TypeError, OSError, RecursionError) as error:
        # 不在错误文本中打印原生 payload、用户路径或异常值。
        print(json.dumps({'offline_audit': 'rejected', 'error_type': type(error).__name__}), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
