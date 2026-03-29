// Environment configuration for Semiont Frontend
// No validation at module load time - values are validated when actually used

// API Configuration
// SERVER_API_URL: Server-side API URL (runtime, used by Next.js server for MCP setup, etc.)
// In Codespaces/Docker: Set to internal service name (e.g., http://backend:4000)
export const SERVER_API_URL = process.env.SERVER_API_URL || '';

// NEXT_PUBLIC_BACKEND_URL: Client-side backend URL used by the browser to call the API directly.
// Defaults to '' (relative URLs) when running behind Envoy on the same origin.
export const NEXT_PUBLIC_BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Site Configuration
export const NEXT_PUBLIC_SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || 'Semiont';
export const NEXT_PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

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
