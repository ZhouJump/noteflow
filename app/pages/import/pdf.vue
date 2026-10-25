<script setup lang="ts">
import { renderPdfPages } from '~/lib/pdf/render'

/**
 * 导入 PDF：PDF.js 逐页渲染成图片后，交给 PageStager 排序、识别与保存。
 *
 * 只接受 `.pdf`。页数超过上限时只渲染前 30 页，并在页面上说明；
 * 渲染失败（加密、损坏）保留原文件不动，只给一条错误提示。
 */
usePageSeo('导入 PDF · NoteFlow', '选择多页 PDF 乐谱，导入后识别成可演奏的曲谱。')

const pdfInput = ref<HTMLInputElement | null>(null)
const stager = ref<{
  addPages: (
    files: { file: Blob, name: string }[],
    meta?: { title?: string, composer?: string }
  ) => void
} | null>(null)
const pageCount = ref(0)
const rendering = ref(false)
const progress = ref({ done: 0, total: 0 })
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const renderStatus = computed(() => {
  if (!rendering.value) return ''
  if (progress.value.total === 0) return '正在读取 PDF'
  return `正在读取 PDF：第 ${Math.min(progress.value.done + 1, progress.value.total)} / ${progress.value.total} 页`
})

const message = computed(() => error.value ?? notice.value ?? renderStatus.value)

function describePdfError(exception: unknown): string {
  const name = (exception as { name?: string } | null)?.name ?? ''
  // 原始异常留给控制台，界面上只说文件哪里不对。
  console.error('PDF 读取失败', exception)
  if (name === 'PasswordException') return '这个 PDF 设置了密码，暂时打不开'
  if (name === 'InvalidPDFException') return '这个文件打不开，可能不是 PDF'
  return '这个 PDF 读不出来，文件可能已损坏'
}

/** 「曲名 — 作曲家.pdf」拆成两个字段；没有分隔符时整段都是曲名。 */
function parseTitle(name: string): { title: string, composer?: string } {
  const base = name.replace(/\.pdf$/i, '').trim()
  const match = /^(.+?)\s+—\s+(.+)$/.exec(base)
  if (match === null) return { title: base }
  return { title: match[1].trim(), composer: match[2].trim() }
}

function pickPdf(): void {
  if (rendering.value) return
  pdfInput.value?.click()
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file === undefined || rendering.value) return
  rendering.value = true
  error.value = null
  notice.value = null
  progress.value = { done: 0, total: 0 }
  try {
    const result = await renderPdfPages(file, (value) => {
      progress.value = value
    })
    if (result.pages.length === 0) {
      error.value = '这个 PDF 里没有可导入的页面'
      return
    }
    stager.value?.addPages(result.pages, parseTitle(file.name))
    if (result.truncated) notice.value = `PDF 共 ${result.total} 页，本次只导入前 ${result.pages.length} 页`
  } catch (exception) {
    error.value = describePdfError(exception)
  } finally {
    rendering.value = false
  }
}
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-default">
    <PageHeader
      title="导入 PDF"
      back="/import"
      back-label="返回导入"
    >
      <span
        v-if="pageCount > 0"
        class="pr-2 text-xs tabular-nums text-muted"
      >
        {{ pageCount }} 页
      </span>
    </PageHeader>

    <input
      ref="pdfInput"
      type="file"
      accept="application/pdf,.pdf"
      class="hidden"
      data-test="pdf-input"
      @change="onFile"
    >

    <p
      v-if="message"
      class="mx-auto w-full max-w-2xl px-4 pt-3 text-sm"
      :class="error ? 'text-error' : 'text-muted'"
      role="status"
      :data-test="error ? 'pdf-error' : 'pdf-status'"
    >
      {{ message }}
    </p>

    <PageStager
      ref="stager"
      add-label="导入 PDF"
      @add="pickPdf"
      @count="pageCount = $event"
    />
  </div>
</template>
