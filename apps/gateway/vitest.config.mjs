import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.shared.config.js';

// Nothing local. The shared config decides which files run; this file is the
// declaration point vitest requires.
export default mergeConfig(baseConfig, defineConfig({}));
