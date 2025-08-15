/**
 * Common test helper utilities
 */

import { vi } from 'vitest';

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: {
    timeout?: number;
    interval?: number;
    message?: string;
  } = {}
): Promise<void> {
  const { 
    timeout = 5000, 
    interval = 100,
    message = 'Condition not met within timeout'
  } = options;
  
  const startTime = Date.now();
  
  while (true) {
    const result = await condition();
    if (result) {
      return;
    }
    
    if (Date.now() - startTime > timeout) {
      throw new Error(message);
    }
    
    await delay(interval);
  }
}

/**
 * Delay execution for a specified time
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a deferred promise
 */
export function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: any) => void;
  
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  
  return {
    promise,
    resolve: resolve!,
    reject: reject!,
  };
}

/**
 * Suppress console output during a test
 */
export function suppressConsole() {
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  
  const restore = () => {
    Object.assign(console, originalConsole);
  };
  
  console.log = vi.fn();
  console.error = vi.fn();
  console.warn = vi.fn();
  console.info = vi.fn();
  console.debug = vi.fn();
  
  return { restore, mocks: console };
}

/**
 * Run a function with suppressed console output
 */
export async function withSuppressedConsole<T>(
  fn: () => T | Promise<T>
): Promise<T> {
  const { restore } = suppressConsole();
  
  try {
    return await fn();
  } finally {
    restore();
  }
}

/**
 * Create a test fixture
 */
export function createFixture<T>(
  setup: () => T | Promise<T>,
  teardown?: (fixture: T) => void | Promise<void>
) {
  let fixture: T | null = null;
  
  return {
    async get(): Promise<T> {
      if (!fixture) {
        fixture = await setup();
      }
      return fixture;
    },
    
    async reset(): Promise<void> {
      if (fixture && teardown) {
        await teardown(fixture);
      }
      fixture = null;
    },
  };
}

/**
 * Mock timers with auto-cleanup
 */
export function useFakeTimers() {
  vi.useFakeTimers();
  
  return {
    advance: (ms: number) => vi.advanceTimersByTime(ms),
    runAll: () => vi.runAllTimers(),
    runPending: () => vi.runOnlyPendingTimers(),
    clear: () => vi.clearAllTimers(),
    restore: () => vi.useRealTimers(),
  };
}

/**
 * Create a test context with setup and teardown
 */
export class TestContext<T = any> {
  private data: T;
  
  constructor(initialData: T) {
    this.data = initialData;
  }
  
  get(): T {
    return this.data;
  }
  
  set(data: T): void {
    this.data = data;
  }
  
  update(updater: (data: T) => T): void {
    this.data = updater(this.data);
  }
  
  reset(initialData: T): void {
    this.data = initialData;
  }
}

/**
 * Assert that a promise rejects with a specific error
 */
export async function expectToReject(
  promise: Promise<any>,
  expectedError?: string | RegExp | Error
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected promise to reject, but it resolved');
  } catch (error: any) {
    if (expectedError) {
      if (typeof expectedError === 'string') {
        expect(error.message).toContain(expectedError);
      } else if (expectedError instanceof RegExp) {
        expect(error.message).toMatch(expectedError);
      } else if (expectedError instanceof Error) {
        expect(error).toEqual(expectedError);
      }
    }
  }
}

/**
 * Create a mock event emitter
 */
export function createMockEventEmitter() {
  const listeners = new Map<string, Set<Function>>();
  
  return {
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
    }),
    
    off: vi.fn((event: string, handler: Function) => {
      listeners.get(event)?.delete(handler);
    }),
    
    emit: vi.fn((event: string, ...args: any[]) => {
      const handlers = listeners.get(event);
      if (handlers) {
        handlers.forEach(handler => handler(...args));
      }
    }),
    
    once: vi.fn((event: string, handler: Function) => {
      const wrapper = (...args: any[]) => {
        handler(...args);
        listeners.get(event)?.delete(wrapper);
      };
      
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(wrapper);
    }),
    
    removeAllListeners: vi.fn((event?: string) => {
      if (event) {
        listeners.delete(event);
      } else {
        listeners.clear();
      }
    }),
    
    listenerCount: (event: string) => listeners.get(event)?.size || 0,
  };
}

/**
 * Test data builder pattern helper
 */
export class TestDataBuilder<T> {
  private data: Partial<T> = {};
  
  with<K extends keyof T>(key: K, value: T[K]): this {
    this.data[key] = value;
    return this;
  }
  
  withMany(values: Partial<T>): this {
    Object.assign(this.data, values);
    return this;
  }
  
  build(): T {
    return this.data as T;
  }
  
  buildMany(count: number, modifier?: (index: number) => Partial<T>): T[] {
    return Array.from({ length: count }, (_, i) => ({
      ...this.data,
      ...(modifier ? modifier(i) : {}),
    })) as T[];
  }
}