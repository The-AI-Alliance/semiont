import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.shared.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Points XDG_STATE_HOME at temp space for the whole package: many suites
      // build a SemiontProject, whose state tree REQUIRES it (stateDirFor
      // throws rather than fabricate a default), and none may write test state
      // into the developer's real ~/.local/state.
      setupFiles: ['./src/__tests__/setup.ts'],
    },
  }),
);
