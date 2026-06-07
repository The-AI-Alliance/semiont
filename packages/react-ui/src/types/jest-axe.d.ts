// Ambient types for jest-axe (the package ships no declarations). This file is
// intentionally a script (no top-level import/export) so `declare module` acts
// as an ambient module declaration that provides types for the untyped package.
// The vitest matcher augmentation lives in vitest-matchers.d.ts (a module file),
// since augmenting an existing module requires module scope.
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
