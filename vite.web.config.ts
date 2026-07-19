import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// The browser bundle the daemon serves on the LAN (remote access). Separate
// from electron.vite.config.ts: same renderer source, no Electron target.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer/web'),
  plugins: [tailwindcss(), vue()],
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
  },
})
