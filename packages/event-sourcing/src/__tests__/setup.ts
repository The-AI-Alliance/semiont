/**
 * Test setup for @semiont/event-sourcing.
 *
 * Every SemiontProject a suite constructs derives its state tree from
 * XDG_STATE_HOME, which has no fabricated default: a missing value is an
 * error, so it throws when unset. Point it into temp space here, once for the
 * whole package, so every test resolves a real throwaway state dir and none
 * writes test state into the developer's own ~/.local/state.
 */
import { tmpdir } from 'os';
import { join } from 'path';

process.env.XDG_STATE_HOME = join(tmpdir(), 'semiont-event-sourcing-tests-state');
