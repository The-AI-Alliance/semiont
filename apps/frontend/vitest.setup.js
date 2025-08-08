import '@testing-library/jest-dom'
import { beforeAll, afterEach, afterAll, vi } from 'vitest'
import { server } from './src/mocks/server'

// Enable API mocking with MSW
beforeAll(() => server.listen({
  onUnhandledRequest: 'warn'
}))

// Reset any runtime request handlers we may add during the tests
afterEach(() => server.resetHandlers())

// Disable API mocking after the tests are done
afterAll(() => server.close())

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter() {
    return {
      push: vi.fn(),
      replace: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
    }
  },
  useSearchParams() {
    return {
      get: vi.fn(),
    }
  },
  usePathname() {
    return ''
  },
  redirect: vi.fn(),
  notFound: vi.fn(),
}))

// Mock getServerSession for auth tests
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

// Mock environment variables
process.env.NEXT_PUBLIC_SITE_NAME = 'Test Semiont'
process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3001'
process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS = 'example.com,test.com'

// Mock window.location for tests that need it
Object.defineProperty(window, 'location', {
  value: {
    href: 'http://localhost/',
    origin: 'http://localhost',
    protocol: 'http:',
    host: 'localhost',
    hostname: 'localhost',
    port: '',
    pathname: '/',
    search: '',
    hash: '',
    reload: vi.fn(),
    replace: vi.fn(),
    assign: vi.fn(),
  },
  writable: true,
})

// Mock URL.createObjectURL and URL.revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
global.URL.revokeObjectURL = vi.fn()