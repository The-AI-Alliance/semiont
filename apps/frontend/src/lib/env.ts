// Environment configuration for Semiont Frontend
// No validation at module load time - values are validated when actually used

// Site Configuration
export const SEMIONT_SITE_NAME = process.env.SEMIONT_SITE_NAME || 'Semiont';
export const SEMIONT_BASE_URL = process.env.SEMIONT_BASE_URL || 'http://localhost:3000';

// OAuth Configuration
export const SEMIONT_GOOGLE_CLIENT_ID = process.env.SEMIONT_GOOGLE_CLIENT_ID;

// OAuth allowed domains (comma-separated list)
export const SEMIONT_OAUTH_ALLOWED_DOMAINS = process.env.SEMIONT_OAUTH_ALLOWED_DOMAINS || '';

// Environment helpers
export const isDevelopment = process.env.NODE_ENV === 'development';
export const isProduction = process.env.NODE_ENV === 'production';

// Helper to parse allowed domains from comma-separated string
export function getAllowedDomains(): string[] {
  return SEMIONT_OAUTH_ALLOWED_DOMAINS
    .split(',')
    .map(d => d.trim())
    .filter(d => d.length > 0);
}
