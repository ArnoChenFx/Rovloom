# 检查版本化文档链接、工具链约束、临时记录和实际测试执行覆盖。
"""Check maintained documentation, transient paths and executed test discovery."""

import argparse
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import shlex
import subprocess
import sys
import unicodedata
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET

from run_python_tests import test_files as python_test_files


ROOT = Path(__file__).resolve().parents[2]
TEST_FILE = re.compile(r'[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$')
# Removed execution records, scoped to their original locations. Versioned inputs
# under fixtures/ and provenance/compatibility records are deliberately unaffected.
TRANSIENT_DIRS = (
    'docs/bun/verification/', 'docs/issue4/implementation-logs/',
    'docs/issue4/focused-review-logs/', 'docs/worker-logs/',
)
TRANSIENT_FILES = {
    'docs/HANDOVER.md', 'docs/PROGRESS.md', 'docs/FOUNDATION-REVIEW.md',
    'docs/bun/CI.md', 'docs/bun/REPORT.md', 'docs/bun/REVIEW.md',
    'docs/bun/dependency-migration.json', 'docs/bun/verified-inputs.json',
    'docs/bun/native-verification.json', 'docs/p0/REPORT.md', 'docs/p0/REVIEW.md',
    'docs/bun/review/ci-first-failure.json', 'docs/bun/review/review.json',
    'docs/bun/review/verified-inputs.json',
    'docs/p0/review-verification.json', 'docs/issue4/FOCUSED-REVIEW-API.md',
    'docs/issue4/FOCUSED-REVIEW.md', 'docs/issue4/IMPLEMENTATION-REPORT.md',
    'docs/issue4/VERIFICATION.md', 'docs/issue4/design-audit.json',
    'docs/issue4/integration-review.json', 'docs/issue4/matrix-implementation-coverage.json',
}


# 读取 Git 跟踪文件集合，排除工作区中未纳入版本控制的文件。
def tracked_files(root):
    result = subprocess.run(['git', 'ls-files', '-z'], cwd=root, check=True, capture_output=True)
    return set(result.stdout.decode('utf-8').rstrip('\0').split('\0')) - {''}


# 按限定路径规则报告被版本化的临时执行记录，保留长期证据材料。
def transient_paths(files):
    found = []
    for path in sorted(files):
        scoped = path.startswith(('docs/bun/', 'docs/p0/', 'docs/issue4/'))
        if (path in TRANSIENT_FILES or path.startswith(TRANSIENT_DIRS) or
                (scoped and (path.endswith(('.log', '-verification.json')) or '/worker-logs/' in path))):
            found.append(f'{path}: transient execution record; put output outside the checkout')
    return found


# 按 GitHub 标题规则生成锚点，保留 Unicode 字母、数字和组合标记。
def heading_slug(text):
    # GitHub heading convention: lower case, remove punctuation/symbols, retain
    # Unicode letters/numbers/marks, underscores and hyphens; spaces become '-'.
    return ''.join(c for c in text.lower() if c in ' _-' or
                   unicodedata.category(c)[0] in 'LNM').replace(' ', '-')


class Document(HTMLParser):
    # 解析渲染后的 HTML，收集链接与锚点并为重复标题分配唯一锚点。
    def __init__(self, rendered):
        super().__init__(convert_charrefs=True)
        self.links, self.anchors, self.headings = [], set(), []
        self.heading = None
        self.feed(rendered)
        used = set()
        for heading in self.headings:
            base = heading_slug(heading)
            slug, suffix = base, 0
            while slug in used:
                suffix += 1
                slug = f'{base}-{suffix}'
            used.add(slug)
            self.anchors.add(slug)

    # 收集链接和显式锚点，并开始累计标题文字及图片替代文本。
    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        for key in ('href', 'src'):
            if attrs.get(key) is not None:
                self.links.append(attrs[key])
        for key in (('id', 'name') if tag == 'a' else ('id',)):
            if attrs.get(key):
                self.anchors.add(attrs[key])
        if re.fullmatch('h[1-6]', tag):
            self.heading = ''
        if self.heading is not None and tag == 'img':
            self.heading += attrs.get('alt', '')

    # 让自闭合标签使用相同的链接、锚点与标题处理规则。
    def handle_startendtag(self, tag, attributes):
        self.handle_starttag(tag, attributes)

    # 将 HTML 文本节点追加到当前尚未结束的标题。
    def handle_data(self, data):
        if self.heading is not None:
            self.heading += data

    # 在标题结束时保存完整文字并清空当前标题状态。
    def handle_endtag(self, tag):
        if re.fullmatch('h[1-6]', tag) and self.heading is not None:
            self.headings.append(self.heading)
            self.heading = None


# 用 Bun 批量渲染版本化 Markdown，再返回按路径索引的文档解析结果。
def documents(root, files):
    names = sorted(path for path in files if path.lower().endswith('.md'))
    sources = [(root / path).read_text(encoding='utf-8') for path in names]
    rendered = subprocess.run(['bun', '--no-env-file', str(ROOT / 'scripts/maintenance/render-markdown.mjs')],
                              input=json.dumps(sources), text=True, capture_output=True, check=True, timeout=30)
    return dict(zip(names, map(Document, json.loads(rendered.stdout)), strict=True))


# 离线核对本地链接目标和 Markdown 锚点，返回错误列表。
def document_links(files, docs):
    directories = {str(parent) for path in files for parent in PurePosixPath(path).parents}
    errors = []
    for source, doc in docs.items():
        for link in doc.links:
            url = urlsplit(link.strip())
            if url.scheme or url.netloc:  # Offline check: no external requests.
                continue
            target = (posixpath.normpath(posixpath.join(posixpath.dirname(source), unquote(url.path)))
                      if url.path else source)
            if target not in files and target not in directories:
                errors.append(f'{source}: broken local link {link!r} (target {target})')
            elif url.fragment and target in docs and unquote(url.fragment) not in docs[target].anchors:
                errors.append(f'{source}: missing Markdown anchor {link!r}')
    return errors


# 提取指定语言的完整围栏代码块，支持反引号和波浪线围栏。
def code_blocks(text, languages):
    blocks, active, lines = [], None, []
    for line in text.splitlines():
        fence = re.fullmatch(r' {0,3}(`{3,}|~{3,})\s*([^\s]*)\s*', line)
        if active:
            if fence and fence[1][0] == active[0][0] and len(fence[1]) >= len(active[0]) and not fence[2]:
                if active[1] in languages:
                    blocks.append('\n'.join(lines).strip())
                active, lines = None, []
            else:
                lines.append(line)
        elif fence:
            active = (fence[1], fence[2])
    return blocks


# 静态识别直接或经常用包装器执行的其他运行时，忽略仅查询命令的形式。
def other_runtime_commands(command):
    # Recognize direct commands and common explicit wrappers. This is static
    # inspection, not shell evaluation or a complete shell language parser.
    lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|\n')
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    groups, current = [], []
    for token in lexer:
        if token and set(token) <= set(';&|\n'):
            groups.append(current)
            current = []
        else:
            current.append(token)
    groups.append(current)
    for tokens in groups:
        while tokens:
            if re.match(r'^[A-Za-z_][A-Za-z_0-9]*=', tokens[0]):
                tokens.pop(0)
                continue
            name = PurePosixPath(tokens.pop(0)).name
            if name in {'node', 'nodejs', 'npm', 'npx', 'yarn', 'pnpm'}:
                return True
            if name not in {'env', 'command', 'exec'}:
                break
            while tokens and tokens[0].startswith('-'):
                option = tokens.pop(0)
                if option == '--':
                    break
                if name == 'command' and option in {'-v', '-V'}:
                    tokens = []  # Lookup-only forms do not execute the named command.
                    break
                if name == 'env' and option in {'-u', '--unset', '-C', '--chdir'}:
                    tokens = tokens[1:]
                elif name == 'env' and option in {'-S', '--split-string'} and tokens:
                    tokens = shlex.split(tokens.pop(0)) + tokens
                elif name == 'env' and option.startswith('--split-string='):
                    tokens = shlex.split(option.split('=', 1)[1]) + tokens
                elif name == 'exec' and option == '-a':
                    tokens = tokens[1:]
    return False


# 检查精确依赖版本、Bun 固定版本及双语 README 命令和图示的一致性。
def toolchain_and_readmes(root):
    errors = []
    package = json.loads((root / 'package.json').read_text())
    version = (root / '.bun-version').read_text().strip()
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        errors.append('.bun-version: require an exact stable Bun version')
    if package.get('packageManager') != f'bun@{version}' or package.get('engines', {}).get('bun') != version:
        errors.append('package.json: Bun pins differ from .bun-version')
    for group in ('dependencies', 'devDependencies', 'optionalDependencies'):
        for name, pin in package.get(group, {}).items():
            if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', pin):
                errors.append(f'package.json: {name} must use an exact dependency version')
    if not (root / 'bun.lock').is_file():
        errors.append('bun.lock: frozen install requires the committed lockfile')
    for name, command in package['scripts'].items():
        # Check executable tokens, not words in comments, fixtures or protocol text.
        if other_runtime_commands(command):
            errors.append(f'package.json scripts.{name}: use the pinned Bun runtime')
    readmes = [(root / name).read_text() for name in ('README.md', 'README-zh.md')]
    commands = [code_blocks(text, {'sh', 'bash', 'shell'}) for text in readmes]
    if not commands[0] or commands[0] != commands[1]:
        errors.append('README.md / README-zh.md: shell command blocks differ or are missing')
    for name, text in zip(('README.md', 'README-zh.md'), readmes):
        versions = re.findall(r'\bBun\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=$|[^\w.+-]|\.(?=\s|$))', text)
        if set(versions) != {version}:
            errors.append(f'{name}: Bun version differs from .bun-version')
        for block in code_blocks(text, {'sh', 'bash', 'shell'}):
            if any(other_runtime_commands(line) for line in block.splitlines()):
                errors.append(f'{name}: development commands must use Bun')
            for script in re.findall(r'^bun (?:--no-env-file )?run ([\w:-]+)\s*$', block, re.M):
                if script not in package['scripts']:
                    errors.append(f'{name}: unknown package script {script}')
        locale = 'en' if name == 'README.md' else 'zh'
        asset = root / f'docs/assets/architecture/target.{locale}.mmd'
        if code_blocks(text, {'mermaid'}) != [asset.read_text().strip()]:
            errors.append(f'{name}: Mermaid fence differs from {asset.relative_to(root)}')
    return errors


# 从 JUnit 和 Bun 日志汇总实际成功执行的文件，拒绝空或不成功的测试段。
def executed_test_files(evidence):
    root = ET.parse(evidence / 'foundation.junit.xml').getroot()
    cases = list(root.iter('testcase'))
    if not cases or any(node.tag in {'skipped', 'failure', 'error'} for node in root.iter()):
        raise ValueError('foundation report contains no tests or unsuccessful cases')
    files = {case.attrib['file'].removeprefix('./') for case in cases}
    for label in ('p0', 'bun-compatibility'):
        log = (evidence / f'{label}.log').read_text()
        sections = list(re.finditer(r'^([^\r\n]+):\s*$', log, re.M))
        found = set()
        for index, section in enumerate(sections):
            path = section[1].removeprefix('./')
            if not TEST_FILE.search(path):
                continue
            end = sections[index + 1].start() if index + 1 < len(sections) else len(log)
            output = log[section.end():end]
            if not re.search(r'^\(pass\) ', output, re.M) or re.search(r'^\((?:fail|skip|todo)\) ', output, re.M):
                raise ValueError(f'{path}: no executed tests or unsuccessful cases')
            found.add(path)
        if not found:
            raise ValueError(f'{label}: no discovered test files in Bun report')
        files |= found
    return files


# 比较版本化测试源码与执行文件集合，报告漏跑或来源未跟踪的文件。
def test_discovery(files, evidence):
    # Any new suite location must be wired into CI; fixture source examples are data.
    expected = {path for path in files if TEST_FILE.search(path) and not path.startswith('fixtures/')}
    actual = executed_test_files(evidence)
    return ([f'{path}: test file was not executed by verification' for path in sorted(expected - actual)] +
            [f'{path}: reported test file is not tracked source' for path in sorted(actual - expected)])


# 核对 Python 报告覆盖、退出码及用例来源，拒绝跳过、失败和空文件。
def python_test_discovery(files, report_path):
    report = json.loads(report_path.read_text())
    if report.get('format') != 1 or not isinstance(report.get('files'), dict):
        raise ValueError('invalid Python execution report')
    expected, records = python_test_files(files), report['files']
    errors = [f'{path}: Python test file was not executed' for path in sorted(expected - records.keys())]
    errors += [f'{path}: reported Python file is not tracked test source' for path in sorted(records.keys() - expected)]
    for path, record in records.items():
        cases = record['cases']
        if (record['exit'] != 0 or not cases or
                any(case['status'] != 'passed' or case['file'] != path for case in cases)):
            errors.append(f'{path}: Python tests skipped, failed, empty or not executed from this file')
    return errors


# 运行维护检查，按需追加执行覆盖检查，并用退出码和错误清单报告结果。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, help='completed scripts/bun/verify.py output; also check discovery')
    parser.add_argument('--python-report', type=Path, help='actual run_python_tests.py execution results')
    args = parser.parse_args()
    files = tracked_files(ROOT)
    errors = transient_paths(files) + document_links(files, documents(ROOT, files)) + toolchain_and_readmes(ROOT)
    if args.evidence:
        if not args.python_report:
            parser.error('--evidence requires --python-report from run_python_tests.py')
        errors += test_discovery(files, args.evidence)
        errors += python_test_discovery(files, args.python_report)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print('Maintenance checks passed' + ('; executed test files match tracked source' if args.evidence else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
