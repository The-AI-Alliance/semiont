/**
 * Frontend-specific test utilities
 *
 * Provides renderWithProviders that wraps components with the providers a
 * frontend test typically needs.
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import {
  TranslationProvider,
  ToastProvider,
  SemiontProvider,
} from '@semiont/react-ui';
import { SemiontBrowser, InMemorySessionStorage } from '@semiont/sdk';
import {
  defaultMocks,
  TestProvidersOptions,
  createMockTranslationManager,
} from '@semiont/react-ui/test-utils';
import type {
  TranslationManager,
} from '@semiont/react-ui';

export interface FrontendTestOptions extends TestProvidersOptions {
}

/**
 * Render component with all providers
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: FrontendTestOptions & Omit<RenderOptions, 'wrapper'>
): RenderResult {
  const {
    translationManager = defaultMocks.translationManager,
    browser,
    ...renderOptions
  } = options || {};

  const effectiveBrowser = browser ?? new SemiontBrowser({ storage: new InMemorySessionStorage() });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TranslationProvider translationManager={translationManager}>
        <SemiontProvider browser={effectiveBrowser}>
          <ToastProvider>
            {children}
          </ToastProvider>
        </SemiontProvider>
      </TranslationProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

// Re-export everything from react-ui test-utils for convenience
export * from '@testing-library/react';
export { vi } from 'vitest';
export {
  defaultMocks,
  createMockTranslationManager,
};
export type {
  TestProvidersOptions,
  TranslationManager,
};
