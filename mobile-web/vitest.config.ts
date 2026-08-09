import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname),
  resolve: { alias: { '@mobile': path.resolve(__dirname, 'src') } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
