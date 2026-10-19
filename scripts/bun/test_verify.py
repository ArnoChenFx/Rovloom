# 通过临时 Bun 项目回归验证测试发现门禁能接纳新增用例并拒绝遗漏和未执行项。
"""用真实 Bun 运行报告回归测试发现门禁，不执行项目业务或使用真实数据。"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

from verify import validate_tests


class TestDiscovery(unittest.TestCase):
    # 建立含普通、嵌套和参数化用例的临时项目，并注册目录清理。
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bun-discovery-')
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        (self.project / 'test/added').mkdir(parents=True)
        self.titles = ['current behavior', 'current safety boundary']
        base = "import { test } from 'bun:test';\n"
        base += ''.join(f'test({json.dumps(title)}, () => {{}});\n' for title in self.titles)
        (self.project / 'test/base.test.ts').write_text(base)
        self.extra = self.project / 'test/added/nested.spec.ts'
        self.extra.write_text("import { test, describe, expect } from 'bun:test';\n"
                              'test("extra", () => expect(1).toBe(1));\n'
                              "describe('nested', () => { test.each([1, 2])(`value %d`, value => expect(value).toBeGreaterThan(0)); });\n")

    # 执行指定 Bun 测试参数并生成 JUnit，返回退出码及合并日志。
    def run_bun(self, *arguments):
        bun = shutil.which('bun')
        self.assertIsNotNone(bun, 'the pinned Bun must be on PATH')
        result = subprocess.run([bun, '--no-env-file', 'test', './test', *arguments, '--reporter=junit',
                                 '--reporter-outfile=foundation.junit.xml'], cwd=self.project,
                                capture_output=True, text=True, timeout=20)
        return result.returncode, result.stdout + result.stderr

    # 验证门禁按实际执行报告识别全部五个用例，无需维护标题清单。
    def test_current_files_and_nested_parameterized_tests_pass_without_inventory(self):
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        self.assertEqual(validate_tests(self.project, 'foundation', log), 5)

    # 验证报告生成后新增而未执行的测试文件会被拒绝。
    def test_new_file_omitted_from_report_is_rejected(self):
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        (self.project / 'test/omitted.test.ts').write_text("import { test } from 'bun:test'; test('omitted', () => {});\n")
        with self.assertRaisesRegex(RuntimeError, 'test files differ'):
            validate_tests(self.project, 'foundation', log)

    # 验证改名用例或删除旧文件后，门禁仍以当前源码与执行结果为准。
    def test_renaming_tests_and_removing_obsolete_files_is_allowed(self):
        path = self.project / 'test/base.test.ts'
        path.write_text(path.read_text().replace('current behavior', 'replacement'))
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        self.assertEqual(validate_tests(self.project, 'foundation', log), 5)
        path.unlink()
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        self.assertEqual(validate_tests(self.project, 'foundation', log), 3)

    # 验证只有导出声明的空测试文件无法通过执行覆盖检查。
    def test_file_without_executed_tests_is_rejected(self):
        (self.project / 'test/empty.test.ts').write_text('export {};\n')
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        with self.assertRaisesRegex(RuntimeError, 'test files differ'):
            validate_tests(self.project, 'foundation', log)

    # 验证按名称筛选执行不能掩盖其他测试文件未被执行。
    def test_filtered_execution_cannot_hide_another_test_file(self):
        code, log = self.run_bun('--test-name-pattern=^extra$')
        self.assertEqual(code, 0, log)
        with self.assertRaises(RuntimeError):
            validate_tests(self.project, 'foundation', log)

    # 验证空报告或声明数量与实际用例数不符的报告会被拒绝。
    def test_empty_or_inconsistent_report_is_rejected(self):
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        report = self.project / 'foundation.junit.xml'
        for content in ('<testsuites tests="0"/>',
                        '<testsuites tests="2"><testcase file="test/base.test.ts" name="one"/></testsuites>'):
            with self.subTest(content=content):
                report.write_text(content)
                with self.assertRaisesRegex(RuntimeError, 'empty or inconsistent'):
                    validate_tests(self.project, 'foundation', log)

    # 验证 JUnit 各种失败、跳过和禁用标记均触发拒绝。
    def test_report_failure_error_skip_and_disabled_markers_are_rejected(self):
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        report = self.project / 'foundation.junit.xml'
        original = report.read_text()
        for marker in ('failure', 'error', 'skipped', 'failures', 'errors', 'disabled'):
            with self.subTest(marker=marker):
                root = ET.fromstring(original)
                if marker in ('failure', 'error', 'skipped'):
                    ET.SubElement(next(root.iter('testcase')), marker)
                else:
                    root.set(marker, '1')
                ET.ElementTree(root).write(report)
                with self.assertRaisesRegex(RuntimeError, 'failed, skipped or disabled'):
                    validate_tests(self.project, 'foundation', log)

    # 验证日志中的通过数量必须与 JUnit 实际用例数一致。
    def test_log_count_must_match_executed_cases(self):
        code, log = self.run_bun()
        self.assertEqual(code, 0, log)
        with self.assertRaisesRegex(RuntimeError, 'test count differs'):
            validate_tests(self.project, 'foundation', log.replace('5 pass', '4 pass'))

    # 验证新增失败用例同时导致 Bun 失败和门禁拒绝。
    def test_new_failure_is_rejected(self):
        with self.extra.open('a') as file:
            file.write("test('new failure', () => expect(1).toBe(2));\n")
        code, log = self.run_bun()
        self.assertNotEqual(code, 0)
        with self.assertRaises(RuntimeError):
            validate_tests(self.project, 'foundation', log)

    # 验证新增 skip 或 todo 用例即使不导致 Bun 失败也无法通过门禁。
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
