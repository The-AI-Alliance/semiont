/**
 * Test setup for @semiont/make-meaning
 *
 * This file runs before all tests in the package.
 */

import { vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';

// Global test timeout
vi.setConfig({ testTimeout: 10000 });

// Every SemiontState/SemiontProject a test constructs derives its state tree
// from XDG_STATE_HOME, which has no default: absence fails loudly, so it
// throws when unset rather than fabricating `~/.local/state`. Point it into
// temp space here, once for the whole package, so a test that builds a
// project resolves a real throwaway state dir. (createTestProject overrides
// and restores this per-test.)
process.env.XDG_STATE_HOME = join(tmpdir(), 'semiont-make-meaning-tests-state');
