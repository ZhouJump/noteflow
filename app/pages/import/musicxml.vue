<script setup lang="ts">
import { describeStorageError, saveMusicXmlScore } from '~/lib/db/scores'
import { readMusicXmlSource, type ParsedMusicXml } from '~/lib/musicxml/document'

/**
 * 导入 MusicXML：选文件、看标题、保存。
 *
 * 手机上不放 XML 文本框或技术统计；解析失败时只说清楚原因。
 */
usePageSeo('导入 MusicXML · NoteFlow', '直接导入 .musicxml 或 .xml 文件，跳过识别，保存后即可演奏与评分。')

const fileInput = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const text = ref('')
const parsed = ref<ParsedMusicXml | null>(null)
const title = ref('')
const composer = ref('')
const error = ref<string | null>(null)
const saving = ref(false)
const saveOpen = ref(false)
const saveError = ref<string | null>(null)

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
    error.value = '文件超过 5 MB，可能不是乐谱文件。'
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
  saveError.value = null
  try {
    const response = await saveMusicXmlScore({
      fileName: fileName.value || 'import.musicxml',
      musicXml: text.value,
      title: title.value,
      composer: composer.value
    })
    await navigateTo(`/scores/${response.scoreId}`)
  } catch (exception) {
    saveError.value = describeStorageError(exception)
  } finally {
    saving.value = false
  }
}

function openSave(): void {
  if (parsed.value === null) return
  saveError.value = null
  saveOpen.value = true
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
          支持 .musicxml 与 .xml 文件。
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
            <p
              v-if="composer"
              class="mt-0.5 truncate text-xs text-muted"
            >
              {{ composer }}
            </p>
          </div>
        </section>

        <UButton
          block
          size="lg"
          icon="i-lucide-library-big"
          label="保存到谱架"
          :loading="saving"
          data-test="import-musicxml"
          @click="openSave"
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

    <UModal
      v-model:open="saveOpen"
      :dismissible="!saving"
    >
      <template #header>
        <h2 class="text-base font-semibold">
          保存到谱架
        </h2>
      </template>
      <template #body>
        <div class="grid gap-4">
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
              placeholder="可选"
              class="w-full"
              data-test="composer-input"
            />
          </UFormField>
          <p
            v-if="saveError"
            class="text-sm text-error"
            data-test="save-error"
          >
            {{ saveError }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            label="取消"
            :disabled="saving"
            data-test="save-cancel"
            @click="saveOpen = false"
          />
          <UButton
            label="保存"
            :loading="saving"
            data-test="import-musicxml-confirm"
            @click="save"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
