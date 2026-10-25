/**
 * 安装为应用：每次启动时询问一次，安装完成后不再出现。
 *
 * 浏览器允许自动安装时才会派发 `beforeinstallprompt`（Chrome 通常还要求用户
 * 点击过页面并累计浏览 30 秒）；事件到达前先展示手动安装步骤，事件到达后
 * 对话框会自动换成可以直接调用浏览器安装流程的按钮。iOS 没有这个事件，
 * 始终显示「添加到主屏幕」的步骤。
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

const deferred = shallowRef<BeforeInstallPromptEvent | null>(null)
const visible = ref(false)
const installed = ref(true)
const ios = ref(false)
const ready = ref(false)
const busy = ref(false)
let listening = false
let asked = false
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
  visible.value = true
}

function scheduleShow(): void {
  if (asked || installed.value) return
  // 等首屏渲染完成再问，避免对话框和页面同时出现。
  timer = window.setTimeout(() => {
    timer = null
    show()
  }, 800)
}

function onBeforeInstall(event: Event): void {
  event.preventDefault()
  const prompt = event as BeforeInstallPromptEvent
  deferred.value = prompt
  rememberPrompt(prompt)
  // 事件只在未安装时派发：本地还留着「已安装」说明应用已经被卸载。
  installed.value = false
  writeFlag(INSTALLED_KEY, false)
  if (asked) return
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  if (!isSkipped()) show()
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
  ? ['点浏览器的分享按钮。', '选择「添加到主屏幕」，再点「添加」。']
  : ['点地址栏右侧的安装图标，或打开浏览器菜单。', '选择「安装 NoteFlow」或「添加到主屏幕」。'])

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
