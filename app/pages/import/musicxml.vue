<script setup lang="ts">
import { describeStorageError, saveMusicXmlScore } from '~/lib/db/scores'
import { readMusicXmlSource, type ParsedMusicXml } from '~/lib/musicxml/document'

/**
 * 导入 MusicXML：选文件、看标题、保存。
 *
 * 手机上不放 XML 文本框或技术统计；解析失败时只说清楚原因。
 */
useSeoMeta({ title: '导入 MusicXML · NoteFlow' })

const fileInput = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const text = ref('')
const parsed = ref<ParsedMusicXml | null>(null)
const title = ref('')
const composer = ref('')
const error = ref<string | null>(null)
const saving = ref(false)

function pickFile(): void {
  fileInput.value?.click()
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file === undefined) return
  error.value = null
  if (file.size > 5 * 1024 * 1024) {
    error.value = '文件超过 5 MB，请确认选择的是 MusicXML。'
    return
  }
  fileName.value = file.name
  text.value = await file.text()
  try {
    const value = readMusicXmlSource(text.value)
    parsed.value = value
    title.value = value.title
    composer.value = value.composer
  } catch (exception) {
    parsed.value = null
    error.value = (exception as Error).message
  }
}

async function save(): Promise<void> {
  if (parsed.value === null) return
  saving.value = true
  error.value = null
  try {
    const response = await saveMusicXmlScore({
      fileName: fileName.value || 'import.musicxml',
      musicXml: text.value,
      title: title.value,
      composer: composer.value
    })
    await navigateTo(`/scores/${response.scoreId}`)
  } catch (exception) {
    error.value = describeStorageError(exception)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="min-h-dvh bg-default pb-10">
    <PageHeader
      title="导入 MusicXML"
      back="/import"
      back-label="返回导入"
    />

    <div class="mx-auto grid max-w-2xl gap-4 px-4 pt-4">
      <input
        ref="fileInput"
        type="file"
        accept=".musicxml,.xml,application/vnd.recordare.musicxml+xml,application/xml,text/xml"
        class="hidden"
        @change="onFile"
      >

      <button
        v-if="parsed === null"
        type="button"
        class="grid aspect-4/3 place-items-center gap-2 border border-dashed border-default bg-elevated/30 px-6 text-center"
        @click="pickFile"
      >
        <UIcon
          name="i-lucide-file-music"
          class="size-10 text-muted"
        />
        <span class="text-sm font-medium">
          {{ fileName ? '重新选择文件' : '选择 MusicXML 文件' }}
        </span>
        <span class="max-w-xs text-xs text-muted">
          支持 .musicxml 与 .xml，保存后可以导出原文。
        </span>
      </button>

      <template v-else>
        <section
          class="grid gap-3 border border-default p-4"
          data-test="musicxml-preview"
        >
          <div>
            <p class="truncate text-base font-medium">
              {{ parsed.title || fileName }}
            </p>
            <p class="mt-0.5 text-xs text-muted">
              {{ parsed.measureCount }} 小节 · {{ parsed.notes.length }} 个音符
            </p>
          </div>
          <UFormField label="标题">
            <UInput
              v-model="title"
              class="w-full"
              data-test="title-input"
            />
          </UFormField>
          <UFormField label="作曲 / 编曲">
            <UInput
              v-model="composer"
              class="w-full"
              data-test="composer-input"
            />
          </UFormField>
        </section>

        <UButton
          block
          size="lg"
          icon="i-lucide-library-big"
          label="保存到书架"
          :loading="saving"
          data-test="import-musicxml"
          @click="save"
        />
        <UButton
          block
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          label="换一个文件"
          @click="pickFile"
        />
      </template>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="无法导入这份 MusicXML"
        :description="error"
        data-test="musicxml-error"
      />
    </div>
  </div>
</template>
