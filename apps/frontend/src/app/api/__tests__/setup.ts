// Setup for API route tests
import 'whatwg-fetch';
import { TextEncoder, TextDecoder } from 'util';

// Mock Next.js server environment
Object.assign(global, {
  TextEncoder,
  TextDecoder
});

// Mock Request and Response for Next.js API routes
if (typeof global.Request === 'undefined') {
  class MockRequest {
    constructor(public url: string, public init?: RequestInit) {}
    async json() { return JSON.parse((this.init?.body as string) || '{}'); }
    async text() { return (this.init?.body as string) || ''; }
  }
  Object.assign(global, { Request: MockRequest });
}

if (typeof global.Response === 'undefined') {
  class MockResponse {
    constructor(public body?: string | null, public init?: ResponseInit) {}
    async json() { return JSON.parse(this.body || '{}'); }
    async text() { return this.body || ''; }
    get status() { return this.init?.status || 200; }
    get headers() {
      return new Headers(this.init?.headers || {});
    }
  }
  Object.assign(global, { Response: MockResponse });
}