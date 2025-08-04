// Environment Variable Validation
import { z } from 'zod';

const envSchema = z.object({
  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Server configuration
  PORT: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().min(1).max(65535)).default('4000'),
  
  // Database
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  DATABASE_NAME: z.string().optional(),
  
  // Authentication
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  
  // CORS and URLs
  CORS_ORIGIN: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  
  // Application configuration
  SITE_NAME: z.string().default('Semiont'),
  DOMAIN: z.string().default('localhost'),
  
  // OAuth configuration
  OAUTH_ALLOWED_DOMAINS: z.string()
    .transform((val) => val.split(',').map(d => d.trim()).filter(d => d.length > 0))
    .pipe(z.array(z.string().min(1))),
  
  // Optional OAuth credentials (may be injected by AWS Secrets Manager)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

// Parse and validate environment variables
function validateEnv() {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map(err => 
        `${err.path.join('.')}: ${err.message}`
      );
      
      console.error('❌ Environment validation failed:');
      errorMessages.forEach(msg => console.error(`  - ${msg}`));
      console.error('\nPlease check your environment variables and try again.');
      process.exit(1);
    }
    throw error;
  }
}

export const env = validateEnv();

// Type export for use elsewhere
export type EnvConfig = typeof env;