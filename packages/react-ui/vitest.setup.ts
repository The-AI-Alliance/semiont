import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';
import { toHaveNoViolations } from 'jest-axe';

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Extend Vitest's expect with jest-axe matchers
expect.extend(toHaveNoViolations);

// Mock DOMMatrix for PDF.js in test environment
if (typeof globalThis !== 'undefined' && !(globalThis as any).DOMMatrix) {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    constructor() {
      // Minimal implementation for PDF.js compatibility
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
    }
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  };
}

// Polyfill for HTMLElement.focus to fix @headlessui/react Dialog focus issues in jsdom
// jsdom's focus is read-only and doesn't properly set document.activeElement
if (typeof globalThis !== 'undefined' && (globalThis as any).HTMLElement) {
  const HTMLElementCtor = (globalThis as any).HTMLElement;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElementCtor.prototype, 'focus');

  if (descriptor && !descriptor.writable) {
    // Redefine focus as a writable method that properly sets activeElement
    Object.defineProperty(HTMLElementCtor.prototype, 'focus', {
      configurable: true,
      writable: true,
      value: function (this: HTMLElement) {
        // Set this element as the activeElement
        if (this.ownerDocument) {
          Object.defineProperty(this.ownerDocument, 'activeElement', {
            configurable: true,
            writable: true,
            value: this
          });
        }

        // Dispatch focus event
        const focusEvent = new FocusEvent('focus', { bubbles: false, cancelable: false });
        this.dispatchEvent(focusEvent);

        // Also dispatch focusin (which bubbles)
        const focusinEvent = new FocusEvent('focusin', { bubbles: true, cancelable: false });
        this.dispatchEvent(focusinEvent);
      }
    });
  }
}

// Cleanup after each test
afterEach(() => {
  cleanup();
});
