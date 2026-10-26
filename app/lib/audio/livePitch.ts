/**
 * 实时复音检测：AudioWorklet 采到 22050Hz → Worker 里跑 Basic Pitch → 逐帧音高。
 *
 * 单音检测（Pitchy）分不开和弦和双声部，练习时的代表性问题都在这里：钢琴踩下
 * 踏板一片延音、小提琴双音有两个基频。所以练习模式优先走这条链路，模型或 ORT
 * 不可用时再由调用方退回 Pitchy。
 *
 * 只在浏览器里运行：Worklet、Worker、AudioContext 都在函数被调用时才用到，
 * 因此 SSR 阶段可以安全地导入。
 */

import type { BasicPitchEvent } from './basicPitch'

const WORKLET_URL = '/audio/pitch-worklet.js'
/**
 * 首次进练习要先下 14MB 的 ORT wasm 和 225KB 的模型。超过这个时间就不再等，
 * 本场退回单音检测；下一次资源已经在浏览器缓存里，一般一秒内就绪。
 */
const READY_TIMEOUT = 4000

export interface LivePitch {
  /** 暂停时断开输入：停止推理，恢复后时间轴接着往下走，不会冒出一段空白。 */
  setPaused(paused: boolean): void
  stop(): void
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`复音检测 ${ms}ms 内没有就绪`)), ms)
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export async function startLivePitch(
  context: AudioContext,
  source: AudioNode,
  onFrames: (frames: BasicPitchEvent[]) => void
): Promise<LivePitch> {
  await context.audioWorklet.addModule(WORKLET_URL)
  const worker = new Worker(new URL('../../workers/pitch.worker.ts', import.meta.url), { type: 'module' })
  const node = new AudioWorkletNode(context, 'pitch-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  })
  // 输出必须接到 destination，浏览器才会持续拉这个节点；增益 0 保证听不到自己的麦克风。
  const mute = context.createGain()
  mute.gain.value = 0
  node.connect(mute).connect(context.destination)

  let connected = true
  let settle: { resolve: () => void, reject: (error: Error) => void } | null = null
  const ready = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject }
  })

  function fail(error: Error): void {
    if (settle === null) {
      console.error('复音检测中断', error)
      return
    }
    settle.reject(error)
    settle = null
  }

  function stop(): void {
    connected = false
    settle = null
    node.port.onmessage = null
    node.onprocessorerror = null
    worker.onmessage = null
    worker.onerror = null
    try {
      source.disconnect(node)
    } catch {
      // 已经断开过了。
    }
    node.disconnect()
    mute.disconnect()
    worker.terminate()
  }

  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type: string, samples?: Float32Array }
    if (data.type !== 'pcm' || data.samples === undefined) return
    worker.postMessage({ type: 'audio', samples: data.samples }, [data.samples.buffer])
  }
  node.onprocessorerror = () => fail(new Error('采集节点出错了'))

  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as { type: string, frames?: BasicPitchEvent[], message?: string }
    if (data.type === 'frames') {
      onFrames(data.frames ?? [])
      return
    }
    if (data.type === 'ready') {
      settle?.resolve()
      settle = null
      return
    }
    if (data.type === 'unavailable' || data.type === 'error') {
      fail(new Error(data.message ?? '复音检测启动失败'))
    }
  }
  worker.onerror = event => fail(new Error(event.message || '复音检测 Worker 加载失败'))

  // 先开始录音再等模型：加载的这几百毫秒里的声音会进窗口，就绪时正好是一整窗。
  worker.postMessage({ type: 'start', baseAt: performance.now() })
  source.connect(node)

  try {
    await withTimeout(ready, READY_TIMEOUT)
  } catch (error) {
    stop()
    throw error
  }

  return {
    setPaused(paused: boolean): void {
      if (paused === !connected) return
      if (paused) {
        try {
          source.disconnect(node)
        } catch {
          // 已经断开过了。
        }
        connected = false
        return
      }
      source.connect(node)
      connected = true
    },
    stop
  }
}
