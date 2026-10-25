// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  routeRules: {
    '/': { prerender: true },
    // onnxruntime-web 的多线程 WASM 需要跨源隔离；SharedArrayBuffer 仅在该条件下可用。
    '/**': {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin'
      }
    }
  },

  compatibilityDate: '2026-06-30',

  // 开发时 `/_nuxt/*` 与 `public/` 由 Vite 直接返回，不经过上面的路由规则。
  // 缺了这些头，COEP 页面里的 Worker 脚本会以 ERR_BLOCKED_BY_RESPONSE 被拦下。
  vite: {
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin'
      }
    }
  },

  typescript: {
    tsConfig: {
      compilerOptions: {
        // 迁入的 HOMR 像素/数组代码按索引访问，与上游 TS 配置一致；
        // 保留 strict，但不额外要求每个下标访问都判空。
        noUncheckedIndexedAccess: false
      }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
