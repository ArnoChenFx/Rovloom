# 使用 Python 标准语法树与分词器检查维护源码中的中文文件职责和函数说明。

import argparse
import ast
import io
import json
from pathlib import Path
import re
import tokenize


ROOT = Path(__file__).resolve().parents[2]
CHINESE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U000323af]')


# 递归发现维护目录中的 Python 文件，不借助 Git，也不跟随符号链接目录。
def maintained_files(root):
    files = []
    for name in ('src', 'test', 'scripts'):
        directory = root / name
        if directory.exists() and not directory.is_symlink():
            for path in directory.rglob('*.py'):
                relative = path.relative_to(directory)
                if (not path.is_symlink() and path.is_file()
                        and not any(part in ('node_modules', '__pycache__') for part in relative.parts)
                        and not any(parent.is_symlink() for parent in path.parents if parent != root)):
                    files.append(path)
    return sorted(files)


# 将错误转换成与 JavaScript 检查器相同的文件和位置字段。
def issue(filename, line, column, message):
    return {'path': str(filename), 'line': line, 'column': column, 'message': message}


# 收集紧邻锚点之前的独立注释块，保持缩进一致并排除文件职责块。
def preceding_description(lines, comments, line, column, header_rows):
    row = line - 1
    while row > 0 and not lines[row - 1].strip():
        row -= 1
    block = []
    while row > 0:
        comment = comments.get(row)
        if comment is None or comment.start[1] != column or lines[row - 1][:comment.start[1]].strip():
            break
        block.append(comment)
        row -= 1
    return any(comment.start[0] not in header_rows and CHINESE.search(comment.string) for comment in block)


# 识别文件最前面的职责块；现有模块 docstring 可承担职责说明，检查器不创建 docstring。
def module_header(tree, tokens, lines):
    header = []
    for token in tokens:
        if token.type == tokenize.COMMENT:
            if header and any(not lines[row - 1].strip() for row in range(header[-1].end[0] + 1, token.start[0])):
                break
            header.append(token)
        elif token.type not in (tokenize.ENCODING, tokenize.NL, tokenize.NEWLINE, tokenize.ENDMARKER):
            break
    documented = bool(CHINESE.search(ast.get_docstring(tree, clean=False) or ''))
    documented = documented or any(CHINESE.search(token.string) for token in header)
    return documented, {token.start[0] for token in header}


# 检查一个 Python 文件，使用父节点确定 lambda 所在的最近语句。
def check_source(source, filename='<input>'):
    result = {'files': 1, 'functions': 0, 'errors': []}
    try:
        tree = ast.parse(source, filename=str(filename))
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (SyntaxError, tokenize.TokenError, IndentationError) as error:
        result['errors'].append(issue(filename, getattr(error, 'lineno', None) or 1,
                                      getattr(error, 'offset', None) or 1, f'syntax: {error}'))
        return result
    lines = source.splitlines()
    comments = {token.start[0]: token for token in tokens if token.type == tokenize.COMMENT}
    documented, header_rows = module_header(tree, tokens, lines)
    if not documented:
        result['errors'].append(issue(filename, 1, 1, 'missing Chinese file responsibility comment'))
    parents = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        result['functions'] += 1
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            anchors = [node.lineno, *(decorator.lineno for decorator in node.decorator_list)]
            described = bool(CHINESE.search(ast.get_docstring(node, clean=False) or ''))
            described = described or any(preceding_description(lines, comments, row, node.col_offset, header_rows)
                                         for row in anchors)
        else:
            statement = parents.get(node)
            while statement is not None and not isinstance(statement, ast.stmt):
                statement = parents.get(statement)
            described = False
            if statement is not None and not isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                anchors = [statement.lineno]
                described = any(preceding_description(lines, comments, row, statement.col_offset, header_rows)
                                for row in anchors)
            comment = comments.get(node.end_lineno)
            if comment is not None:
                # AST 列位置使用 UTF-8 字节，分词器列位置使用 Unicode 字符；先统一单位。
                end_column = len(lines[node.end_lineno - 1].encode('utf-8')[:node.end_col_offset].decode('utf-8'))
                described = described or (comment.start[1] >= end_column and bool(CHINESE.search(comment.string)))
        if not described:
            result['errors'].append(issue(filename, node.lineno, node.col_offset + 1,
                                          f'missing Chinese function description ({type(node).__name__})'))
    return result


# 合并仓库内 Python 源文件的检查结果，并把解码问题作为检查失败报告。
def check_repository(root):
    if not root.is_dir():
        raise ValueError(f'Comment-check root is not a directory: {root}')
    result = {'files': 0, 'functions': 0, 'errors': []}
    for path in maintained_files(root):
        try:
            with tokenize.open(path) as source:
                checked = check_source(source.read(), path)
        except (OSError, UnicodeError, SyntaxError) as error:
            checked = {'files': 1, 'functions': 0, 'errors': [issue(path, 1, 1, f'source: {error}')]}
        result['files'] += checked['files']
        result['functions'] += checked['functions']
        result['errors'].extend(checked['errors'])
    return result


# 提供可独立运行的只读入口和供 JavaScript 聚合的 JSON 输出。
def main():
    parser = argparse.ArgumentParser(description='Check Chinese Python source comments.')
    parser.add_argument('root', type=Path, nargs='?', default=ROOT)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    result = check_repository(root)
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        for error in result['errors']:
            path = Path(error['path']).relative_to(root)
            print(f"{path}:{error['line']}:{error['column']}: {error['message']}")
        print(f"comments: {result['files']} files, {result['functions']} functions, {len(result['errors'])} errors")
    return 1 if result['errors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
