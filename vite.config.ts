import { defineConfig } from 'vitest/config';
export default defineConfig({
  server: { host: '127.0.0.1', port: 4318, strictPort: true },
  test: { include: ['tests/**/*.test.ts'], exclude: ['tests/browser/**'], maxWorkers: 2 },
});
