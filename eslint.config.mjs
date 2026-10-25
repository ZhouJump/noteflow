// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import betterTailwindcss from 'eslint-plugin-better-tailwindcss'
import { getDefaultAttributes } from 'eslint-plugin-better-tailwindcss/api/defaults'

export default withNuxt(
  {
    // reference/ 是移植参考与上游源码，不参与应用的代码风格约束。
    ignores: ['reference/**', 'public/**']
  },
  betterTailwindcss.configs['correctness-error'],
  {
    // app/lib 是识别引擎：其中的字符串是 MusicXML 取值与几何常量，不是 Tailwind 类名。
    files: ['app/lib/**'],
    rules: {
      'better-tailwindcss/no-unknown-classes': 'off'
    }
  },
  {
    settings: {
      'better-tailwindcss': {
        entryPoint: 'app/assets/css/main.css',
        attributes: [
          ...getDefaultAttributes(),
          ['^v-bind:ui$', [{ match: 'objectValues' }]]
        ]
      }
    }
  }
)
