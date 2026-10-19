// 为标准stdio帧提供有界发送与背压生命周期；未完成写入在关闭时明确拒绝，不形成重试队列。
import type { Writable } from 'node:stream'
import { MAX_MCP_BYTES } from './schema.js'

const MAX_OUTPUT_FRAMES = 16
const MAX_OUTPUT_BYTES = MAX_MCP_BYTES * MAX_OUTPUT_FRAMES
type OutputJob = {
  raw: string
  bytes: number
  current?: () => boolean
  onWrite?: () => void
  resolve(): void
  reject(error: Error): void
  written: boolean
  waitingDrain: boolean
}
type OutputLifecycle = {
  // 下游返回背压后暂停协议输入，排空后仅由所属会话恢复。
  pause(): void
  resume(): void
  // 报告固定错误并关闭桥接；不能将输出失败解释为业务回滚。
  failure(): void
}

// 单次只交给Writable一帧，队列同时限制总帧数与UTF-8字节；所有Promise均由标准SDK发送路径观察。
export function createStdioOutput(stdout: Writable, lifecycle: OutputLifecycle) {
  const queue: OutputJob[] = []
  const closedError = new Error('stdio_output_closed')
  let active: OutputJob | undefined
  let bytes = 0
  let stopped = false
  let paused = false
  let failed = false
  let terminalObserved = false

  // 仅移除本模块的监听器，不更改共享流的监听上限或压制其它错误。
  function detach(): void {
    stdout.off('drain', onDrain)
    stdout.off('error', onError)
    stdout.off('close', onClose)
  }

  // 先结算所有发送，再终止尚有物理写入的输出；保留错误处理器直到destroy的终止事件到达。
  function close(): void {
    if (stopped) {
      return
    }
    stopped = true
    stdout.off('drain', onDrain)
    const writing = active !== undefined
    const pending = active ? [active, ...queue] : [...queue]
    active = undefined
    queue.length = 0
    bytes = 0
    for (const job of pending) {
      job.raw = ''
      job.reject(closedError)
    }
    if (writing && !stdout.destroyed) {
      // 固定销毁原因使底层写进入明确失败状态，晚到EPIPE仍由所属write回调观察。
      stdout.destroy(closedError)
    } else if (stdout.destroyed && !terminalObserved) {
      // 外部已开始销毁但尚未发出终止事件，不能提前移除最后的错误监听。
      return
    } else {
      detach()
    }
  }

  // 实际写入错误至多报告一次；队列溢出与EPIPE都使未发送回复明确失败。
  function fail(): void {
    if (!failed) {
      failed = true
      lifecycle.failure()
    }
    close()
  }

  // pump可能已开始下一帧，按实际活动写状态决定是否仍有下游背压。
  function waitingDrain(): boolean {
    return active?.waitingDrain === true
  }

  // 物理写回调和drain都已完成后才释放当前帧预算，再推进下一帧。
  function finish(job: OutputJob): void {
    if (active !== job || !job.written || job.waitingDrain || stopped) {
      return
    }
    active = undefined
    bytes -= job.bytes
    job.raw = ''
    job.resolve()
    pump()
    if (paused && !waitingDrain() && !stopped) {
      paused = false
      lifecycle.resume()
    }
  }

  // 顺序发送尚有效的回复；取消后还未写入的帧不进入底层流。
  function pump(): void {
    if (active || stopped) {
      return
    }
    while (queue.length) {
      const job = queue.shift()!
      if (job.current && !job.current()) {
        bytes -= job.bytes
        job.raw = ''
        job.resolve()
        continue
      }
      active = job
      try {
        job.onWrite?.()
        const accepted = stdout.write(
          job.raw,
          /* 即使会话已经关闭，实际晚到写错误也有所属观察器，不成为uncaughtException。 */ (error) => {
            queueMicrotask(
              /* 避免同步Writable回调早于write返回，先确定是否需要等待drain。 */ () => {
                if (error) {
                  if (error !== closedError) {
                    fail()
                  }
                  return
                }
                job.written = true
                finish(job)
              }
            )
          }
        )
        if (!accepted) {
          job.waitingDrain = true
          stdout.once('drain', onDrain)
          if (!paused) {
            paused = true
            lifecycle.pause()
          }
        }
      } catch {
        fail()
      }
      return
    }
  }

  // 一个活动物理写最多使用一个drain监听器，不按请求重复注册。
  function onDrain(): void {
    if (active) {
      active.waitingDrain = false
      finish(active)
    }
  }

  // 原始错误永不进入诊断；自身关闭标记已结算请求，只等待流的终止清理。
  function onError(error: Error): void {
    if (error !== closedError) {
      fail()
    }
  }

  // 外部流关闭同样结束协议；销毁流程的末尾释放本模块全部监听器。
  function onClose(): void {
    terminalObserved = true
    if (!stopped) {
      fail()
    }
    detach()
  }

  stdout.on('error', onError)
  stdout.once('close', onClose)
  return {
    close,
    send: /* 接受标准序列化后的完整帧；队列满立即拒绝并关闭，不丢帧伪装成功。 */ (
      raw: string,
      current?: () => boolean,
      onWrite?: () => void
    ): Promise<void> => {
      if (stopped) {
        return Promise.reject(closedError)
      }
      const size = Buffer.byteLength(raw)
      if (queue.length + (active ? 1 : 0) >= MAX_OUTPUT_FRAMES || bytes + size > MAX_OUTPUT_BYTES) {
        fail()
        return Promise.reject(closedError)
      }
      return new Promise<void>(
        /* 发送结果由SDK等待；预算登记早于任何同步流回调。 */ (resolve, reject) => {
          queue.push({ raw, bytes: size, current, onWrite, resolve, reject, written: false, waitingDrain: false })
          bytes += size
          pump()
        }
      )
    }
  }
}
