import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Polyfill for HTMLElement.focus to fix @headlessui/react Dialog focus issues in jsdom
// The focus property is read-only in jsdom, so we need to use Object.defineProperty
if (typeof globalThis !== 'undefined' && (globalThis as any).HTMLElement) {
  const HTMLElementCtor = (globalThis as any).HTMLElement;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElementCtor.prototype, 'focus');
  if (descriptor && !descriptor.writable && !descriptor.set) {
    // Store original focus implementation
    const originalFocus = descriptor.get ? descriptor.get.bind(HTMLElementCtor.prototype) : null;

    // Redefine focus as a writable property
    Object.defineProperty(HTMLElementCtor.prototype, 'focus', {
      configurable: true,
      writable: true,
      value: function (this: HTMLElement) {
        // Call original focus if available
        if (originalFocus && typeof originalFocus === 'function') {
          try {
            originalFocus.call(this);
          } catch (e) {
            // Ignore focus errors in tests
          }
        }
      }
    });
  }
}

// Cleanup after each test
afterEach(() => {
  cleanup();
});
