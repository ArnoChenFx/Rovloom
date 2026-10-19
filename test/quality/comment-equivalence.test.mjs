// 验证 Python 等价比较遵循源码原字节的编码声明，并保留 docstring 和语法错误边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comparePythonSources } from '../../scripts/maintenance/comment_equivalence.mjs'

// 为字节比较构造 UTF-8 源码，测试时可添加影响真实解释结果的编码声明。
function source(text) {
  return Buffer.from(text, 'utf8')
}

test(
  'Python byte comparison accepts comments and equivalent declared encodings',
  /* 验证普通中文注释不改变原程序。 */ () => {
    const utf8 = source('value = "中文"\n')
    const latin = Buffer.from('# coding: latin-1\nvalue = "caf\xe9"\n', 'latin1')
    assert.deepEqual(
      comparePythonSources([
        { path: 'comments.py', before: utf8, after: source('# 文件职责。\nvalue = "中文"\n') },
        { path: 'encoding.py', before: latin, after: source('# coding: utf-8\nvalue = "café"\n') }
      ]),
      []
    )
  }
)

test(
  'Python byte comparison rejects encoding-cookie changes that alter string values',
  /* 防止固定 UTF-8 解码掩盖源码编码变化。 */ () => {
    const errors = comparePythonSources([
      { path: 'cookie.py', before: source('value = "中文"\n'), after: source('# coding: latin-1\nvalue = "中文"\n') },
      {
        path: 'docstring.py',
        before: source('def result():\n    return 1\n'),
        after: source('def result():\n    "说明"\n    return 1\n')
      }
    ])
    assert.deepEqual(errors, ['cookie.py: Python AST differs', 'docstring.py: Python AST differs'])
  }
)

test(
  'Python byte comparison reports unknown encodings and conflicting BOM cookies',
  /* 将解释器无法解码的源码作为失败报告。 */ () => {
    const before = source('value = 1\n')
    const errors = comparePythonSources([
      { path: 'unknown.py', before, after: source('# coding: unavailable-codec\nvalue = 1\n') },
      {
        path: 'bom.py',
        before,
        after: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source('# coding: latin-1\nvalue = 1\n')])
      }
    ])
    assert.equal(errors.length, 2)
    assert.match(errors[0], /^unknown\.py: .*unknown encoding/)
    assert.match(errors[1], /^bom\.py: .*encoding problem/)
  }
)
