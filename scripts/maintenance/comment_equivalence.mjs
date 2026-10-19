// 比较指定 Git 基线与当前维护代码的解析结构，证明补注释未改变既有程序、类型或 Python docstring。
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseJavaScriptSources, semanticTree } from './comments.mjs'

const codeExtension = /\.(?:[cm]?[jt]s|[jt]sx|py)$/
const pythonComparison = `
import ast, base64, json, sys
items = json.load(sys.stdin)
errors = []
for item in items:
    try:
        before = ast.dump(ast.parse(base64.b64decode(item['before']), filename=item['path']), include_attributes=False)
        after = ast.dump(ast.parse(base64.b64decode(item['after']), filename=item['path']), include_attributes=False)
        if before != after:
            errors.append(item['path'] + ': Python AST differs')
    except SyntaxError as error:
        errors.append(item['path'] + ': ' + str(error))
print(json.dumps(errors))
`

// 在指定仓库运行只读 Git 命令；失败时保留诊断，不通过 shell 解释 ref 或路径。
function git(root, args, encoding = 'utf8') {
  const result = spawnSync('git', args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr.toString().trim() || `git exited ${result.status}`)
  }
  return result.stdout
}

// 将原始字节交给 Python 按编码声明解析，拒绝 cookie、BOM 或 docstring 引起的真实 AST 变化。
export function comparePythonSources(sources) {
  if (sources.length === 0) {
    return []
  }
  const encoded = sources.map(
    /* 保留两版原字节，避免提前按 UTF-8 解码掩盖编码声明的作用。 */ (source) => ({
      path: source.path,
      before: Buffer.from(source.before).toString('base64'),
      after: Buffer.from(source.after).toString('base64')
    })
  )
  const result = spawnSync('python3', ['-c', pythonComparison], {
    input: JSON.stringify(encoded),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr.trim() || `Python comparison exited ${result.status}`)
  }
  return JSON.parse(result.stdout)
}

// 比较基线所有维护文件，拒绝删除和语义变化；新增工具单独报告，由其回归测试负责验证。
export async function compareRef(root, base) {
  const commit = git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim()
  const paths = git(root, ['ls-tree', '-r', '--name-only', '-z', commit, '--', 'src', 'test', 'scripts'])
    .split('\0')
    .filter(/* 只比较三个维护目录下受支持的代码语言，数据文件保持独立。 */ (path) => codeExtension.test(path))
  const sources = new Map()
  const pairs = []
  const python = []
  const errors = []
  for (const path of paths) {
    const current = resolve(root, path)
    if (!existsSync(current)) {
      errors.push(`${path}: baseline file is missing`)
      continue
    }
    if (path.endsWith('.py')) {
      python.push({
        path,
        before: git(root, ['cat-file', 'blob', `${commit}:${path}`], null),
        after: readFileSync(current)
      })
    } else {
      const before = git(root, ['cat-file', 'blob', `${commit}:${path}`])
      const after = readFileSync(current, 'utf8')
      const baseline = resolve(root, '.comment-equivalence-base', path)
      sources.set(baseline, before)
      sources.set(current, after)
      pairs.push({ path, baseline, current })
    }
  }
  if (sources.size) {
    const parsed = await parseJavaScriptSources(sources)
    for (const { path, baseline, current } of pairs) {
      const before = parsed.get(baseline)
      const after = parsed.get(current)
      if (before.diagnostics.length || after.diagnostics.length) {
        errors.push(`${path}: JavaScript/TypeScript parse diagnostics prevent equivalence comparison`)
      } else if (JSON.stringify(semanticTree(before.sourceFile)) !== JSON.stringify(semanticTree(after.sourceFile))) {
        errors.push(`${path}: JavaScript/TypeScript AST differs`)
      }
    }
  }
  errors.push(...comparePythonSources(python))
  return { base: commit, files: paths.length, javascript: pairs.length, python: python.length, errors }
}

// 读取基线与可选仓库目录；以非零退出码报告语法、删除或行为/类型结构变化。
async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--') {
    args.shift()
  }
  const { values } = parseArgs({ args, options: { base: { type: 'string' }, root: { type: 'string' } } })
  if (!values.base) {
    throw new Error('Usage: bun run comments:equivalence -- --base <commit> [--root <checkout>]')
  }
  const report = await compareRef(resolve(values.root ?? '.'), values.base)
  console.log(JSON.stringify(report, null, 2))
  if (report.errors.length) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
