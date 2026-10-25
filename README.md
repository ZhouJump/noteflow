# NoteFlow

乐谱识别与演奏跟踪应用（Nuxt 4 + Nuxt UI 4）。当前进度是 **M8：纵向曲谱、节拍器、批注与评分**，
界面以手机为主 —— 图片与多页 PDF 按页导入，缩略图网格里可以继续添加、长按拖动排序，确认后整批识别；
识别结果存到浏览器本机（IndexedDB），谱架只显示封面与标题。曲谱页把一份曲谱的所有页面从上往下
排开，不再有翻页按钮、页码或翻页标记：练习覆盖整份曲谱，目标跨页时文档自动滚到当前音符，
用户也可以随时手动滚动。乐谱两侧各有一条固定控件栏：左侧是节拍器、BPM、拍点与声部筛选（只在双手谱出现）；
右侧是当前模式的播放/暂停、停止/重来，以及画笔、橡皮、撤销和清空。跟随与评分用顶栏正中的
紧凑 tab 切换，右侧按钮始终只操作当前模式。

图片页面直接显示识别后的页面图，点音符看底部音符卡；定位圈会吸到音符头上，不跟着模型给出的
注意力点漂。打开麦克风后进入跟随练习：Pitchy 检测音高，演奏对目标音就往前推进，演奏错或没听清时
停在原地，点任意音符可以从那里继续。双手谱按手计数，两只手都在时间窗内各演奏一个音才推进。
追丢时不会盲目向前搜索：记住最近 8 个按键，如果其中命中当前音不足 3 个，而这 8 个音又完整
命中乐谱别处连续 8 个音，就把箭头跳到那 8 个音之后并滚动过去。暂停会停住游标和节拍器，
继续时重新布防跟踪器，不会把暂停前的半只手状态带进来。
直接导入的 MusicXML 没有页面图，用 Verovio 排版，跟随时同样显示箭头并滚到屏幕中间。

评分模式与跟随共用麦克风链路，但按 BPM 排好一条时间线：在顶部切到“评分”并点开始后先等
当前音，首音一落就以它为原点计时，之后每个音按应演奏时间判定，超过容错窗口直接记漏音，
不因错音停住。评分也可以暂停；继续后回到等待状态，等下一个未判音落下再以它为新原点，
暂停前已判的音保留，暂停时长不计入成绩。每个音
给出完美 / 良好 / 偏早 / 偏晚 / 八度 / 错音 / 漏音和毫秒偏差，音高占 0.6、时间占 0.4；演奏完
弹出成绩与逐音列表，并把这次演奏（BPM、拍号、声部、逐音结果）写进本机评分记录。曲谱页
菜单里可以查看历史成绩，删除曲谱时一并删除。

每首曲谱的 BPM、拍号与默认声部单独保存；BPM 与节奏型都通过对话框选择（4/4、3/4、2/4）；
双手谱的左右手各有一个手形图标，激活时与谱面上的箭头同色，左手图标镜像显示；单谱表不显示声部筛选。批注是黑色
细笔画，两端收锋；橡皮按住拖动时沿路径连续擦除，按真实半径裁掉经过的部分，而不是整条删除。所有确认、重命名与首次保存
信息都使用 Nuxt UI 对话框。识别统计、坐标、模型版本和 MusicXML 都不上界面。识别结果只读，
不提供音符人工校正。

开发里程碑与约束见 [`.doc/开发指引.md`](.doc/开发指引.md)。

## 目录

```
app/                  应用源码（Nuxt srcDir）
  pages/index.vue       谱架：谱集与独立曲谱，长按拖拽整理
  pages/collections/[id].vue 谱集页：曲谱列表、封面、重命名、移出与删除谱集
  pages/import/         导入入口、图片与 PDF 识别、MusicXML 导入
  pages/scores/[id].vue 曲谱页：纵向多页、自动滚动、侧栏、跟随、节拍器、批注
  components/           PageHeader、Verovio 乐谱、页面图、音符卡、跟随/评分面板、成绩对话框、侧栏、批注层
  composables/          Worker 生命周期、Blob 临时地址、麦克风跟随与评分、Web Audio 节拍器
  lib/audio/            音高换算、练习跟踪与评分时间线（不碰 DOM，可在 Node 里回归）
  workers/              pipeline.worker.ts，整条 HOMR 链
  lib/homr/             HOMR 的 TS 移植（模型、掩码、谱表、词表、MusicXML）
  lib/musicxml/         安全解析、音符模型、渲染副本
  lib/db/               IndexedDB 实体与仓储（曲谱、谱集、设置、批注、评分记录）
  lib/presets/          自带曲集的预识别数据与首次安装
  lib/verovio.ts        Verovio 懒加载与串行渲染
  lib/vision/           图像前置：缩放、灰度、CLAHE
public/               运行时静态资源（models/ ort/ 为 ≤10 MB 分片，samples/ verovio/ pdf/ 为复制，均由脚本生成、不入库；
                      presets/ 是预识别的自带曲集，直接入库；图标、manifest.webmanifest 与 og.png 也直接入库）
reference/            只读参考资料，不入运行时
  homr/                 上游 HOMR 源码与 ONNX 模型（体积大，本地准备）
  homr-web/             参考实现：可运行的浏览器端 demo（Vite）
  samples/              样例输入 reference/samples/input/*.jpg（含一份两页 PDF）
  artifacts/            基准与验收产物（Python 链、参考浏览器输出、本应用输出）
scripts/              prepare-assets.mjs、check-bundle-size.mjs、各 check-*.mjs
```

`reference/` 之外就是应用本身，根目录只留 `app/ public/ scripts/ reference/` 和配置文件。

## 准备

需要 Node 24 与 pnpm。模型、样例、ORT 运行时都不入库，首次运行前生成一次：

```bash
pnpm install
pnpm assets          # 准备模型分片、样例与 Verovio，并生成 public/ort 的 wasm 分片
```

`pnpm dev` / `pnpm build` 会自动先跑这一步。资产来源：

| 运行时路径 | 来源 |
| --- | --- |
| `public/models/*.onnx.part-*`、`*.onnx.json` | `reference/homr/homr/{segmentation,transformer}/*.onnx`，按 10 MB 切片 |
| `public/samples` | `reference/samples/input`（逐个文件同步，目录里其他素材原样保留） |
| `public/ort/ort.wasm.js`、`ort-wasm-simd-threaded.js` | `node_modules/onnxruntime-web/dist`（API 与胶水代码） |
| `public/ort/ort-wasm-simd-threaded.wasm.*` | 同目录的 wasm 按 10 MB 切片，附 `ort-wasm-simd-threaded.wasm.json` 清单 |
| `public/verovio/*.js` | `node_modules/verovio/dist`（排版引擎，wasm 内嵌，复制） |
| `public/pdf/pdf.min.js`、`pdf.worker.min.js` | `node_modules/pdfjs-dist/build`（PDF 解析与渲染，`.mjs` 落成 `.js`） |
| `public/pdf/{cmaps,standard_fonts,wasm}` | `node_modules/pdfjs-dist`（中文 CMap、标准字体与图像解码器，渲染时按需取） |

`public/presets/violin` 是预识别的「小提琴经典曲集」（4 首、19 页），随仓库入库。
应用首次打开谱架时把它写进 IndexedDB，删除后不会再出现，清除站点数据后重新安装。
重建时先启动 `pnpm dev`，把四份「曲名 — 作曲家.pdf」与封面 `cover.webp` 放进
`public/samples/violin`，再执行 `node scripts/build-preset.mjs`：脚本走真实的
PDF 导入与 HOMR 识别链路，逐页导出图片、MusicXML 与定位侧车，约 15–20 分钟。
`pnpm assets` 只同步 `reference/samples/input` 里的文件，不会清掉这个目录。

构建环境（例如 EdgeOne）里没有 `reference/homr` 时，`prepare-assets` 会从
`https://github.com/liebharc/homr/releases/download/onnx_checkpoints/` 下载 fp32 模型
（约 152 MB），解压后缓存在 `.cache/noteflow-models/` 再切片。下载慢或不可达时用
`HOMR_MODEL_BASE` 指向镜像；拿不到模型会让构建直接失败，而不是产出没有模型的包。

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

构建产物里不允许出现超过 10 MB 的单个文件，大资产全部按需切片：

- `ort-wasm-simd-threaded.wasm` 原始 14.2 MB，切成两片（10,000,000 + 4,239,897 字节）并写
  `ort-wasm-simd-threaded.wasm.json`；Worker 第一次识别时按清单取回并拼成 Blob。ORT 的 JS
  （`ort.wasm.js`）也从 `public/ort/` 动态加载，不进入 Worker bundle，`_nuxt/` 里不再有
  14 MB 的 wasm 副本。
- ORT、Verovio 与 PDF.js 的模块脚本一律落成 `.js`：EdgeOne 这类静态托管没给 `.mjs` 配 MIME，
  会以 `application/octet-stream` 返回，浏览器按模块脚本加载时直接拒绝。
- 三个 ONNX 模型（57.3 / 52.9 / 47.3 MB）各切成 5–6 片，附 `<name>.onnx.json`；
  `pipeline.worker.ts` 顺序取回分片、写进一块连续内存后再建 session，避免手机端同时持有整份模型的多份拷贝。
- Verovio（7.3 MB）与样例图直接复制，不再用符号链接——部署只会带走 `.output` / `.edgeone`，
  链接指向的仓库外路径不会跟着走。

`pnpm build` 末尾运行 `node scripts/check-bundle-size.mjs`（也可以单独执行 `pnpm check:size`），
同时扫描 `.output` 与 EdgeOne 生成的 `.edgeone`：任何文件超过 10,000,000 字节就失败。

首次识别要下载约 166 MB 的模型与 wasm 分片，之后由浏览器缓存；耗时计入现有 `modelLoad` 阶段。

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

### 多页导入、谱架与乐谱（M5 / M7）

```bash
pnpm dev
pnpm check:score
```

脚本在手机视口（390×844）下从 `/import/images` 一次选入两页样例，确认识别缩略图末尾仍有“添加图片”，
用真实指针事件长按拖动交换两页、再换回来，然后手动开始识别；保存到谱架后打开曲谱页，确认两页
从上往下排开、没有翻页按钮与页码，并按侧车坐标（吸附到符头后的落点）点击页面图核对底部音符卡，
在画布上采样琥珀圈确认圈心落在音符上；第二页有自己的页面图，音符编号沿用全局序号并标出所在页。
随后验证两侧控件分居乐谱左右、BPM 数字与文案共用一个触发按钮、节拍器默认 80 BPM、
BPM 对话框输入 96、节奏型对话框切到 3/4 再切回 4/4（拍点数随之变化且保持单行）、
刷新后 BPM 与节奏型都按曲谱持久化；画笔使用黑色细笔画，按住橡皮拖过笔画确认能连续
擦除路径上的部分，批注写入 IndexedDB、刷新后恢复、继续添加、撤销和清空都会同步删除本地记录。
最后用静音假麦克风开始跟随，点第二页的音符让目标跨页，确认文档自动向下滚动（同时把视口
缩到 390×480 留出滚动空间）。
回谱架确认曲谱出现后，两页曲谱会把第二页斜垫在封面下面；长按拖动时跟随指针的 ghost 用的就是第一页缩略图。
在 `/import/musicxml` 导入同一份 MusicXML，确认它能排版、不显示纵向页容器
与页面图，且存入 IndexedDB 的文本与文件逐字节一致。最后长按把两首独立曲谱拖到一起组成谱集，
确认谱集卡封面里显示名称、右下角显示曲谱数量；在谱集页的编辑对话框里选一张图片设置封面，保存后
回到谱架确认封面替掉默认叠纸、名称移到卡片下方且封面内不再重复标题；同一个对话框里改名后，把其中一首拖到底部移出区后
回到谱架，再把独立曲谱拖到谱集卡上重新加入，最后删除谱集确认两首曲谱都恢复为独立曲谱。
最后从 `/import/pdf` 导入一份两页 PDF，确认逐页渲染成带页码的缩略图、识别完成后保存成另一份两页曲谱。
最后移除干净库的跳过标记并重新打开谱架，确认首次自动安装「小提琴经典曲集」：封面、4 首曲谱，
且每首的曲名与作曲家分开保存（例如「G 大调小步舞曲 · 佩措尔德」）。
通过时输出 80 项检查与截图，写在 `reference/artifacts/m5/<页名>/`。

### 跟随练习（M6）

```bash
pnpm dev
pnpm check:tracker       # 合成音高帧，不需要浏览器
pnpm check:practice      # 真实浏览器 + 假麦克风
```

跟踪器不依赖 Web Audio，`scripts/check-tracker.mjs` 用合成帧验证 32 项规则：稳定帧确认、持续音
只算一次、错音不推进、后面的音不会跳过当前目标、重复音重新起音、八度等价、低清晰度忽略、
同一拍点按手分组、只演奏一只手不推进、两只手补齐才推进、时间窗边界、和弦/休止/装饰音/延音线整理、
手动定位、连续 8 键匹配别处后的追寻跳转和超时提示。报告在 `reference/artifacts/m6/tracker.run.json`。

`check:practice` 生成一份双谱表八音 MusicXML（右手 C5–F5、左手 C4–F4）和对应的 WAV，用 Edge 的
`--use-file-for-fake-audio-capture` 当作麦克风输入；应用走真实的 getUserMedia → AudioContext →
Pitchy → 跟踪器链路。WAV 开头先反复只演奏右手 C5，脚本确认状态保持“正在聆听”、游标停在“第 1 / 4 音”；
随后双手交替，确认每个目标出现两个不同颜色的箭头、左右手图标用各自主题色且左手镜像、音高推进
到第 3 个音、暂停后保持不动、恢复后继续监听、结束后面板与箭头消失，再点第三个音符确认能重新
定位；最后导入一份单谱表曲谱，确认不显示声部筛选，共 17 项检查；截图和报告在 `reference/artifacts/m6/`。

### 评分模式（M7-评分）

```bash
pnpm dev
pnpm check:scoring           # 纯逻辑 21 项 + 浏览器 13 项
node scripts/check-scoring.mjs --pure
```

`ScoreTracker` 不依赖 Web Audio 和 DOM，前半段用合成音高帧验证 21 项规则：首音锚定、准点完美、
偏早/偏晚、错音、八度 0.8 音高分、漏音窗口、暂停后重新锚定、等待首音时取消、主动结束补齐漏音。
后半段生成八音单声部 MusicXML 和 60 BPM WAV，让 Edge 把 WAV 当作麦克风，走完整的
`getUserMedia → Pitchy → 评分时间线 → 成绩对话框 → IndexedDB` 链路：先确认状态条停在“等待首音”，
演奏完后成绩对话框列出 8 个逐音结果，评分记录写入 `runs` store，曲谱菜单里的“评分记录”能打开
本次成绩详情；再单独开始一轮确认暂停后继续会回到等待当前音。报告和截图在 `reference/artifacts/m7/`。

当前边界：验收使用 Chromium 假麦克风，尚未用真实乐器或手机麦克风记录验证；Pitchy 是单音检测，
同一只手的和弦演奏任意一个音就算这只手到齐，双手同时发声无法完整评分；两只手必须在上一次命中
后 1.5 秒内各演奏一次，超过时间窗只保留后演奏的那只手。

### PWA 安装

浏览器打开应用后，每次启动都会询问一次是否安装；在独立窗口
（standalone / window-controls-overlay）里运行或安装成功后不再询问，
「以后再说」只对本次启动有效。

- Manifest 的应用名是 `NoteFlow`，网页标题仍保留「NoteFlow · 乐谱识别与演奏辅助」；
- 浏览器允许自动安装时，`beforeinstallprompt` 提供一键安装按钮；
  还没拿到安装事件时（例如首次访问）会改为显示浏览器菜单步骤；
- iOS 显示分享菜单 →「添加到主屏幕」；
- 安装后的桌面窗口使用 Window Controls Overlay：顶栏同时是拖动区，并按
  `env(titlebar-area-*)` 避让最小化 / 最大化 / 关闭按钮，按钮、链接和输入框不参与拖动；
- 验收脚本在文档加载前写入 `noteflow:install:off`，避免安装对话框挡住自动操作。

## 参考实现

`reference/homr-web` 是移植来源，可单独运行（它有自己的 node_modules）：

```bash
cd reference/homr-web
pnpm preview        # 或 npm run dev / npm run test:browser
```

## 数据与设置

IndexedDB 当前是 v4，业务数据分布在 `scores`、`collections`、`pages`、`assets`、`recognitions`、
`settings`、`annotations`、`runs` 八个 store：

- `collections`：谱集名称、封面资源与谱架排序；封面由用户拍摄或从图片选择，缩到 640 宽的 JPEG
  后存进 `assets`，不设封面时用默认叠纸封面。`scores.collectionId` 指向所属谱集，
  `scores.collectionOrder` 保存谱集内顺序。删除谱集只清空这两个字段，曲谱仍在本机。

- `settings`：每首曲谱一条，保存 BPM、拍号（`beats` / `beatType`）与默认声部；打开曲谱时若没有记录，
  按 MusicXML 的拍号生成默认值（BPM 80、双手）。切换曲谱不会互相覆盖。
- `annotations`：每页一条，`pageKey` 是页面 ID 或结构化乐谱的 `structured`；笔迹存归一化 0–1 坐标与
  屏幕像素线宽，换设备或旋转屏幕后按页宽重算。清空时直接删记录，不留下空壳。
- `runs`：每次评分一条，按曲谱 ID 建索引；记录 BPM、拍号、声部、总分、四项统计、时长与逐音结果
  （音名、手、判定、偏差、实际听到的音）。历史列表按结束时间倒序，删除曲谱时一并删除。

旧版本的曲谱、页面、资源和识别结果会自动升级到 v4，不受影响。

## 还没做的

- 音符人工校正：识别结果只读，导出的是 Worker 写出的原始 MusicXML；
- 评分时间线目前按 BPM 等分拍点，不处理渐慢 / 渐快、装饰音和跨小节的自由速度；双手同时发声仍
  受 Pitchy 单音检测限制；
- 批注重做：目前只有撤销与清空，历史栈不跨刷新保存；
- 真实乐器、噪声环境与手机麦克风下的跟踪调参：验收用的是 Chromium 假麦克风；
- 多页曲谱的旋转、裁切与重新排序后的识别复用；
- PWA 离线：manifest、WCO 自定义标题栏、启动安装提示、图标与各页 SEO 已就位，
  Service Worker 与离线缓存还没做；
- 模型首次加载：还没有下载进度与持久化缓存，弱网下第一次识别要等约 152 MB 分片。
