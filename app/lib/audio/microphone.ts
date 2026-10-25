/** 把浏览器抛出麦克风异常翻译成能指导操作的一句话。 */
export function describeMicrophoneError(exception: unknown): string {
  if (!(exception instanceof Error)) return '无法打开麦克风。'
  if (exception.name === 'NotAllowedError' || exception.name === 'SecurityError') {
    return '麦克风权限被拒绝。请在浏览器设置里允许后重试。'
  }
  if (exception.name === 'NotFoundError' || exception.name === 'OverconstrainedError') {
    return '没有找到可用的麦克风。'
  }
  if (exception.name === 'NotReadableError' || exception.name === 'AbortError') {
    return '麦克风被其他应用占用，关闭后重试。'
  }
  return `无法打开麦克风：${exception.message}`
}
