// 将固定编译 Worker 内嵌进 Bun 模块产物，避免拆分 chunk 的相对路径指向源码或外部入口。
import { fileURLToPath } from 'node:url'

// 同一源码入口先独立打包；只替换受维护的定位模块，不接受运行时 caller 提供的代码或路径。
export async function compilerWorkerPlugin() {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../../src/native-contract/compiler-worker.ts', import.meta.url))],
    target: 'bun',
    format: 'esm',
    packages: 'bundle',
    minify: true,
    write: false
  })
  if (!built.success || built.outputs.length !== 1) {
    throw new AggregateError(built.logs, 'Schema Worker build failed')
  }
  const workerSource = await built.outputs[0].text()
  const contents = `
    // 内嵌代码来自本次构建的固定 Worker 入口；Blob URL 只由本 Worker 生命周期持有。
    export function createCompilerWorker() {
      const url = URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], {type: 'text/javascript'}))
      try {
        const worker = new Worker(url, {smol: true})
        // 退出或失败后释放资源定位符，避免在 open 时提前撤销仍在加载的脚本。
        const release = () => URL.revokeObjectURL(url)
        worker.addEventListener('error', release, {once: true})
        worker.addEventListener('close', release, {once: true})
        return worker
      } catch (error) { URL.revokeObjectURL(url); throw error }
    }
  `
  return {
    name: 'rovloom-schema-worker',
    // 插件只匹配这个固定模块，保留其余模块原有构建行为。
    setup(build) {
      build.onLoad(
        { filter: /[/\\]native-contract[/\\]compiler-location\.ts$/ },
        /* 将源定位器替换为本次同源构建的内嵌定位器。 */ () => ({ contents, loader: 'js' })
      )
    }
  }
}
