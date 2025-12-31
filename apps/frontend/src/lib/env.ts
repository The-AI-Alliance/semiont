// Environment configuration for Semiont Frontend
// Direct access to Next.js environment variables - no validation

// API Configuration
// SERVER_API_URL: Server-side API URL (runtime, used by Next.js server for auth, etc.)
// In Codespaces/Docker: Set to internal service name (e.g., http://backend:4000)
// Client-side API calls use relative URLs - routing layer handles path-based routing
if (!process.env.SERVER_API_URL) {
  throw new Error('SERVER_API_URL environment variable is required');
}
export const SERVER_API_URL = process.env.SERVER_API_URL;

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
