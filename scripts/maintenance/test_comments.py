# 回归 Python 中文注释门禁的文件职责、函数实现、装饰器和 lambda 关联边界。

import tempfile
from pathlib import Path
import unittest

from check_comments import check_repository, check_source


HEADER = '# 维护测试模块的职责。\n\n'


class CommentTests(unittest.TestCase):
    # 验证中文文件职责和函数前注释构成完整覆盖。
    def test_described_functions(self):
        source = HEADER + '''# 计算输入值。
def plain(value):
    return value

class Example:
    # 初始化成员值。
    def __init__(self):
        self.value = 1

    # 异步读取成员值。
    async def current(self):
        return self.value
'''
        result = check_source(source)
        self.assertEqual(result['functions'], 3)
        self.assertEqual(result['errors'], [])

    # 验证函数、异步函数和嵌套函数都必须单独说明。
    def test_missing_nested_descriptions(self):
        result = check_source(HEADER + '''# 创建外层函数。
def outer():
    def nested():
        return 1
    async def asynchronous():
        return 2
    return nested
''')
        self.assertEqual(result['functions'], 3)
        self.assertEqual(len(result['errors']), 2)

    # 兼容已经存在的中文模块和函数 docstring，且不改写源码。
    def test_existing_docstrings(self):
        source = '"""维护模块职责。"""\n\ndef value():\n    """返回一个值。"""\n    return 1\n'
        self.assertEqual(check_source(source)['errors'], [])

    # 英文注释、英文 docstring 和普通中文字符串都不能替代中文职责。
    def test_chinese_text_must_be_documentation(self):
        source = '# Module responsibility.\nlabel = "中文 # 不是注释"\n\n# Return its input.\ndef value():\n    """Return one value."""\n    return 1\n'
        self.assertEqual(len(check_source(source)['errors']), 2)

    # 将文件头和首个函数说明作为不同职责块处理。
    def test_header_does_not_describe_first_function(self):
        self.assertEqual(len(check_source('# 维护模块职责。\ndef value():\n    return 1\n')['errors']), 1)
        self.assertEqual(check_source(HEADER + '# 返回一个值。\ndef value():\n    return 1\n')['errors'], [])

    # 接受首个装饰器前或 def 前的独立说明，包括多行装饰器。
    def test_decorator_anchors(self):
        sources = [
            HEADER + '# 包装输入函数。\n@decorate\ndef value():\n    return 1\n',
            HEADER + '@decorate\n# 返回一个值。\ndef value():\n    return 1\n',
            HEADER + '# 包装输入函数。\n@decorate(\n    enabled=True,\n)\nasync def value():\n    return 1\n',
            HEADER + 'class Value:\n    # 读取当前值。\n    @property\n    def current(self):\n        return 1\n',
        ]
        for source in sources:
            with self.subTest(source=source):
                self.assertEqual(check_source(source)['errors'], [])

    # 装饰器参数内部的注释不描述被装饰函数。
    def test_decorator_argument_comment_is_not_function_description(self):
        source = HEADER + '@decorate(\n    # 开启某个装饰器选项。\n    enabled=True,\n)\ndef value():\n    return 1\n'
        self.assertEqual(len(check_source(source)['errors']), 1)

    # lambda 可由最近所在语句之前的中文说明覆盖。
    def test_lambda_statement_description(self):
        source = HEADER + '# 按第二项排序。\nitems = sorted(values, key=lambda value: value[1])\n'
        result = check_source(source)
        self.assertEqual(result['functions'], 1)
        self.assertEqual(result['errors'], [])

    # lambda 可由其结束行的尾部注释说明，中文前缀需要正确换算列位置。
    def test_lambda_trailing_description(self):
        for source in [
            HEADER + 'identity = lambda value: value  # 返回输入值。\n',
            HEADER + '标签 = "中文"; identity = lambda value: value  # 返回输入值。\n',
            HEADER + 'identity = lambda value: (\n    value\n)  # 返回输入值。\n',
        ]:
            with self.subTest(source=source):
                self.assertEqual(check_source(source)['errors'], [])

    # lambda 不借用前一语句的尾注、后续语句注释或函数体内部注释。
    def test_lambda_invalid_comment_boundaries(self):
        for source in [
            HEADER + 'previous = 1  # 返回输入值。\nidentity = lambda value: value\n',
            HEADER + 'identity = lambda value: value\n# 返回输入值。\nnext_value = 1\n',
            HEADER + 'identity = (\n    # 返回输入值。\n    lambda value: value\n)\n',
            HEADER + 'identity = lambda value: value  # Return its input.\n',
        ]:
            with self.subTest(source=source):
                self.assertEqual(len(check_source(source)['errors']), 1)

    # 嵌套 lambda 均计为函数；所在语句的说明按明确规则关联全部实现。
    def test_nested_lambdas_are_counted(self):
        result = check_source(HEADER + '# 创建返回输入值的闭包。\nfactory = lambda value: lambda: value\n')
        self.assertEqual(result['functions'], 2)
        self.assertEqual(result['errors'], [])

    # 参数默认值、装饰器和类基类中的 lambda 不能借用外层声明说明。
    def test_lambda_cannot_borrow_definition_description(self):
        sources = [
            HEADER + '# 返回默认回调值。\ndef value(callback=lambda: 1):\n    return callback()\n',
            HEADER + '# 包装输入函数。\n@decorate(lambda: 1)\ndef value():\n    return 1\n',
            HEADER + '# 定义容器。\nclass Value(create_base(lambda: 1)):\n    pass\n',
        ]
        for source in sources:
            with self.subTest(source=source):
                result = check_source(source)
                self.assertEqual(len(result['errors']), 1)
                self.assertIn('(Lambda)', result['errors'][0]['message'])

    # 文件末尾和注释中的 def 或 lambda 文字不产生虚假函数。
    def test_non_code_text_is_not_a_function(self):
        source = HEADER + '# def ignored(): lambda: 1\ntext = "def ignored(): lambda: 1"\n'
        result = check_source(source)
        self.assertEqual(result['functions'], 0)
        self.assertEqual(result['errors'], [])

    # 损坏语法必须失败，不能把正则匹配到的说明误报为覆盖成功。
    def test_syntax_errors_fail(self):
        result = check_source(HEADER + '# 返回损坏的值。\ndef broken(:\n    pass\n')
        self.assertEqual(len(result['errors']), 1)
        self.assertTrue(result['errors'][0]['message'].startswith('syntax:'))

    # 最近英文注释块和错误缩进均不能借用先前的中文说明。
    def test_nearest_comment_and_indent_boundaries(self):
        sources = [
            HEADER + '# 先前中文说明。\n\n# Current English description.\ndef value():\n    return 1\n',
            HEADER + 'class Value:\n# 读取当前值。\n    def current(self):\n        return 1\n',
        ]
        for source in sources:
            with self.subTest(source=source):
                self.assertEqual(len(check_source(source)['errors']), 1)

    # 文件头支持 shebang 和编码声明，独立函数说明仍然需要保留。
    def test_shebang_and_encoding(self):
        source = '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n# 维护模块职责。\n\n# 返回一个值。\ndef value():\n    return 1\n'
        self.assertEqual(check_source(source)['errors'], [])

    # 没有 Git 的目录递归包含维护根目录，跳过 JSON 和根目录外的 fixture。
    def test_isolated_repository_scope(self):
        with tempfile.TemporaryDirectory(prefix='rovloom-python-comments-') as temporary:
            root = Path(temporary)
            for name in ('src/fixtures/value.py', 'test/vendor/value.py', 'scripts/generated/value.py'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('value = 1\n', encoding='utf-8')
            for name in ('fixtures/value.py', 'docs/value.py', 'src/value.json', 'src/__pycache__/value.py'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('not source syntax', encoding='utf-8')
            result = check_repository(root)
            self.assertEqual(result['files'], 3)
            self.assertEqual(len(result['errors']), 3)

    # 目录和文件符号链接均不将外部源码引入维护范围。
    def test_symlink_scope(self):
        with tempfile.TemporaryDirectory(prefix='rovloom-python-comments-') as temporary:
            root = Path(temporary)
            outside = root / 'outside'
            outside.mkdir()
            (outside / 'value.py').write_text('not source syntax', encoding='utf-8')
            (root / 'src').symlink_to(outside, target_is_directory=True)
            (root / 'scripts').mkdir()
            (root / 'scripts/linked').symlink_to(outside, target_is_directory=True)
            (root / 'scripts/linked.py').symlink_to(outside / 'value.py')
            self.assertEqual(check_repository(root)['files'], 0)


if __name__ == '__main__':
    unittest.main()
