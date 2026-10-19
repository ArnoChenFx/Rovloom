// 在隔离项目中验证 lint 与格式化覆盖范围、数据保真和自动修复的行为稳定性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const badSource = 'export const reviewProduct=(value: number)=>value == 1;\n'

// 创建目标父目录并写入隔离项目中的测试文件。
function write(project, path, content) {
  const destination = join(project, path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, content)
}

// 递归计算目录中每个文件的相对路径与摘要，用于检查字节保真。
function hashes(root) {
  const result = {}
  // 遍历子目录，将文件内容摘要累积到共享结果映射。
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else {
        result[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
      }
    }
  }
  walk(root)
  return result
}

// 建立最小独立项目并运行检查回调，结束后始终删除临时目录。
function isolated(check) {
  const project = mkdtempSync(join(tmpdir(), 'rovloom-quality-coverage-'))
  try {
    for (const name of ['package.json', 'bunfig.toml', '.gitignore', '.oxlintrc.json', '.oxfmtrc.json']) {
      cpSync(join(repo, name), join(project, name))
    }
    symlinkSync(join(repo, 'node_modules'), join(project, 'node_modules'), 'dir')
    for (const name of ['src', 'test', 'scripts']) {
      mkdirSync(join(project, name))
    }
    write(project, 'src/product.ts', 'export const product = true\n')
    write(project, 'tsconfig.json', '{}\n')
    return check(project)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}

// 用当前 Bun 在隔离项目执行命令，核对退出状态后返回合并输出。
function run(project, args, expected = 0) {
  const result = spawnSync(process.execPath, ['--no-env-file', ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: '1' }
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  const output = result.stdout + result.stderr
  assert.equal(result.status, expected, `${args.join(' ')}\n${output}`)
  return output
}

// 通过标准输入格式化源码，要求命令成功并返回输出文本。
function formatSource(project, source, name = 'review.ts') {
  const result = spawnSync(
    process.execPath,
    ['--no-env-file', 'node_modules/oxfmt/bin/oxfmt', '--config', '.oxfmtrc.json', '--stdin-filepath', name],
    { cwd: project, input: source, encoding: 'utf8', timeout: 30_000 }
  )
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

// 在子进程导入测试模块并调用其 probe，解析返回的 JSON 结果。
function evaluate(project, path) {
  return JSON.parse(
    run(project, [
      '-e',
      'const m = await import(process.argv[1]); console.log(JSON.stringify(m.probe()))',
      join(project, path)
    ])
  )
}

// 要求 lint 和格式检查覆盖全部违规源码，同时证明只读检查没有修改文件。
function rejectsProduct(project, paths) {
  const before = Object.fromEntries(
    paths.map(/* 保存各违规文件原始字节以核对检查无副作用。 */ (path) => [path, readFileSync(join(project, path))])
  )
  const lint = run(project, ['run', 'lint'], 1)
  assert.match(lint, /eqeqeq/)
  const format = run(project, ['run', 'format:check'], 1)
  for (const path of paths) {
    assert(lint.includes(path), `lint omitted ${path}: ${lint}`)
    assert(format.includes(path), `format:check omitted ${path}: ${format}`)
    assert.deepEqual(readFileSync(join(project, path)), before[path], `check changed ${path}`)
  }
}

test(
  'product code in schema/evidence and other data-like paths is checked',
  /* 验证源码即使位于类似数据目录的路径也会被检查。 */ () => {
    isolated(
      /* 为各种易误判为数据的源码路径写入违规样例并检查覆盖。 */ (project) => {
        const paths = [
          'src/schema/review-product.ts',
          'src/evidence/review-product.ts',
          'src/review-product.schema.ts',
          ...[
            'schemas',
            'fixtures',
            '__fixtures__',
            '__snapshots__',
            'golden',
            'goldens',
            'archive',
            'archives',
            'third-party',
            'third_party',
            'vendor',
            'docs',
            'coverage'
          ].map(/* 将候选目录转换为真实源码路径。 */ (name) => `src/${name}/review-product.ts`),
          'src/LICENSE-product.ts',
          'src/COPYING-product.ts'
        ]
        for (const path of paths) {
          write(project, path, badSource)
        }
        rejectsProduct(project, paths)
      }
    )
  }
)

test(
  'moving identical bytes from fixtures into src activates both checks',
  /* 证明相同字节从 fixture 移入源码目录后会启用两种检查。 */ () => {
    isolated(
      /* 先确认 fixture 被保留，再移动文件并要求检查拒绝违规源码。 */ (project) => {
        const fixture = 'inputs/quality/moved-product.schema.ts'
        const product = 'src/fixtures/moved-product.schema.ts'
        write(project, fixture, badSource)
        run(project, ['run', 'lint'])
        run(project, ['run', 'format:check'])
        assert.equal(readFileSync(join(project, fixture), 'utf8'), badSource)
        mkdirSync(dirname(join(project, product)), { recursive: true })
        renameSync(join(project, fixture), join(project, product))
        rejectsProduct(project, [product])
      }
    )
  }
)

test(
  'whole-checkout formatting preserves real fixture, schema, archive and license bytes',
  /* 用真实 fixture 副本验证全目录格式化保持数据和许可证字节不变。 */ () => {
    const source = join(repo, 'test/fixtures')
    const beforeSource = hashes(source)
    isolated(
      /* 对包含真实数据副本的隔离项目执行全目录格式化并核对摘要。 */ (project) => {
        cpSync(source, join(project, 'test/fixtures'), { recursive: true })
        const example = 'test/wire/v2-examples.json'
        write(project, example, readFileSync(join(repo, example)))
        const before = hashes(join(project, 'test/fixtures'))
        assert.deepEqual(before, beforeSource)
        const exampleBefore = readFileSync(join(project, example))
        run(project, ['node_modules/oxfmt/bin/oxfmt', '--config', '.oxfmtrc.json', '--write', '.'])
        assert.deepEqual(hashes(join(project, 'test/fixtures')), before)
        assert.deepEqual(readFileSync(join(project, example)), exampleBefore)
        assert(existsSync(join(project, 'test/fixtures/luvus/0.14.3/LICENSE')))
      }
    )
    assert.deepEqual(hashes(source), beforeSource)
  }
)

test(
  'formatter uses the selected 120-column punctuation policy and retains authored gaps',
  /* 验证行宽、标点和手写段间空白策略，并核对重复格式化稳定性。 */ () => {
    isolated(
      /* 格式化边界长度和 JSX 样例，检查输出布局符合配置。 */ (project) => {
        const args = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(25)]
        const fitting = formatSource(project, `export const result = resolve(${args.join(', ')});\n`)
        assert.equal(fitting.trim().split('\n').length, 1)
        assert(fitting.trim().length > 100 && fitting.trim().length <= 120)

        const wrapped = formatSource(
          project,
          `export const result = resolve(${[...args, 'd'.repeat(20)].join(', ')});\n`
        )
        assert.match(wrapped, /\n  /)
        assert.doesNotMatch(wrapped, /,\n\)/)

        const source = `const f = value => ({ "safe": value, "not-safe": true });
const view = <Widget title='ready' active={true} />;
export function first() { return f; }

// 第二个阶段保留独立说明。
export function second() { return view; }
`
        const formatted = formatSource(project, source, 'review.tsx')
        assert.match(formatted, /\(value\) => \(\{ safe: value, 'not-safe': true \}\)/)
        assert.match(formatted, /<Widget title="ready" active=\{true\} \/>/)
        assert.match(formatted, /\}\n\n\/\/ 第二个阶段/)
        assert.doesNotMatch(formatted, /;/)
        assert.equal(formatSource(project, formatted, 'review.tsx'), formatted)
      }
    )
  }
)

test(
  'semicolon-free formatting preserves ASI-sensitive statement and return boundaries',
  /* 验证移除分号后的语句边界和换行 return 行为保持一致。 */ () => {
    isolated(
      /* 对比格式化前后的实际执行结果，并检查敏感行的保护分号。 */ (project) => {
        const source = `const values = [];
values.push('start');
[1, 2].forEach(value => values.push(value));
(function () { values.push('iife'); })();
/ready/.test('ready');
\`hello\`.toUpperCase();
+values.length;
-values.length;
export function probe() {
  function stopped() { return
    { ignored: true };
  }
  return { values, object: { ready: true }, stopped: stopped() === undefined };
}
`
        const formatted = formatSource(project, source, 'asi.mjs')
        assert.match(formatted, /^;\[/m)
        assert.match(formatted, /^;\(/m)
        assert.match(formatted, /^;\//m)
        assert.match(formatted, /^;`/m)
        assert.match(formatted, /^;\+/m)
        assert.match(formatted, /^;-/m)
        write(project, 'src/asi-before.mjs', source)
        write(project, 'src/asi-after.mjs', formatted)
        assert.deepEqual(evaluate(project, 'src/asi-before.mjs'), {
          values: ['start', 1, 2, 'iife'],
          object: { ready: true },
          stopped: true
        })
        assert.deepEqual(evaluate(project, 'src/asi-after.mjs'), evaluate(project, 'src/asi-before.mjs'))
      }
    )
  }
)

for (const [rule, source, expected] of [
  [
    'curly',
    'export function probe() { function choose(ready) { if (ready) return 1; else return 0; } return [choose(true), choose(false)]; }\n',
    [1, 0]
  ],
  [
    'one-var',
    'const values = []; function mark(value) { values.push(value); return value; } const first = mark(1), second = mark(2); export function probe() { return { values, first, second }; }\n',
    { values: [1, 2], first: 1, second: 2 }
  ]
]) {
  test(
    `${rule} rejects dense code, fixes it safely and stays stable with Oxfmt`,
    /* 验证当前规则能拒绝密集写法、自动修复且保持行为和格式稳定。 */ () => {
      isolated(
        /* 在隔离项目中执行两轮修复与格式化，比较行为及最终字节。 */ (project) => {
          const path = `src/${rule}-probe.mjs`
          write(project, path, source)
          assert.deepEqual(evaluate(project, path), expected)
          assert.match(run(project, ['run', 'lint'], 1), new RegExp(rule))
          run(project, ['run', 'lint:fix'])
          run(project, ['run', 'format'])
          run(project, ['run', 'lint'])
          run(project, ['run', 'format:check'])
          assert.deepEqual(evaluate(project, path), expected)
          const fixed = readFileSync(join(project, path), 'utf8')
          assert.notEqual(fixed, source)
          run(project, ['run', 'lint:fix'])
          run(project, ['run', 'format'])
          assert.equal(readFileSync(join(project, path), 'utf8'), fixed)
        }
      )
    }
  )
}
