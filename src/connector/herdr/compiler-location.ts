/** 固定 Herdr 编译 Worker 入口；构建插件将同一源码嵌入模块及 standalone。 */
import type { HerdrCompilerPort } from './compiler-protocol.js'

/** 仅受维护的固定定位器能创建 Worker；本地 API 不接收路径、代码或选项。 */
export function createHerdrCompilerWorker(): HerdrCompilerPort {
  const RuntimeWorker = Worker as unknown as new (url: string, options: { smol: boolean }) => HerdrCompilerPort
  return new RuntimeWorker(new URL('./compiler-herdr-worker.ts', import.meta.url).href, { smol: true })
}
