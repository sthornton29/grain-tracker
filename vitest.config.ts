import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Unit tests for the pure business-logic in lib/. These functions are where a
// silent math bug costs real money, so they're tested with hand-verified worked
// examples. The `@` alias mirrors tsconfig so lib files resolve their imports.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
})
