<script setup lang="ts">
/**
 * 导入图片：从相册选好页面后，交给 PageStager 统一排序、识别与保存。
 *
 * 页面格子、拖动排序和保存对话框都在 PageStager 里，PDF 导入复用同一套。
 */
usePageSeo('导入图片 · NoteFlow', '选择或拍摄多张乐谱照片，调整顺序后识别成可演奏的曲谱。')

const fileInput = ref<HTMLInputElement | null>(null)
const stager = ref<{ addPages: (files: { file: Blob, name: string }[]) => void } | null>(null)
const pageCount = ref(0)

function pickFiles(): void {
  fileInput.value?.click()
}

function onFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  stager.value?.addPages(files.map(file => ({ file, name: file.name })))
}
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-default">
    <PageHeader
      title="导入图片"
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
      ref="fileInput"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      multiple
      class="hidden"
      @change="onFile"
    >

    <PageStager
      ref="stager"
      add-label="添加图片"
      @add="pickFiles"
      @count="pageCount = $event"
    />
  </div>
</template>
