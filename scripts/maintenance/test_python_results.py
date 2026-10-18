"""Exercise Python discovery gates using real unittest subprocess outcomes."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from check import ROOT, python_test_discovery


GOOD = ('import unittest\nclass Cases(unittest.TestCase):\n'
        ' def test_real(self): self.assertEqual(2 + 2, 4)\n')


class PythonResults(unittest.TestCase):
    def setUp(self):
        self.project = tempfile.TemporaryDirectory(prefix='rovloom-python-source-')
        self.output = tempfile.TemporaryDirectory(prefix='rovloom-python-report-')
        self.addCleanup(self.project.cleanup)
        self.addCleanup(self.output.cleanup)
        self.root = Path(self.project.name)
        self.report = Path(self.output.name) / 'results.json'
        self.files = set()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.write('scripts/test_good.py', GOOD)

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        subprocess.run(['git', 'add', '--', relative], cwd=self.root, check=True)
        self.files.add(relative)

    def run_reporter(self):
        self.report.unlink(missing_ok=True)
        return subprocess.run([sys.executable, str(ROOT / 'scripts/maintenance/run_python_tests.py'),
                               '--root', str(self.root), '--output', str(self.report)],
                              capture_output=True, text=True, timeout=30)

    def test_real_cases_in_arbitrary_flat_and_nested_files_pass(self):
        self.write('another/nested/new_test.py', GOOD)
        result = self.run_reporter()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(python_test_discovery(self.files, self.report), [])
        records = json.loads(self.report.read_text())['files']
        self.assertEqual(set(records), self.files)
        self.assertTrue(all(record['cases'] for record in records.values()))

    def test_module_skip_empty_module_and_method_skip_fail_alongside_normal_tests(self):
        for code in ('import unittest\nraise unittest.SkipTest("synthetic skip")\n',
                     '# Empty module next to a real passing test\n',
                     GOOD.replace(' def test_real', ' @unittest.skip("synthetic skip")\n def test_real')):
            with self.subTest(code=code):
                self.write('scripts/maintenance/test_added.py', code)
                result = self.run_reporter()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertTrue(python_test_discovery(self.files, self.report))

    def test_failure_import_error_expected_failure_and_failed_subtest_fail(self):
        for code in (GOOD.replace('2 + 2, 4', '2 + 2, 5'),
                     'raise RuntimeError("synthetic import error")\n',
                     GOOD.replace(' def test_real', ' @unittest.expectedFailure\n def test_real').replace('2 + 2, 4', '2 + 2, 5'),
                     'import unittest\nclass Cases(unittest.TestCase):\n'
                     ' def test_sub(self):\n  with self.subTest(value=1): self.fail("synthetic")\n'):
            with self.subTest(code=code):
                self.write('scripts/test_added.py', code)
                result = self.run_reporter()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertTrue(python_test_discovery(self.files, self.report))

    def test_echo_command_and_filename_are_not_execution_evidence(self):
        result = self.run_reporter()
        self.assertEqual(result.returncode, 0, result.stderr)
        missing = 'scripts/p0/test_never_run.py'
        self.write(missing, GOOD)
        # Neither echo output nor a declared package command adds a testcase.
        self.write('package.json', json.dumps({'scripts': {'test:p0': f'echo python3 {missing}'}}))
        subprocess.run(['sh', '-c', f'echo python3 {missing}'], cwd=self.root, check=True, capture_output=True)
        errors = python_test_discovery(self.files, self.report)
        self.assertEqual(len(errors), 1)
        self.assertIn(f'{missing}: Python test file was not executed', errors[0])

    def test_imported_cases_do_not_count_as_execution_of_an_empty_file(self):
        self.write('scripts/test_imported.py', 'from test_good import Cases\n')
        result = self.run_reporter()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(python_test_discovery(self.files, self.report))


if __name__ == '__main__':
    unittest.main()
