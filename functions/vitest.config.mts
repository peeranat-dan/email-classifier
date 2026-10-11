import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Every test starts with fresh mocks, so no test depends on another one's setup
    mockReset: true,
    unstubEnvs: true,
  },
});
