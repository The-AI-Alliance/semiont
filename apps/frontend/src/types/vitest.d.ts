/// <reference types="vitest" />
/// <reference types="vitest/globals" />

import type { expect as vitestExpect } from 'vitest'

declare global {
  const vi: typeof import('vitest').vi
  const expect: typeof vitestExpect
}

// This file ensures TypeScript knows about Vitest globals and types
// when type checking test files