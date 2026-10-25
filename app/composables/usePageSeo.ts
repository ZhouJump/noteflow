import type { MaybeRefOrGetter } from 'vue'

/**
 * 页面级 SEO：标题、描述与分享卡片。
 *
 * 站点名、默认分享图和全局描述由 `app.vue` 兜底，这里只补页面自己的部分。
 * 曲谱与谱集来自 IndexedDB，标题描述用 getter 传入，读到数据后 head 会自动更新。
 */
export function usePageSeo(
  title: MaybeRefOrGetter<string>,
  description: MaybeRefOrGetter<string>
): void {
  useSeoMeta({
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    twitterTitle: title,
    twitterDescription: description
  })
}
