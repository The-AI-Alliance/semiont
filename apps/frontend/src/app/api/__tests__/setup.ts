// Setup for API route tests
import 'whatwg-fetch';
import { TextEncoder, TextDecoder } from 'util';

// Mock Next.js server environment
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

// Mock Request and Response for Next.js API routes
if (typeof global.Request === 'undefined') {
  global.Request = class Request {
    constructor(public url: string, public init?: any) {}
    async json() { return JSON.parse(this.init?.body || '{}'); }
    async text() { return this.init?.body || ''; }
  } as any;
}

if (typeof global.Response === 'undefined') {
  global.Response = class Response {
    constructor(public body?: any, public init?: any) {}
    async json() { return this.body; }
    async text() { return this.body; }
    get status() { return this.init?.status || 200; }
    get headers() { 
      return new Map(Object.entries(this.init?.headers || {}));
    }
  } as any;
}