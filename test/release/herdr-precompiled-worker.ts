/** 隔离单文件探针封死 Ajv 入口，证明生产 Herdr Worker 只接纳已内嵌且核对的资产。 */
import '../../src/connector/herdr/compiler-herdr-worker.js'
import { Ajv2020 } from 'ajv/dist/2020.js'

/** 任何意外运行时全量编译必须使探针失败，不用预热或重复尝试掩盖。 */
function denied(): never {
  throw new Error('herdr_precompiled_probe_full_compile_forbidden')
}
Ajv2020.prototype.addSchema = denied
Ajv2020.prototype.getSchema = denied
Ajv2020.prototype.compile = denied
