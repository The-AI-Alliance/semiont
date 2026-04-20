/**
 * Public surface for the session module. Everything a consumer needs to
 * interact with the per-KB session and the app-level browser goes
 * through here — except the test-only `__resetForTests`, which lives in
 * `./testing` and is gated behind a separate subpath.
 */

export { SemiontSession, type SemiontSessionConfig, type UserInfo } from './semiont-session';
export { SemiontBrowser } from './semiont-browser';
export { SemiontError, type SemiontErrorCode } from './errors';
export { getBrowser } from './registry';
export { SemiontProvider, useSemiont, type SemiontProviderProps } from './SemiontProvider';
