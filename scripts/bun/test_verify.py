"""用真实 Bun 运行报告回归测试发现门禁，不执行项目业务或使用真实数据。"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from verify import validate_tests


class TestDiscovery(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bun-discovery-')
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        (self.project / 'test/added').mkdir(parents=True)
        inventory = self.project / 'fixtures/acceptance/original-test-inventory.json'
        inventory.parent.mkdir(parents=True)
        self.titles = [f'baseline {number}' for number in range(20)]
        inventory.write_text(json.dumps([{'file': 'test/base.test.ts', 'discovered': self.titles}]))
        base = "import { test } from 'bun:test';\n"
        base += ''.join(f'test({json.dumps(title)}, () => {{}});\n' for title in self.titles)
        (self.project / 'test/base.test.ts').write_text(base)
        self.extra = self.project / 'test/added/nested.spec.ts'
        self.extra.write_text("import { test, describe, expect } from 'bun:test';\n"
                              'test("extra", () => expect(1).toBe(1));\n'
                              "describe('nested', () => { test.each([1, 2])(`value %d`, value => expect(value).toBeGreaterThan(0)); });\n")

    def run_bun(self):
        bun = shutil.which('bun')
        self.assertIsNotNone(bun, 'the pinned Bun must be on PATH')
        result = subprocess.run([bun, '--no-env-file', 'test', './test', '--reporter=junit',
                                 '--reporter-outfile=foundation.junit.xml'], cwd=self.project,
                                capture_output=True, text=True, timeout=20)
        return result.returncode, result.stdout + result.stderr

    def test_original_twenty_and_all_nested_parameterized_additions_pass(self):
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        self.assertEqual(validate_tests(self.project, 'foundation', log), 23)

    def test_new_file_omitted_from_report_is_rejected(self):
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        (self.project / 'test/omitted.test.ts').write_text("import { test } from 'bun:test'; test('omitted', () => {});\n")
        with self.assertRaisesRegex(RuntimeError, 'test files differ'):
            validate_tests(self.project, 'foundation', log)

    def test_replacing_one_baseline_with_a_new_test_is_rejected(self):
        path = self.project / 'test/base.test.ts'
        path.write_text(path.read_text().replace('baseline 0', 'replacement'))
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        with self.assertRaisesRegex(RuntimeError, 'original 20'):
            validate_tests(self.project, 'foundation', log)

    def test_new_failure_is_rejected(self):
        with self.extra.open('a') as file:
            file.write("test('new failure', () => expect(1).toBe(2));\n")
        code, log = self.run_bun()
        self.assertNotEqual(code, 0)
        with self.assertRaises(RuntimeError):
            validate_tests(self.project, 'foundation', log)

    def test_new_skip_and_todo_are_rejected(self):
        original = self.extra.read_text()
        for modifier in ('skip', 'todo'):
            with self.subTest(modifier=modifier):
                self.extra.write_text(original + f"test.{modifier}('unexecuted', () => {{}});\n")
                code, log = self.run_bun()
                self.assertEqual(code, 0, log)
                with self.assertRaises(RuntimeError):
                    validate_tests(self.project, 'foundation', log)


if __name__ == '__main__':
    unittest.main()
