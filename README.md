# NoteFlow

乐谱识别与演奏跟踪应用（Nuxt 4 + Nuxt UI 4）。当前进度是 **M6：跟弹练习**，界面以手机为主 ——
图片按页导入，缩略图网格里可以继续添加、长按拖动排序，确认后整批识别；识别结果存到浏览器本机
（IndexedDB），书架只显示封面与标题。曲谱页直接显示识别后的页面图，可以翻页、点音符看底部音符卡；
定位圈会吸到音符头上，不跟着模型给出的注意力点漂。打开麦克风后进入跟弹练习：Pitchy 检测音高，
弹对目标音就往前推进，弹错或没听清时停在原地，点任意音符可以从那里继续。直接导入的 MusicXML
没有页面图，用 Verovio 排版，跟弹时当前目标会高亮并滚到屏幕中间。
识别统计、坐标、模型版本和 MusicXML 都不上界面。识别结果只读，不提供音符人工校正。

开发里程碑与约束见 [`.doc/开发指引.md`](.doc/开发指引.md)。

## 目录

```
app/                  应用源码（Nuxt srcDir）
  pages/index.vue       书架：读取 IndexedDB 里的真实曲谱
  pages/import/         导入入口、图片识别、MusicXML 导入
  pages/scores/[id].vue 曲谱页：翻页、页面图、底部音符卡、跟弹练习
  components/           PageHeader、Verovio 乐谱、页面图、音符卡、跟弹面板
  composables/          Worker 生命周期、Blob 临时地址、麦克风跟弹
  lib/audio/            音高换算与练习跟踪（不碰 DOM，可在 Node 里回归）
  workers/              pipeline.worker.ts，整条 HOMR 链
  lib/homr/             HOMR 的 TS 移植（模型、掩码、谱表、词表、MusicXML）
  lib/musicxml/         安全解析、音符模型、渲染副本
  lib/db/               IndexedDB 实体与仓储
  lib/verovio.ts        Verovio 懒加载与串行渲染
  lib/vision/           图像前置：缩放、灰度、CLAHE
public/               运行时静态资源（models/ samples/ verovio/ 由脚本链接生成；ort/ 为分片产物，不入库）
reference/            只读参考资料，不入运行时
  homr/                 上游 HOMR 源码与 ONNX 模型（体积大，本地准备）
  homr-web/             参考实现：可运行的浏览器端 demo（Vite）
  samples/              样例输入 reference/samples/input/*.jpg
  artifacts/            基准与验收产物（Python 链、参考浏览器输出、本应用输出）
scripts/              prepare-assets.mjs、check-bundle-size.mjs、各 check-*.mjs
```

`reference/` 之外就是应用本身，根目录只留 `app/ public/ scripts/ reference/` 和配置文件。

## 准备

需要 Node 24 与 pnpm。模型、样例、ORT 运行时都不入库，首次运行前链接一次：

```bash
pnpm install
pnpm assets          # 链接 models/samples/verovio，并生成 public/ort 的 wasm 分片
```

`pnpm dev` / `pnpm build` 会自动先跑这一步。资产来源：

| 运行时路径 | 来源 |
| --- | --- |
| `public/models/*.onnx` | `reference/homr/homr/{segmentation,transformer}/*.onnx` |
| `public/samples` | `reference/samples/input` |
| `public/ort/ort.wasm.mjs`、`ort-wasm-simd-threaded.mjs` | `node_modules/onnxruntime-web/dist`（API 与胶水代码） |
| `public/ort/ort-wasm-simd-threaded.wasm.*` | 同目录的 wasm 按 10 MB 切片，附 `ort-wasm-simd-threaded.wasm.json` 清单 |
| `public/verovio/*.mjs` | `node_modules/verovio/dist`（排版引擎，wasm 内嵌） |

## 开发

```bash
pnpm dev             # http://localhost:3000
pnpm lint
pnpm typecheck
```

多线程 WASM 需要跨源隔离，`nuxt.config.ts` 因此给页面和 Vite 的 `/_nuxt/*`、`public/` 都加了
`Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`。
少了后一组头，Worker 脚本会被浏览器以 `ERR_BLOCKED_BY_RESPONSE` 拦掉，页面只剩“准备中 0/0”。

## 构建产物体积

`ort-wasm-simd-threaded.wasm` 原始大小 14.2 MB。`pnpm assets` 把它切成两片
（10,000,000 + 4,239,897 字节）并写一份 `ort-wasm-simd-threaded.wasm.json`；Worker 在第一次
识别时按清单取回全部分片，拼成 Blob 后交给 ORT。ORT 的 JS 胶水（`ort.wasm.mjs`）也从
`public/ort/` 动态加载，不再进入 Worker bundle，因此 `_nuxt/` 里不会再有 14 MB 的 wasm 副本。

`pnpm build` 末尾会运行 `node scripts/check-bundle-size.mjs`（也可以单独执行 `pnpm check:size`）：
扫描 `.output` 里实际落盘的文件，任何单个文件超过 10,000,000 字节就失败。
`.output/public/models` 与 `public/verovio` 仍是脚本生成的符号链接，不计入产物体积；部署到不跟随
符号链接的平台时，需要另外提供这些文件（模型单个 47–57 MB，若部署平台同样限制单文件大小，
需要另行分片）。

首次识别会多一次 wasm 分片下载与拼接，之后由浏览器缓存；耗时计入现有 `modelLoad` 阶段。

## 验收

### 识别（M4）

```bash
pnpm dev                                   # 另开一个终端
pnpm check:recognition                     # 默认跑样例 1
node scripts/check-recognition.mjs --image path/to.jpg
```

脚本用无头 Edge 通过 CDP 打开 `/import/images`、塞入图片、点“开始识别”，等页面进入“识别完成”，把 MusicXML 和
截图写到 `reference/artifacts/nuxt-browser/<页名>/`，再和基准逐行对比：

- `reference/artifacts/browser/<页名>/` 参考实现的浏览器输出（同一张图）——本移植必须逐字节一致；
- `reference/artifacts/browser-reference/`、`reference/artifacts/python/` 只作参考：Python 链和浏览器链
  在个别记号（例如 `staccatissimo`）上本来就不一致，标题也取自各自的输入文件名。

样例 1 的实测结果（8 线程、Edge 152、`永远同在1.jpg`，开发服务器与生产包一致）：

| 项 | 值 |
| --- | --- |
| 页面 / 谱表 | 1920×2714，4 个谱表 / 2 个系统 |
| 识别 | 127 音符、5 休止符、136 音符头，165 符号全部定位 |
| 耗时 | 约 40 s（其中推理 34 s） |
| MusicXML | 41271 字符，与参考实现的浏览器输出**逐字节一致** |

生产构建同样验收过：`pnpm build` 后 `PORT=3100 node .output/server/index.mjs`，再
`node scripts/check-recognition.mjs --url http://127.0.0.1:3100/import/images`。Nitro 的 `/**`
路由头也会覆盖 `_nuxt/*`、`public/*`，所以生产下 Worker 与多线程 WASM 同样可用。

### 多页导入、书架与乐谱（M5）

```bash
pnpm dev
pnpm check:score
```

脚本在手机视口（390×844）下从 `/import/images` 一次选入两页样例，确认缩略图末尾仍有“添加图片”，
用真实指针事件长按拖动交换两页、再换回来，然后手动开始识别；保存到书架后打开曲谱页，只显示页面图，
按侧车坐标（吸附到符头后的落点）点击页面图核对底部音符卡，并在画布上采样琥珀圈确认圈心落在音符上，
翻到第二页确认换成自己的页面图、选中被清空；随后回书架确认曲谱出现，并在 `/import/musicxml`
导入同一份 MusicXML，确认它能排版、不提供翻页与页面图，且存入 IndexedDB 的文本与文件逐字节一致。
通过时输出 29 项检查与截图，写在 `reference/artifacts/m5/<页名>/`。

### 跟弹练习（M6）

```bash
pnpm dev
pnpm check:tracker       # 合成音高帧，不需要浏览器
pnpm check:practice      # 真实浏览器 + 假麦克风
```

跟踪器不依赖 Web Audio，`scripts/check-tracker.mjs` 用合成帧验证 24 项规则：稳定帧确认、持续音
只算一次、错音不推进、向前窗口跳音、重复音重新起音、八度等价、低清晰度忽略、和弦/休止/装饰音/
延音线整理、手动定位、超时提示和窗口边界。报告在 `reference/artifacts/m6/tracker.run.json`。

`check:practice` 生成一份四音 MusicXML 和同样四个音的 WAV，用 Edge 的
`--use-file-for-fake-audio-capture` 当作麦克风输入；应用走真实的 getUserMedia → AudioContext →
Pitchy → 跟踪器链路。脚本导入乐谱、开始练习，确认面板、当前目标高亮、音高推进到第 3 个音、
结束后面板与高亮消失，再点第三个音符确认能重新定位，共 9 项检查；截图和报告在
`reference/artifacts/m6/`。

当前边界：验收使用 Chromium 假麦克风，尚未用真实钢琴或手机麦克风记录验证；单音检测下和弦只要
弹中任意一个音就推进，双手同时发声无法完整评分；练习只针对当前页，弹完一页要手动点“下一页”。

## 参考实现

`reference/homr-web` 是移植来源，可单独运行（它有自己的 node_modules）：

```bash
cd reference/homr-web
pnpm preview        # 或 npm run dev / npm run test:browser
```

## 还没做的

- 音符人工校正：识别结果只读，导出的是 Worker 写出的原始 MusicXML；
- 评分模式、节拍器与自动翻页：当前只有练习模式和手动“下一页”；
- 真实乐器、噪声环境与手机麦克风下的跟踪调参：验收用的是 Chromium 假麦克风；
- 多页曲谱的旋转、裁切与重新排序后的识别复用，谱集整理、批注与练习记录；
- 模型与 Verovio 的体积：模型（47–57 MB）和 Verovio 仍以符号链接接入，尚未像 wasm 一样分片。
