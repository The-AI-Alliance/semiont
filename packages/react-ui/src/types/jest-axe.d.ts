// Ambient types for jest-axe (ships no declarations) plus the vitest matcher
// augmentation. These tests run under vitest, so toHaveNoViolations must extend
// vitest's Assertion — @types/jest-axe only augments jest, which wouldn't apply.
declare module 'jest-axe' {
  export interface AxeResults {
    violations: unknown[];
    passes: unknown[];
    incomplete: unknown[];
    inapplicable: unknown[];
  }

  export function axe(
    html: Element | Document | DocumentFragment | string,
    options?: Record<string, unknown>
  ): Promise<AxeResults>;

  export function configureAxe(options?: Record<string, unknown>): typeof axe;

  export const toHaveNoViolations: {
    toHaveNoViolations(results: AxeResults): { pass: boolean; message(): string };
  };
}

declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}
