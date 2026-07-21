import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    server: {
      watch: {
        // The pre-commit hook regenerates these modules; watching them made
        // every commit (and every agent turn that runs the hook) full-reload
        // the window mid-stream. The .css stays watched — it hot-applies.
        ignored: ['**/*.generated.ts']
      }
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          viewer: resolve(__dirname, 'src/renderer/viewer.html'),
          desk: resolve(__dirname, 'src/renderer/desk.html'),
        }
      }
    },
    plugins: [tailwindcss(), vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag: string) => tag === 'webview'
        }
      }
    })]
  }
})
