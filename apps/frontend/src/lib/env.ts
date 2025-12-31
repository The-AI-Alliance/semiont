// Environment configuration for Semiont Frontend
// Direct access to Next.js environment variables - no validation

// API Configuration
// NEXT_PUBLIC_API_URL: Client-side API URL (embedded at build time, used by browser)
if (!process.env.NEXT_PUBLIC_API_URL) {
  throw new Error('NEXT_PUBLIC_API_URL environment variable is required');
}
export const NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL;

// SERVER_API_URL: Server-side API URL (runtime, used by Next.js server for auth, etc.)
// Falls back to NEXT_PUBLIC_API_URL for local dev, but should be set explicitly in production
// In Codespaces/Docker: Set to internal service name (e.g., http://backend:4000)
// At runtime (not build time): Can use public URL if no service mesh available
export const SERVER_API_URL = process.env.SERVER_API_URL || process.env.NEXT_PUBLIC_API_URL;

// Site Configuration
if (!process.env.NEXT_PUBLIC_SITE_NAME) {
  throw new Error('NEXT_PUBLIC_SITE_NAME environment variable is required');
}
export const NEXT_PUBLIC_SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME;

// OAuth Configuration
export const NEXT_PUBLIC_GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

// OAuth allowed domains (comma-separated list)
export const NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS = process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS || '';

// Environment helpers
export const isDevelopment = process.env.NODE_ENV === 'development';
export const isProduction = process.env.NODE_ENV === 'production';

// Helper to parse allowed domains from comma-separated string
export function getAllowedDomains(): string[] {
  return NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS
    .split(',')
    .map(d => d.trim())
    .filter(d => d.length > 0);
}
