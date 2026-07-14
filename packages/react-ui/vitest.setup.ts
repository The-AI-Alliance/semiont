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

// Unit tests must never touch the network. The test-utils fake browsers
// construct REAL SemiontClients over HttpTransport (localhost:4000); without
// this stub their live-query caches issue real fetches that fail, and the
// B14 fail→log→retry→log chain rides an async tail that can straddle the
// vitest worker's RPC teardown (the `EnvironmentTeardownError` CI failures).
// A never-settling fetch produces no rejection, no retry chain, no
// post-teardown logs. A test that needs fetch behavior stubs it locally
// (test-local stubs override this default). Belt to the braces in
// test-utils' afterEach client disposal, which closes the same class for
// chains already in flight.
//
// ⚠️ ACKNOWLEDGED INTERIM, not architecture. A never-settling promise models
// nothing — it's a black hole, and its shape was chosen to dodge the B14 log
// chain (a rejecting stub would re-trigger it), not because it's a good test
// double. If a test ever legitimately awaits fetch, it will HANG here with no
// error — that's this stub, not your code. The real defect is one layer down:
// test-utils composes a real HttpTransport into unit tests. The right fix is
// an in-memory ITransport double in test-utils (pending-by-default requests,
// controllable responses, a baseUrl) — when that lands, DELETE this stub;
// its continued existence past that point is a bug.
// Diagnosis: .plans/bugs/panels-tests-b14-tail-races-vitest-teardown.md
const neverSettlingFetch: typeof fetch = () => new Promise<Response>(() => {});
globalThis.fetch = neverSettlingFetch;
