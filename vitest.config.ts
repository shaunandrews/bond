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
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/**/main.ts', 'src/**/index.ts'],
      reporter: ['text', 'json-summary'],
      // Ratcheted just below current coverage so new code can't regress the
      // suite. Raise these as coverage climbs; don't lower them.
      thresholds: {
        lines: 29,
        branches: 19,
        functions: 27,
        statements: 29,
      },
    },
  },
})
