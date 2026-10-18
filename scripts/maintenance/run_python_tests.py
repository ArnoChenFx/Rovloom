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


def test_files(files):
    return {path for path in files if not path.startswith('fixtures/') and
            (Path(path).match('test_*.py') or Path(path).match('*_test.py'))}


class RecordedResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cases = {}
        self.test_objects = {}  # Prevent object-id reuse as unittest releases completed cases.

    def record(self, test, status):
        self.test_objects[id(test)] = test
        try:
            source = str(Path(inspect.getfile(type(test))).resolve().relative_to(Path.cwd().resolve()))
        except (TypeError, ValueError):
            source = None
        self.cases.setdefault(id(test), {'id': test.id(), 'file': source})['status'] = status

    def startTest(self, test):
        super().startTest(test)
        self.record(test, 'started')

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, 'passed')

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.record(test, 'failed')

    def addError(self, test, error):
        super().addError(test, error)
        self.record(test, 'error')

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.record(test, 'skipped')

    def addExpectedFailure(self, test, error):
        super().addExpectedFailure(test, error)
        self.record(test, 'expected_failure')

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.record(test, 'unexpected_success')

    def addSubTest(self, test, subtest, error):
        super().addSubTest(test, subtest, error)
        if error is not None:
            self.record(test, 'failed_subtest')


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
