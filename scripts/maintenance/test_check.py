"""Positive/negative maintenance checks in disposable Git repositories."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from check import ROOT, documents, document_links, executed_test_files, test_discovery, transient_paths


class RepositoryChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='rovloom-maintenance-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.files = set()
        self.write('.gitignore', (ROOT / '.gitignore').read_text())
        self.write('.bun-version', '1.4.3\n')
        self.package = {'packageManager': 'bun@1.4.3', 'engines': {'bun': '1.4.3'},
                        'dependencies': {'example': '1.0.0'}, 'scripts': {'build': 'bun build.mjs'}}
        self.write('package.json', json.dumps(self.package))
        self.write('bun.lock', '{}\n')
        for name, locale in [('README.md', 'en'), ('README-zh.md', 'zh')]:
            self.write(name, f'# Rovloom\n\nBun 1.4.3\n\n```sh\nbun install\nbun run build\n```\n'
                            f'\n```mermaid\nflowchart TB\n  A[{locale}]\n```\n')
            self.write(f'docs/assets/architecture/target.{locale}.mmd', f'flowchart TB\n  A[{locale}]\n')
        for name in ('check.py', 'render-markdown.mjs', 'run_python_tests.py'):
            self.write(f'scripts/maintenance/{name}', (ROOT / 'scripts/maintenance' / name).read_text())

    def write(self, path, content, force=False):
        dest = self.root / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding='utf-8')
        subprocess.run(['git', 'add', *(['--force'] if force else []), '--', path], cwd=self.root, check=True)
        self.files.add(path)

    def cli(self, *args):
        return subprocess.run(['python3', 'scripts/maintenance/check.py', *args], cwd=self.root,
                              text=True, capture_output=True, timeout=30)

    def links(self):
        return document_links(self.files, documents(self.root, self.files))

    def test_valid_markdown_forms_unicode_duplicate_headings_and_literal_code(self):
        self.write('docs/target (v2).md', '# 标题 与 `code`\n\n## Repeat!\n\n## Repeat!\n\n'
                   '## Repeat-1\n\nSetext heading\n--------------\n\n<a id="explicit"></a>\n')
        self.write('docs/image.svg', '<svg/>')
        self.write('docs/links.md', '[inline](<target (v2).md#标题-与-code>)\n\n'
                   '[balanced](target%20\\(v2\\).md#repeat-1)\n\n'
                   '[full][target]\n\n[target]: <target (v2).md#repeat-1-1> "Title"\n\n'
                   '[collapsed][]\n\n[collapsed]: <target (v2).md#setext-heading>\n\n'
                   '[shortcut]\n\n[shortcut]: <target (v2).md#explicit>\n\n'
                   '![picture](image.svg)\n\n<img src="image.svg">\n\n'
                   '<a href="target%20(v2).md#repeat">HTML</a>\n\n'
                   '[external](https://example.invalid/missing#never-fetched)\n\n'
                   '`[literal](missing-inline.md)`\n\n```md\n[example](missing-fenced.md)\n```\n\n'
                   '    [indented](missing-indented.md)\n\n<!-- [comment](missing-comment.md) -->\n')
        self.assertEqual(self.links(), [])
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_deleted_or_untracked_link_target_and_removed_heading_fail(self):
        self.write('docs/target.md', '# Surviving heading\n')
        self.write('docs/links.md', '[missing file](missing.md)\n\n[target](target.md#removed-heading)\n')
        # An untracked file present on the workstation must not make CI pass.
        (self.root / 'docs/missing.md').write_text('# Untracked\n')
        result = self.cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('broken local link', result.stderr)
        self.assertIn('missing Markdown anchor', result.stderr)

    def test_reference_html_image_and_same_page_anchor_fail(self):
        for content in ('[link][ref]\n\n[ref]: missing.md\n', '<a href="missing.md">x</a>',
                        '![image](missing.png)', '<img src="missing.png">', '[self](#missing)'):
            with self.subTest(content=content):
                self.write('docs/link.md', content)
                self.assertTrue(self.links())

    def test_relative_directories_and_encoded_paths(self):
        self.write('docs/版本 文件.md', '# 中文\n')
        self.write('docs/nested/link.md', '[parent](../)\n\n'
                   '[encoded](../%E7%89%88%E6%9C%AC%20%E6%96%87%E4%BB%B6.md#中文)\n')
        self.assertEqual(self.links(), [])
        self.write('docs/nested/link.md', '[outside](../../../outside.md)\n')
        self.assertIn('broken local link', self.links()[0])

    def test_readme_commands_runtime_pin_and_diagram_drift_fail(self):
        path = self.root / 'README-zh.md'
        original = path.read_text()
        for old, new, message in [('bun run build', 'npm run build', 'shell command blocks differ'),
                                  ('Bun 1.4.3', 'Bun 9.9.9', 'Bun version differs'),
                                  ('Bun 1.4.3', 'Bun 1.4.30', 'Bun version differs'),
                                  ('A[zh]', 'A[changed]', 'Mermaid fence differs')]:
            with self.subTest(message=message):
                self.write('README-zh.md', original.replace(old, new))
                result = self.cli()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_environment_assignments_wrappers_and_newlines_do_not_hide_node(self):
        for command in ('FOO=1 node build.mjs', 'env node build.mjs',
                        'FOO=1 /usr/bin/env -u UNUSED FOO=2 node build.mjs',
                        'env --chdir=/tmp -- node build.mjs', 'command node build.mjs',
                        'exec -a synthetic node build.mjs', 'env -S "node build.mjs"',
                        'bun first.mjs\nnode second.mjs'):
            with self.subTest(command=command):
                package = {**self.package, 'scripts': {'build': command}}
                self.write('package.json', json.dumps(package))
                result = self.cli()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('pinned Bun runtime', result.stderr)
        self.write('package.json', json.dumps(self.package))
        for name in ('README.md', 'README-zh.md'):
            self.write(name, (self.root / name).read_text().replace('bun install', 'FOO=1 node install.mjs'))
        result = self.cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('development commands must use Bun', result.stderr)

    def test_dependency_ranges_runtime_drift_and_direct_node_commands_fail(self):
        for mutate, message in [
                (lambda p: p['dependencies'].update(example='^1.0.0'), 'exact dependency version'),
                (lambda p: p['engines'].update(bun='latest'), 'Bun pins differ'),
                (lambda p: p['scripts'].update(build='bun first.mjs && /usr/bin/node second.mjs'), 'pinned Bun runtime')]:
            with self.subTest(message=message):
                package = json.loads(json.dumps(self.package))
                mutate(package)
                self.write('package.json', json.dumps(package))
                result = self.cli()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_both_readmes_cannot_switch_to_npm_together(self):
        for name in ('README.md', 'README-zh.md'):
            self.write(name, (self.root / name).read_text().replace('bun install', 'npm install'))
        result = self.cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('development commands must use Bun', result.stderr)

    def test_bun_environment_wrappers_literal_arguments_and_lookup_are_allowed(self):
        for command in ('FOO=1 bun build.mjs', 'env -u UNUSED FOO=1 bun build.mjs',
                        'command bun build.mjs', 'exec bun build.mjs', 'command -v node',
                        'bun -e "console.log(\'node\')"', 'bun first.mjs\nbun second.mjs'):
            with self.subTest(command=command):
                self.write('package.json', json.dumps({**self.package, 'scripts': {'build': command}}))
                result = self.cli()
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_reintroduced_transient_record_fails_even_if_force_added(self):
        self.write('docs/issue4/integration-verification.json', '{}\n', force=True)
        result = self.cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('transient execution record', result.stderr)

    def test_ignore_rules_cover_outputs_but_allow_versioned_evidence(self):
        for path, ignored in [('docs/bun/typecheck.log', True), ('docs/bun/review/typecheck.execve.log', True),
                              ('docs/worker-logs/task.txt', True), ('docs/issue4/integration-verification.json', True),
                              ('fixtures/p0/native.log', False), ('docs/bun/provenance.json', False),
                              ('docs/bun/review/original-test-inventory.json', False)]:
            with self.subTest(path=path):
                result = subprocess.run(['git', 'check-ignore', '--no-index', '-q', path], cwd=self.root)
                self.assertEqual(result.returncode, 0 if ignored else 1)

    def test_cli_rejects_unexecuted_script_test_file(self):
        evidence = self.root / 'evidence'
        evidence.mkdir()
        (evidence / 'verification.json').write_text('{"records": []}')
        report = self.root / 'python-tests.json'
        report.write_text('{"format": 1, "files": {}}')
        (evidence / 'foundation.junit.xml').write_text(
            '<testsuites><testcase file="test/base.test.ts" name="base"/></testsuites>')
        for label, path in [('p0', 'scripts/p0/fixtures.test.mjs'),
                            ('bun-compatibility', 'scripts/bun/compatibility.test.mjs')]:
            (evidence / f'{label}.log').write_text(f'{path}:\n(pass) real test\n')
            self.write(path, '// already executed test source\n')
        self.write('test/base.test.ts', '// already executed test source\n')
        self.assertEqual(self.cli('--evidence', str(evidence), '--python-report', str(report)).returncode, 0)
        self.write('scripts/bun/nested/new.test.mjs', '// omitted from the run\n')
        result = self.cli('--evidence', str(evidence), '--python-report', str(report))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('scripts/bun/nested/new.test.mjs: test file was not executed', result.stderr)

    def test_precise_artifact_rules_allow_versioned_inputs_and_future_maintained_docs(self):
        good = {'fixtures/p0/review-native-evidence.tar.gz', 'fixtures/p0/native.log',
                'fixtures/issue4/native-validator/matrix.json', 'test/native-contract/focused-review.test.ts',
                'docs/bun/provenance.json', 'docs/bun/sdk-compatibility.json',
                'docs/bun/review/original-test-inventory.json', 'docs/bun/review/provenance.json',
                'docs/adr/0005-protocol-v3.md', 'docs/issue4/IMPLEMENTATION-API.md'}
        self.assertEqual(transient_paths(good), [])
        bad = {'docs/PROGRESS.md', 'docs/bun/verification/new.log', 'docs/bun/review/native-replay.log',
               'docs/issue4/worker-logs/new.log', 'docs/p0/review-verification.json',
               'docs/issue4/implementation-logs/new.txt'}
        self.assertEqual(len(transient_paths(bad)), len(bad))
        # Source provenance and protocol identifiers are content, never banned words.
        self.write('docs/provenance.md', '# Protocol v3\n\nmain `abc1234`; SHA-256 ' + 'a' * 64 + '\n')
        self.assertEqual(self.cli().returncode, 0)


class DiscoveryChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='rovloom-discovery-test-')
        self.addCleanup(self.temporary.cleanup)
        self.evidence = Path(self.temporary.name)
        (self.evidence / 'foundation.junit.xml').write_text(
            '<testsuites tests="1"><testsuite><testcase file="test/base.test.ts" name="base"/>'
            '</testsuite></testsuites>')
        (self.evidence / 'p0.log').write_text('bun test\n\nscripts/p0/fixtures.test.mjs:\n(pass) case\n\n 1 pass\n 0 fail\n')
        (self.evidence / 'bun-compatibility.log').write_text(
            'bun test\n\nscripts/bun/compatibility.test.mjs:\n(pass) case\n\n 1 pass\n 0 fail\n')
        self.files = {'test/base.test.ts', 'scripts/p0/fixtures.test.mjs', 'scripts/bun/compatibility.test.mjs'}

    def test_all_executed_files_pass_without_fixing_current_test_count(self):
        self.assertEqual(test_discovery(self.files, self.evidence), [])
        path = self.evidence / 'p0.log'
        path.write_text(path.read_text() + '\nscripts/p0/new.spec.mjs:\n(pass) new nested or parameterized test\n')
        self.files.add('scripts/p0/new.spec.mjs')
        self.assertEqual(test_discovery(self.files, self.evidence), [])

    def test_new_file_in_script_test_or_new_suite_location_is_rejected(self):
        for path in ('scripts/bun/new.test.mjs', 'scripts/p0/nested/added.spec.ts',
                     'test/nested/new.test.ts', 'new-suite/added_test.ts'):
            with self.subTest(path=path):
                errors = test_discovery(self.files | {path}, self.evidence)
                self.assertEqual(len(errors), 1)
                self.assertIn(path, errors[0])
                self.assertIn('was not executed', errors[0])

    def test_source_code_examples_in_fixtures_are_not_test_suites(self):
        self.assertEqual(test_discovery(self.files | {'fixtures/examples/example.test.ts'}, self.evidence), [])

    def test_reported_untracked_test_is_rejected(self):
        self.assertIn('not tracked source', test_discovery(self.files - {'test/base.test.ts'}, self.evidence)[0])

    def test_script_skip_todo_failure_or_empty_file_is_rejected(self):
        for result in ('(pass) earlier\n(skip) case', '(pass) earlier\n(todo) case',
                       '(pass) earlier\n(fail) case', ''):
            with self.subTest(result=result):
                (self.evidence / 'p0.log').write_text('scripts/p0/fixtures.test.mjs:\n' + result + '\n')
                with self.assertRaisesRegex(ValueError, 'no executed tests or unsuccessful'):
                    executed_test_files(self.evidence)

    def test_empty_and_skipped_foundation_or_missing_auxiliary_suite_is_rejected(self):
        original = (self.evidence / 'foundation.junit.xml').read_text()
        for report in ('<testsuites/>', original.replace('/>', '><skipped/></testcase>')):
            with self.subTest(report=report):
                (self.evidence / 'foundation.junit.xml').write_text(report)
                with self.assertRaises(ValueError):
                    executed_test_files(self.evidence)
        (self.evidence / 'foundation.junit.xml').write_text(original)
        (self.evidence / 'p0.log').write_text('0 pass\n0 fail\n')
        with self.assertRaisesRegex(ValueError, 'no discovered test files'):
            executed_test_files(self.evidence)


if __name__ == '__main__':
    unittest.main()
