/**
 * Test-only exports. Not part of the public runtime API — tests import
 * from this subpath (`@semiont/react-ui/session/testing`) to reset
 * module-scoped state between tests. Production code importing this
 * subpath is a bug.
 */

export { __resetForTests } from './registry';
