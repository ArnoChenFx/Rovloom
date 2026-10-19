// 隔离进程内运行同一离线编译器；只允许一次编译及该契约的结构校验，无网络或执行权限。
/* global readFrame, writeFrame, frameSequence, workerEpoch */
import './compiler-platform.mjs'
import { compileBundle } from '../../src/native-contract/bundle.ts'
import { contracts } from '../../src/native-contract/internal.ts'
import { equal } from '../../src/native-contract/json.ts'

// 精确列举私有 IPC 字段，拒绝未知版本、动作或缺省字段，不做兼容推断。
function fields(value, names) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    names.some(/* 核对协议要求的全部自有字段。 */ (name) => !Object.hasOwn(value, name))
  ) {
    throw Error('protocol')
  }
}

// 输出只有受限元数据和校验结论；不向宿主传送 schema 异常原文或请求副本。
function send(sequence, result) {
  writeFrame(JSON.stringify({ compiler_protocol: 1, sequence, ...result }))
}

// 进程只持有一个编译契约；摘要和随机进程代次同时约束后续校验。
function run() {
  let contract
  for (;;) {
    const raw = readFrame()
    if (raw === null) {
      return
    }
    const sequence = frameSequence()
    try {
      const message = JSON.parse(raw)
      if (message.compiler_protocol !== 1 || message.sequence !== sequence || !Number.isSafeInteger(sequence)) {
        throw Error('protocol')
      }
      if (!contract && message.op === 'compile') {
        fields(message, ['compiler_protocol', 'sequence', 'op', 'bytes', 'options'])
        const result = compileBundle(message.bytes, message.options)
        if (!result.ok) {
          send(message.sequence, result)
          return
        }
        contract = result.value
        const data = contracts.get(contract)
        send(message.sequence, {
          ok: true,
          value: {
            identity: contract.identity,
            documents: contract.documents,
            epoch: workerEpoch,
            limits: data.limits,
            branches: [...data.branches],
            schemas: [...data.validators.keys()]
          }
        })
      } else if (contract && message.op === 'validate') {
        fields(message, ['compiler_protocol', 'sequence', 'op', 'identity', 'epoch', 'schema', 'value'])
        if (message.epoch !== workerEpoch || !equal(message.identity, contract.identity)) {
          throw Error('binding')
        }
        const validate = contracts.get(contract).validators.get(message.schema)
        if (!validate) {
          throw Error('schema')
        }
        const valid = validate(message.value) === true
        send(message.sequence, {
          ok: true,
          value: { valid, keyword: valid ? null : (validate.errors?.[0]?.keyword ?? null) }
        })
      } else {
        throw Error('operation')
      }
    } catch {
      send(sequence, {
        ok: false,
        error: {
          origin: 'contract',
          stage: 'isolation',
          code: 'schema_unavailable',
          reason: 'compiler_protocol_invalid'
        }
      })
      return
    }
  }
}

run()
