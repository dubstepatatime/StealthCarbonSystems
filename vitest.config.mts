import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // `server-only` throws outside a React Server environment; tests run in plain Node.
      'server-only': path.resolve(import.meta.dirname, 'tests/stubs/server-only.ts'),
      '@': path.resolve(import.meta.dirname),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    restoreMocks: true,
  },
})
