<script setup lang="ts">
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    // 地址栏与启动画面跟随应用底色；深色档用 stone-950。
    { name: 'theme-color', content: '#f8f5ef', media: '(prefers-color-scheme: light)' },
    { name: 'theme-color', content: '#0c0a09', media: '(prefers-color-scheme: dark)' },
    { name: 'apple-mobile-web-app-title', content: 'NoteFlow' },
    { name: 'format-detection', content: 'telephone=no' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
    { rel: 'icon', type: 'image/png', href: '/icon-192.png' },
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    { rel: 'manifest', href: '/manifest.webmanifest' }
  ],
  script: [{
    // beforeinstallprompt 可能在 Vue 挂载前派发：先在文档头部接住，
    // 由 useInstallPrompt 在启动时取走。
    innerHTML: `window.__noteflowInstallPrompt=null;addEventListener('beforeinstallprompt',event=>{event.preventDefault();window.__noteflowInstallPrompt=event})`
  }],
  htmlAttrs: {
    lang: 'zh-CN'
  }
})

const title = 'NoteFlow · 乐谱识别与演奏辅助'
const description = '拍摄或导入乐谱，在浏览器本地完成识别，跟踪演奏进度并提供练习与评分。'

useSeoMeta({
  title,
  description,
  ogType: 'website',
  ogSiteName: 'NoteFlow',
  ogLocale: 'zh_CN',
  ogTitle: title,
  ogDescription: description,
  ogImage: '/og.png',
  ogImageAlt: 'NoteFlow 应用图标',
  ogImageType: 'image/png',
  ogImageWidth: 1200,
  ogImageHeight: 630,
  twitterCard: 'summary_large_image',
  twitterTitle: title,
  twitterDescription: description,
  twitterImage: '/og.png'
})
</script>

<template>
  <UApp>
    <NuxtPage />
    <InstallPrompt />
  </UApp>
</template>
