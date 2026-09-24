import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.shared.config.js';

// Nothing local. The shared config decides what a coverage run emits and which
// files it runs; this file is the declaration point vitest requires.
export default mergeConfig(baseConfig, defineConfig({}));
