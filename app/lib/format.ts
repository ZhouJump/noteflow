/** 毫秒转 `m:ss`，用于成绩与练习时长。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/** 成绩历史的本地时间：`10月26日 14:05`。 */
export function formatRunTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

/** 偏差显示：正数带 +，漏音用破折号。 */
export function formatDeviation(deviationMs: number | null): string {
  if (deviationMs === null) return '—'
  if (deviationMs === 0) return '0ms'
  return `${deviationMs > 0 ? '+' : ''}${deviationMs}ms`
}
