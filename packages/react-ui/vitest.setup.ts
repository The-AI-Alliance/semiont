import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Polyfill for HTMLElement.focus to fix @headlessui/react Dialog focus issues in jsdom
if (typeof window !== 'undefined' && window.HTMLElement) {
  const originalFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function (this: HTMLElement, options?: any) {
    if (typeof originalFocus === 'function') {
      originalFocus.call(this, options);
    }
  };
}

// Cleanup after each test
afterEach(() => {
  cleanup();
});
