/**
 * M4 page: pick a page photo, run the whole HOMR chain in the worker, overlay what was
 * recognised and export the results.
 *
 * Everything shown here comes from the worker's report of a real run: the staff outlines
 * and the noteheads are geometry the segmentation produced, and the symbol dots are the
 * decoder's attention points carried back to page coordinates. Nothing is synthesised.
 *
 * The page the models see is 1920 px wide, so `result.scale` converts page coordinates
 * to the pixels of the file the user picked; the exported JSON is in input-image space.
 */

const fileInput = document.querySelector<HTMLInputElement>('#file')!;
const fileInfo = document.querySelector<HTMLParagraphElement>('#file-info')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const sampleButton = document.querySelector<HTMLButtonElement>('#sample')!;
const replayButton = document.querySelector<HTMLButtonElement>('#replay')!;
const log = document.querySelector<HTMLPreElement>('#log')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const bar = document.querySelector<HTMLDivElement>('#bar')!;
const pageCanvas = document.querySelector<HTMLCanvasElement>('#page')!;
const overlayCanvas = document.querySelector<HTMLCanvasElement>('#overlay')!;
const empty = document.querySelector<HTMLDivElement>('#empty')!;
const counts = document.querySelector<HTMLDListElement>('#counts')!;
const environment = document.querySelector<HTMLDListElement>('#env')!;
const musicXmlView = document.querySelector<HTMLPreElement>('#musicxml')!;
const downloadXml = document.querySelector<HTMLButtonElement>('#download-xml')!;
const downloadJson = document.querySelector<HTMLButtonElement>('#download-json')!;
const downloadReport = document.querySelector<HTMLButtonElement>('#download-report')!;
const toggles = {
  staffs: document.querySelector<HTMLInputElement>('#show-staffs')!,
  notes: document.querySelector<HTMLInputElement>('#show-notes')!,
  symbols: document.querySelector<HTMLInputElement>('#show-symbols')!,
  mask: document.querySelector<HTMLInputElement>('#show-mask')!,
};

/** The three ONNX files `scripts/prepare-assets.mjs` links in, with their HOMR names. */
const MODELS = [
  'segnet_308-3296ccd4 (320x320, 6 classes)',
  'encoder_pytorch_model_396-f6feedb4 (256x1280 -> 1280x512)',
  'decoder_pytorch_model_396-f6feedb4 (int8, 32 KV caches)',
];
/** `reference/homr` is the fschuh/homr fork; see PORTING_STATUS.md. */
const SOURCE_REVISION = 'fschuh/homr 0b9a9d65ca8623e8e6757f1a83ee39be4542156b';
const SAMPLE_IMAGE = '/samples/永远同在1.jpg';

interface SymbolRow {
  rhythm: string;
  pitch: string;
  lift: string;
  articulation: string;
  slur: string;
  position: string;
  /** Page coordinates of the decoder's attention point; null when unmapped. */
  x: number | null;
  y: number | null;
}

interface StaffRow {
  index: number;
  voice: number;
  systemIndex: number;
  quad: [number, number][];
  symbols: SymbolRow[];
  notes: { x: number; y: number; width: number; height: number; angle: number }[];
}

interface RecogniseResult {
  type: 'result';
  title: string;
  musicxml: string;
  page: { width: number; height: number };
  image: { width: number; height: number };
  scale: { x: number; y: number };
  voices: Record<string, string>[][];
  staffs: StaffRow[];
  counts: {
    noteheads: number;
    systems: number;
    staves: number;
    symbols: number;
    notes: number;
    rests: number;
    withPosition: number;
    withoutPosition: number;
  };
  timings: Record<string, number>;
  runtime: { threads: number; crossOriginIsolated: boolean; hardwareConcurrency: number };
}

type Stage = 'preprocess' | 'segnet' | 'symbols' | 'staffs' | 'transformer' | 'musicxml';

const STAGE_LABELS: Record<Stage, string> = {
  preprocess: '预处理',
  segnet: 'SegNet 分割',
  symbols: '符号与谱表检测',
  staffs: '谱表合并',
  transformer: 'Transformer 识别',
  musicxml: '生成 MusicXML',
};

/** Rough share of the wall clock each stage takes, for one overall bar. */
const STAGE_SPAN: Record<Stage, [number, number]> = {
  preprocess: [0, 0.02],
  segnet: [0.02, 0.62],
  symbols: [0.62, 0.7],
  staffs: [0.7, 0.72],
  transformer: [0.72, 0.97],
  musicxml: [0.97, 1],
};

const CLASS_COLORS: [number, number, number][] = [
  [0, 0, 0], // 0 background
  [220, 30, 30], // 1 stems / rests
  [30, 90, 220], // 2 noteheads
  [20, 160, 90], // 3 clefs / keys
  [120, 120, 120], // 4 staff lines
  [240, 150, 0], // 5 other symbols
];

const worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });

let bitmap: ImageBitmap | null = null;
let pageRgb: Uint8Array | null = null;
let pageSize: { width: number; height: number } | null = null;
let classMap: Uint8Array | null = null;
let result: RecogniseResult | null = null;
let running = false;

const ms = (value: number) => `${(value / 1000).toFixed(2)} s`;

function say(line: string): void {
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
}

function setProgress(fraction: number, text: string): void {
  bar.style.width = `${Math.round(fraction * 100)}%`;
  status.textContent = text;
}

function definitionList(target: HTMLDListElement, rows: [string, string][]): void {
  target.replaceChildren();
  for (const [term, value] of rows) {
    target.append(Object.assign(document.createElement('dt'), { textContent: term }));
    target.append(Object.assign(document.createElement('dd'), { textContent: value }));
  }
}

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Paint the page the models saw, optionally with the segmentation class map on top. */
function renderPage(): void {
  if (!pageRgb || !pageSize) return;
  // The canvas is the 1920 px page, not the image the user picked: `page-done` arrives
  // before `result`, so the size has to come from the worker.
  const { width, height } = pageSize;
  const pixels = width * height;
  const image = new ImageData(width, height);
  for (let i = 0, p = 0, q = 0; i < pixels; i += 1, p += 4, q += 3) {
    if (classMap && toggles.mask.checked) {
      const [r, g, b] = CLASS_COLORS[classMap[i]] ?? CLASS_COLORS[0];
      image.data[p] = r;
      image.data[p + 1] = g;
      image.data[p + 2] = b;
    } else {
      image.data[p] = pageRgb[q];
      image.data[p + 1] = pageRgb[q + 1];
      image.data[p + 2] = pageRgb[q + 2];
    }
    image.data[p + 3] = 255;
  }
  pageCanvas.width = width;
  pageCanvas.height = height;
  pageCanvas.getContext('2d')!.putImageData(image, 0, 0);
  empty.hidden = true;
}

/** Page coordinates to canvas pixels: the canvas is the 1920 px page. */
function drawOverlay(): void {
  overlayCanvas.width = pageCanvas.width;
  overlayCanvas.height = pageCanvas.height;
  const context = overlayCanvas.getContext('2d')!;
  context.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!result) return;
  const sx = overlayCanvas.width / result.page.width;
  const sy = overlayCanvas.height / result.page.height;

  if (toggles.staffs.checked) {
    context.lineWidth = 1.5;
    context.strokeStyle = 'rgba(26, 115, 232, 0.85)';
    context.fillStyle = 'rgba(26, 115, 232, 0.9)';
    context.font = '12px system-ui, sans-serif';
    for (const staff of result.staffs) {
      context.beginPath();
      staff.quad.forEach(([x, y], index) => {
        if (index === 0) context.moveTo(x * sx, y * sy);
        else context.lineTo(x * sx, y * sy);
      });
      context.closePath();
      context.stroke();
      const [x, y] = staff.quad[0];
      context.fillText(`P${staff.voice + 1}.${staff.systemIndex + 1}`, x * sx + 4, y * sy - 4);
    }
  }

  if (toggles.notes.checked) {
    context.strokeStyle = 'rgba(240, 150, 0, 0.9)';
    context.lineWidth = 1;
    for (const staff of result.staffs) {
      for (const note of staff.notes) {
        context.beginPath();
        context.ellipse(
          note.x * sx,
          note.y * sy,
          Math.max(1, (note.width / 2) * sx),
          Math.max(1, (note.height / 2) * sy),
          (note.angle * Math.PI) / 180,
          0,
          2 * Math.PI,
        );
        context.stroke();
      }
    }
  }

  if (toggles.symbols.checked) {
    context.fillStyle = 'rgba(20, 150, 90, 0.85)';
    for (const staff of result.staffs) {
      for (const symbol of staff.symbols) {
        if (symbol.x === null || symbol.y === null) continue;
        context.beginPath();
        context.arc(symbol.x * sx, symbol.y * sy, 3, 0, 2 * Math.PI);
        context.fill();
      }
    }
  }
}

function renderCounts(): void {
  if (!result) {
    definitionList(counts, [['状态', '尚未识别']]);
    return;
  }
  const { counts: value, timings } = result;
  definitionList(counts, [
    ['谱表 / 系统', `${value.staves} / ${value.systems}`],
    ['音符头', String(value.noteheads)],
    ['识别音符 / 休止符', `${value.notes} / ${value.rests}`],
    ['定位点（已关联 / 未关联）', `${value.withPosition} / ${value.withoutPosition}`],
    ['耗时', `${ms(timings.total)}（SegNet ${ms(timings.segnet)}，Transformer ${ms(timings.transformer)}）`],
  ]);
}

function renderEnvironment(): void {
  const runtime = result?.runtime;
  definitionList(environment, [
    ['运行方式', `Web Worker + WASM${runtime ? `，${runtime.threads} 线程` : ''}`],
    ['跨源隔离', (runtime?.crossOriginIsolated ?? globalThis.crossOriginIsolated) ? '已启用（COOP/COEP）' : '未启用'],
    ['逻辑核心', String(runtime?.hardwareConcurrency ?? navigator.hardwareConcurrency)],
    ['模型', MODELS.join('\n')],
    ['源码版本', SOURCE_REVISION],
    ['浏览器', navigator.userAgent],
  ]);
}

/** `input-image` coordinates: what the JSON export promises in `schemaVersion: 1`. */
function normalisedJson(): string {
  if (!result) return '{}';
  const scale = result.scale;
  const notes: Record<string, unknown>[] = [];
  const unmatched: Record<string, unknown>[] = [];
  for (const staff of result.staffs) {
    staff.symbols.forEach((symbol, index) => {
      const id = `s${staff.index}-${index}`;
      const entry = {
        id,
        voice: staff.voice + 1,
        staff: staff.systemIndex + 1,
        rhythm: symbol.rhythm,
        pitch: symbol.pitch,
        lift: symbol.lift,
        articulation: symbol.articulation,
        slur: symbol.slur,
      };
      if (symbol.x === null || symbol.y === null) {
        unmatched.push({ ...entry, reason: 'decoder gave no attention point' });
        return;
      }
      notes.push({
        ...entry,
        x: Number((symbol.x / scale.x).toFixed(2)),
        y: Number((symbol.y / scale.y).toFixed(2)),
      });
    });
  }
  return JSON.stringify(
    {
      schemaVersion: 1,
      coordinateSpace: 'input-image',
      image: result.image,
      page: result.page,
      scale,
      notes,
      unmatched,
      metadata: {
        title: result.title,
        sourceRevision: SOURCE_REVISION,
        models: MODELS,
        generatedAt: new Date().toISOString(),
      },
    },
    null,
    2,
  );
}

function reportJson(): string {
  if (!result) return '{}';
  return JSON.stringify(
    {
      title: result.title,
      image: result.image,
      page: result.page,
      counts: result.counts,
      timings: result.timings,
      runtime: result.runtime,
      models: MODELS,
      sourceRevision: SOURCE_REVISION,
      staffs: result.staffs.map((staff) => ({
        index: staff.index,
        voice: staff.voice + 1,
        system: staff.systemIndex + 1,
        symbols: staff.symbols.length,
        noteheads: staff.notes.length,
      })),
      voices: result.voices,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

function showResult(): void {
  if (!result) return;
  musicXmlView.textContent = result.musicxml;
  downloadXml.disabled = false;
  downloadJson.disabled = false;
  downloadReport.disabled = false;
  renderCounts();
  renderEnvironment();
  drawOverlay();
}

worker.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;

  if (data.type === 'progress') {
    const stage = data.stage as Stage;
    const [start, end] = STAGE_SPAN[stage];
    const fraction = end - start <= 0 ? end : start + (end - start) * (data.done / data.total);
    setProgress(fraction, `${STAGE_LABELS[stage]} ${data.done}/${data.total}`);
    return;
  }

  if (data.type === 'page-done') {
    pageRgb = new Uint8Array(data.rgb);
    classMap = new Uint8Array(data.mask);
    pageSize = { width: data.width, height: data.height };
    renderPage();
    drawOverlay();
    say(
      `  页面 ${data.width}×${data.height}，SegNet ${data.timings.tiles} 块，` +
        `掩码像素 ${data.histogram.map((v: number, i: number) => `${i}:${v}`).join(' ')}`,
    );
    return;
  }

  if (data.type === 'result') {
    result = data as RecogniseResult;
    running = false;
    runButton.disabled = bitmap === null;
    setProgress(1, `识别完成：${result.counts.notes} 个音符，${result.counts.staves} 个谱表`);
    say(`  识别完成，${result.counts.notes} 个音符，${result.counts.rests} 个休止符`);
    say(`  生成 MusicXML ${result.musicxml.split('\n').length} 行，可下载`);
    showResult();
    return;
  }

  if (data.type === 'replay-staff') {
    const ok = data.mismatches.length === 0 && data.steps === data.referenceSteps;
    say(
      `  谱表 ${data.index}: encoder ${ms(data.encoderMs)}  decoder ${ms(data.decoderMs)} ` +
        `${data.steps} 步（参考 ${data.referenceSteps}）${ok ? 'token 全等' : 'token 不一致'}`,
    );
    for (const line of data.mismatches) say(`    ${line}`);
    return;
  }

  if (data.type === 'replay-done') {
    say('  参考谱表回放完成');
    return;
  }

  if (data.type === 'error') {
    running = false;
    runButton.disabled = bitmap === null;
    setProgress(0, `失败：${data.message}`);
    say(`  失败：${data.message}`);
  }
});

async function useFile(file: File, label: string): Promise<void> {
  result = null;
  pageRgb = null;
  pageSize = null;
  classMap = null;
  bitmap = await createImageBitmap(file);
  fileInfo.textContent = `${label} · ${bitmap.width}×${bitmap.height} · ${(file.size / 1024).toFixed(0)} KB`;

  pageCanvas.width = bitmap.width;
  pageCanvas.height = bitmap.height;
  const context = pageCanvas.getContext('2d')!;
  context.clearRect(0, 0, pageCanvas.width, pageCanvas.height);
  context.drawImage(bitmap, 0, 0);
  empty.hidden = true;
  overlayCanvas.width = 0;
  overlayCanvas.height = 0;

  renderCounts();
  musicXmlView.textContent = '';
  downloadXml.disabled = true;
  downloadJson.disabled = true;
  downloadReport.disabled = true;
  runButton.disabled = false;
  setProgress(0, '已选择图片，点击开始识别');
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void useFile(file, file.name);
});

sampleButton.addEventListener('click', async () => {
  setProgress(0, '加载示例图片');
  try {
    const response = await fetch(SAMPLE_IMAGE);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    await useFile(new File([blob], '永远同在1.jpg', { type: blob.type }), '示例图片');
  } catch (error) {
    setProgress(0, `示例图片加载失败：${(error as Error).message}`);
  }
});

runButton.addEventListener('click', () => {
  if (!bitmap || running) return;
  running = true;
  runButton.disabled = true;
  result = null;
  log.textContent = '';
  setProgress(0, '开始识别');
  say(`识别 ${fileInput.files?.[0]?.name ?? '示例图片'}`);

  const scratch = document.createElement('canvas');
  scratch.width = bitmap.width;
  scratch.height = bitmap.height;
  const context = scratch.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const name = fileInput.files?.[0]?.name ?? '永远同在1.jpg';
  worker.postMessage(
    { type: 'page', rgba: image.data.buffer, width: bitmap.width, height: bitmap.height, name },
    [image.data.buffer],
  );
});

replayButton.addEventListener('click', () => {
  say('回放参考谱表（encoder + decoder）');
  worker.postMessage({ type: 'replay' });
});

downloadXml.addEventListener('click', () => {
  if (result) download(`${result.title}.musicxml`, result.musicxml, 'application/vnd.recordare.musicxml+xml');
});
downloadJson.addEventListener('click', () => {
  if (result) download(`${result.title}.localisation.json`, normalisedJson(), 'application/json');
});
downloadReport.addEventListener('click', () => {
  if (result) download(`${result.title}.report.json`, reportJson(), 'application/json');
});

for (const toggle of Object.values(toggles)) {
  toggle.addEventListener('change', () => {
    renderPage();
    drawOverlay();
  });
}

renderCounts();
renderEnvironment();
setProgress(0, '等待图片');
