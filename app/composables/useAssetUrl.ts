/**
 * 把 IndexedDB 里的 Blob 变成一个可放进 `<img>` 的临时地址。
 *
 * 地址在来源变化或组件卸载时立刻回收，避免书架里来回翻页时把原图一直留在内存里。
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
