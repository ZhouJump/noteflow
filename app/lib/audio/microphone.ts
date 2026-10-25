/** 把浏览器抛出麦克风异常翻译成能指导操作的一句话。 */
export function describeMicrophoneError(exception: unknown): string {
  if (!(exception instanceof Error)) return '打不开麦克风，请再试一次。'
  if (exception.name === 'NotAllowedError' || exception.name === 'SecurityError') {
    return '没有麦克风权限。请在浏览器里允许使用麦克风，再试一次。'
  }
  if (exception.name === 'NotFoundError' || exception.name === 'OverconstrainedError') {
    return '没有找到麦克风，检查一下设备是否接好。'
  }
  if (exception.name === 'NotReadableError' || exception.name === 'AbortError') {
    return '麦克风被别的应用占用了，关掉之后再试。'
  }
  return '打不开麦克风，请检查设备后重试。'
}
