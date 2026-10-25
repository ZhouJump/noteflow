/**
 * Worker 消息与识别结果在 UI 侧的镜像类型。
 *
 * 这些结构必须与 `app/workers/pipeline.worker.ts` 的 postMessage 载荷保持一致；
 * 坐标一律是模型看到的页面坐标，`scale` 负责换算回输入图片的像素。
 */

export interface RecognitionSymbol {
  /** 稳定 id（`s<谱表序号>-<符号序号>`），把写出的音符与注意力点对上。 */
  id: string
  rhythm: string
  pitch: string
  lift: string
  articulation: string
  slur: string
  position: string
  /** 页面坐标里的注意力点；decoder 没有给出位置时为 null。 */
  x: number | null
  y: number | null
}

export interface RecognitionNotehead {
  x: number
  y: number
  width: number
  height: number
  angle: number
}

export interface RecognitionStaff {
  index: number
  voice: number
  systemIndex: number
  quad: [number, number][]
  symbols: RecognitionSymbol[]
  notes: RecognitionNotehead[]
}

export interface RecognitionCounts {
  noteheads: number
  systems: number
  staves: number
  symbols: number
  notes: number
  rests: number
  withPosition: number
  withoutPosition: number
}

export interface RecognitionTimings {
  preprocess: number
  modelLoad: number
  segnet: number
  symbols: number
  transformer: number
  musicxml: number
  total: number
}

export interface RecognitionRuntime {
  threads: number
  crossOriginIsolated: boolean
  hardwareConcurrency: number
}

export interface RecognitionResult {
  type: 'result'
  title: string
  musicxml: string
  /**
   * 每个 `<note>` 元素一个符号 id（文档顺序）。写出器只在回调里报顺序，不往
   * MusicXML 里写 id，因此识别输出与参考实现仍然逐字节一致。
   */
  noteSymbols: (string | null)[]
  page: { width: number, height: number }
  image: { width: number, height: number }
  scale: { x: number, y: number }
  voices: Record<string, string>[][]
  staffs: RecognitionStaff[]
  counts: RecognitionCounts
  timings: RecognitionTimings
  runtime: RecognitionRuntime
}

/** SegNet 完成、几何还没跑完时先送到主线程的页面预览。 */
export interface PagePreview {
  width: number
  height: number
  /** 1920px 宽页面上的 RGB 像素。 */
  rgb: Uint8Array
  /** 每个像素的 SegNet 类别。 */
  mask: Uint8Array
  histogram: number[]
  timings: {
    preprocess: number
    modelLoad: number
    segnet: number
    tiles: number
  }
}

/**
 * Worker 里可预期的失败（例如图片里没有谱表）。
 * 消息本身就是给用户的说明，可以原样上界面；其它异常只写控制台。
 */
export class RecognitionHint extends Error {}

export type RecognitionStage = 'preprocess' | 'segnet' | 'symbols' | 'staffs' | 'transformer' | 'musicxml'

/** 识别阶段面向用户的说法：不出现模型与框架名称。 */
export const STAGE_LABELS: Record<RecognitionStage, string> = {
  preprocess: '整理页面',
  segnet: '找谱表',
  symbols: '找音符',
  staffs: '对齐谱表',
  transformer: '识别音符',
  musicxml: '整理曲谱'
}

/** 各阶段大致的墙钟占比，用来合成一根总进度条。 */
export const STAGE_SPAN: Record<RecognitionStage, [number, number]> = {
  preprocess: [0, 0.02],
  segnet: [0.02, 0.62],
  symbols: [0.62, 0.7],
  staffs: [0.7, 0.72],
  transformer: [0.72, 0.97],
  musicxml: [0.97, 1]
}

export const RECOGNITION_MODELS = [
  'segnet_308-3296ccd4 (320x320, 6 classes)',
  'encoder_pytorch_model_396-f6feedb4 (256x1280 -> 1280x512)',
  'decoder_pytorch_model_396-f6feedb4 (int8, 32 KV caches)'
]

export const HOMR_SOURCE_REVISION = 'fschuh/homr 0b9a9d65ca8623e8e6757f1a83ee39be4542156b'
