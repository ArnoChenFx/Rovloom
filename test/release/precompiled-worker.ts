// 单文件探针在真实 Worker 中禁止 Ajv 编译，证明固定资产已嵌入且没有从 checkout 补包。
import '../../src/native-contract/compiler-worker.js'
import { Ajv2020 } from 'ajv/dist/2020.js'

// 仅此隔离探针替换编译方法；固定资产命中不依赖这些入口。
function denied(): never {
  throw new Error('precompiled_probe_full_compile_forbidden')
}
Ajv2020.prototype.addSchema = denied
Ajv2020.prototype.getSchema = denied
Ajv2020.prototype.compile = denied
