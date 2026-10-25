/**
 * The transformer stage: encoder + greedy decoder on one 1280x256 staff canvas.
 *
 * This is HOMR's `transformer/staff2score.py` + `decoder_inference.py`, ported to run on
 * ONNX Runtime Web sessions the caller owns (the worker keeps three sessions alive for
 * the whole page). The loop is the one verified in M3 against Python: the full encoder
 * context feeds step 0 and one position feeds every later step, the 32 KV cache tensors
 * grow by one position per step, and `cache_len` counts the steps already taken.
 *
 * `attention` is the decoder's localisation output: one (x, y) per token in
 * `model-input` space, i.e. on the staff canvas. HOMR stores it as the symbol's
 * coordinates and warns that it is only as precise as the model's attention, so it is
 * reported for the overlay and never used to decide the music.
 */

import type * as OrtTypes from 'onnxruntime-web/wasm'

import { currentOrt, type OrtModule } from './ortRuntime'
import type { GrayImage } from './staffDewarping'
import { EncodedSymbol, Vocabulary } from './vocabulary'

export const TR_OMR_HEIGHT = 256
export const TR_OMR_WIDTH = 1280
export const MAX_SEQ_LEN = 608
const BOS_TOKEN = 1
const EOS_TOKEN = 2
const NONOTE_TOKEN = 0
const MEAN = 0.7931
const STD = 0.1738
const DECODER_HEADS = 8
const DECODER_HEAD_DIM = 64
/** `decoder_depth * 4`: two attention blocks and two cross blocks per layer. */
const CACHE_TENSORS = 32

export interface TransformerSessions {
  encoder: OrtTypes.InferenceSession
  decoder: OrtTypes.InferenceSession
}

const vocabulary = new Vocabulary()
const inverse: Record<string, string[]> = {
  rhythm: Vocabulary.inverse(vocabulary.rhythm),
  pitch: Vocabulary.inverse(vocabulary.pitch),
  lift: Vocabulary.inverse(vocabulary.lift),
  articulation: Vocabulary.inverse(vocabulary.articulation),
  slur: Vocabulary.inverse(vocabulary.slur),
  position: Vocabulary.inverse(vocabulary.position)
}

/** The token a head's id stands for; ids outside the table become `#<id>`. */
function detokenize(head: keyof typeof inverse, id: number): string {
  return inverse[head][id] ?? `#${id}`
}

/** Greedy argmax of the last position of a decoder output. */
function argmaxLast(tensor: OrtTypes.Tensor): number {
  const data = tensor.data as Float32Array
  const stride = tensor.dims[tensor.dims.length - 1]
  const base = data.length - stride
  let best = 0
  for (let i = 1; i < stride; i += 1) {
    if (data[base + i] > data[base + best]) best = i
  }
  return best
}

function toInputTensor(canvas: GrayImage, ort: OrtModule): OrtTypes.Tensor {
  if (canvas.width !== TR_OMR_WIDTH || canvas.height !== TR_OMR_HEIGHT) {
    throw new Error(
      `staff canvas is ${canvas.width}x${canvas.height}, expected ${TR_OMR_WIDTH}x${TR_OMR_HEIGHT}`
    )
  }
  const input = new Float32Array(canvas.data.length)
  for (let i = 0; i < input.length; i += 1) input[i] = (canvas.data[i] / 255 - MEAN) / STD
  return new ort.Tensor('float32', input, [1, 1, TR_OMR_HEIGHT, TR_OMR_WIDTH])
}

/**
 * Run the transformer on one staff canvas and return its symbols in reading order.
 *
 * The caller decides what to do with `position == 'lower'` (HOMR drops those for a
 * staff that is not part of a grand staff) and with the `newline` separators, which are
 * only added between the staffs of one voice.
 */
export async function predictStaffSymbols(
  canvas: GrayImage,
  sessions: TransformerSessions
): Promise<EncodedSymbol[]> {
  const ort = currentOrt()
  const { encoder, decoder } = sessions
  const encoded = await encoder.run({
    [encoder.inputNames[0]]: toInputTensor(canvas, ort)
  })
  const context = encoded[encoder.outputNames[0]]

  let cache: OrtTypes.Tensor[] = []
  for (let i = 0; i < CACHE_TENSORS; i += 1) {
    cache.push(new ort.Tensor('float32', new Float32Array(0), [1, DECODER_HEADS, 0, DECODER_HEAD_DIM]))
  }

  const rhythm: number[] = [BOS_TOKEN]
  const pitch: number[] = [NONOTE_TOKEN]
  const lift: number[] = [NONOTE_TOKEN]
  const articulation: number[] = [NONOTE_TOKEN]
  const slur: number[] = [NONOTE_TOKEN]
  const symbols: EncodedSymbol[] = []
  const reducedContext = new ort.Tensor(
    'float32',
    (context.data as Float32Array).slice(0, 512),
    [1, 1, 512]
  )

  for (let step = 0; step < MAX_SEQ_LEN; step += 1) {
    const feeds: Record<string, OrtTypes.Tensor> = {
      rhythms: new ort.Tensor('int64', BigInt64Array.from([BigInt(rhythm[rhythm.length - 1])]), [1, 1]),
      pitchs: new ort.Tensor('int64', BigInt64Array.from([BigInt(pitch[pitch.length - 1])]), [1, 1]),
      lifts: new ort.Tensor('int64', BigInt64Array.from([BigInt(lift[lift.length - 1])]), [1, 1]),
      articulations: new ort.Tensor(
        'int64',
        BigInt64Array.from([BigInt(articulation[articulation.length - 1])]),
        [1, 1]
      ),
      slurs: new ort.Tensor('int64', BigInt64Array.from([BigInt(slur[slur.length - 1])]), [1, 1]),
      cache_len: new ort.Tensor('int64', BigInt64Array.from([BigInt(step)]), [1]),
      // After step 0 HOMR passes the first context position only; the decoder splits
      // the context with a reshape that only accepts that shape.
      context: step === 0 ? context : reducedContext
    }
    for (let i = 0; i < CACHE_TENSORS; i += 1) feeds[`cache_in${i}`] = cache[i]

    const out = await decoder.run(feeds)
    cache = []
    for (let i = 0; i < CACHE_TENSORS; i += 1) cache.push(out[`cache_out${i}`])

    const rhythmId = argmaxLast(out.out_rhythms)
    if (rhythmId === EOS_TOKEN) break
    const pitchId = argmaxLast(out.out_pitchs)
    const liftId = argmaxLast(out.out_lifts)
    const articulationId = argmaxLast(out.out_articulations)
    const slurId = argmaxLast(out.out_slurs)
    const positionId = argmaxLast(out.out_positions)

    rhythm.push(rhythmId)
    pitch.push(pitchId)
    lift.push(liftId)
    articulation.push(articulationId)
    slur.push(slurId)

    let coordinates: { x: number, y: number } | null = null
    const attention = out.attention
    if (attention !== undefined && attention.data.length >= 2) {
      const data = attention.data as Float32Array
      if (Number.isFinite(data[0]) && Number.isFinite(data[1])) {
        coordinates = { x: data[0], y: data[1] }
      }
    }

    symbols.push(
      new EncodedSymbol(
        detokenize('rhythm', rhythmId),
        detokenize('pitch', pitchId),
        detokenize('lift', liftId),
        detokenize('articulation', articulationId),
        detokenize('slur', slurId),
        detokenize('position', positionId),
        coordinates
      )
    )
  }

  return symbols
}
