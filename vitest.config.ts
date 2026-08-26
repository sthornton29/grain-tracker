import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Unit tests for the pure business-logic in lib/. These functions are where a
// silent math bug costs real money, so they're tested with hand-verified worked
// examples. The `@` alias mirrors tsconfig so lib files resolve their imports.
export default defineConfig({
  // Transforms the component tests' JSX (tsconfig has jsx: "preserve" for
  // Next.js, which vite would otherwise pass through untransformed).
  plugins: [react()],
  test: {
    environment: 'node',
    // Component tests (components/**) opt into jsdom per-file via the
    // `@vitest-environment jsdom` pragma.
    include: ['lib/**/*.test.ts', 'components/**/*.test.tsx'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
})
