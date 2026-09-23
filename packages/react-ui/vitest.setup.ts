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

// jsdom does not implement Element.prototype.scrollIntoView AT ALL — the
// property is undefined, with no descriptor. Tests that need to observe
// scrolling therefore could not `vi.spyOn` it and had to assign the prototype
// directly, which nothing restores: the clobbered method then leaked to every
// later test in the file. Defining a no-op here gives `vi.spyOn` something to
// attach to, so those tests become ordinary restorable spies.
if (typeof globalThis !== 'undefined' && (globalThis as any).Element) {
  const ElementCtor = (globalThis as any).Element;
  if (typeof ElementCtor.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(ElementCtor.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: function scrollIntoView(): void {},
    });
  }
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

// Unit tests must never touch the network — they compose the SDK's in-memory
// doubles (`@semiont/sdk/testing`), so any real request is a wiring mistake.
// This refuses one loudly and names the URL, rather than letting it fail
// against a server that is not there.
//
// It replaced a never-settling stub that silently absorbed every request: the
// interim tier-1 fix from
// `.plans/bugs/panels-tests-b14-tail-races-vitest-teardown.md`, whose own
// acceptance criterion was its deletion once test-utils stopped composing a
// real HttpTransport. That happened 2026-09-23
// (.plans/TEST-UTILS-IN-MEMORY-TRANSPORT.md); throwing is safe now only
// because the suite makes no requests at all — a rejecting stub would
// otherwise re-trigger the B14 fail→log→retry→log chain that races vitest's
// worker teardown.
const refuseNetwork: typeof fetch = (input) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new Error(
    `Unit test attempted a network request: ${url}\n` +
      `Unit tests compose the SDK's in-memory doubles, never a real transport. ` +
      `Build clients via test-utils (or @semiont/sdk/testing directly) and script ` +
      `the response, rather than issuing a request no server answers.`,
  );
};
globalThis.fetch = refuseNetwork;
