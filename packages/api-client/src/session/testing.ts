/**
 * Test-only exports for the session module. Tests import `__resetForTests`
 * to clear the `SemiontBrowser` singleton between runs. Production code
 * must not import this file.
 */

export { __resetForTests } from './registry';
