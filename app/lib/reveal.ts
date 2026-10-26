/**
 * 让跟随目标留在视口里，但不给每个音重新居中。
 *
 * 同一行（同一谱表系统）里音高不同，符头位置能差几十像素；逐个音居中会让
 * 页面上下轻推，看起来像在抖。这里只在目标跑出视口中段时滚一次，并把它放到
 * 正中，换行、换页仍然会跟随。
 *
 * 上下留白同时避开固定顶栏（48px）与底部跟随 / 评分面板（约 64px）。
 */
export function revealInViewport(element: Element): void {
  const rect = element.getBoundingClientRect()
  // 还没排版或已经卸载的元素没有尺寸，别把页面滚到 0。
  if (rect.width === 0 && rect.height === 0) return
  const center = rect.top + rect.height / 2
  const inset = Math.max(72, Math.round(window.innerHeight * 0.1))
  if (center >= inset && center <= window.innerHeight - inset) return
  window.scrollBy({ top: center - window.innerHeight / 2, behavior: 'smooth' })
}
