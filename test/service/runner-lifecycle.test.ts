// 用明确的内存ChildProcess模型覆盖启动/退出/close缺失；不向真实PID发信号，真实Bun子进程回归仍独立执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process'
import { createSystemCommandRunner } from '../../src/service/runner.js'

class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kills = 0
  detached = false
  // 模型只记录固定信号，既无实际进程也不使用合成PID执行系统操作。
  kill(signal: string): boolean {
    assert.equal(signal, 'SIGKILL')
    this.kills++
    return false
  }
  // 未知终态仍由晚到close观察器接管；模型不让测试事件循环永远等待。
  unref(): void {
    this.detached = true
  }
}

// 受信注入仅用于机械生命周期模型，生产入口始终绑定真实spawn。
function runner(child: Child, begin?: (options: SpawnOptions) => void) {
  const start = /* 把受控事件安排在实际监听器注册之后，避免伪造同步spawn返回。 */ ((
    _file: unknown,
    _args: unknown,
    options: SpawnOptions
  ) => {
    queueMicrotask(/* 测试自选观察序列，不能在生产配置中注入。 */ () => begin?.(options))
    return child as unknown as ChildProcess
  }) as typeof spawn
  return createSystemCommandRunner({ start, cleanupMs: 10 })
}
const plan = { executable: '/synthetic-only', args: [] as string[], timeout: 10 }

test(
  '无输入走ignore，真实close前收齐两流；模型成功不需要等待测试超时',
  /* 使用受控close事实，不接触系统工具。 */ async () => {
    const child = new Child()
    const run = runner(
      child,
      /* 模型按正常启动、输出、退出、关闭顺序发事件。 */ (options) => {
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
        child.emit('spawn')
        child.stdout.write('out')
        child.stderr.write('err')
        child.emit('exit', 7)
        child.emit('close', 7)
      }
    )
    assert.deepEqual(await run(plan), { code: 7, stdout: 'out', stderr: 'err' })
    assert.equal(child.kills, 0)
  }
)

test(
  '未观察到退出的工具只有一次终止请求，回收截止后必须保留恢复保护',
  /* 合成模型永久缺失exit/close，不能把未知执行洗成普通超时。 */ async () => {
    const child = new Child()
    const run = runner(child)
    await assert.rejects(/* 完整await证明Promise在回收期限内结算。 */ () => run(plan), {
      code: 'service_recovery_required',
      phase: 'cleanup_unknown'
    })
    assert.equal(child.kills, 1)
    assert.equal(child.detached, true)
    // 晚到close只清理模型引用，不得再次结算、重发动作或按PID恢复。
    child.emit('exit', 0)
    child.emit('close', 0)
  }
)

test(
  '已退出但输出不关闭时失败阶段为draining，不能成功或永久等close',
  /* 直接进程退出是已知事实，回收管道不扩大为未知系统操作。 */ async () => {
    const child = new Child()
    const run = runner(
      child,
      /* 模拟原生工具已退出而Node桥仍持有管道。 */ () => {
        child.emit('spawn')
        child.emit('exit', 0)
      }
    )
    await assert.rejects(/* 保留操作期限失败，不因原exit0返回成功。 */ () => run(plan), {
      code: 'service_timeout',
      phase: 'draining'
    })
    assert.equal(child.kills, 1)
    assert.equal(child.detached, false)
    child.emit('close', 0)
  }
)

test(
  '启动失败只有固定错误且不留下回收计时或终止一个并不存在的进程',
  /* ENOENT模型无spawn/exit，不作未知重试。 */ async () => {
    const child = new Child()
    const run = runner(
      child,
      /* 系统明确拒绝创建程序，错误正文不进入诊断。 */ () =>
        child.emit('error', Object.assign(new Error('private-text'), { code: 'ENOENT' }))
    )
    await assert.rejects(/* 只断言固定分类。 */ () => run(plan), { code: 'backend_unavailable', phase: 'starting' })
    assert.equal(child.kills, 0)
  }
)
