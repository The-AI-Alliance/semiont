// The matchers vitest does not have, given to its types: jest-dom's, and
// jest-axe's toHaveNoViolations. vitest.setup.ts gives the same to its
// `expect`.
//
// vitest takes a matcher library's types through `Matchers`: what `expect()`
// answers extends it, and so do the asymmetric matchers. `R` is what a matcher
// answers: nothing, or after `.resolves` and `.rejects` a promise of nothing.
// The type parameters are written as vitest writes them, as a declaration
// that merges with its own must be.
//
// jest-dom's first parameter is what stands in for a string where a matcher
// takes text, which with vitest is whatever `expect.stringContaining` answers.
// vitest does not say what that is.
//
// The `import 'vitest'` gives this file module scope so `declare module 'vitest'`
// merges into the real module rather than shadowing it.
import 'vitest';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<unknown, R> {
    toHaveNoViolations(): R;
  }
}
