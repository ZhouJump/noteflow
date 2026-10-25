/**
 * Drive the M4 page in a real Chromium (headless) and print what it reports.
 *
 * This is the only way to measure the browser honestly: WASM threads, Worker,
 * ImageBitmap decode and the ORT runtime all behave differently outside Node.
 *
 *   node scripts/browser-run.mjs [--image <path>] [--url http://127.0.0.1:4173/] [--keep]
 *
 * Without --url it builds nothing and starts `vite preview` itself, so the page
 * under test is the production bundle. What the page produced is written to
 * artifacts/browser/<page>/, next to the Python baseline it is compared with: the
 * MusicXML from the panel, the three exports through the real download buttons, and
 * screenshots of the overlay so the positioning can be inspected without a screen.
 *
 * With a non-score image the run is expected to fail; the error state is written to
 * `<page>_error.png` and the script exits 1.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const repo = path.resolve(web, '..');

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const image = path.resolve(flag('--image', path.join(repo, 'samples/input/永远同在1.jpg')));
const page = path.basename(image, path.extname(image));
const url = flag('--url', 'http://127.0.0.1:4173/');
const keep = process.argv.includes('--keep');

const BROWSER = process.env.BROWSER ?? '/usr/bin/microsoft-edge';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // keep polling
    }
    await sleep(250);
  }
  throw new Error(`timeout: ${label}`);
}

const children = [];
const shutdown = () => {
  for (const child of children) child.kill('SIGKILL');
};
process.on('exit', shutdown);
process.on('SIGINT', () => process.exit(1));

if (!flag('--url', null)) {
  const preview = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', '4173', '--strictPort'],
    { cwd: web, stdio: 'inherit' },
  );
  children.push(preview);
  await waitFor(async () => (await fetch(url)).ok, 30_000, 'vite preview');
}

const profile = fs.mkdtempSync('/tmp/homr-edge-');
const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    url,
  ],
  { stdio: 'ignore' },
);
children.push(browser);

const version = await waitFor(
  async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl,
  30_000,
  'devtools endpoint',
);

let list = [];
await waitFor(async () => {
  list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.some((target) => target.type === 'page' && target.webSocketDebuggerUrl);
}, 30_000, 'page target');
const target = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    const description = details.exception?.description ?? details.text;
    console.log(`[page error] ${description}`);
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (text) console.log(`[console] ${text}`);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = (nextId += 1);
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};

await send('Runtime.enable');
await send('DOM.enable');
await send('Page.enable');
await send('Page.reload');
await sleep(1500);

const ua = await evaluate('navigator.userAgent');
const isolated = await evaluate('crossOriginIsolated');
const threads = await evaluate('navigator.hardwareConcurrency');
console.log(`browser ${ua}`);
console.log(`crossOriginIsolated=${isolated} hardwareConcurrency=${threads}`);

const { root } = await send('DOM.getDocument', { depth: -1 });

// How much does the browser's own JPEG decoder differ from libjpeg-turbo (the
// Python side)? That difference is the only error the port cannot remove.
const decodeDelta = await evaluate(`(async () => {
  const [a, b] = await Promise.all([
    fetch('/samples/%E6%B0%B8%E8%BF%9C%E5%90%8C%E5%9C%A81.jpg').then((r) => r.blob()),
    fetch('/reference/current/page_decoded.png').then((r) => r.blob()),
  ]);
  const [ia, ib] = await Promise.all([createImageBitmap(a), createImageBitmap(b)]);
  const canvas = new OffscreenCanvas(ia.width, ia.height);
  const g = canvas.getContext('2d');
  const read = (bitmap) => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0);
    return g.getImageData(0, 0, bitmap.width, bitmap.height).data;
  };
  const da = read(ia);
  const db = read(ib);
  let max = 0, sum = 0, over = 0, n = 0;
  for (let i = 0; i < da.length; i += 1) {
    if ((i & 3) === 3) continue;
    const d = Math.abs(da[i] - db[i]);
    if (d > max) max = d;
    sum += d;
    if (d > 1) over += 1;
    n += 1;
  }
  return { max, mean: sum / n, over1: over / n };
})()`);
// Always measured on the reference page, whatever --image says.
console.log(
  `browser JPEG decode vs libjpeg-turbo (参考页 永远同在1): max=${decodeDelta.max} ` +
    `mean=${decodeDelta.mean.toFixed(3)} >1=${(decodeDelta.over1 * 100).toFixed(3)}%`,
);
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
await send('DOM.setFileInputFiles', { nodeId, files: [image] });
await waitFor(
  async () => (await evaluate("document.querySelector('#run').disabled")) === false,
  30_000,
  'image preview',
);

const started = Date.now();
await evaluate("document.querySelector('#run').click()");
let log = '';
try {
  await waitFor(
    async () => {
      log = await evaluate("document.querySelector('#log').textContent");
      return log.includes('识别完成') || log.includes('失败');
    },
    Number(process.env.PAGE_TIMEOUT ?? 1_800_000),
    'page pipeline',
  );
} catch (error) {
  console.log(`\n--- 失败，页面日志 ---\n${log.trim() || '(空)'}`);
  throw error;
}
console.log(`\n--- 页面链路（含浏览器解码），墙钟 ${((Date.now() - started) / 1000).toFixed(1)} s ---`);
console.log(log.trim());

const outDir = path.join(repo, 'artifacts/browser', page);
fs.mkdirSync(outDir, { recursive: true });
await send('Emulation.setDeviceMetricsOverride', {
  width: 1500,
  height: 1100,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(500);
const shoot = async (name) => {
  const metrics = await send('Page.getLayoutMetrics');
  const content = metrics.cssContentSize ?? metrics.contentSize;
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: content.width, height: content.height, scale: 1 },
  });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`截图 ${path.relative(repo, file)}`);
};

// A non-score image must end in the error path, with the message visible on the page.
if (log.includes('失败')) {
  await shoot(`${page}_error.png`);
  console.log(`\n识别按预期失败，错误已写在页面上（${path.relative(repo, path.join(outDir, `${page}_error.png`))}）`);
  socket.close();
  if (!keep) shutdown();
  process.exit(1);
}

const summary = await evaluate("document.querySelector('#counts').innerText");
console.log(`\n--- 结果统计 ---\n${summary.trim()}`);
const environmentText = await evaluate("document.querySelector('#env').innerText");
console.log(`\n--- 运行环境 ---\n${environmentText.trim()}`);

const xml = await evaluate("document.querySelector('#musicxml').textContent");
fs.writeFileSync(path.join(outDir, `${page}.musicxml`), xml);
console.log(`\nMusicXML ${xml.split('\n').length} 行 -> ${path.relative(repo, outDir)}/`);

// The three export buttons, exercised the way a user clicks them.
const downloadDir = path.join(outDir, 'downloads');
fs.rmSync(downloadDir, { recursive: true, force: true });
fs.mkdirSync(downloadDir, { recursive: true });
try {
  await send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });
} catch {
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
}
const downloads = [`${page}.musicxml`, `${page}.localisation.json`, `${page}.report.json`];
for (const id of ['#download-xml', '#download-json', '#download-report']) {
  await evaluate(`document.querySelector('${id}').click()`);
}
const finished = () =>
  downloads.every((name) => {
    const file = path.join(downloadDir, name);
    return fs.existsSync(file) && fs.statSync(file).size > 0;
  }) && !fs.readdirSync(downloadDir).some((name) => name.endsWith('.crdownload'));
await waitFor(finished, 60_000, 'exports');
const downloadedXml = fs.readFileSync(path.join(downloadDir, downloads[0]), 'utf8');
console.log(
  `导出 ${downloads.map((name) => `${name} ${fs.statSync(path.join(downloadDir, name)).size} B`).join('，')}` +
    `${downloadedXml === xml ? '（下载的 MusicXML 与面板一致）' : '（下载的 MusicXML 与面板不一致）'}`,
);

// Screenshots: the default overlay, then the segmentation class map.
await shoot(`${page}_overlay.png`);
await evaluate(
  "(() => { const box = document.querySelector('#show-mask'); box.checked = true; box.dispatchEvent(new Event('change')); })()",
);
await sleep(800);
await shoot(`${page}_mask.png`);
await evaluate(
  "(() => { const box = document.querySelector('#show-mask'); box.checked = false; box.dispatchEvent(new Event('change')); })()",
);

// Full resolution strips: the canvases are 1920 px wide, so cropping them here shows
// whether every attention point really lands on the printed symbol.
const strip = async (name, top, height) => {
  const dataUrl = await evaluate(`(() => {
    const page = document.querySelector('#page');
    const overlay = document.querySelector('#overlay');
    const out = document.createElement('canvas');
    out.width = page.width;
    out.height = ${height};
    const context = out.getContext('2d');
    context.drawImage(page, 0, -${top});
    context.drawImage(overlay, 0, -${top});
    return out.toDataURL('image/png');
  })()`);
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  console.log(`细节 ${path.relative(repo, file)}`);
};
await strip(`${page}_detail-system1.png`, 820, 480);
await strip(`${page}_detail-system3.png`, 1690, 480);

await evaluate("document.querySelector('#replay').click()");
const replayStarted = Date.now();
await waitFor(
  async () => {
    log = await evaluate("document.querySelector('#log').textContent");
    return log.includes('回放完成') || log.includes('失败');
  },
  900_000,
  'transformer replay',
);
console.log(`\n--- transformer 回放，墙钟 ${((Date.now() - replayStarted) / 1000).toFixed(1)} s ---`);
console.log(log.trim().split('回放参考谱表')[1]?.trim() ?? log.trim());
socket.close();
if (!keep) shutdown();
