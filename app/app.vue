<script setup lang="ts">
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'zh-CN'
  }
})

const title = 'NoteFlow · 乐谱识别与演奏辅助'
const description = '拍摄或导入乐谱，在浏览器本地完成识别，跟踪演奏进度并提供练习与评分。'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  twitterCard: 'summary'
})
</script>

<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>
