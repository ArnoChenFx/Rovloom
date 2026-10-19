// 回归中文注释门禁的语法识别、就近关联、隔离目录范围和注释变更语义证据。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  checkRepository,
  inspectJavaScript,
  maintainedFiles,
  parseJavaScriptSources,
  semanticTree
} from '../../scripts/maintenance/comments.mjs'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const header = '// 维护测试模块的职责。\n\n'

// 解析独立测试源码，并保持语法错误以供门禁断言。
async function inspect(source, extension = '.ts') {
  const path = `/__comment_regression__/sample${extension}`
  const parsed = (await parseJavaScriptSources(new Map([[path, source]]))).get(path)
  return { ...inspectJavaScript(parsed.sourceFile, parsed.diagnostics), tree: semanticTree(parsed.sourceFile) }
}

// 创建没有 Git 元数据的隔离目录，并在测试结束后删除所有输入。
async function isolated(check) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-comments-'))
  try {
    return await check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// 为目录范围和命令行回归写入单个源码或数据文件。
function write(root, name, source) {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
  return path
}

test(
  'maintained repository code has Chinese responsibility and function descriptions',
  /* 检查完整仓库门禁。 */ async () => {
    const result = await checkRepository(repositoryRoot)
    assert(result.files > 0)
    assert(result.functions > 0)
    assert.deepEqual(result.errors, [])
  }
)

test(
  'all executable function forms need their own nearby descriptions',
  /* 覆盖声明、表达式和成员实现。 */ async () => {
    const result = await inspect(`${header}
// 返回普通函数输入。
export function declared(value: number) { return value }
// 返回表达式函数输入。
export const expression = function named(value: number) { return value }
// 返回箭头函数输入。
const arrow = (value: number) => value
class Example {
  // 保存初始值。
  constructor(public value: number) {}
  // 读取当前值。
  get current() { return this.value }
  // 更新当前值。
  set current(value: number) { this.value = value }
  // 异步返回当前值。
  async method() { return this.value }
}
const object = {
  // 生成一次值。
  *generate() { yield 1 },
  // 创建属性函数。
  property: () => 1
}
consume(/* 处理每次回调输入。 */ (value: number) => {
  // 创建局部函数。
  const nested = () => value
  return /* 延迟读取局部结果。 */ () => nested()
})
`)
    assert.deepEqual(result.errors, [])
    assert.equal(result.functions, 12)
  }
)

test(
  'a declaration description cannot cover its nested callback',
  /* 防止外层说明覆盖内嵌回调。 */ async () => {
    const result = await inspect(`${header}// 注册转换回调。\nconst value = consume((item) => item)\n`)
    assert.equal(result.functions, 1)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].message, /ArrowFunction/)
    const fixed = await inspect(
      `${header}// 注册转换回调。\nconst value = consume(/* 返回每个元素。 */ (item) => item)\n`
    )
    assert.deepEqual(fixed.errors, [])
  }
)

test(
  'nested callbacks and named expressions are visited independently',
  /* 校验函数内部的回调仍被遍历。 */ async () => {
    const result = await inspect(
      `${header}// 创建执行函数。\nconst outer = function () { return values.map((value) => value) }\n`
    )
    assert.equal(result.functions, 2)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].message, /ArrowFunction/)
  }
)

test(
  'constructors, accessors, and object methods cannot borrow class comments',
  /* 确认每个成员独立说明。 */ async () => {
    const result = await inspect(
      `${header}// 定义值容器。\nclass Value { constructor() {} get value() { return 1 } set value(v) {} method() {} }\nconst object = { method() {} }\n`
    )
    assert.equal(result.functions, 5)
    assert.equal(result.errors.length, 5)
  }
)

test(
  'function types, signatures, declarations and overloads without bodies are excluded',
  /* 排除无执行体语法。 */ async () => {
    const result = await inspect(`${header}
type Callback = (value: number) => number
type ObjectType = { method(value: number): number; new(value: number): unknown }
interface Contract { method(): void; (value: number): number; new(): Contract }
declare function external(value: number): number
abstract class Base { abstract method(): void; methodWithOverload(value: number): number }
function convert(value: string): string
function convert(value: number): number
// 返回重载实现的输入。
function convert(value: string | number) { return value }
`)
    assert.deepEqual(result.errors, [])
    assert.equal(result.functions, 1)
    const declaration = await inspect(
      `${header}declare class Value { constructor(); method(): void; get value(): number }`,
      '.d.ts'
    )
    assert.deepEqual(declaration.errors, [])
    assert.equal(declaration.functions, 0)
  }
)

test(
  'declaration files still require a Chinese responsibility header',
  /* 声明文件保留文件头门禁。 */ async () => {
    const result = await inspect('declare function external(): void', '.d.ts')
    assert.equal(result.functions, 0)
    assert.match(result.errors[0].message, /file responsibility/)
  }
)

test(
  'syntax errors fail even when apparent comments are present',
  /* 语法损坏不能伪装成已覆盖。 */ async () => {
    const result = await inspect(`${header}// 说明损坏函数。\nfunction broken( {\n`)
    assert(result.errors.some(/* 查找解析器语法诊断。 */ (error) => error.message.startsWith('syntax ')))
  }
)

test(
  'Chinese strings and English comments cannot satisfy the requirements',
  /* 区分真实中文注释与源码文本。 */ async () => {
    const result = await inspect(
      '// Module responsibility.\nconst label = "中文 // 伪装注释"\n// Return its input.\nconst identity = (value) => value\n'
    )
    assert.equal(result.errors.length, 2)
    assert.match(result.errors[0].message, /file responsibility/)
    assert.match(result.errors[1].message, /function description/)
  }
)

test(
  'batched syntax diagnostics stay attached to every affected source file',
  /* 多文件批量取诊断仍逐个保留错误，正确文件不能借用或掩盖相邻错误。 */ async () => {
    const sources = new Map([
      ['/__comment_regression__/valid.ts', header + 'export const value = 1\n'],
      ['/__comment_regression__/first.ts', header + 'const = invalid\n'],
      ['/__comment_regression__/second.ts', header + 'function broken( {\n']
    ])
    const parsed = await parseJavaScriptSources(sources)
    assert.equal(parsed.size, 3)
    for (const [path, { sourceFile, diagnostics }] of parsed) {
      const checked = inspectJavaScript(sourceFile, diagnostics)
      if (path.endsWith('/valid.ts')) {
        assert.deepEqual(checked.errors, [])
      } else {
        assert(diagnostics.length > 0)
        assert(
          checked.errors.some(/* 每个损坏输入均独立触发原语法门禁。 */ (error) => error.message.startsWith('syntax TS'))
        )
        assert(checked.errors.every(/* 诊断来源不得错配到其它文件。 */ (error) => error.path === path))
      }
    }
  }
)

test(
  'Windows source paths retain per-file batched syntax diagnostics',
  /* 在所有平台使用真实虚拟 Windows 路径，验证诊断分隔符规范化且不混淆相邻文件。 */ async () => {
    const sources = new Map([
      ['C:\\__comment_regression__\\valid.ts', header + 'export const value = 1\n'],
      ['C:\\__comment_regression__\\first.ts', header + 'const = invalid\n'],
      ['C:/__comment_regression__/second.ts', header + 'function broken( {\n']
    ])
    const parsed = await parseJavaScriptSources(sources)
    assert.equal(parsed.size, 3)
    for (const [path, { sourceFile, diagnostics }] of parsed) {
      const checked = inspectJavaScript(sourceFile, diagnostics)
      if (path.endsWith('valid.ts')) {
        assert.deepEqual(checked.errors, [])
      } else {
        assert(diagnostics.length > 0)
        assert(
          checked.errors.every(
            /* 每个错误仍归属原输入对应的规范化路径。 */ (error) => error.path === path.replaceAll('\\', '/')
          )
        )
        assert(
          checked.errors.every(/* 路径规范化不能丢弃语法错误。 */ (error) => error.message.startsWith('syntax TS'))
        )
      }
    }
  }
)

test(
  'the module responsibility block is not a first-function description',
  /* 文件职责与函数职责分别检查。 */ async () => {
    const result = await inspect('// 维护模块职责。\nfunction first() {}\n')
    assert.equal(result.errors.length, 1)
    const fixed = await inspect(`${header}// 执行首个操作。\nfunction first() {}\n`)
    assert.deepEqual(fixed.errors, [])
  }
)

test(
  'only the nearest comment block describes a function',
  /* 防止跨说明块借用先前中文。 */ async () => {
    const result = await inspect(
      `${header}// 旧的中文说明。\n\n// Current English description.\nfunction current() {}\n`
    )
    assert.equal(result.errors.length, 1)
  }
)

test(
  'previous-statement line comments cannot describe the following function',
  /* 排除上一条语句的尾部说明。 */ async () => {
    const result = await inspect(`${header}consume() // 说明前一操作。\nfunction next() {}\n`)
    assert.equal(result.errors.length, 1)
  }
)

test(
  'inline block and standalone line comments can describe callbacks',
  /* 接受回调紧前的两种注释形式。 */ async () => {
    const result = await inspect(
      `${header}consume(/* 返回一个值。 */ () => 1)\nconsume(\n  // 返回另一个值。\n  () => 2\n)\n`
    )
    assert.deepEqual(result.errors, [])
    assert.equal(result.functions, 2)
  }
)

test(
  'direct function bindings support wrappers, properties, and default exports',
  /* 保留直接绑定声明的就近说明。 */ async () => {
    const result = await inspect(`${header}
// 返回包装后的值。
export const wrapped = ((value: number) => value) satisfies (value: number) => number
class Example {
  // 返回字段函数的值。
  field = () => 1
}
// 返回默认导出值。
export default () => 2
globalThis.fetch = /* 替换下载实现并返回响应。 */ (() => {}) as typeof fetch
`)
    assert.deepEqual(result.errors, [])
    assert.equal(result.functions, 4)
  }
)

test(
  'multi-variable declarations require a distinct description for each function',
  /* 避免一条声明说明覆盖多个函数。 */ async () => {
    const result = await inspect(`${header}// 声明多个函数。\nconst first = () => 1, second = () => 2\n`)
    assert.equal(result.errors.length, 2)
    const fixed = await inspect(
      `${header}const /* 返回第一个值。 */ first = () => 1, /* 返回第二个值。 */ second = () => 2\n`
    )
    assert.deepEqual(fixed.errors, [])
  }
)

test(
  'regexes, templates, JSX and shebangs are parsed as syntax',
  /* 验证容易混淆注释的词法输入。 */ async () => {
    const result = await inspect(
      `#!/usr/bin/env bun\n${header}const pattern = /https?:\\/\\/example/\nconst template = \`literal // /* 字符串内容 */ \${pattern}\`\nconst element = <Widget value={/* 返回组件属性值。 */ () => template} />\n`,
      '.tsx'
    )
    assert.deepEqual(result.errors, [])
    assert.equal(result.functions, 1)
  }
)

test(
  'AST snapshots ignore comments and formatting while retaining real syntax',
  /* 核实比较接口忽略纯注释改动。 */ async () => {
    const before = await inspect('const value = /a\\/b/g; function result() { return `value:${value}`; }')
    const after = await inspect(
      `${header}const value=/a\\/b/g\n/** 返回当前匹配值。 */\nfunction result(){return \`value:\${value}\`}\n`
    )
    assert.deepEqual(after.tree, before.tree)
  }
)

test(
  'AST snapshots preserve ASI, operators, declaration flags and literal content',
  /* 防止词法相同但语法语义改变漏检。 */ async () => {
    const pairs = [
      ['function value(){return 1}', 'function value(){return\n1}'],
      ['const value = 1', 'let value = 1'],
      ['const value = +input', 'const value = -input'],
      ['input++', 'input--'],
      ['const value = /a/g', 'const value = /b/g'],
      ['const value = `a${input}`', 'const value = `b${input}`'],
      ['import { Value } from "value"', 'import type { Value } from "value"'],
      ['import { Value } from "value"', 'import { type Value } from "value"'],
      ['class Value extends Base {}', 'class Value implements Base {}']
    ]
    for (const [before, after] of pairs) {
      assert.notDeepEqual((await inspect(before)).tree, (await inspect(after)).tree, `${before} -> ${after}`)
    }
  }
)

test(
  'AST snapshots preserve declaration-level type-only exports and import aliases',
  /* 保留整条导出声明和导入别名的类型专用标记。 */ async () => {
    const pairs = [
      ['export { Foo } from "foo"', 'export type { Foo } from "foo"'],
      ['export * from "foo"', 'export type * from "foo"'],
      ['import Foo = require("foo")', 'import type Foo = require("foo")']
    ]
    for (const [before, after] of pairs) {
      const original = await inspect(header + before)
      const changed = await inspect(header + after)
      assert.deepEqual(original.errors, [])
      assert.deepEqual(changed.errors, [])
      assert.notDeepEqual(original.tree, changed.tree, `${before} -> ${after}`)
    }
  }
)

test(
  'recursive scope includes every maintained code path without Git',
  /* 验证数据样目录不会绕过源码门禁。 */ async () => {
    await isolated(
      /* 构造无 Git 的维护代码和非代码路径。 */ async (root) => {
        for (const name of ['src/fixtures/value.ts', 'test/vendor/value.mjs', 'scripts/generated/value.py']) {
          write(root, name, name.endsWith('.py') ? 'value = 1\n' : 'export const value = 1\n')
        }
        for (const name of ['fixtures/value.ts', 'docs/value.ts', 'dist/value.js', 'src/value.json', 'src/value.txt']) {
          write(root, name, 'not source syntax')
        }
        write(root, 'src/node_modules/dependency.js', 'invalid syntax')
        write(root, 'scripts/__pycache__/cache.py', 'invalid syntax')
        const result = await checkRepository(root)
        assert.equal(result.files, 3)
        assert.equal(result.errors.length, 3)
        assert.equal(maintainedFiles(root).length, 3)
      }
    )
  }
)

test(
  'Python discovery covers dot basenames and platform case matching',
  /* 对照真实 Python 发现集合，防止跳过仅含点文件或 Windows 大写扩展名的根目录。 */ async () => {
    for (const name of ['src/.py', 'scripts/UPPER.PY']) {
      await isolated(
        /* 每个隔离根只放一份 Python 候选，不能借其它小写文件触发检查器。 */ async (root) => {
          const path = write(root, name, 'def broken(:\n')
          const python = spawnSync(
            'python3',
            [join(repositoryRoot, 'scripts/maintenance/check_comments.py'), root, '--json'],
            {
              encoding: 'utf8',
              timeout: 30_000
            }
          )
          assert.ifError(python.error)
          assert([0, 1].includes(python.status), python.stderr)
          const expected = JSON.parse(python.stdout)
          const actual = await checkRepository(root)
          assert.equal(actual.files, expected.files, name)
          assert.equal(actual.functions, expected.functions, name)
          assert.deepEqual(
            actual.errors.map(/* 比较真实 Python 返回的语法错误内容。 */ (error) => error.message),
            expected.errors.map(/* 保留发现集合决定的全部错误。 */ (error) => error.message)
          )
          assert(maintainedFiles(root).includes(path), name)
        }
      )
    }
  }
)

test(
  'the reliability test path receives normal comment and syntax coverage',
  /* 验证可靠性测试与相邻路径同样接受注释和语法检查，补齐说明后才消除对应错误。 */ async () => {
    await isolated(
      /* 依次检查缺失说明、语法损坏和正确说明，确认目标文件不会被路径豁免。 */ async (root) => {
        const name = 'test/wire/reliability.test.ts'
        const source = 'export const value = () => 1\n'
        const target = write(root, name, source)
        for (const path of ['test/wire/reliability-other.test.ts', 'test/other/reliability.test.ts']) {
          write(root, path, source)
        }
        const result = await checkRepository(root)
        assert.equal(result.files, 3)
        assert.equal(result.functions, 3)
        assert.equal(result.errors.length, 6)
        assert.equal(maintainedFiles(root).includes(target), true)
        assert(result.errors.some(/* 确认目标路径实际报告缺失说明。 */ (error) => error.path === name))
        assert.equal(readFileSync(target, 'utf8'), source)

        write(root, name, 'const = invalid\n')
        const invalid = await checkRepository(root)
        assert(
          invalid.errors.some(
            /* 确认目标文件的语法错误也会触发门禁。 */ (error) => error.path === name && /syntax/.test(error.message)
          )
        )

        const fixed = header + '// 返回固定测试值。\n' + source
        write(root, name, fixed)
        const described = await checkRepository(root)
        assert.equal(described.files, 3)
        assert.equal(described.errors.length, 4)
        assert(described.errors.every(/* 补齐目标说明后只保留相邻文件的错误。 */ (error) => error.path !== name))
        assert.equal(readFileSync(target, 'utf8'), fixed)
      }
    )
  }
)

test(
  'symlinks do not bring external code into the maintained scope',
  /* 防止递归跟随外部源码。 */ async () => {
    await isolated(
      /* 检查根目录和内部目录符号链接。 */ async (root) => {
        const outside = join(root, 'outside')
        write(root, 'outside/value.ts', 'invalid syntax')
        symlinkSync(outside, join(root, 'src'), 'dir')
        mkdirSync(join(root, 'scripts'))
        symlinkSync(outside, join(root, 'scripts/linked'), 'dir')
        symlinkSync(join(outside, 'value.ts'), join(root, 'scripts/linked.ts'))
        assert.equal((await checkRepository(root)).files, 0)
      }
    )
  }
)

test(
  'the CLI reports counts, rejects missing comments and leaves inputs unchanged',
  /* 验证独立命令行门禁。 */ async () => {
    await isolated(
      /* 用隔离根目录运行仓库中的检查脚本。 */ async (root) => {
        const path = write(root, 'src/value.ts', `${header}const value = () => 1\n`)
        const result = spawnSync(
          process.execPath,
          ['--no-env-file', join(repositoryRoot, 'scripts/maintenance/comments.mjs'), root, '--json'],
          { encoding: 'utf8', timeout: 30_000 }
        )
        assert.ifError(result.error)
        assert.equal(result.status, 1, result.stderr)
        const report = JSON.parse(result.stdout)
        assert.equal(report.files, 1)
        assert.equal(report.functions, 1)
        assert.equal(report.errors.length, 1)
        assert.equal(report.errors[0].path, 'src/value.ts')
        assert.equal(readFileSync(path, 'utf8'), `${header}const value = () => 1\n`)
      }
    )
  }
)

test(
  'a missing CLI root fails instead of silently checking zero files',
  /* 防止根目录拼写错误造成假成功。 */ async () => {
    await isolated(
      /* 使用确定不存在的根目录参数。 */ async (root) => {
        const result = spawnSync(
          process.execPath,
          ['--no-env-file', join(repositoryRoot, 'scripts/maintenance/comments.mjs'), join(root, 'missing')],
          { encoding: 'utf8', timeout: 30_000 }
        )
        assert.ifError(result.error)
        assert.notEqual(result.status, 0)
        assert.doesNotMatch(result.stdout, /0 files/)
      }
    )
  }
)
