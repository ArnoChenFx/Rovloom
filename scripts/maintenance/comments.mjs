// 解析维护代码的语法树，检查中文文件职责和函数说明，并提供注释变更的语义比较接口。

import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { API } from 'typescript/unstable/async'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { createScanner, getShebang, NodeFlags, SyntaxKind } from 'typescript/unstable/ast'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const javascriptExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'])
const functionKinds = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor
])
const commentKinds = new Set([SyntaxKind.SingleLineCommentTrivia, SyntaxKind.MultiLineCommentTrivia])
const triviaKinds = new Set([...commentKinds, SyntaxKind.WhitespaceTrivia, SyntaxKind.NewLineTrivia])
const wrapperKinds = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.NonNullExpression
])
const chinese = /\p{Script=Han}/u

// 文件发现保留 Python 的大小写兼容，实际检查仍由原发现器决定。
function mayBePythonSource(path) {
  return path.toLowerCase().endsWith('.py')
}

// TypeScript 项目统一使用正斜杠键，保留调用方原始路径作为返回键。
function parserPath(path) {
  return path.replaceAll('\\', '/')
}

// 只遍历维护根目录中的源码；不依赖 Git，也不跟随可能越出根目录的符号链接。
export function maintainedFiles(root) {
  if (!statSync(root).isDirectory()) {
    throw new Error(`Comment-check root is not a directory: ${root}`)
  }
  const files = []
  // 递归收集源码扩展名，目录名本身不构成 fixtures 或 vendor 豁免。
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '__pycache__') {
        walk(path)
      } else if (entry.isFile() && (javascriptExtensions.has(extname(path)) || mayBePythonSource(path))) {
        files.push(path)
      }
    }
  }
  for (const name of ['src', 'test', 'scripts']) {
    const path = join(root, name)
    try {
      if (!lstatSync(path).isSymbolicLink()) {
        walk(path)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }
  return files.sort()
}

// 所有解析路径使用同一无依赖项目设置，完整保留语法诊断和原始文件路径。
function projectConfig(sources) {
  return JSON.stringify({
    compilerOptions: { allowJs: true, checkJs: false, noLib: true, noResolve: true, types: [], target: 'ESNext' },
    files: [...sources.keys()].map(parserPath)
  })
}

// 从当前项目取完整 AST；实际读取必须与检查开始时的源码快照一致，变化时明确拒绝。
async function parseProject(sources, config, fs) {
  const api = new API({ cwd: dirname(config), ...(fs ? { fs } : {}) })
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] })
    const project = snapshot.getProject(config)
    if (!project) {
      throw new Error('TypeScript did not create the comment-check project')
    }
    const paths = [...sources.keys()]
    const normalized = new Set(paths.map(parserPath))
    if (normalized.size !== paths.length) {
      throw new Error('Duplicate normalized comment-check path')
    }
    // AST 读取保持有界并发，失败先排空当前窗口；语法诊断整个快照只取一次。
    const ast = async () => {
      const result = new Map()
      for (let offset = 0; offset < paths.length; offset += 8) {
        const window = paths.slice(offset, offset + 8)
        const parsed = await Promise.allSettled(
          window.map(
            /* 每个文件仍读取完整 AST 并核对开始时的原文快照。 */ async (path) => {
              const sourceFile = await project.program.getSourceFile(parserPath(path))
              if (!sourceFile) {
                throw new Error(`TypeScript did not parse ${path}`)
              }
              const source = sources.get(path)
              if (sourceFile.text !== (source.startsWith('\ufeff') ? source.slice(1) : source)) {
                throw new Error(`Source changed while checking ${path}`)
              }
              return sourceFile
            }
          )
        )
        for (let index = 0; index < parsed.length; index++) {
          const file = parsed[index]
          if (file.status === 'rejected') {
            throw file.reason
          }
          result.set(window[index], file.value)
        }
      }
      return result
    }
    const [files, syntax] = await Promise.allSettled([ast(), project.program.getSyntacticDiagnostics()])
    if (files.status === 'rejected') {
      throw files.reason
    }
    if (syntax.status === 'rejected') {
      throw syntax.reason
    }
    const diagnostics = new Map()
    for (const diagnostic of syntax.value) {
      const path = parserPath(diagnostic.fileName)
      if (!normalized.has(path)) {
        throw new Error('TypeScript returned a syntactic diagnostic outside the comment-check project')
      }
      const entries = diagnostics.get(path) ?? []
      entries.push(diagnostic)
      diagnostics.set(path, entries)
    }
    return new Map(
      [...files.value].map(
        /* 返回所有逐文件语法诊断，不以全项目摘要替代错误。 */ ([path, sourceFile]) => [
          path,
          { sourceFile, diagnostics: diagnostics.get(parserPath(path)) ?? [] }
        ]
      )
    )
  } finally {
    await api.close()
  }
}

// 将合成或尚未落盘的源码交给同一原生解析器，继续支持独立语法及语义比较。
export async function parseJavaScriptSources(sources) {
  if (sources.size === 0) {
    return new Map()
  }
  const config = '/__rovloom_comment_check__/tsconfig.json'
  const files = {
    ...Object.fromEntries(
      [...sources].map(/* 虚拟读取与项目索引共用规范路径。 */ ([path, source]) => [parserPath(path), source])
    ),
    [config]: projectConfig(sources)
  }
  return parseProject(sources, config, createVirtualFileSystem(files))
}

// 全仓文件由原生解析器直接读取，避免每次虚拟文件系统回调的跨进程往返；配置始终私有且清理。
async function parseRepositorySources(sources) {
  if (sources.size === 0) {
    return new Map()
  }
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-comment-project-'))
  const config = join(directory, 'tsconfig.json')
  try {
    writeFileSync(config, projectConfig(sources))
    const parsed = await parseProject(sources, config)
    for (const [path, source] of sources) {
      if (readFileSync(path, 'utf8') !== source) {
        throw new Error(`Source changed while checking ${path}`)
      }
    }
    return parsed
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// 仅扫描节点前的 trivia 区间，避免把正则、模板或字符串内的斜杠误认为注释。
function precedingComments(source, start, end) {
  if (start === 0) {
    start = getShebang(source)?.length ?? start
  }
  const scanner = createScanner(false, undefined, source, start, end - start)
  const comments = []
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (!triviaKinds.has(kind)) {
      return []
    }
    if (commentKinds.has(kind)) {
      comments.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd(), kind, text: scanner.getTokenText() })
    }
  }
  return comments
}

// 把连续的注释行归为一个说明块，空行将文件职责和首个函数说明分开。
function commentBlocks(source, comments) {
  const blocks = []
  for (const comment of comments) {
    const previous = blocks.at(-1)
    if (previous && !/\r?\n\s*\r?\n/u.test(source.slice(previous.at(-1).end, comment.start))) {
      previous.push(comment)
    } else {
      blocks.push([comment])
    }
  }
  return blocks
}

// 判断最近说明块是否含中文，并防止上一条语句的行尾注释被下个函数借用。
function hasDescription(source, node, headerEnd) {
  const blocks = commentBlocks(source, precedingComments(source, node.pos, node.getStart()))
  const block = blocks.at(-1)
  if (!block || block[0].start < headerEnd) {
    return false
  }
  return block.some(
    /* 检查块内独立注释是否提供中文说明。 */ (comment) => {
      const lineStart = source.lastIndexOf('\n', comment.start - 1) + 1
      const standalone = source.slice(lineStart, comment.start).trim() === ''
      return chinese.test(comment.text) && (standalone || comment.kind === SyntaxKind.MultiLineCommentTrivia)
    }
  )
}

// 只允许直接绑定函数的声明继承说明，调用参数等嵌套回调必须拥有自己的说明。
function descriptionAnchors(node) {
  const anchors = [node]
  let expression = node
  while (wrapperKinds.has(expression.parent?.kind)) {
    expression = expression.parent
    anchors.push(expression)
  }
  const parent = expression.parent
  if (parent?.initializer === expression) {
    if (parent.kind === SyntaxKind.VariableDeclaration) {
      anchors.push(parent)
      const list = parent.parent
      if (list?.kind === SyntaxKind.VariableDeclarationList && list.declarations.length === 1) {
        anchors.push(list.parent)
      }
    } else if (parent.kind === SyntaxKind.PropertyAssignment || parent.kind === SyntaxKind.PropertyDeclaration) {
      anchors.push(parent)
    }
  } else if (parent?.kind === SyntaxKind.ExportAssignment && parent.expression === expression) {
    anchors.push(parent)
  }
  return anchors
}

// 将源码位置转换为可直接定位的检查错误。
function issue(sourceFile, position, message) {
  const point = sourceFile.getLineAndCharacterOfPosition(Math.max(0, position))
  return { path: sourceFile.fileName, line: point.line + 1, column: point.character + 1, message }
}

// 检查单个已解析文件的职责说明与全部有函数体的实现节点。
export function inspectJavaScript(sourceFile, diagnostics = []) {
  const source = sourceFile.text
  const errors = []
  let functions = 0
  for (const diagnostic of diagnostics) {
    errors.push(issue(sourceFile, diagnostic.pos, `syntax TS${diagnostic.code}: ${diagnostic.text}`))
  }
  if (diagnostics.length > 0) {
    return { files: 1, functions, errors }
  }
  const first = sourceFile.statements[0] ?? sourceFile.endOfFileToken
  const header = commentBlocks(source, precedingComments(source, 0, first.getStart()))[0]
  const headerEnd = header?.at(-1).end ?? 0
  if (!header?.some(/* 确认文件头注释含中文职责。 */ (comment) => chinese.test(comment.text))) {
    errors.push(issue(sourceFile, 0, 'missing Chinese file responsibility comment'))
  }
  // 逐层访问函数实现，类型签名、接口方法和无函数体重载不计数。
  function visit(node) {
    if (functionKinds.has(node.kind) && node.body) {
      functions += 1
      if (
        !descriptionAnchors(node).some(
          /* 查找实现本身或直接声明前的说明。 */ (anchor) => hasDescription(source, anchor, headerEnd)
        )
      ) {
        errors.push(
          issue(sourceFile, node.getStart(), `missing Chinese function description (${SyntaxKind[node.kind]})`)
        )
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return { files: 1, functions, errors }
}

// 提取 AST 中未作为子节点存储的语义值，保留操作符和 type-only 等差异。
function semanticScalars(node) {
  switch (node.kind) {
    case SyntaxKind.SourceFile:
      return [getShebang(node.text) ?? '']
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression:
    case SyntaxKind.TypeOperator:
      return [node.operator]
    case SyntaxKind.ModuleDeclaration:
      return [node.keyword]
    case SyntaxKind.MetaProperty:
      return [node.keywordToken]
    case SyntaxKind.ImportClause:
      return [node.phaseModifier]
    case SyntaxKind.HeritageClause:
    case SyntaxKind.ImportAttributes:
      return [node.token]
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ExportDeclaration:
      return [node.isTypeOnly]
    case SyntaxKind.ExportAssignment:
      return [node.isExportEquals]
    case SyntaxKind.ImportType:
      return [node.isTypeOf]
    default:
      return []
  }
}

// 生成忽略位置和注释的保守语法树快照；ASI、字面量和模板仍按真实解析结果比较。
export function semanticTree(sourceFile) {
  const commentFlags = NodeFlags.HasJSDoc | NodeFlags.JSDoc | NodeFlags.PossiblyContainsDeprecatedTag
  // 递归保留节点类型、语义标记、子节点顺序和词法叶子原文。
  function snapshot(node) {
    const children = []
    node.forEachChild(
      /* 将实际语法子节点加入语义快照。 */ (child) => {
        children.push(snapshot(child))
      }
    )
    const token =
      node.kind <= SyntaxKind.LastToken && node.kind !== SyntaxKind.EndOfFile ? node.getText(sourceFile) : ''
    return [node.kind, node.flags & ~commentFlags, semanticScalars(node), token, children]
  }
  return snapshot(sourceFile)
}

// 合并 JavaScript 与 Python 的检查结果，Python 使用标准库 ast/tokenize 而不新增依赖。
export async function checkRepository(root = repositoryRoot) {
  root = resolve(root)
  const sources = new Map()
  const paths = maintainedFiles(root)
  for (const path of paths) {
    if (javascriptExtensions.has(extname(path))) {
      sources.set(path, readFileSync(path, 'utf8'))
    }
  }
  const result = { files: 0, functions: 0, errors: [] }
  for (const { sourceFile, diagnostics } of (await parseRepositorySources(sources)).values()) {
    const checked = inspectJavaScript(sourceFile, diagnostics)
    result.files += checked.files
    result.functions += checked.functions
    result.errors.push(...checked.errors)
  }
  // 没有 Python 输入时无需启动零输入扫描；有文件时保持原完整检查。
  if (paths.some(mayBePythonSource)) {
    const python = spawnSync(
      'python3',
      [fileURLToPath(new URL('./check_comments.py', import.meta.url)), root, '--json'],
      {
        encoding: 'utf8',
        timeout: 30_000
      }
    )
    if (python.error || ![0, 1].includes(python.status)) {
      throw new Error(`Python comment checker failed: ${python.error?.message ?? python.stderr}`)
    }
    const checked = JSON.parse(python.stdout)
    result.files += checked.files
    result.functions += checked.functions
    result.errors.push(...checked.errors)
  }
  for (const error of result.errors) {
    error.path = relative(root, error.path).split('\\').join('/')
  }
  return result
}

// 运行只读命令行检查，输出可选 JSON 或带文件及函数计数的定位结果。
async function main(args) {
  const json = args.includes('--json')
  const paths = args.filter(/* 移除 JSON 开关以识别可选根目录。 */ (argument) => argument !== '--json')
  if (paths.length > 1 || paths.some(/* 拒绝未知命令行开关。 */ (argument) => argument.startsWith('-'))) {
    throw new Error('usage: bun scripts/maintenance/comments.mjs [root] [--json]')
  }
  const result = await checkRepository(paths[0])
  if (json) {
    console.log(JSON.stringify(result))
  } else {
    for (const error of result.errors) {
      console.error(`${error.path}:${error.line}:${error.column}: ${error.message}`)
    }
    console.log(`comments: ${result.files} files, ${result.functions} functions, ${result.errors.length} errors`)
  }
  process.exitCode = result.errors.length > 0 ? 1 : 0
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2))
}
