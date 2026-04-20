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
  ApiClientProvider,
  OpenResourcesProvider,
  ToastProvider,
  SemiontProvider,
  SemiontBrowser,
} from '@semiont/react-ui';
import {
  defaultMocks,
  TestProvidersOptions,
  createMockTranslationManager,
  createMockOpenResourcesManager,
} from '@semiont/react-ui/test-utils';
import type {
  TranslationManager,
  OpenResourcesManager,
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
    apiBaseUrl = 'http://localhost:4000',
    openResourcesManager = defaultMocks.openResourcesManager,
    browser,
    ...renderOptions
  } = options || {};

  const effectiveBrowser = browser ?? new SemiontBrowser();

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TranslationProvider translationManager={translationManager}>
        <SemiontProvider browser={effectiveBrowser}>
          <ApiClientProvider baseUrl={apiBaseUrl}>
            <OpenResourcesProvider openResourcesManager={openResourcesManager}>
              <ToastProvider>
                {children}
              </ToastProvider>
            </OpenResourcesProvider>
          </ApiClientProvider>
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
  createMockOpenResourcesManager,
};
export type {
  TestProvidersOptions,
  TranslationManager,
  OpenResourcesManager,
};
