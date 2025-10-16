// Environment configuration for Semiont Frontend
// Direct access to Next.js environment variables - no validation

// API Configuration
export const NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || '';
export const NEXT_PUBLIC_FRONTEND_URL = process.env.NEXT_PUBLIC_FRONTEND_URL || '';

// Site Configuration
export const NEXT_PUBLIC_SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || '';
export const NEXT_PUBLIC_DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || '';

// OAuth Configuration
export const NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS = process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS || '';
export const NEXT_PUBLIC_GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

// Environment helpers
export const isDevelopment = process.env.NODE_ENV === 'development';
export const isProduction = process.env.NODE_ENV === 'production';

// Helper function to parse allowed domains
export const getAllowedDomains = (): string[] => {
  return NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS
    .split(',')
    .map((domain: string) => domain.trim())
    .filter((domain: string) => domain.length > 0);
};
