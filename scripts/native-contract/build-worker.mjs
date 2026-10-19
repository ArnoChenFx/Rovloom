// 打包隔离进程的完整编译语义，再用固定官方源码离线构建原生执行边界。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// 构建函数也供统一 build 入口调用；失败不留下可被误认为成功的执行文件。
export async function buildSchemaWorker(output = new URL('../../dist/native-contract/', import.meta.url)) {
  const temporary = mkdtempSync(join(tmpdir(), 'rovloom-schema-service-'))
  try {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./compiler-entry.mjs', import.meta.url))],
      outdir: temporary,
      naming: 'compiler.js',
      target: 'browser',
      format: 'iife',
      minify: true,
      plugins: [
        {
          name: 'bare-engine-encoding',
          // 选择上游裸引擎编码实现，避免浏览器条件依赖不存在的全局对象。
          setup(build) {
            // 使用该包已发布的裸引擎实现，避免 browser 条件假设宿主已有 TextEncoder。
            build.onResolve(
              { filter: /(?:^|\/)(platform|utf8\.auto|utf16)\.js$/ },
              /* 只改写编码包内部的平台入口。 */ (args) => {
                if (!args.importer.includes('/@exodus/bytes/')) {
                  return
                }
                const name = args.path.split('/').at(-1)
                if (name === 'utf16.js' && args.path.includes('/fallback/')) {
                  return
                }
                const base = fileURLToPath(new URL('../../node_modules/@exodus/bytes/', import.meta.url))
                const file = name === 'utf16.js' ? 'utf16.native.js' : `fallback/${name.replace('.js', '.native.js')}`
                return { path: join(base, file) }
              }
            )
          }
        }
      ]
    })
    if (!result.success) {
      throw new AggregateError(result.logs, 'schema worker bundle failed')
    }
    const process = spawnSync(
      'python3',
      [
        fileURLToPath(new URL('./build-worker.py', import.meta.url)),
        '--root',
        fileURLToPath(new URL('../../', import.meta.url)),
        '--service',
        join(temporary, 'compiler.js'),
        '--output',
        fileURLToPath(output)
      ],
      { stdio: 'inherit' }
    )
    if (process.status !== 0) {
      throw Error('schema worker native build failed')
    }
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await buildSchemaWorker()
}
