# 逐个在独立进程中执行版本化 unittest 文件，并记录真实用例状态及来源。
"""Run tracked unittest files in separate processes and record actual outcomes."""

import argparse
import inspect
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


# 筛选符合 Python 测试命名的文件，排除 fixtures 中作为数据保存的源码。
def test_files(files):
    return {path for path in files if not path.startswith('test/fixtures/') and
            (Path(path).match('test_*.py') or Path(path).match('*_test.py'))}


class RecordedResult(unittest.TextTestResult):
    # 初始化用例记录和对象引用，防止 unittest 释放对象后标识被复用。
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cases = {}
        self.test_objects = {}  # Prevent object-id reuse as unittest releases completed cases.

    # 记录用例真实定义文件和最新状态，无法解析来源时记为空值。
    def record(self, test, status):
        self.test_objects[id(test)] = test
        try:
            source = str(Path(inspect.getfile(type(test))).resolve().relative_to(Path.cwd().resolve()))
        except (TypeError, ValueError):
            source = None
        self.cases.setdefault(id(test), {'id': test.id(), 'file': source})['status'] = status

    # 保留 unittest 开始处理并将用例状态记为已开始。
    def startTest(self, test):
        super().startTest(test)
        self.record(test, 'started')

    # 保留 unittest 成功处理并将用例状态记为通过。
    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, 'passed')

    # 保留断言失败信息并将用例状态记为失败。
    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.record(test, 'failed')

    # 保留执行异常信息并将用例状态记为错误。
    def addError(self, test, error):
        super().addError(test, error)
        self.record(test, 'error')

    # 保留跳过原因并将用例状态记为跳过。
    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.record(test, 'skipped')

    # 记录预期失败，使此类用例无法被当作真实通过。
    def addExpectedFailure(self, test, error):
        super().addExpectedFailure(test, error)
        self.record(test, 'expected_failure')

    # 记录意外成功，使预期失败标记失效也能被门禁发现。
    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.record(test, 'unexpected_success')

    # 保留子测试结果，并在子测试出错时标记其父用例失败。
    def addSubTest(self, test, subtest, error):
        super().addSubTest(test, subtest, error)
        if error is not None:
            self.record(test, 'failed_subtest')


# 按直接运行脚本的导入路径执行单个文件，落盘真实用例结果并返回是否全部通过。
def worker(root, path, output):
    # Match direct-script imports without sharing module state across files.
    parent = root / Path(path).parent
    sys.path.insert(0, str(parent))
    suite = unittest.defaultTestLoader.discover(str(parent), pattern=Path(path).name, top_level_dir=str(parent))
    result = unittest.TextTestRunner(verbosity=2, resultclass=RecordedResult).run(suite)
    cases = list(result.cases.values())
    passed = bool(cases) and all(case['status'] == 'passed' and case['file'] == path for case in cases)
    output.write_text(json.dumps({'exit': 0 if passed else 1, 'cases': cases}) + '\n')
    return 0 if passed else 1


# 顺序启动各测试文件的独立进程，汇总报告并返回整体成功状态。
def run_files(root, files, output):
    records = {}
    with tempfile.TemporaryDirectory(prefix='rovloom-python-results-') as temporary:
        for index, path in enumerate(sorted(test_files(files))):
            report = Path(temporary) / f'{index}.json'
            process = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--root', str(root),
                                      '--worker', path, '--output', str(report)], cwd=root,
                                     text=True, capture_output=True, timeout=180)
            data = json.loads(report.read_text()) if report.is_file() else {'cases': []}
            data['exit'] = process.returncode
            records[path] = data
            passed = process.returncode == 0 and data['cases']
            print(f'{path}: {len(data["cases"])} cases, {"pass" if passed else "FAIL"}', flush=True)
            if not passed:
                print(process.stdout + process.stderr, file=sys.stderr)
    output.write_text(json.dumps({'format': 1, 'files': records}, indent=2) + '\n')
    return 0 if records and all(item['exit'] == 0 for item in records.values()) else 1


# 校验报告必须是检出目录外的新文件，再调度单文件或全部版本化测试。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help=argparse.SUPPRESS)
    parser.add_argument('--worker', help=argparse.SUPPRESS)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root, output = args.root.resolve(), args.output.resolve()
    if output.is_relative_to(root) or output.exists():
        parser.error('--output must be a fresh file outside the checkout')
    if args.worker:
        return worker(root, args.worker, output)
    tracked = subprocess.run(['git', 'ls-files', '-z'], cwd=root, check=True, capture_output=True)
    return run_files(root, set(tracked.stdout.decode().rstrip('\0').split('\0')), output)


if __name__ == '__main__':
    sys.exit(main())
