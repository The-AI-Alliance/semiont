import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Points XDG_STATE_HOME at temp space for the whole package: many suites
    // build a SemiontProject, whose state tree now REQUIRES it (stateDirFor
    // throws with no fabricated default). Without this they wrote their state
    // into the developer's real ~/.local/state — the pollution the fallback hid.
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
