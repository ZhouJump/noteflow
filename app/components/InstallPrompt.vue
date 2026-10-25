<script setup lang="ts">
/**
 * 安装提示：应用启动后询问一次是否安装为应用。
 *
 * 已安装、验收脚本写入跳过标记或正在独立窗口中运行时，composable 会直接
 * 压掉提示；支持 beforeinstallprompt 的浏览器给出「安装」按钮，其余浏览器
 * 展示手动添加步骤。
 */
const { ready, visible, canPrompt, busy, steps, install, close } = useInstallPrompt()

function onOpenChange(open: boolean): void {
  if (!open) close()
}
</script>

<template>
  <UModal
    v-if="ready"
    :open="visible"
    @update:open="onOpenChange"
  >
    <template #header>
      <h2 class="text-base font-semibold">
        安装 NoteFlow
      </h2>
    </template>
    <template #body>
      <div
        class="grid gap-3"
        data-test="install-prompt"
      >
        <p class="text-sm text-muted">
          {{ canPrompt
            ? '装好后从桌面或主屏幕直接打开，界面清爽，也不用每次输入网址。'
            : '这个浏览器需要手动添加，按下面的步骤操作就行。' }}
        </p>
        <ol
          v-if="!canPrompt"
          class="grid gap-1 text-sm"
          data-test="install-steps"
        >
          <li
            v-for="(step, index) in steps"
            :key="step"
            class="flex gap-2"
          >
            <span class="shrink-0 text-muted tabular-nums">{{ index + 1 }}.</span>
            <span>{{ step }}</span>
          </li>
        </ol>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          v-if="canPrompt"
          color="neutral"
          variant="ghost"
          label="以后再说"
          data-test="install-dismiss"
          @click="close"
        />
        <UButton
          v-if="canPrompt"
          icon="i-lucide-download"
          label="安装 NoteFlow"
          :loading="busy"
          data-test="install-accept"
          @click="install"
        />
        <UButton
          v-else
          label="知道了"
          data-test="install-dismiss"
          @click="close"
        />
      </div>
    </template>
  </UModal>
</template>
