/**
 * 安装为应用：每次启动时询问一次，安装完成后不再出现。
 *
 * 浏览器判定可以安装后才派发 `beforeinstallprompt`：Chrome 与 Edge 在页面加载后
 * 几百毫秒就发，不需要 Service Worker；Safari 与 Firefox 不发。所以启动时先等这个
 * 事件再决定话术——事件没到就说「手动添加」，会把本来能装的浏览器误报成不支持，
 * 第一次打开和第二次打开的表现也会不一样。
 *
 * 事件在手动步骤已经弹出后才到，对话框会就地换成安装按钮；如果用户已经关掉了
 * 手动步骤，事件到达时再问一次，因为那次关掉的只是说明，不是安装。
 *
 * 自动化验收在文档加载前写入 `noteflow:install:off`，避免弹窗挡住页面操作；
 * 安装成功后把 `noteflow:installed` 留在本机，之后在普通标签页里打开也不再询问。
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type InstallWindow = Window & { __noteflowInstallPrompt?: BeforeInstallPromptEvent | null }

/** 文档头部的小脚本会先接住事件，这里只负责取用与清理。 */
function earlyPrompt(): BeforeInstallPromptEvent | null {
  return (window as InstallWindow).__noteflowInstallPrompt ?? null
}

function rememberPrompt(event: BeforeInstallPromptEvent | null): void {
  (window as InstallWindow).__noteflowInstallPrompt = event
}

/** 验收脚本在文档加载前写入这个标记，本次启动不弹安装提示。 */
const SKIP_KEY = 'noteflow:install:off'
/** 记住已经安装过，避免从浏览器标签页打开时重复询问。 */
const INSTALLED_KEY = 'noteflow:installed'
/** 没有安装事件时等这么久再退回手动步骤：给浏览器留出判定可安装的时间。 */
const PROMPT_WAIT_MS = 2500
/** 已经有安装事件、或 iOS 等不到事件时，首屏稳定后就弹出。 */
const FIRST_SHOW_MS = 800

const deferred = shallowRef<BeforeInstallPromptEvent | null>(null)
const visible = ref(false)
const installed = ref(true)
const ios = ref(false)
const ready = ref(false)
const busy = ref(false)
let listening = false
/** 这次启动已经弹过对话框。 */
let asked = false
/** 弹出的时候已经有安装按钮；只展示过手动步骤时，晚到的事件还该再问一次。 */
let promptShown = false
let timer: number | null = null

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    // 隐私模式可能禁用本地存储，此时按未安装处理。
    return false
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    // 存不下只影响下次启动的判断，不阻断本次安装。
  }
}

function detectInstalled(): boolean {
  const modes = window.matchMedia(
    '(display-mode: standalone), (display-mode: window-controls-overlay), '
    + '(display-mode: fullscreen), (display-mode: minimal-ui)'
  )
  if (modes.matches) return true
  // iOS 的主屏幕应用只暴露 navigator.standalone。
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function detectIos(): boolean {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true
  // iPadOS 13+ 的桌面模式把 UA 伪装成 Mac，用触点数区分。
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function isSkipped(): boolean {
  return navigator.webdriver === true || readFlag(SKIP_KEY)
}

function show(): void {
  if (visible.value || installed.value) return
  asked = true
  promptShown = promptShown || deferred.value !== null
  visible.value = true
}

function scheduleShow(): void {
  if (asked || installed.value) return
  // 等安装事件再定话术，避免把能安装的浏览器说成需要手动添加。
  const delay = deferred.value !== null || ios.value ? FIRST_SHOW_MS : PROMPT_WAIT_MS
  timer = window.setTimeout(() => {
    timer = null
    show()
  }, delay)
}

function onBeforeInstall(event: Event): void {
  event.preventDefault()
  const prompt = event as BeforeInstallPromptEvent
  deferred.value = prompt
  rememberPrompt(prompt)
  // 事件只在未安装时派发：本地还留着「已安装」说明应用已经被卸载。
  installed.value = false
  writeFlag(INSTALLED_KEY, false)
  if (isSkipped()) return
  if (visible.value) {
    // 对话框开着：canPrompt 变化后会就地换成安装按钮。
    promptShown = true
    return
  }
  // 已经问过并且当时就有安装按钮，说明用户拒绝过安装，不再打扰。
  if (asked && promptShown) return
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  show()
}

function onInstalled(): void {
  writeFlag(INSTALLED_KEY, true)
  installed.value = true
  deferred.value = null
  rememberPrompt(null)
  visible.value = false
}

function setup(): void {
  if (listening) return
  listening = true
  const early = earlyPrompt()
  if (early !== null) {
    deferred.value = early
    // 事件只在未安装时派发：本地还留着「已安装」说明应用已经被卸载。
    writeFlag(INSTALLED_KEY, false)
  }
  ios.value = detectIos()
  const runningInstalled = detectInstalled()
  if (runningInstalled) writeFlag(INSTALLED_KEY, true)
  installed.value = early === null && (runningInstalled || readFlag(INSTALLED_KEY))
  ready.value = true
  window.addEventListener('beforeinstallprompt', onBeforeInstall)
  window.addEventListener('appinstalled', onInstalled)
  if (installed.value || isSkipped()) return
  scheduleShow()
}

function teardown(): void {
  window.removeEventListener('beforeinstallprompt', onBeforeInstall)
  window.removeEventListener('appinstalled', onInstalled)
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  listening = false
}

async function install(): Promise<void> {
  const event = deferred.value
  if (event === null || busy.value) return
  busy.value = true
  try {
    await event.prompt()
    await event.userChoice
  } catch {
    // 浏览器可能拒绝再次弹出安装界面，退回到浏览器菜单。
  } finally {
    busy.value = false
    deferred.value = null
    rememberPrompt(null)
    visible.value = false
  }
}

function close(): void {
  visible.value = false
}

const canPrompt = computed(() => deferred.value !== null)
const steps = computed(() => ios.value
  ? ['点浏览器的分享按钮。', '选「添加到主屏幕」，再点「添加」。']
  : ['点浏览器右上角的菜单。', '选「安装 NoteFlow」或「添加到主屏幕」。'])

export function useInstallPrompt() {
  onMounted(setup)
  onBeforeUnmount(teardown)

  return {
    ready,
    visible,
    canPrompt,
    busy,
    steps,
    install,
    close
  }
}
