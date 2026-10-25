/**
 * 把 IndexedDB 里的 Blob 变成一个可放进 `<img>` 的临时地址。
 *
 * 地址在来源变化或组件卸载时立刻回收，避免谱架里来回翻页时把原图一直留在内存里。
 */
export function useAssetUrl(source: MaybeRefOrGetter<Blob | null | undefined>) {
  const url = shallowRef<string | null>(null)

  function release(): void {
    if (url.value === null) return
    URL.revokeObjectURL(url.value)
    url.value = null
  }

  watch(
    () => toValue(source),
    (blob) => {
      release()
      if (!import.meta.client || blob === null || blob === undefined) return
      url.value = URL.createObjectURL(blob)
    },
    { immediate: true }
  )

  if (getCurrentScope()) onScopeDispose(release)

  return url
}

/**
 * 一次给多页生成临时地址；曲谱页纵向排列时每页一个 `<img>`。
 * 来源数组变化、换曲谱或卸载时统一回收。
 */
export function useAssetUrls(sources: () => (Blob | null | undefined)[]) {
  const urls = shallowRef<(string | null)[]>([])

  function release(): void {
    for (const url of urls.value) {
      if (url !== null) URL.revokeObjectURL(url)
    }
    urls.value = []
  }

  watch(
    () => sources(),
    (blobs) => {
      release()
      if (!import.meta.client) {
        urls.value = blobs.map(() => null)
        return
      }
      urls.value = blobs.map(blob => (
        blob === null || blob === undefined ? null : URL.createObjectURL(blob)
      ))
    },
    { immediate: true }
  )

  if (getCurrentScope()) onScopeDispose(release)

  return urls
}
