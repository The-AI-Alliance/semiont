// Environment Configuration
// Uses the shared config system instead of .env files for consistency
import { z } from 'zod';
import { loadBackendConfig } from './loader';

// Load configuration from the shared config system
const config = loadBackendConfig();

// Define the schema for validation
const envSchema = z.object({
  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']),
  
  // Server configuration
  PORT: z.number().min(1).max(65535),
  
  // Database
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  DATABASE_NAME: z.string(),
  
  // Authentication
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  
  // CORS and URLs
  CORS_ORIGIN: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  
  // Application configuration
  SITE_NAME: z.string(),
  DOMAIN: z.string(),
  
  // OAuth configuration
  OAUTH_ALLOWED_DOMAINS: z.array(z.string().min(1)),
  
  // Optional OAuth credentials (may be injected by AWS Secrets Manager)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

// Validate the loaded configuration
function validateEnv() {
  try {
    return envSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map(err => 
        `${err.path.join('.')}: ${err.message}`
      );
      
      console.error('❌ Configuration validation failed:');
      errorMessages.forEach(msg => console.error(`  - ${msg}`));
      console.error('\nPlease check your configuration and secrets.');
      console.error('Use "semiont secrets set" to configure required secrets.');
      process.exit(1);
    }
    throw error;
  }
}

export const env = validateEnv();

// Type export for use elsewhere
export type EnvConfig = typeof env;