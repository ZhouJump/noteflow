/**
 * Pixel-exact re-implementations of the two OpenCV/PIL steps HOMR runs before SegNet.
 *
 * The Python baseline does:
 *   PIL.Image.resize((1920, round(h * 1920 / w)))   # default resample = BICUBIC
 *   cv2.cvtColor(img, COLOR_BGR2GRAY)
 *   cv2.createCLAHE(clipLimit=1.0, tileGridSize=(8, 8)).apply(gray)
 *
 * Both are reproduced here because a one-pixel shift in the page image moves every
 * downstream note. See docs/m3-browser-inference.md for the measured deltas.
 *
 * Order matters: the resize must match Pillow bit for bit, otherwise the CLAHE
 * histograms land in different bins and the difference compounds.
 */

/*
 * Pillow's bicubic_filter is the a = -0.5 Catmull-Rom kernel, *not* the
 * B = C = 1/3 variant. Copied verbatim from src/libImaging/Resample.c so the
 * float64 results are bit-identical.
 */
const BICUBIC_A = -0.5;

function cubic(x) {
  if (x < 0) x = -x;
  if (x < 1.0) return ((BICUBIC_A + 2.0) * x - (BICUBIC_A + 3.0)) * x * x + 1;
  if (x < 2.0) return (((x - 5) * x + 8) * x - 4) * BICUBIC_A;
  return 0;
}

/*
 * Pillow accumulates in int32 with coefficients fixed-point scaled by 2^22 and a
 * 1 << 21 rounding bias, then truncates with `>> PRECISION_BITS`. Reproduce that
 * exactly: float accumulation rounds differently on ~4% of the pixels, which is
 * enough to move SegNet's class boundaries.
 */
const PRECISION_BITS = 32 - 8 - 2; // 22, as in Resample.c
const PRECISION_SCALE = 1 << PRECISION_BITS;
const PRECISION_BIAS = 1 << (PRECISION_BITS - 1);

/**
 * Precompute Pillow's separable filter taps for one axis.
 * Mirrors precompute_coeffs() + normalize_coeffs_8bpc() in Resample.c.
 */
function precomputeCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1.0);
  const support = 2.0 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const coeffs = new Int32Array(outSize * ksize);
  const invFilterscale = 1.0 / filterscale;

  for (let i = 0; i < outSize; i += 1) {
    const center = (i + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    const count = xmax - xmin;

    const taps = new Float64Array(count);
    let sum = 0;
    for (let x = 0; x < count; x += 1) {
      const w = cubic((x + xmin - center + 0.5) * invFilterscale);
      taps[x] = w;
      sum += w;
    }
    const base = i * ksize;
    if (sum !== 0) {
      for (let x = 0; x < count; x += 1) {
        const w = taps[x] / sum;
        coeffs[base + x] = Math.trunc(w * PRECISION_SCALE + (w < 0 ? -0.5 : 0.5));
      }
    } else {
      for (let x = 0; x < count; x += 1) coeffs[base + x] = 0;
    }
    bounds[i * 2] = xmin;
    bounds[i * 2 + 1] = count;
  }
  return { coeffs, bounds, ksize };
}

/** Resample.c's clip8(): arithmetic shift, then clamp through the lookup table. */
function clip8(acc) {
  const v = Math.floor(acc / PRECISION_SCALE);
  return v <= 0 ? 0 : v >= 255 ? 255 : v;
}

/**
 * Pillow-compatible BICUBIC resize of an 8-bit interleaved image.
 * Two passes with a uint8 round-trip in between, exactly like Pillow does.
 */
export function resizeBicubic(src, srcW, srcH, dstW, dstH, channels) {
  const horiz = precomputeCoeffs(srcW, dstW);
  const temp = new Uint8Array(dstW * srcH * channels);

  for (let y = 0; y < srcH; y += 1) {
    const rowIn = y * srcW * channels;
    const rowOut = y * dstW * channels;
    for (let x = 0; x < dstW; x += 1) {
      const xmin = horiz.bounds[x * 2];
      const count = horiz.bounds[x * 2 + 1];
      const base = x * horiz.ksize;
      for (let c = 0; c < channels; c += 1) {
        let acc = PRECISION_BIAS;
        for (let k = 0; k < count; k += 1) {
          acc += src[rowIn + (xmin + k) * channels + c] * horiz.coeffs[base + k];
        }
        temp[rowOut + x * channels + c] = clip8(acc);
      }
    }
  }

  const vert = precomputeCoeffs(srcH, dstH);
  const out = new Uint8Array(dstW * dstH * channels);
  for (let y = 0; y < dstH; y += 1) {
    const ymin = vert.bounds[y * 2];
    const count = vert.bounds[y * 2 + 1];
    const base = y * vert.ksize;
    const rowOut = y * dstW * channels;
    for (let x = 0; x < dstW; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        let acc = PRECISION_BIAS;
        for (let k = 0; k < count; k += 1) {
          acc += temp[((ymin + k) * dstW + x) * channels + c] * vert.coeffs[base + k];
        }
        out[rowOut + x * channels + c] = clip8(acc);
      }
    }
  }
  return out;
}

/**
 * cv2.cvtColor(BGR2GRAY) uses fixed-point weights; RGB input needs the same
 * coefficients with R and B swapped. Keep the integer arithmetic.
 */
export function grayFromRgb(rgb, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 3) {
    out[i] = (rgb[p] * 4899 + rgb[p + 1] * 9617 + rgb[p + 2] * 1868 + 8192) >> 14;
  }
  return out;
}

/** cv2.copyMakeBorder(..., BORDER_REFLECT_101) for the right/bottom edges. */
function padReflect101(src, width, height, padRight, padBottom) {
  const outW = width + padRight;
  const outH = height + padBottom;
  const out = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y += 1) {
    const sy = y < height ? y : 2 * height - y - 2;
    for (let x = 0; x < outW; x += 1) {
      const sx = x < width ? x : 2 * width - x - 2;
      out[y * outW + x] = src[sy * width + sx];
    }
  }
  return { data: out, width: outW, height: outH };
}

const fround = Math.fround;

/** cvRound()/saturate_cast<uchar>(float): round half to even, then clamp. */
function roundEvenToByte(v) {
  const r = Math.round(v);
  // Math.round breaks ties upward; cvRound breaks them to even.
  const even = Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  return even <= 0 ? 0 : even >= 255 ? 255 : even;
}

/**
 * Per-tile CLAHE lookup tables, the `calcLut` half of OpenCV's clahe.cpp.
 * Exported so the tables can be diffed against cv2 without going through the
 * interpolation stage.
 */
export function claheLuts(gray, width, height, tilesX, tilesY, clipLimit, histSize = 256) {
  // Measured, not read off clahe.cpp: when either axis is not a multiple of the
  // tile count OpenCV pads a *whole* tile on both axes, including the axis that
  // already divided evenly. A 1920x2714 page in an 8x8 grid therefore grows to
  // 1928x2720 and uses 241x340 tiles, not 240x340. That extra column is what made
  // the last tile column disagree with its own histogram; see
  // docs/m3-browser-inference.md §3.2.
  const needsPad = width % tilesX !== 0 || height % tilesY !== 0;
  const padRight = needsPad ? tilesX - (width % tilesX) : 0;
  const padBottom = needsPad ? tilesY - (height % tilesY) : 0;
  const padded = padReflect101(gray, width, height, padRight, padBottom);

  const tileW = padded.width / tilesX;
  const tileH = padded.height / tilesY;
  const tileArea = tileW * tileH;
  // static_cast<int>(clipLimit * tileArea / histSize), truncated, then >= 1.
  const limit = Math.max(1, Math.trunc((clipLimit * tileArea) / histSize));
  const lutScale = fround((histSize - 1) / tileArea);

  const luts = new Uint8Array(tilesX * tilesY * histSize);
  const hist = new Int32Array(histSize);

  for (let ty = 0; ty < tilesY; ty += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) {
      hist.fill(0);
      for (let y = 0; y < tileH; y += 1) {
        const row = (ty * tileH + y) * padded.width + tx * tileW;
        for (let x = 0; x < tileW; x += 1) hist[padded.data[row + x]] += 1;
      }

      let clipped = 0;
      for (let i = 0; i < histSize; i += 1) {
        if (hist[i] > limit) {
          clipped += hist[i] - limit;
          hist[i] = limit;
        }
      }
      const batch = Math.floor(clipped / histSize);
      let residual = clipped - batch * histSize;
      for (let i = 0; i < histSize; i += 1) hist[i] += batch;
      if (residual !== 0) {
        const step = Math.max(Math.floor(histSize / residual), 1);
        for (let i = 0; i < histSize && residual > 0; i += step, residual -= 1) hist[i] += 1;
      }

      let sum = 0;
      const base = (ty * tilesX + tx) * histSize;
      for (let i = 0; i < histSize; i += 1) {
        sum += hist[i];
        luts[base + i] = roundEvenToByte(fround(sum * lutScale));
      }
    }
  }
  return { luts, padded, tileW, tileH, limit, histSize };
}

/**
 * cv2.createCLAHE(clipLimit, tileGridSize).apply(gray).
 * Follows OpenCV's clahe.cpp: reflect-101 padding up to the next tile boundary,
 * per-tile histogram clipping + uniform redistribution, then bilinear blending.
 *
 * Three details are easy to get wrong and each one shifts a visible number of
 * pixels: clipLimit truncates to int, the interpolation is anchored on
 * `x * inv_tile - 0.5` (not the pixel centre), and every blend step runs in
 * float32 with cvRound (half to even) at the end.
 */
export function clahe(gray, width, height, tilesX = 8, tilesY = 8, clipLimit = 1.0) {
  const { luts, padded, tileW, tileH, histSize } = claheLuts(
    gray,
    width,
    height,
    tilesX,
    tilesY,
    clipLimit,
  );

  // Per-column interpolation weights, exactly as CLAHE_Interpolation_Body does it.
  const ind1 = new Int32Array(width);
  const ind2 = new Int32Array(width);
  const xa = new Float32Array(width);
  const invTileW = fround(1 / tileW);
  for (let x = 0; x < width; x += 1) {
    const txf = fround(fround(x * invTileW) - 0.5);
    const tx1 = Math.floor(txf);
    xa[x] = fround(txf - tx1);
    ind1[x] = Math.max(tx1, 0) * histSize;
    ind2[x] = Math.min(tx1 + 1, tilesX - 1) * histSize;
  }

  const out = new Uint8Array(width * height);
  const invTileH = fround(1 / tileH);
  for (let y = 0; y < height; y += 1) {
    const tyf = fround(fround(y * invTileH) - 0.5);
    const ty1 = Math.floor(tyf);
    const ya = fround(tyf - ty1);
    const ya1 = fround(1.0 - ya);
    const rowA = Math.max(ty1, 0) * tilesX * histSize;
    const rowB = Math.min(ty1 + 1, tilesY - 1) * tilesX * histSize;
    const srcRow = y * padded.width;
    const dstRow = y * width;

    for (let x = 0; x < width; x += 1) {
      const v = padded.data[srcRow + x];
      const i1 = ind1[x] + v;
      const i2 = ind2[x] + v;
      const ax = xa[x];
      const ax1 = fround(1.0 - ax);
      const top = fround(fround(luts[rowA + i1] * ax1) + fround(luts[rowA + i2] * ax));
      const bottom = fround(fround(luts[rowB + i1] * ax1) + fround(luts[rowB + i2] * ax));
      out[dstRow + x] = roundEvenToByte(fround(fround(top * ya1) + fround(bottom * ya)));
    }
  }
  return out;
}
