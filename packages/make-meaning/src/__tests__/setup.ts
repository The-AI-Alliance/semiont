/**
 * Test setup for @semiont/make-meaning
 *
 * This file runs before all tests in the package.
 */

import { vi } from 'vitest';

// Global test timeout
vi.setConfig({ testTimeout: 10000 });
