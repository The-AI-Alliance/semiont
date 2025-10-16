// Environment configuration for Semiont Frontend
// This provides type-safe access to environment variables with runtime validation

import { z } from 'zod';

// Environment variable validation schema
// Per CLAUDE.md: NO defaults, NO fallbacks - all required vars must be explicitly set
const envSchema = z.object({
  // API Configuration - Required
  NEXT_PUBLIC_API_URL: z.string().url('NEXT_PUBLIC_API_URL must be a valid URL'),

  // Site Configuration - Required
  NEXT_PUBLIC_SITE_NAME: z.string().min(1, 'NEXT_PUBLIC_SITE_NAME cannot be empty'),
  NEXT_PUBLIC_DOMAIN: z.string().min(1, 'NEXT_PUBLIC_DOMAIN cannot be empty'),

  // OAuth Configuration - Required
  NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS: z.string().min(1, 'NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS must be specified'),
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: z.string().optional(),

  // Build Configuration
  NODE_ENV: z.enum(['development', 'production', 'test']),
});

// Validate environment variables (lazy - only when accessed)
let _env: z.infer<typeof envSchema> | null = null;

function validateEnv() {
  // Skip validation during build time (Next.js static analysis)
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    console.warn('⚠️  Skipping env validation during build phase');
    return process.env as any;
  }

  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.issues.map(err => `${err.path.join('.')}: ${err.message}`);

      // During runtime, provide helpful error messages
      if (typeof window === 'undefined') {
        console.error('❌ Environment validation failed:');
        missingVars.forEach(msg => console.error(`  - ${msg}`));
        throw new Error(`Environment validation failed:\n${missingVars.join('\n')}`);
      }

      // Client-side error
      throw new Error('Environment configuration error - check server logs');
    }
    throw error;
  }
}

// Export validated environment variables (lazy getter)
export const env = new Proxy({} as z.infer<typeof envSchema>, {
  get(target, prop) {
    if (_env === null) {
      _env = validateEnv();
    }
    // After validation, _env is guaranteed to be non-null
    return _env![prop as keyof typeof _env];
  }
});

// Type-safe environment variable access
export type Env = typeof env;

// Export validation schema for testing
export { envSchema };

// Helper function to check if we're in development
export const isDevelopment = env.NODE_ENV === 'development';
export const isProduction = env.NODE_ENV === 'production';

// Helper function to parse allowed domains
export const getAllowedDomains = (): string[] => {
  return env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS
    .split(',')
    .map(domain => domain.trim())
    .filter(domain => domain.length > 0);
};