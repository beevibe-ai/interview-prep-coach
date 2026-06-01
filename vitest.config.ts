import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    // Default: node. The component test opts into jsdom via a file docblock.
    environment: 'node',
  },
  resolve: {
    alias: { '@': root },
  },
});
