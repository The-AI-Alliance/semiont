import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.shared.config.js';

// Nothing local. The shared config decides what a coverage run emits; this
// file exists so that decision reaches this package at all.
export default mergeConfig(baseConfig, defineConfig({}));
