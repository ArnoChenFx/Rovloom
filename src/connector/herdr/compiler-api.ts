/** Herdr 固定安装 schema 的异步编译入口；成功后提供同步完整原生根及不可复制来源品牌。 */
import { HerdrSchemaCompiler } from './compiler-host.js'
import { createHerdrCompilerWorker } from './compiler-location.js'
import type { HerdrSchemas } from './readonly.js'

export { isCompiledHerdrSchemas } from './compiler-host.js'

const compiler = new HerdrSchemaCompiler(createHerdrCompilerWorker)
process.once('exit', /** 正常退出时撤销自有在途编译并请求回收 Worker。 */ () => compiler.close())

/** 仅接受原始官方 schema 字节；binary 安装来源仍由独立宿主核验，不能由本 API 自报。 */
export function compileHerdrSchemas(bytes: Uint8Array | string, signal?: AbortSignal): Promise<HerdrSchemas> {
  return compiler.compile(bytes, signal)
}
