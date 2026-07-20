import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PRD-034 S4: real-home hash tripwire. Fails the run if any real client
    // config surface changed while the suite ran.
    globalSetup: ['./tests/helpers/global-tripwire.mjs'],
  },
});
