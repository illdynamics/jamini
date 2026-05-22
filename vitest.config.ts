import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bridge/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});
