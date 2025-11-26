// Environment configuration for Semiont Frontend
// Direct access to Next.js environment variables - no validation

// API Configuration
if (!process.env.NEXT_PUBLIC_API_URL) {
  throw new Error('NEXT_PUBLIC_API_URL environment variable is required');
}
export const NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL;

// Site Configuration
if (!process.env.NEXT_PUBLIC_SITE_NAME) {
  throw new Error('NEXT_PUBLIC_SITE_NAME environment variable is required');
}
export const NEXT_PUBLIC_SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME;

// OAuth Configuration
export const NEXT_PUBLIC_GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

// Environment helpers
export const isDevelopment = process.env.NODE_ENV === 'development';
export const isProduction = process.env.NODE_ENV === 'production';
