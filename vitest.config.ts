import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,vue}'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        // Entrypoints only, listed explicitly — wildcard main.ts/index.ts
        // globs silently hid src/main/index.ts (the whole Electron main
        // process) from the denominator. It must stay counted.
        'src/daemon/main.ts', // daemon process entry
        'src/daemon/index.ts', // pure re-exports
        'src/preload/index.ts', // contextBridge glue, untestable under happy-dom
        'src/renderer/main.ts',
        'src/renderer/web/main.ts',
        'src/renderer/settings-main.ts',
        'src/renderer/viewer-main.ts',
      ],
      reporter: ['text', 'json-summary'],
      // Ratcheted just below current coverage so new code can't regress the
      // suite. Raise these as coverage climbs; don't lower them. (Any dip vs
      // pre-2026-07 numbers is a denominator correction: the wildcard
      // main.ts/index.ts excludes had hidden src/main/index.ts — the whole
      // Electron main process — from the totals. No coverage was lost.)
      thresholds: {
        lines: 42,
        branches: 35,
        functions: 38,
        statements: 40,
      },
    },
  },
})
