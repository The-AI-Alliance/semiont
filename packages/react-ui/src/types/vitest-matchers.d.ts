// Augments vitest's matcher interfaces with jest-axe's toHaveNoViolations.
// The `import 'vitest'` gives this file module scope so `declare module 'vitest'`
// merges into the real module rather than shadowing it.
import 'vitest';

declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}
