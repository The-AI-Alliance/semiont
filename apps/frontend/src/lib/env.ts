// Environment configuration for Semiont Frontend
// This provides type-safe access to environment variables with runtime validation

import { z } from 'zod';

// Environment variable validation schema
const envSchema = z.object({
  // API Configuration - Required in runtime, optional in build
  NEXT_PUBLIC_API_URL: z.string().url('NEXT_PUBLIC_API_URL must be a valid URL').default('http://localhost:4000'),
  
  // Site Configuration
  NEXT_PUBLIC_SITE_NAME: z.string().min(1, 'NEXT_PUBLIC_SITE_NAME cannot be empty').default('Semiont'),
  NEXT_PUBLIC_DOMAIN: z.string().min(1, 'NEXT_PUBLIC_DOMAIN cannot be empty').default('localhost'),
  
  // OAuth Configuration - Required in runtime, optional in build
  NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS: z.string().min(1, 'NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS must be specified').default('gmail.com'),
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: z.string().optional(),
  
  // Build Configuration
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

// Validate environment variables
function validateEnv() {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.issues.map(err => `${err.path.join('.')}: ${err.message}`);
      
      // During build time, provide more helpful error messages
      if (typeof window === 'undefined') {
        console.error('❌ Environment validation failed:');
        missingVars.forEach(msg => console.error(`  - ${msg}`));
        
        // For development, provide fallback values but warn
        if (process.env.NODE_ENV === 'development') {
          console.warn('⚠️  Using fallback values for missing environment variables in development mode');
          return {
            NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000',
            NEXT_PUBLIC_SITE_NAME: process.env.NEXT_PUBLIC_SITE_NAME || 'Semiont',
            NEXT_PUBLIC_DOMAIN: process.env.NEXT_PUBLIC_DOMAIN || 'localhost',
            NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS: process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS || 'gmail.com',
            NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
            NODE_ENV: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',
          };
        }
        
        // In production, fail hard
        throw new Error(`Environment validation failed:\n${missingVars.join('\n')}`);
      }
      
      // Client-side error
      throw new Error('Environment configuration error - check server logs');
    }
    throw error;
  }
}

// Export validated environment variables
export const env = validateEnv();

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