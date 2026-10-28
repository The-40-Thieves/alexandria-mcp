import codspeedPlugin from '@codspeed/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Benchmarks only: the unit tests run on node:test (`npm test`), not vitest.
export default defineConfig({
  plugins: [codspeedPlugin()],
  test: {
    include: ['bench/**/*.bench.ts'],
    env: {
      ALEXANDRIA_STATE_DB: ':memory:',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    },
  },
});
